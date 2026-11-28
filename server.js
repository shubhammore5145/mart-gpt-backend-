const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const whatsappBot = require('./whatsapp');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config(); // fallback to root .env if any

const app = express();
const port = process.env.PORT || 5000;

// Safety net: prevent errors from crashing the server
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception (server kept running):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection (server kept running):', reason?.message || reason);
});

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

// In-Memory Rate Limiter for Auth Routes (Brute-force protection)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_AUTH_ATTEMPTS = 25; // 25 requests per minute per IP

function authRateLimiter(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW;
  } else {
    record.count += 1;
  }

  rateLimitMap.set(ip, record);

  if (record.count > MAX_AUTH_ATTEMPTS) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      error: `Too many authentication attempts. Please try again in ${retryAfter} seconds.`,
      retryAfter
    });
  }
  next();
}

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Database Connection
const pool = require('./db');
pool.testConnection().catch(() => {});

// Routes
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const superAdminRoutes = require('./routes/superadmin');
const notificationsRoutes = require('./routes/notifications');
const {
  router: whatsappRoutes,
  generateAndSendNightlySummary,
  getIstTimeParts
} = require('./routes/whatsapp');

// ── Health Check Endpoint (for UptimeRobot / keep-alive pings) ────────────────
app.get('/api/ping', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's',
    activeWhatsappSessions: whatsappBot.getActiveSessionCount()
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    db: require('./db').getStatus()
  });
});

// --- WhatsApp Bot Routes (Authenticated & Strictly Isolated per Shop) ---
app.use('/api/whatsapp', whatsappRoutes);

// ── Nightly WhatsApp Summary Scheduler (Runs every 30s) ──────────────────────
const lastSummarySent = {}; // Key: `${shopId}_${YYYY-MM-DD}`

async function checkAndSendScheduledSummaries() {
  const { currentHHMM, dateKey } = getIstTimeParts();

  try {
    const db = await pool.getDb();
    const shops = await db.collection('shops').find({}, { projection: { shopId: 1, name: 1, phone: 1, settings: 1 } }).toArray();

    for (const shop of shops) {
      let settings = {};
      try {
        settings = typeof shop.settings === 'string' ? JSON.parse(shop.settings) : (shop.settings || {});
      } catch {}

      const baileysConnected = whatsappBot.getStatus(shop.shopId).status === 'CONNECTED';
      const greenConfigured = whatsappBot.isValidGreenConfig(settings.greenApi, { requireEnabled: true });
      if (!baileysConnected && !greenConfigured) continue;

      const isEnabled = settings.whatsappSummaryEnabled !== false;
      const targetTime = settings.whatsappSummaryTime || '21:30';
      const recipientPhone = settings.whatsappSummaryPhone || shop.phone;
      const trackKey = `${shop.shopId}_${dateKey}`;

      if (isEnabled && recipientPhone && currentHHMM === targetTime && !lastSummarySent[trackKey]) {
        console.log(`[Auto-Summary] Triggering scheduled summary for ${shop.name} (${shop.shopId}) at ${currentHHMM}...`);
        lastSummarySent[trackKey] = true;
        try {
          await generateAndSendNightlySummary(shop.shopId, recipientPhone);
          console.log(`[Auto-Summary] Successfully sent scheduled summary to ${recipientPhone}`);
        } catch (err) {
          console.error(`[Auto-Summary] Failed to send for shop ${shop.shopId}:`, err.message);
          delete lastSummarySent[trackKey];
        }
      }
    }
  } catch {}
}

setInterval(checkAndSendScheduledSummaries, 30000);

app.use('/api/auth', authRateLimiter, authRoutes);
app.use('/api/superadmin', superAdminRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api', apiRoutes);

// Safe Global Error Handler for API
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err.stack || err.message);
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'An unexpected error occurred. Please try again later.' 
      : err.message
  });
});

// Serve frontend in production
app.use(express.static(path.join(__dirname, '../dist')));

// Catch-all route for React Router
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  const indexPath = path.join(__dirname, '../dist/index.html');
  const fs = require('fs');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send('MartGPT Backend API running on port ' + port);
  }
});

// ── Keep-Alive Self-Ping (prevents Render free tier sleep) ────────────────────
function startKeepAlive() {
  // Only run on Render (not locally)
  const renderUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (!renderUrl) {
    console.log('Keep-alive: Not on Render, skipping self-ping.');
    return;
  }

  const pingUrl = renderUrl.replace(/\/$/, '') + '/api/ping';
  console.log('Keep-alive: Will ping', pingUrl, 'every 10 minutes to prevent sleep.');

  // Ping every 10 minutes (600,000 ms)
  setInterval(() => {
    const mod = pingUrl.startsWith('https') ? https : http;
    const req = mod.get(pingUrl, (res) => {
      console.log('[Keep-alive] Pinged', pingUrl, '→ HTTP', res.statusCode);
    });
    req.on('error', (err) => {
      console.warn('[Keep-alive] Ping failed:', err.message);
    });
    req.end();
  }, 10 * 60 * 1000); // 10 minutes
}

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 MartGPT Server running on http://localhost:${port}`);

  // Auto-restore saved WhatsApp bot sessions for shops that have connected
  setTimeout(() => {
    try {
      console.log('Restoring saved WhatsApp sessions for connected shops...');
      if (typeof whatsappBot.restoreAllSavedSessions === 'function') {
        whatsappBot.restoreAllSavedSessions();
      }
    } catch (e) {
      console.error('Failed to auto-restore WhatsApp bot sessions:', e.message);
    }
  }, 2000);

  // Start keep-alive pinger (prevents Render from sleeping)
  setTimeout(() => startKeepAlive(), 5000);
});
