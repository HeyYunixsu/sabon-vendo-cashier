/**
 * Sabon Vendo — Cashier Dashboard Server (v2)
 *
 * - Serves the tap-based dashboard UI
 * - TCP proxy to controller with auto-reconnect
 * - SSE for live STATUS pushes to the browser
 * - Sale IDs + double-click guard
 * - Local ARM queue (retry on reconnect)
 * - Unclaimed sale tracking
 * - Prime / purge: run a pump briefly to clear air, recording no sale
 */

const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadEnv(filepath) {
  const vars = {};
  try {
    const lines = fs.readFileSync(filepath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      let key = trimmed.substring(0, eq).trim();
      let val = trimmed.substring(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) vars[key] = val;
    }
    return vars;
  } catch (e) {
    console.error(`[dashboard] Could not load config: ${e.message}`);
    return vars;
  }
}

const CONFIG_PATH = path.resolve(__dirname, '..', 'CONFIG', 'config.env');
const config = loadEnv(CONFIG_PATH);
const SOCKET_IP   = config.SOCKET_IP   || '127.0.0.1';
const SOCKET_PORT = parseInt(config.SOCKET_PORT || '8080', 10);
const HTTP_PORT   = parseInt(config.DASHBOARD_PORT || '80', 10);

// Prime events. The controller owns this file; the dashboard only reads it, so
// the count staff see is the controller's own record and not a tally the
// dashboard could quietly lose on restart. Kept out of the transaction
// directory on purpose -- the uploader sends everything in there as a sale.
const PRIME_LOG_PATH = config.PRIME_LOG
  ? path.resolve(__dirname, '..', config.PRIME_LOG)
  : path.resolve(__dirname, '..', 'logs', 'prime_events.jsonl');
const PRIME_SECONDS = parseFloat(config.PRIME_SECONDS || '3');

// What each slot actually holds. Different clients stock different products,
// so this cannot be assumed -- it used to be a hardcoded list in the browser,
// which meant every machine claimed to sell the same six things.
const PRODUCTS = {};
for (let i = 1; i <= 6; i++) {
  PRODUCTS[i] = {
    name: config[`PRODUCT${i}_NAME`] || `Product ${i}`,
    ml: parseInt(config[`PRODUCT${i}_ML`] || '0', 10) || 0,
  };
}

// Sales cut short by an empty tank: charged in full, delivered in part.
const INTERRUPTED_LOG_PATH = config.INTERRUPTED_LOG
  ? path.resolve(__dirname, '..', config.INTERRUPTED_LOG)
  : path.resolve(__dirname, '..', 'logs', 'interrupted_sales.jsonl');

// Credits paid for but never dispensed. Written by the controller.
const UNCLAIMED_LOG_PATH = config.UNCLAIMED_LOG
  ? path.resolve(__dirname, '..', config.UNCLAIMED_LOG)
  : path.resolve(__dirname, '..', 'logs', 'unclaimed_credits.jsonl');

// Which entries a cashier has already dealt with. The log itself is
// append-only and owned by the controller, so the dashboard keeps its own
// note of what has been settled rather than rewriting history.
const RESOLVED_FILE = path.resolve(__dirname, '.resolved_credits.json');
let resolvedKeys = new Set();
try {
  if (fs.existsSync(RESOLVED_FILE))
    resolvedKeys = new Set(JSON.parse(fs.readFileSync(RESOLVED_FILE, 'utf-8')));
} catch (e) {
  console.error(`[dashboard] Could not read resolved credits: ${e.message}`);
}

function saveResolved() {
  try {
    fs.writeFileSync(RESOLVED_FILE, JSON.stringify([...resolvedKeys]), 'utf-8');
  } catch (e) {
    console.error(`[dashboard] Could not save resolved credits: ${e.message}`);
  }
}

// Confirmed sales, archived by transaction_uploader.py before it deletes each
// record. Read-only here.
const SALES_ARCHIVE_DIR = config.SALES_ARCHIVE_DIR
  ? path.resolve(__dirname, '..', config.SALES_ARCHIVE_DIR)
  : path.resolve(__dirname, '..', 'logs', 'sales');

// Audit trail of price changes. Written by the controller; read-only here.
const PRICE_LOG_PATH = config.PRICE_LOG
  ? path.resolve(__dirname, '..', config.PRICE_LOG)
  : path.resolve(__dirname, '..', 'logs', 'price_changes.jsonl');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sseClients = new Set();
const processedSaleIds = new Set();      // double-click guard
const localArmQueue = [];                // queued ARM commands (offline retry)
let coinSocket = null;
// True only between 'connect' and 'close'. A socket that is still connecting
// is neither null nor destroyed, and write() on it silently buffers -- so
// checking the socket object alone reports a send that has not happened yet.
let coinConnected = false;
let statusBuffer = '';

// Prices, in pesos per press, as reported by the controller. It resolves
// defaults, config.env and the saved file in that order, so asking it is the
// only way to avoid re-implementing that precedence here and drifting from it.
let prices = {};

// ---------------------------------------------------------------------------
// TCP client to controller
// ---------------------------------------------------------------------------

function connectToCoinSlot() {
  if (coinSocket) { try { coinSocket.destroy(); } catch (_) {} }

  console.log(`[dashboard] Connecting to controller at ${SOCKET_IP}:${SOCKET_PORT}...`);
  coinSocket = new net.Socket();

  coinSocket.connect(SOCKET_PORT, SOCKET_IP, () => {
    console.log(`[dashboard] Connected to controller`);
    coinConnected = true;
    sendToCoinSlot('GETPRICES');
    // Flush any locally queued ARM commands
    flushLocalQueue();
  });

  coinSocket.on('data', (data) => {
    statusBuffer += data.toString();
    const lines = statusBuffer.split('\n');
    statusBuffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith('STATUS')) {
        broadcastSSE(line);
      } else if (line.startsWith('PRICES,')) {
        const p = line.trim().split(',');
        const next = {};
        for (let i = 1; i < p.length; i++) {
          const v = parseInt(p[i], 10);
          if (Number.isFinite(v)) next[i] = v;
        }
        prices = next;
        console.log(`[dashboard] prices: ${JSON.stringify(prices)}`);
        broadcastSSE('PRICES:' + JSON.stringify(prices));
      } else if (line.startsWith('PRICE_ACK')) {
        console.log(`[dashboard] ${line.trim()}`);
        broadcastSSE(line.trim());
        // Re-read rather than trusting the value we sent: the controller may
        // have refused it, or applied it without managing to save.
        sendToCoinSlot('GETPRICES');
      } else if (line.startsWith('PRIME_ACK')) {
        // Forwarded so the page can say why a prime was refused. Without it
        // staff cannot tell a refusal from a dropped packet and retry blindly.
        console.log(`[dashboard] ${line.trim()}`);
        broadcastSSE(line.trim());
      }
    }
    // Whatever is left is an incomplete line. Keep it for the next chunk --
    // broadcasting it here would emit a truncated STATUS and orphan the
    // continuation bytes, corrupting the following parse.
    if (statusBuffer.length > 64 * 1024) {
      console.error('[dashboard] controller sent 64KB with no newline — dropping buffer');
      statusBuffer = '';
    }
  });

  coinSocket.on('error', (err) => {
    console.error(`[dashboard] controller error: ${err.message}`);
  });

  coinSocket.on('close', () => {
    console.log('[dashboard] controller disconnected — reconnecting in 3s...');
    coinConnected = false;
    coinSocket = null;
    setTimeout(connectToCoinSlot, 3000);
  });
}

function sendToCoinSlot(command) {
  if (!coinSocket || coinSocket.destroyed) {
    console.log(`[dashboard] Offline — queuing command: ${command}`);
    localArmQueue.push(command);
    return false;
  }
  try {
    // The controller frames on newlines. Without the terminator a command sits
    // in its buffer forever, and two commands sent close together arrive as one.
    coinSocket.write(command.endsWith('\n') ? command : command + '\n');
    console.log(`[dashboard] Sent: ${command}`);
    return true;
  } catch (e) {
    console.error(`[dashboard] Send error: ${e.message}`);
    localArmQueue.push(command);
    return false;
  }
}

// Send without queuing. Used by PRIME: a queued prime would fire whenever the
// controller next reconnects, which could be hours later, running a pump with
// nobody at the machine. Better to refuse and let staff retry deliberately.
function sendNowOrFail(command) {
  // Requires a live connection, not merely a socket object. Writing to one
  // that is mid-connect buffers the command and delivers it on connect --
  // which is the delayed unattended prime this function exists to prevent.
  if (!coinConnected || !coinSocket || coinSocket.destroyed) return false;
  try {
    coinSocket.write(command.endsWith('\n') ? command : command + '\n');
    console.log(`[dashboard] Sent: ${command}`);
    return true;
  } catch (e) {
    console.error(`[dashboard] Send error: ${e.message}`);
    return false;
  }
}

function flushLocalQueue() {
  if (localArmQueue.length === 0) return;
  console.log(`[dashboard] Flushing ${localArmQueue.length} queued ARM commands...`);
  while (localArmQueue.length > 0) {
    const cmd = localArmQueue.shift();
    try { coinSocket.write(cmd.endsWith('\n') ? cmd : cmd + '\n'); console.log(`[dashboard] Flushed: ${cmd}`); }
    catch (e) { localArmQueue.unshift(cmd); break; }
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function broadcastSSE(data) {
  const payload = `data: ${data}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SSE endpoint
app.get('/api/status/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: connected\n\n');
  sseClients.add(res);
  console.log(`[dashboard] SSE client connected (${sseClients.size} total)`);

  // Keep-alive heartbeat every 15s so the browser doesn't time out
  const keepAlive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch (_) { clearInterval(keepAlive); }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    console.log(`[dashboard] SSE client disconnected (${sseClients.size} total)`);
  });
});

// ARM endpoint — supports batch mode (ARM_BATCH) for simultaneous arming
app.post('/api/arm', (req, res) => {
  const { saleId, items, batch } = req.body;

  if (!saleId) {
    return res.status(400).json({ error: 'Missing saleId' });
  }

  // Double-click guard
  if (processedSaleIds.has(saleId)) {
    console.log(`[dashboard] Duplicate sale ignored: ${saleId}`);
    return res.json({ success: false, duplicate: true });
  }
  processedSaleIds.add(saleId);
  if (processedSaleIds.size > 1000) {
    const it = processedSaleIds.values();
    for (let i = 0; i < 500; i++) processedSaleIds.delete(it.next().value);
  }

  // New batch mode: ARM_BATCH,1:3,2:1,3:5 (atomic, simultaneous)
  if (batch) {
    const command = `ARM_BATCH,${batch}`;
    const sent = sendToCoinSlot(command);
    return res.json({ success: sent, queued: !sent, saleId });
  }

  // Legacy mode: individual ARM per product
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items or batch provided' });
  }

  const results = [];
  for (const item of items) {
    const { productId, qty } = item;
    if (!productId || productId < 1 || productId > 6) {
      results.push({ productId, success: false, error: `Invalid product ID: ${productId}` });
      continue;
    }
    if (!qty || qty < 1) {
      results.push({ productId, success: false, error: `Invalid qty: ${qty}` });
      continue;
    }
    const command = `ARM,${productId},${qty}`;
    const sent = sendToCoinSlot(command);
    results.push({ productId, qty, success: sent, queued: !sent });
  }

  res.json({ saleId, results });
});

// Cancel single armed slot
app.post('/api/cancel', (req, res) => {
  const { productId } = req.body;
  const sent = sendToCoinSlot(`CANCEL,${productId}`);
  console.log(`[dashboard] CANCEL slot ${productId}: ${sent ? 'sent' : 'queued'}`);
  res.json({ success: sent });
});

// Cancel all armed slots + clear all queues
app.post('/api/cancel-all', (req, res) => {
  const sent = sendToCoinSlot('CANCEL_ALL');
  console.log(`[dashboard] CANCEL_ALL: ${sent ? 'sent' : 'queued'}`);
  res.json({ success: sent });
});

// Cancel queue for a specific slot
app.post('/api/cancel-queue', (req, res) => {
  const { productId } = req.body;
  const sent = sendToCoinSlot(`CANCEL_QUEUE,${productId}`);
  console.log(`[dashboard] CANCEL_QUEUE slot ${productId}: ${sent ? 'sent' : 'queued'}`);
  res.json({ success: sent });
});

// ---------------------------------------------------------------------------
// Prime / purge
//
// Replacing an empty gallon lets air into the hose, so the next press
// dispenses air and still charges the customer. Priming runs the pump for a
// short fixed burst to push that air through, recording no sale.
//
// Because it moves product without booking revenue, every prime is counted
// and shown back to staff. An untraceable prime would make "I was only
// priming" an excuse nobody could check.
// ---------------------------------------------------------------------------

// Today's primes, per slot, read from the controller's own log.
function readPrimeCounts() {
  const counts = {};
  let total = 0;
  try {
    if (!fs.existsSync(PRIME_LOG_PATH)) return { counts, total };

    // Local date, matching the controller's localtime timestamps.
    const now = new Date();
    const today = `${now.getFullYear()}-`
                + `${String(now.getMonth() + 1).padStart(2, '0')}-`
                + `${String(now.getDate()).padStart(2, '0')}`;

    for (const line of fs.readFileSync(PRIME_LOG_PATH, 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      // One malformed line must not hide the rest of the day's activity.
      try { rec = JSON.parse(line); } catch (_) { continue; }
      if (!rec.date_created || !String(rec.date_created).startsWith(today)) continue;
      const slot = parseInt(rec.slot, 10);
      if (!Number.isFinite(slot)) continue;
      counts[slot] = (counts[slot] || 0) + 1;
      total++;
    }
  } catch (e) {
    console.error(`[dashboard] Could not read prime log: ${e.message}`);
  }
  return { counts, total };
}

app.get('/api/prime', (req, res) => {
  const { counts, total } = readPrimeCounts();
  res.json({ seconds: PRIME_SECONDS, today: counts, todayTotal: total });
});

app.post('/api/prime', (req, res) => {
  const slot = parseInt(req.body && req.body.slot, 10);

  if (!Number.isFinite(slot) || slot < 1 || slot > 6) {
    return res.status(400).json({ success: false, reason: 'invalid_slot' });
  }

  // Never queued. A prime held until the controller reconnects would start a
  // pump with nobody standing at the machine.
  const sent = sendNowOrFail(`PRIME,${slot}`);
  if (!sent) {
    console.error(`[dashboard] PRIME slot ${slot} not sent — controller offline`);
    return res.status(503).json({ success: false, reason: 'controller_offline' });
  }

  console.log(`[dashboard] PRIME slot ${slot}: sent`);
  // The controller answers asynchronously with PRIME_ACK, forwarded over SSE.
  res.json({ success: true, slot, seconds: PRIME_SECONDS });
});

app.post('/api/unclaimed/resolve', (req, res) => {
  const { key, action } = req.body;
  if (!key) return res.status(400).json({ success: false, error: 'missing key' });

  // Only these two are handled below. Anything else -- a typo, a client bug,
  // or the field being omitted -- must not fall through to being marked
  // resolved: that would silently write off a credit nobody actually settled.
  if (action !== 'rearm' && action !== 'writeoff')
    return res.status(400).json({ success: false, error: 'bad action' });

  if (action === 'rearm') {
    const slot = parseInt(String(key).split('|')[0], 10);
    const qty = parseInt(req.body.qty, 10) || 1;
    // PRODUCTS is built from the PRODUCTn_* config keys, so a slot present
    // there is a slot this machine actually has. server.js has no slot-count
    // constant -- it hardcodes 6 in two loops -- and this avoids adding a third.
    if (!PRODUCTS[slot])
      return res.status(400).json({ success: false, error: 'bad slot' });
    // No money changes hands: the customer already paid, the credit expired
    // before they pressed. Fail loudly rather than marking it settled when
    // the controller never heard us.
    if (!sendNowOrFail(`ARM,${slot},${qty}`))
      return res.status(503).json({ success: false, error: 'controller unreachable' });
  }

  resolvedKeys.add(key);
  saveResolved();
  console.log(`[dashboard] Unclaimed settled: ${key} action=${action}`);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// QR code endpoint — encodes current LAN URL so cashier can scan with phone
const os = require('os');
function getLanUrl() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return `http://${iface.address}:${HTTP_PORT}`;
      }
    }
  }
  return `http://localhost:${HTTP_PORT}`;
}

// Machine identity for the Settings panel. The header used to show a
// hardcoded "Machine 001" on every unit, which is worse than showing nothing
// when someone is looking at one of several machines.
app.get('/api/info', (req, res) => {
  res.json({
    products: PRODUCTS,
    machineId: config.machineId || 'unknown',
    lanUrl: getLanUrl(),
    controllerHost: `${SOCKET_IP}:${SOCKET_PORT}`,
    controllerConnected: coinConnected,
    primeSeconds: PRIME_SECONDS,
  });
});

// ---------------------------------------------------------------------------
// Prices
//
// Set per client, so they are edited here rather than compiled in. The
// controller owns the value, audits every change and persists it; this is
// only the way in.
// ---------------------------------------------------------------------------

app.get('/api/prices', (req, res) => {
  res.json({ prices, connected: coinConnected });
});

app.post('/api/prices', (req, res) => {
  const body = (req.body && req.body.prices) || {};

  // Validate everything before sending anything. A partly-applied price list
  // would leave the machine charging a mix of old and new.
  const changes = [];
  for (const key of Object.keys(body)) {
    const slot = parseInt(key, 10);
    const price = parseInt(body[key], 10);
    if (!Number.isFinite(slot) || slot < 1 || slot > 6)
      return res.status(400).json({ success: false, reason: 'invalid_slot', slot: key });
    if (!Number.isFinite(price) || price < 0 || price > 10000)
      return res.status(400).json({ success: false, reason: 'invalid_price', slot });
    if (prices[slot] !== price) changes.push([slot, price]);
  }

  if (!coinConnected)
    return res.status(503).json({ success: false, reason: 'controller_offline' });

  if (!changes.length)
    return res.json({ success: true, changed: 0 });

  for (const [slot, price] of changes) sendToCoinSlot(`SETPRICE,${slot},${price}`);
  console.log(`[dashboard] SETPRICE x${changes.length}`);

  // The controller answers each one asynchronously with PRICE_ACK over SSE,
  // including a refusal if a sale is in progress.
  res.json({ success: true, changed: changes.length });
});

// Recent price changes, newest first, straight from the controller's audit log.
app.get('/api/prices/history', (req, res) => {
  const out = [];
  try {
    if (fs.existsSync(PRICE_LOG_PATH)) {
      for (const line of fs.readFileSync(PRICE_LOG_PATH, 'utf-8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (_) { /* skip one bad line */ }
      }
    }
  } catch (e) {
    console.error(`[dashboard] Could not read price log: ${e.message}`);
  }
  res.json({ changes: out.reverse().slice(0, 20) });
});

// ---------------------------------------------------------------------------
// Local sales report
//
// The machine keeps no memory of its own trading otherwise: every transaction
// file is deleted the moment the cloud accepts it. This reads the archive the
// uploader leaves behind, plus anything still queued, so a day is complete
// even if the link has been down since morning.
// ---------------------------------------------------------------------------

function localDateString(d) {
  return `${d.getFullYear()}-`
       + `${String(d.getMonth() + 1).padStart(2, '0')}-`
       + `${String(d.getDate()).padStart(2, '0')}`;
}

// Every sale recorded for `day` (YYYY-MM-DD), from the archive and the queue.
function readSalesForDay(day) {
  const sales = [];
  const seen = new Set();

  const take = (rec) => {
    const when = String(rec.date_created || '');
    if (!when.startsWith(day)) return;
    // A record can be in both places for the moment between upload and delete.
    const key = `${rec.slot}|${when}|${rec.amount}`;
    if (seen.has(key)) return;
    seen.add(key);
    sales.push({ slot: parseInt(rec.slot, 10), amount: Number(rec.amount) || 0, at: when });
  };

  try {
    const file = path.join(SALES_ARCHIVE_DIR, `sales-${day.slice(0, 7)}.jsonl`);
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        // One damaged line must not hide the rest of the day's trading.
        try { take(JSON.parse(line)); } catch (_) { /* skip */ }
      }
    }
  } catch (e) {
    console.error(`[dashboard] Could not read sales archive: ${e.message}`);
  }

  // Not yet uploaded, so not yet archived -- but sold all the same.
  try {
    const dir = config.TRANSACTION_DIR;
    if (dir && fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          take(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')));
        } catch (_) { /* skip */ }
      }
    }
  } catch (e) {
    console.error(`[dashboard] Could not read transaction queue: ${e.message}`);
  }

  return sales;
}

app.get('/api/sales/today', (req, res) => {
  const day = typeof req.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
    ? req.query.day
    : localDateString(new Date());

  const sales = readSalesForDay(day);

  const bySlot = {};
  for (let i = 1; i <= 6; i++) {
    bySlot[i] = { slot: i, name: PRODUCTS[i].name, presses: 0, pesos: 0, price: prices[i] };
  }
  let presses = 0, pesos = 0;
  for (const sale of sales) {
    if (!bySlot[sale.slot]) continue;
    bySlot[sale.slot].presses += 1;
    // The amount recorded at the time of sale, not today's price. A price
    // change must not rewrite what yesterday was worth.
    bySlot[sale.slot].pesos += sale.amount;
    presses += 1;
    pesos += sale.amount;
  }

  const last = sales.reduce((a, b) => (!a || b.at > a.at ? b : a), null);
  res.json({
    day,
    presses,
    pesos,
    products: Object.values(bySlot),
    lastSaleAt: last ? last.at : null,
    archiveExists: fs.existsSync(SALES_ARCHIVE_DIR),
  });
});

// Today's interrupted sales. The customer paid in full and got a partial
// pour, so someone has to settle it with them -- this is the only place that
// event surfaces to a person.
app.get('/api/interrupted', (req, res) => {
  const entries = [];
  const today = localDateString(new Date());
  try {
    if (fs.existsSync(INTERRUPTED_LOG_PATH)) {
      for (const line of fs.readFileSync(INTERRUPTED_LOG_PATH, 'utf-8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (_) { continue; }
        if (!String(rec.date_created || '').startsWith(today)) continue;
        const slot = parseInt(rec.slot, 10);
        entries.push({
          slot,
          name: (PRODUCTS[slot] && PRODUCTS[slot].name) || ('Slot ' + rec.slot),
          amount: Number(rec.amount) || 0,
          reason: rec.reason || 'unknown',
          date_created: rec.date_created,
        });
      }
    }
  } catch (e) {
    console.error(`[dashboard] Could not read interrupted log: ${e.message}`);
  }
  res.json({ entries: entries.reverse() });
});

app.get('/api/unclaimed', (req, res) => {
  const entries = [];
  const today = localDateString(new Date());
  try {
    if (fs.existsSync(UNCLAIMED_LOG_PATH)) {
      for (const line of fs.readFileSync(UNCLAIMED_LOG_PATH, 'utf-8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (_) { continue; }
        if (!String(rec.date_created || '').startsWith(today)) continue;
        // Cancels are recorded for review but do not raise a row -- see the
        // design note in the plan. A panel full of routine cancels teaches
        // staff to dismiss it without reading.
        if (rec.reason !== 'timeout') continue;

        const key = rec.slot + '|' + rec.date_created;
        if (resolvedKeys.has(key)) continue;

        const slot = parseInt(rec.slot, 10);
        entries.push({
          key,
          slot,
          name: (PRODUCTS[slot] && PRODUCTS[slot].name) || ('Slot ' + rec.slot),
          qty: Number(rec.qty) || 0,
          amount: Number(rec.amount) || 0,
          date_created: rec.date_created,
        });
      }
    }
  } catch (e) {
    console.error(`[dashboard] Could not read unclaimed log: ${e.message}`);
  }
  res.json({ entries: entries.reverse() });
});

app.get('/qr', (req, res) => {
  const url = getLanUrl();
  const qrApi = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
  res.redirect(qrApi);
});

app.listen(HTTP_PORT, () => {
  const lanUrl = getLanUrl();
  console.log(`[dashboard] Cashier Dashboard running on ${lanUrl}`);
  console.log(`[dashboard] QR code: ${lanUrl}/qr`);
  console.log(`[dashboard] Config: controller at ${SOCKET_IP}:${SOCKET_PORT}`);
  connectToCoinSlot();
});
