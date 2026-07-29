/**
 * Sabon Vendo — Cashier Dashboard Server
 *
 * Serves the single-page dashboard and acts as a TCP proxy to the coin_slot
 * socket server.  The dashboard UI connects via SSE for live status pushes,
 * and POSTs ARM commands that this server forwards over TCP.
 *
 * Configuration is read from ../CONFIG/config.env (shared with coin_slot).
 */

const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config loader (minimal .env parser, same format as coin_slot)
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
    console.error(`[dashboard] Could not load config from ${filepath}: ${e.message}`);
    return vars;
  }
}

const CONFIG_PATH = path.resolve(__dirname, '..', 'CONFIG', 'config.env');
const config = loadEnv(CONFIG_PATH);

const SOCKET_IP   = config.SOCKET_IP   || '127.0.0.1';
const SOCKET_PORT = parseInt(config.SOCKET_PORT || '8080', 10);
const HTTP_PORT   = parseInt(config.DASHBOARD_PORT || '3000', 10);

// ---------------------------------------------------------------------------
// TCP client to coin_slot
// ---------------------------------------------------------------------------

let coinSocket = null;
let statusBuffer = '';
const sseClients = new Set();  // active SSE response objects

function connectToCoinSlot() {
  if (coinSocket) {
    try { coinSocket.destroy(); } catch (_) { /* ignore */ }
  }

  console.log(`[dashboard] Connecting to coin_slot at ${SOCKET_IP}:${SOCKET_PORT}...`);
  coinSocket = new net.Socket();

  coinSocket.connect(SOCKET_PORT, SOCKET_IP, () => {
    console.log(`[dashboard] Connected to coin_slot`);
  });

  coinSocket.on('data', (data) => {
    statusBuffer += data.toString();
    // Split on newlines (coin_slot doesn't append newlines, but STATUS
    // messages are self-contained)
    const lines = statusBuffer.split('\n');
    statusBuffer = lines.pop();  // keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith('STATUS')) {
        broadcastSSE(line);
      }
    }

    // If buffer ends with a complete STATUS (no newline delimiter),
    // broadcast it anyway after a short debounce
    if (statusBuffer.startsWith('STATUS')) {
      broadcastSSE(statusBuffer);
      statusBuffer = '';
    }
  });

  coinSocket.on('error', (err) => {
    console.error(`[dashboard] coin_slot connection error: ${err.message}`);
  });

  coinSocket.on('close', () => {
    console.log('[dashboard] coin_slot connection closed — reconnecting in 5s...');
    coinSocket = null;
    setTimeout(connectToCoinSlot, 5000);
  });
}

function sendToCoinSlot(command) {
  if (!coinSocket || coinSocket.destroyed) {
    console.error('[dashboard] Cannot send — not connected to coin_slot');
    return false;
  }
  try {
    coinSocket.write(command);
    console.log(`[dashboard] Sent: ${command}`);
    return true;
  } catch (e) {
    console.error(`[dashboard] Send error: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// SSE (Server-Sent Events) for live dashboard updates
// ---------------------------------------------------------------------------

function broadcastSSE(data) {
  const payload = `data: ${data}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { /* client disconnected */ }
  }
}

// ---------------------------------------------------------------------------
// Express server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SSE endpoint — dashboard connects here for live STATUS pushes
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

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[dashboard] SSE client disconnected (${sseClients.size} total)`);
  });
});

// ARM endpoint — cashier sends product selections here
app.post('/api/arm', (req, res) => {
  const { items } = req.body;  // items: [{productId, qty}, ...]

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided' });
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
    results.push({ productId, qty, success: sent });
  }

  res.json({ results });
});

// Cancel endpoint — not yet implemented in coin_slot, but UI ready
app.post('/api/cancel', (req, res) => {
  const { productId } = req.body;
  // Future: send CANCEL,<productId> to coin_slot
  console.log(`[dashboard] Cancel requested for product ${productId} (not yet implemented)`);
  res.json({ success: false, error: 'Cancel not yet implemented in coin_slot' });
});

// Start
app.listen(HTTP_PORT, () => {
  console.log(`[dashboard] Cashier Dashboard running on http://localhost:${HTTP_PORT}`);
  console.log(`[dashboard] Config: coin_slot at ${SOCKET_IP}:${SOCKET_PORT}`);
  connectToCoinSlot();
});
