const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');

// ─── Multi-Tenant Session Store (One WhatsApp per Shop) ─────────────────────
const sessions = new Map();
const syncTimers = new Map();

function cleanShopKey(shopId = 'default') {
  return String(shopId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getAuthDir(shopId = 'default') {
  const cleanId = cleanShopKey(shopId);
  const baseDir = path.join(__dirname, '.baileys_auth');
  const shopDir = path.join(baseDir, cleanId);
  if (!fs.existsSync(shopDir)) {
    fs.mkdirSync(shopDir, { recursive: true });
  }
  return shopDir;
}

function hasSavedCredentials(shopId = 'default') {
  try {
    const cleanId = cleanShopKey(shopId);
    const credsPath = path.join(__dirname, '.baileys_auth', cleanId, 'creds.json');
    return fs.existsSync(credsPath);
  } catch {
    return false;
  }
}

function getSessionState(shopId = 'default') {
  const cleanId = cleanShopKey(shopId);
  if (!sessions.has(cleanId)) {
    sessions.set(cleanId, {
      shopId: cleanId,
      sock: null,
      qrCodeDataUrl: null,
      clientStatus: hasSavedCredentials(cleanId) ? 'CONNECTING' : 'DISCONNECTED',
      clientInfo: null,
      lastError: null,
      reconnectTimer: null,
      isConnecting: false,
      authDir: getAuthDir(cleanId)
    });
  }
  return sessions.get(cleanId);
}

// ─── Phone & Green API Helpers ──────────────────────────────────────────────
function formatPhoneNumber(phone) {
  let clean = String(phone || '').replace(/\D/g, '');
  if (clean.length === 10) clean = '91' + clean;
  else if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.slice(1);
  return clean;
}

function isValidGreenConfig(cfg, { requireEnabled = true } = {}) {
  if (!cfg || typeof cfg !== 'object') return false;
  const id = String(cfg.idInstance || '').trim();
  const tok = String(cfg.apiTokenInstance || '').trim();
  if (!id || !tok || id.includes('@')) return false;
  if (requireEnabled && cfg.enabled !== true) return false;
  return true;
}

async function checkGreenApiStatus(greenConfig = {}) {
  const idInstance = String(greenConfig.idInstance || '').trim();
  const apiTokenInstance = String(greenConfig.apiTokenInstance || '').trim();
  const apiUrl = String(greenConfig.apiUrl || 'https://api.green-api.com').trim().replace(/\/+$/, '');

  if (!idInstance || !apiTokenInstance) {
    return { configured: false, isAuthorized: false, state: 'not_configured', message: 'Not configured' };
  }
  if (idInstance.includes('@')) {
    return { configured: false, isAuthorized: false, state: 'error', message: 'Invalid Instance ID (must be numeric, not email)' };
  }

  try {
    const res = await fetch(`${apiUrl}/waInstance${idInstance}/getStateInstance/${apiTokenInstance}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      return { configured: true, isAuthorized: false, state: 'error', message: `Green API HTTP ${res.status}` };
    }
    const data = await res.json();
    const state = data?.stateInstance || 'unknown';
    if (state === 'authorized') {
      let info = { phone: '', pushname: 'Green API' };
      try {
        const devRes = await fetch(`${apiUrl}/waInstance${idInstance}/getDeviceInfo/${apiTokenInstance}`, {
          signal: AbortSignal.timeout(5000)
        });
        if (devRes.ok) {
          const dev = await devRes.json();
          info = { phone: dev.phone || '', pushname: dev.pushname || 'Green API' };
        }
      } catch {}
      return { configured: true, isAuthorized: true, state: 'authorized', info, message: 'Green API authorized' };
    }
    return {
      configured: true,
      isAuthorized: false,
      state,
      message: state === 'notAuthorized' ? 'Green API QR scan required.' : `Green API state: ${state}`
    };
  } catch (err) {
    return { configured: true, isAuthorized: false, state: 'error', message: err.message || 'Green API check failed' };
  }
}

// ─── MongoDB Backup for Baileys Multi-Tenant Sessions (survives Render restarts) ───
async function persistBaileysSessionToDb(shopId) {
  const cleanId = cleanShopKey(shopId);
  if (!cleanId || cleanId === 'default') return;
  try {
    const authDir = path.join(__dirname, '.baileys_auth', cleanId);
    if (!fs.existsSync(path.join(authDir, 'creds.json'))) return;

    const pool = require('./db');
    const db = await pool.getDb();
    const entries = fs.readdirSync(authDir);
    const files = {};
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const fullPath = path.join(authDir, name);
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && stat.size <= 512 * 1024) {
        files[name] = fs.readFileSync(fullPath, 'utf8');
      }
    }
    if (!files['creds.json']) return;

    await db.collection('whatsapp_sessions').updateOne(
      { shopId: cleanId },
      { $set: { shopId: cleanId, files, updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[WhatsApp - Shop ${cleanId}] Mongo session backup skipped:`, err.message);
  }
}

function scheduleDbSessionSync(shopId) {
  const cleanId = cleanShopKey(shopId);
  if (!cleanId || cleanId === 'default') return;
  if (syncTimers.has(cleanId)) {
    clearTimeout(syncTimers.get(cleanId));
  }
  const timer = setTimeout(() => {
    syncTimers.delete(cleanId);
    persistBaileysSessionToDb(cleanId).catch(() => {});
  }, 2000);
  syncTimers.set(cleanId, timer);
}

async function deleteDbSession(shopId) {
  const cleanId = cleanShopKey(shopId);
  try {
    const pool = require('./db');
    const db = await pool.getDb();
    await db.collection('whatsapp_sessions').deleteOne({ shopId: cleanId });
  } catch {}
}

function hydrateSessionFiles(shopId, files) {
  if (!files || typeof files !== 'object' || !files['creds.json']) return false;
  const authDir = getAuthDir(shopId);
  for (const [name, content] of Object.entries(files)) {
    if (!name.endsWith('.json') || name.includes('/') || name.includes('\\') || name.includes('..')) continue;
    const target = path.join(authDir, name);
    fs.writeFileSync(target, String(content), 'utf8');
  }
  return hasSavedCredentials(shopId);
}

// ─── Core: connectShop ──────────────────────────────────────────────────────
async function connectShop(shopId = 'default') {
  const cleanId = cleanShopKey(shopId);
  const session = getSessionState(cleanId);

  if (session.isConnecting) {
    console.log(`[WhatsApp - Shop ${cleanId}] Connection attempt in progress, skipping duplicate.`);
    return;
  }

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  session.isConnecting = true;

  try {
    const authDir = getAuthDir(cleanId);
    if (!hasSavedCredentials(cleanId) && cleanId !== 'default') {
      try {
        const pool = require('./db');
        const db = await pool.getDb();
        const saved = await db.collection('whatsapp_sessions').findOne({ shopId: cleanId });
        if (saved?.files) {
          hydrateSessionFiles(cleanId, saved.files);
        }
      } catch {}
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1015901307]
    }));

    if (session.clientStatus !== 'PAIRING') {
      session.clientStatus = hasSavedCredentials(cleanId) ? 'CONNECTING' : 'INITIALIZING';
    }
    session.lastError = null;

    console.log(`[WhatsApp - Shop ${cleanId}] Connecting via Baileys v${version.join('.')}...`);

    const silentLogger = pino({ level: 'silent' });

    if (session.sock) {
      try {
        session.sock.ev.removeAllListeners();
        session.sock.ws?.close();
      } catch {}
      session.sock = null;
    }

    const sock = makeWASocket({
      version,
      auth: state,
      logger: silentLogger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu(`MartGPT-${cleanId}`),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 2000,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false
    });

    session.sock = sock;

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        scheduleDbSessionSync(cleanId);
      } catch (err) {
        console.error(`[WhatsApp - Shop ${cleanId}] Error saving credentials:`, err.message);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.clientStatus = 'NEEDS_QR';
        try {
          session.qrCodeDataUrl = await qrcode.toDataURL(qr, { margin: 2, scale: 7 });
          console.log(`[WhatsApp - Shop ${cleanId}] QR code generated — ready in Settings.`);
        } catch (e) {
          console.error(`[WhatsApp - Shop ${cleanId}] QR generation error:`, e.message);
        }
      }

      if (connection === 'open') {
        session.clientStatus = 'CONNECTED';
        session.qrCodeDataUrl = null;
        session.lastError = null;
        const me = sock?.user;
        if (me) {
          session.clientInfo = {
            phone: me.id?.split(':')[0] || me.id?.split('@')[0] || '',
            pushname: me.name || me.notify || `Shop ${cleanId}`
          };
          console.log(`[WhatsApp - Shop ${cleanId}] ✅ Connected as: ${session.clientInfo.pushname} (+${session.clientInfo.phone})`);
        }
        scheduleDbSessionSync(cleanId);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : (lastDisconnect?.error?.code || null);

        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
        const isReplaced = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;

        console.log(`[WhatsApp - Shop ${cleanId}] Connection closed. StatusCode: ${statusCode} | LoggedOut: ${isLoggedOut} | Restart: ${isRestartRequired}`);

        const oldSock = session.sock;
        session.sock = null;
        if (oldSock) {
          try {
            oldSock.ev.removeAllListeners();
            oldSock.ws?.close();
          } catch {}
        }

        if (isLoggedOut) {
          session.clientStatus = 'DISCONNECTED';
          session.clientInfo = null;
          session.qrCodeDataUrl = null;
          session.lastError = 'Session logged out. Please scan QR again.';
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
          deleteDbSession(cleanId).catch(() => {});
          console.log(`[WhatsApp - Shop ${cleanId}] Session cleared.`);
        } else if (isReplaced) {
          session.clientStatus = 'DISCONNECTED';
          session.lastError = 'Connection replaced by another session.';
        } else if (isRestartRequired) {
          console.log(`[WhatsApp - Shop ${cleanId}] QR scanned & paired! Finalizing credentials...`);
          session.clientStatus = 'PAIRING';
          session.qrCodeDataUrl = null;
          session.lastError = null;
          if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
          session.reconnectTimer = setTimeout(async () => {
            session.isConnecting = false;
            try { await connectShop(cleanId); } catch {}
          }, 1200);
        } else {
          session.clientStatus = 'CONNECTING';
          if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
          session.reconnectTimer = setTimeout(async () => {
            session.isConnecting = false;
            try { await connectShop(cleanId); } catch {}
          }, 3000);
        }
      }
    });
  } catch (err) {
    console.error(`[WhatsApp - Shop ${cleanId}] Connection failure:`, err.message);
    session.lastError = err.message || String(err);
    session.clientStatus = 'DISCONNECTED';
    session.sock = null;
  } finally {
    session.isConnecting = false;
  }
}

async function waitForReady(shopId = 'default', timeoutMs = 12000) {
  const session = getSessionState(shopId);
  if (session.clientStatus === 'CONNECTED' && session.sock) return true;

  if (session.clientStatus === 'DISCONNECTED' && !session.isConnecting && hasSavedCredentials(shopId)) {
    connectShop(shopId).catch(() => {});
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 300));
    if (session.clientStatus === 'CONNECTED' && session.sock) return true;
  }
  return false;
}

// ─── Public Multi-Tenant APIs ────────────────────────────────────────────────
function initializeWhatsApp(shopId = 'default') {
  const cleanId = cleanShopKey(shopId);
  const session = getSessionState(cleanId);
  if (session.clientStatus === 'CONNECTED' || session.clientStatus === 'PAIRING' || session.isConnecting) {
    return;
  }
  connectShop(cleanId).catch(err => {
    session.lastError = err.message || String(err);
    session.clientStatus = 'DISCONNECTED';
  });
}

function getStatus(shopId = 'default') {
  const cleanId = cleanShopKey(shopId);
  const session = sessions.get(cleanId);
  if (!session) {
    return {
      shopId: cleanId,
      status: hasSavedCredentials(cleanId) ? 'CONNECTING' : 'DISCONNECTED',
      qr: null,
      info: null,
      error: null,
      hasSavedSession: hasSavedCredentials(cleanId)
    };
  }
  return {
    shopId: cleanId,
    status: session.clientStatus,
    qr: session.qrCodeDataUrl,
    info: session.clientInfo,
    error: session.lastError,
    hasSavedSession: hasSavedCredentials(cleanId)
  };
}

function getActiveSessionCount() {
  let connected = 0;
  for (const s of sessions.values()) {
    if (s.clientStatus === 'CONNECTED') connected++;
  }
  return connected;
}

async function sendViaGreenApi(phoneNumber, message, greenConfig = {}) {
  const idInstance = String(greenConfig.idInstance || process.env.GREEN_API_ID_INSTANCE || '').trim();
  const apiTokenInstance = String(greenConfig.apiTokenInstance || process.env.GREEN_API_TOKEN_INSTANCE || '').trim();
  const apiUrl = String(greenConfig.apiUrl || process.env.GREEN_API_URL || 'https://api.green-api.com').trim().replace(/\/+$/, '');

  if (!idInstance || !apiTokenInstance) {
    return null;
  }
  if (idInstance.includes('@')) {
    throw new Error('Invalid Green API Instance ID (numeric ID required, not email).');
  }

  const clean = formatPhoneNumber(phoneNumber);
  if (clean.length < 10) {
    throw new Error('Invalid phone number: ' + phoneNumber);
  }
  const chatId = `${clean}@c.us`;
  const url = `${apiUrl}/waInstance${idInstance}/sendMessage/${apiTokenInstance}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ chatId, message }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Green API HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  console.log(`[Green API] Message delivered to ${chatId} (ID: ${data.idMessage})`);
  return { success: true, idMessage: data.idMessage };
}

async function sendMessage(phoneNumber, message, shopId = 'default', maxRetries = 3, greenConfig = null) {
  const cleanId = cleanShopKey(shopId);
  const clean = formatPhoneNumber(phoneNumber);
  if (clean.length < 10) {
    throw new Error('Invalid phone number: ' + phoneNumber);
  }

  const greenActive = isValidGreenConfig(greenConfig, { requireEnabled: true });
  const envGreenActive = !greenConfig && Boolean(process.env.GREEN_API_ID_INSTANCE && process.env.GREEN_API_TOKEN_INSTANCE);
  let greenError = null;

  if (greenActive || envGreenActive) {
    try {
      const gaResult = await sendViaGreenApi(phoneNumber, message, greenConfig || {});
      if (gaResult) return gaResult;
    } catch (gaErr) {
      greenError = gaErr;
      console.warn(`[WhatsApp - Shop ${cleanId}] Green API dispatch failed:`, gaErr.message);
    }
  }

  const session = getSessionState(cleanId);

  if (!hasSavedCredentials(cleanId) && session.clientStatus !== 'CONNECTED') {
    if (greenError) {
      throw new Error(`Green API delivery failed: ${greenError.message}`);
    }
    throw new Error(`WhatsApp is not linked or auto-sending is turned OFF for shop (${cleanId}). Please connect and enable WhatsApp in Settings -> WhatsApp.`);
  }

  const isReady = await waitForReady(cleanId, 12000);
  if (!isReady || !session.sock || session.clientStatus !== 'CONNECTED') {
    if (greenError) {
      throw new Error(`Green API delivery failed: ${greenError.message}`);
    }
    throw new Error(`WhatsApp bot (${cleanId}) is not connected (Status: ${session.clientStatus}). Please reconnect in Settings.`);
  }

  const jid = clean + '@s.whatsapp.net';

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      if (!session.sock || session.clientStatus !== 'CONNECTED') {
        const reconnected = await waitForReady(cleanId, 8000);
        if (!reconnected) throw new Error('Connection lost during send');
      }
      await session.sock.sendMessage(jid, { text: message });
      console.log(`[WhatsApp - Shop ${cleanId}] Message delivered to ${jid}`);
      return { success: true, jid };
    } catch (err) {
      attempt++;
      console.warn(`[WhatsApp - Shop ${cleanId}] Send attempt ${attempt} failed for ${jid}: ${err.message}`);
      if (attempt > maxRetries) {
        throw new Error(`Failed to send WhatsApp message after ${maxRetries} retries: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}

async function logout(shopId = 'default') {
  const cleanId = cleanShopKey(shopId);
  const session = getSessionState(cleanId);
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  if (session.sock) {
    try { await session.sock.logout(); } catch {}
    session.sock = null;
  }
  session.clientStatus = 'DISCONNECTED';
  session.qrCodeDataUrl = null;
  session.clientInfo = null;
  session.lastError = null;
  session.isConnecting = false;
  try {
    fs.rmSync(session.authDir, { recursive: true, force: true });
  } catch {}
  await deleteDbSession(cleanId);
  console.log(`[WhatsApp - Shop ${cleanId}] Logged out and session cleared.`);
}

async function restoreAllSavedSessions() {
  try {
    const shopIdsToRestore = new Set();

    // 1. Hydrate saved Baileys sessions from MongoDB (survives Render restarts/redeploy)
    try {
      const pool = require('./db');
      const db = await pool.getDb();
      const savedDocs = await db.collection('whatsapp_sessions').find({}).toArray();
      for (const doc of savedDocs) {
        if (doc?.shopId && doc.shopId !== 'default' && doc.files?.['creds.json']) {
          if (hydrateSessionFiles(doc.shopId, doc.files)) {
            shopIdsToRestore.add(doc.shopId);
          }
        }
      }
    } catch (dbErr) {
      console.warn('[WhatsApp] MongoDB session hydration notice:', dbErr.message);
    }

    // 2. Also include any local disk sessions
    const baseDir = path.join(__dirname, '.baileys_auth');
    if (fs.existsSync(baseDir)) {
      const items = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory() && item.name !== 'default' && hasSavedCredentials(item.name)) {
          shopIdsToRestore.add(item.name);
        }
      }
    }

    let delay = 0;
    for (const shopId of shopIdsToRestore) {
      setTimeout(() => {
        console.log(`[WhatsApp] Auto-restoring saved session for shop: ${shopId}`);
        initializeWhatsApp(shopId);
      }, delay);
      delay += 600;
    }
  } catch (err) {
    console.error('[WhatsApp] Error restoring saved sessions:', err.message);
  }
}

module.exports = {
  initializeWhatsApp,
  getStatus,
  getActiveSessionCount,
  sendMessage,
  sendViaGreenApi,
  isValidGreenConfig,
  checkGreenApiStatus,
  logout,
  restoreAllSavedSessions
};
