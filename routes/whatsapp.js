const express = require('express');
const router = express.Router();
const pool = require('../db');
const whatsappBot = require('../whatsapp');
const { requireAuth } = require('../middleware/auth');

function parseSettingsSafe(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/**
 * Returns deterministic India Standard Time (+05:30) strings & today UTC boundaries.
 */
function getIstTimeParts(now = new Date()) {
  const utcMs = now.getTime() + 5.5 * 3600000;
  const ist = new Date(utcMs);
  const year = ist.getUTCFullYear();
  const month = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  const hour = String(ist.getUTCHours()).padStart(2, '0');
  const minute = String(ist.getUTCMinutes()).padStart(2, '0');
  const dateKey = `${year}-${month}-${day}`;
  const currentHHMM = `${hour}:${minute}`;

  // Midnight 00:00:00.000 IST -> UTC ISO
  const startUtcMs = Date.UTC(year, ist.getUTCMonth(), ist.getUTCDate(), 0, 0, 0, 0) - 5.5 * 3600000;
  const endUtcMs = startUtcMs + 24 * 3600000 - 1;

  return {
    dateKey,
    currentHHMM,
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(endUtcMs).toISOString()
  };
}

/**
 * Loads strictly the authenticated shop's WhatsApp configuration from MongoDB.
 */
async function loadShopWhatsappContext(shopId) {
  const db = await pool.getDb();
  const shop = await db.collection('shops').findOne({ shopId }, { projection: { _id: 0 } });
  const settings = parseSettingsSafe(shop?.settings);
  const greenConfig = settings?.greenApi || null;
  const provider = settings?.whatsappProvider || (whatsappBot.isValidGreenConfig(greenConfig, { requireEnabled: false }) ? 'green_api' : 'baileys');
  return { db, shop, settings, greenConfig, provider };
}

/**
 * Resolves effective Green API config (only active when explicitly enabled) + shop info.
 */
async function resolveShopDispatchContext(shopId) {
  const ctx = await loadShopWhatsappContext(shopId);
  const greenActive = whatsappBot.isValidGreenConfig(ctx.greenConfig, { requireEnabled: true });
  return {
    ...ctx,
    activeGreenConfig: greenActive ? ctx.greenConfig : null
  };
}

/**
 * Generates and dispatches the daily business summary strictly using that shop's own data & WhatsApp channel.
 */
async function generateAndSendNightlySummary(shopId, targetPhone) {
  const { db, shop, activeGreenConfig } = await resolveShopDispatchContext(shopId);
  const resolvedShop = shop || { shopId, name: 'MartGPT Store', phone: targetPhone };

  const recipientPhone = targetPhone || resolvedShop.phone;
  if (!recipientPhone) {
    throw new Error('Shop phone number is required to send nightly summary.');
  }

  const { startIso, endIso, dateKey } = getIstTimeParts();
  const resolvedShopId = resolvedShop.shopId || shopId;

  let transactions = [];
  let expenses = [];
  let lowStock = [];

  try {
    transactions = await db.collection('transactions')
      .find({ shopId: resolvedShopId, isDeleted: { $ne: 1 }, createdAt: { $gte: startIso, $lte: endIso } })
      .toArray();
  } catch {}

  try {
    expenses = await db.collection('expenses')
      .find({ shopId: resolvedShopId, date: { $gte: dateKey, $lte: dateKey } })
      .toArray();
  } catch {}

  try {
    const prods = await db.collection('products')
      .find({ shopId: resolvedShopId, isDeleted: { $ne: 1 } })
      .toArray();
    lowStock = prods.filter((p) => Number(p.stock || 0) <= Number(p.minStock || 0)).slice(0, 5);
  } catch {}

  let grossSales = 0;
  let cashSales = 0;
  let upiSales = 0;
  let udharSales = 0;
  const itemCounts = {};

  transactions.forEach((t) => {
    const amt = Number(t.totalAmount) || 0;
    grossSales += amt;
    const method = (t.paymentMethod || '').toLowerCase();
    if (method === 'cash') cashSales += amt;
    else if (method === 'upi') upiSales += amt;
    else if (method === 'udhar') udharSales += amt;
    else if (method === 'split') {
      const sc = Number(t.splitAmounts?.cash || 0);
      const su = Number(t.splitAmounts?.upi || 0);
      const sud = Number(t.splitAmounts?.udhar || 0);
      if (t.splitAmounts && (sc > 0 || su > 0 || sud > 0)) {
        cashSales += sc;
        upiSales += su;
        udharSales += sud;
      } else {
        cashSales += amt / 2;
        upiSales += amt / 2;
      }
    } else {
      cashSales += amt;
    }

    let items = [];
    try {
      items = typeof t.items === 'string' ? JSON.parse(t.items) : (t.items || []);
    } catch {}
    items.forEach((it) => {
      if (it.name) {
        itemCounts[it.name] = (itemCounts[it.name] || 0) + (it.qty || 1);
      }
    });
  });

  let totalExpenses = 0;
  expenses.forEach((e) => { totalExpenses += Number(e.amount) || 0; });

  const cashInHand = Math.max(0, cashSales - totalExpenses);
  const topItems = Object.entries(itemCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, qty]) => `• ${name}: ${qty} sold`)
    .join('\n');

  const lowStockAlert = lowStock.length > 0
    ? lowStock.map((p) => `• ⚠️ ${p.name}: ${p.stock} ${p.unit || ''} left`).join('\n')
    : '• All inventory healthy ✅';

  const dateFormatted = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });

  const summaryMessage =
`🌙 *DAILY BUSINESS SUMMARY REPORT* 🌙
🏪 *${resolvedShop.name || 'MartGPT Store'}*
📅 ${dateFormatted}
━━━━━━━━━━━━━━━━━━━

💰 *Gross Sales:* ₹${grossSales.toFixed(2)}
🧾 *Total Invoices:* ${transactions.length}

💳 *COLLECTIONS BREAKDOWN:*
💵 Cash Collected: ₹${cashSales.toFixed(2)}
📱 UPI Received: ₹${upiSales.toFixed(2)}
📝 Udhar Given: ₹${udharSales.toFixed(2)}

💸 *EXPENSES & CASH FLOW:*
📤 Today's Expenses: ₹${totalExpenses.toFixed(2)}
💼 Net Cash in Drawer: ₹${cashInHand.toFixed(2)}

⭐ *TOP SELLING PRODUCTS:*
${topItems || '• No items logged today'}

📦 *STOCK ALERTS:*
${lowStockAlert}

━━━━━━━━━━━━━━━━━━━
✨ *Generated automatically by MartGPT POS*`;

  await whatsappBot.sendMessage(recipientPhone, summaryMessage, resolvedShopId, 3, activeGreenConfig);
  return { success: true, message: 'Nightly summary sent to ' + recipientPhone, preview: summaryMessage };
}

// ─── Authenticated Multi-Tenant WhatsApp Routes ──────────────────────────────
router.use(requireAuth);

router.get('/status', async (req, res) => {
  const shopId = req.user.shopId;
  const isServerless = Boolean(process.env.VERCEL);

  try {
    const { greenConfig, provider } = await loadShopWhatsappContext(shopId);
    const baileysStatus = isServerless
      ? { shopId, status: 'DISCONNECTED', qr: null, info: null, error: null, hasSavedSession: false }
      : whatsappBot.getStatus(shopId);

    const hasGreenCreds = whatsappBot.isValidGreenConfig(greenConfig, { requireEnabled: false });
    if (hasGreenCreds) {
      const greenSt = await whatsappBot.checkGreenApiStatus(greenConfig);
      if (greenSt.isAuthorized) {
        if (greenConfig.enabled === true) {
          return res.json({
            shopId,
            status: 'CONNECTED',
            provider: 'green_api',
            autoSendEnabled: true,
            info: greenSt.info || { phone: '', pushname: 'Green API' },
            error: null
          });
        }
        return res.json({
          shopId,
          status: 'DISABLED',
          provider: 'green_api',
          autoSendEnabled: false,
          info: greenSt.info || { phone: '', pushname: 'Green API' },
          error: 'Green API is linked, but automatic checkout billing is turned OFF in Settings -> WhatsApp.'
        });
      }
      if (provider === 'green_api' && baileysStatus.status !== 'CONNECTED') {
        return res.json({
          shopId,
          status: greenSt.state === 'notAuthorized' ? 'NEEDS_QR' : 'DISCONNECTED',
          provider: 'green_api',
          autoSendEnabled: Boolean(greenConfig.enabled),
          error: greenSt.message
        });
      }
    }

    return res.json({
      ...baileysStatus,
      provider: baileysStatus.status === 'CONNECTED' ? 'baileys' : provider,
      autoSendEnabled: baileysStatus.status === 'CONNECTED'
    });
  } catch (err) {
    return res.json(whatsappBot.getStatus(shopId));
  }
});

router.post('/start', (req, res) => {
  if (process.env.VERCEL) {
    return res.status(400).json({
      error: 'Baileys local bot cannot run on serverless Vercel hosting. Please configure Green API (Cloud) in Settings -> WhatsApp.'
    });
  }
  const shopId = req.user.shopId;
  whatsappBot.initializeWhatsApp(shopId);
  res.json({ success: true, message: `WhatsApp initialization started for shop ${shopId}` });
});

router.post('/logout', async (req, res) => {
  const shopId = req.user.shopId;
  await whatsappBot.logout(shopId);
  res.json({ success: true, message: `WhatsApp logged out for shop ${shopId}` });
});

router.post('/send', async (req, res) => {
  const shopId = req.user.shopId;
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'Phone and message are required' });
  }
  try {
    const { activeGreenConfig } = await resolveShopDispatchContext(shopId);
    await whatsappBot.sendMessage(phone, message, shopId, 3, activeGreenConfig);
    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    console.error(`WhatsApp send error for shop ${shopId}:`, error.message);
    res.status(500).json({ error: error.message || 'Failed to send message' });
  }
});

router.post('/send-bill', async (req, res) => {
  const shopId = req.user.shopId;
  const { phone, message, billNo } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'Phone and message are required' });
  }
  try {
    const { activeGreenConfig } = await resolveShopDispatchContext(shopId);
    await whatsappBot.sendMessage(phone, message, shopId, 3, activeGreenConfig);
    res.json({ success: true, message: `WhatsApp bill #${billNo || ''} sent to +91 ${phone}` });
  } catch (error) {
    console.error(`WhatsApp send-bill error for shop ${shopId}:`, error.message);
    res.status(500).json({ error: error.message || 'Failed to send WhatsApp bill' });
  }
});

router.post('/bulk-reminder', async (req, res) => {
  const shopId = req.user.shopId;
  const { customers, shopName } = req.body;
  if (!customers || !Array.isArray(customers) || customers.length === 0) {
    return res.status(400).json({ error: 'Customers array is required' });
  }

  try {
    const { shop, activeGreenConfig } = await resolveShopDispatchContext(shopId);
    const baileysReady = !process.env.VERCEL && whatsappBot.getStatus(shopId).status === 'CONNECTED';
    const greenReady = activeGreenConfig ? (await whatsappBot.checkGreenApiStatus(activeGreenConfig)).isAuthorized : false;

    if (!baileysReady && !greenReady) {
      return res.status(400).json({
        error: 'Store WhatsApp is not connected or auto-sending is turned OFF. Please connect & enable WhatsApp in Settings.',
        notConnected: true
      });
    }

    const results = {
      total: customers.length,
      sent: 0,
      failed: 0,
      details: []
    };

    const currentShopName = shopName || shop?.name || 'Our Store';

    for (const c of customers) {
      const rawBalance = Number(c.balance || c.udhar || 0);
      if (!c.phone || rawBalance <= 0) {
        results.failed++;
        results.details.push({ name: c.name, phone: c.phone, status: 'skipped', reason: 'No phone or zero balance' });
        continue;
      }

      const message = `🙏 *Hello ${c.name},*\n\nThis is a gentle reminder from *${currentShopName}*:\nYour outstanding balance is: *₹${rawBalance.toFixed(2)}*.\n\nPlease clear the balance at your earliest convenience. Feel free to contact us for any queries.\n\nThank you! 💐`;

      try {
        await whatsappBot.sendMessage(c.phone, message, shopId, 3, activeGreenConfig);
        results.sent++;
        results.details.push({ name: c.name, phone: c.phone, status: 'sent' });
        await new Promise((r) => setTimeout(r, 700));
      } catch (err) {
        console.error(`WhatsApp bulk reminder error for shop ${shopId} ${c.name} (${c.phone}):`, err.message);
        results.failed++;
        results.details.push({ name: c.name, phone: c.phone, status: 'failed', error: err.message });
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to dispatch bulk reminders' });
  }
});

router.post('/nightly-summary', async (req, res) => {
  const shopId = req.user.shopId;
  const { targetPhone } = req.body;
  try {
    const result = await generateAndSendNightlySummary(shopId, targetPhone);
    res.json(result);
  } catch (error) {
    console.error('Nightly summary error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = {
  router,
  generateAndSendNightlySummary,
  getIstTimeParts
};
