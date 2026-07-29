/**
 * Sabon Vendo — Cashier Dashboard (Design-Plan Tokens)
 * Black & Blue · 6-product · tap-to-sell · bundle tracking
 */

const PRODUCT_NAMES = {
  1: 'Deesh Premium', 2: 'Lanz Blossom', 3: 'Lanz Dainty',
  4: 'Switch', 5: 'Slot 5', 6: 'Slot 6',
};

const AMOUNT_TO_QTY = { 5: 1, 10: 2, 15: 3, 20: 4 };
const ACTIVE_SLOTS = 4;
const TOTAL_SLOTS  = 6;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let machineState = {
  armedQty:     new Array(7).fill(0),
  remaining:    new Array(5).fill(0),
  wlvl:         new Array(5).fill(false),
  busy:         new Array(7).fill(false),
  queueDepth:   new Array(7).fill(0),
  paused:       false,
  lastUpdate:   null,
  connected:    false,
};

let selectedProduct = null;
let stagedItems = [];
let unclaimedItems = [];
let saleIdCounter = 0;

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function connectSSE() {
  const es = new EventSource('/api/status/stream');
  es.addEventListener('message', (e) => {
    if (e.data === 'connected') { machineState.connected = true; updateAll(); return; }
    if (e.data.startsWith('UNCLAIMED:')) { parseUnclaimed(e.data); return; }
    parseStatus(e.data);
  });
  es.addEventListener('error', () => { machineState.connected = false; updateAll(); });
}

function parseStatus(raw) {
  const parts = raw.split(',');
  if (parts.length < 18) return;
  let idx = 1;
  for (let i = 1; i <= 4; i++) machineState.armedQty[i]   = parseInt(parts[idx++]) || 0;
  for (let i = 1; i <= 4; i++) machineState.remaining[i]  = parseInt(parts[idx++]) || 0;
  for (let i = 1; i <= 4; i++) machineState.wlvl[i]       = parts[idx++] === '1';
  for (let i = 1; i <= 4; i++) machineState.busy[i]       = parts[idx++] === '1';
  for (let i = 1; i <= 4; i++) machineState.queueDepth[i] = parseInt(parts[idx++]) || 0;
  machineState.paused = parts[idx] === '1';
  machineState.lastUpdate = new Date();
  updateAll();
}

function parseUnclaimed(raw) {
  const parts = raw.substring(10).split(',');
  if (parts.length >= 3) {
    unclaimedItems.push({ slot: parseInt(parts[0]), qty: parseInt(parts[1]), amount: parseFloat(parts[2]), time: parts[3] || '' });
    renderUnclaimed();
  }
}

// ---------------------------------------------------------------------------
// Bundle status
// ---------------------------------------------------------------------------

function bundleReadyCount() {
  let count = 0;
  for (let i = 1; i <= ACTIVE_SLOTS; i++) {
    if (!machineState.wlvl[i]) count++;
  }
  return count;
}

function renderBundleBar() {
  const container = document.getElementById('bundle-bar');
  if (!container) return;
  const ready = bundleReadyCount();
  const total = ACTIVE_SLOTS;
  let segs = '';
  for (let i = 1; i <= total; i++) {
    segs += `<div class="seg ${machineState.wlvl[i] ? 'missing' : 'filled'}"></div>`;
  }
  const allGood = ready === total;
  container.innerHTML = `
    <span style="font-weight:600;">Bundle</span>
    <div class="segments">${segs}</div>
    <span style="color:${allGood ? 'var(--green)' : 'var(--yellow)'};">${ready}/${total} ready</span>`;
}

// ---------------------------------------------------------------------------
// Render — all
// ---------------------------------------------------------------------------

function updateAll() {
  updateStatusBar();
  updateGreeting();
  renderBundleBar();
  renderProductGrid();
  renderArmedSlots();
  renderQueue();
  renderAlerts();
  renderUnclaimed();
}

function updateStatusBar() {
  const el = document.getElementById('machine-status');
  const pauseEl = document.getElementById('pause-indicator');
  const updateEl = document.getElementById('last-update');

  if (machineState.connected) {
    el.innerHTML = '<span class="dot dot-green"></span> Machine Online';
  } else {
    el.innerHTML = '<span class="dot dot-red"></span> Machine Offline';
  }
  pauseEl.classList.toggle('hidden', !machineState.paused);
  if (machineState.lastUpdate) {
    updateEl.textContent = 'Last update: ' + machineState.lastUpdate.toLocaleTimeString('en-US', { hour12: false });
  }
}

function updateGreeting() {
  const el = document.getElementById('greeting');
  if (!el) return;
  const lowStock = [];
  for (let i = 1; i <= ACTIVE_SLOTS; i++) {
    if (machineState.wlvl[i]) lowStock.push(i);
  }
  if (lowStock.length > 0) {
    el.innerHTML = `<h1>Product Dashboard</h1><p><span style="color:var(--yellow);font-weight:600;">${lowStock.length} low-stock alert${lowStock.length>1?'s':''}</span> — Slot${lowStock.length>1?'s':''} ${lowStock.join(', ')} need${lowStock.length===1?'s':''} refill</p>`;
  } else {
    el.innerHTML = `<h1>Product Dashboard</h1><p style="color:var(--green);">All slots in stock</p>`;
  }
}

// ---------------------------------------------------------------------------
// Render — Product Grid
// ---------------------------------------------------------------------------

function renderProductGrid() {
  const container = document.getElementById('grid-container');
  let html = '';
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    const active = i <= ACTIVE_SLOTS;
    const armed  = machineState.armedQty[i] || 0;
    const busy   = machineState.busy[i];
    const empty  = machineState.wlvl[i];
    const sel    = (selectedProduct === i);

    let cls = 'product-card';
    if (!active) cls += ' not-available';
    else if (busy) cls += ' busy';
    else if (empty) cls += ' empty';
    else if (armed > 0) cls += ' armed';
    if (sel) cls += ' selected';

    let statusHTML, statusColor;
    if (!active)      { statusHTML = '<span class="dot dot-gray"></span> N/A';        statusColor = 'var(--text-muted)'; }
    else if (busy)    { statusHTML = '<span class="dot dot-yellow"></span> Dispensing'; statusColor = 'var(--yellow)'; }
    else if (armed)   { statusHTML = '<span class="dot dot-blue"></span> Armed';       statusColor = 'var(--blue)'; }
    else if (empty)   { statusHTML = '<span class="dot dot-red"></span> Empty';        statusColor = 'var(--red)'; }
    else              { statusHTML = '<span class="dot dot-gray"></span> Idle';         statusColor = 'var(--text-muted)'; }

    html += `<div class="${cls}" data-slot="${i}">`;
    html += `<div class="slot-num">Slot ${String(i).padStart(2,'0')}</div>`;
    html += `<div class="product-name">${PRODUCT_NAMES[i]}</div>`;
    html += `<div class="armed-qty${!active || armed === 0 ? ' zero' : ''}${armed > 0 ? ' armed-num' : ''}">${active ? armed : '—'}</div>`;
    html += `<div class="status-row" style="color:${statusColor}">${statusHTML}`;
    if (machineState.queueDepth[i] > 0) {
      html += `<span style="color:var(--yellow);"><span class="dot dot-yellow"></span> Q:${machineState.queueDepth[i]}</span>`;
    }
    html += `</div></div>`;
  }
  container.innerHTML = html;
  container.querySelectorAll('.product-card').forEach(card => {
    card.addEventListener('click', () => {
      const slot = parseInt(card.dataset.slot);
      if (slot <= ACTIVE_SLOTS && !machineState.wlvl[slot]) selectProduct(slot);
    });
  });
}

function renderArmedSlots() {
  const container = document.getElementById('armed-list');
  let html = '';
  let has = false;
  for (let i = 1; i <= 4; i++) {
    if (machineState.armedQty[i] > 0 || machineState.busy[i]) {
      has = true;
      const dot = machineState.busy[i]
        ? '<span class="dot dot-yellow"></span>'
        : '<span class="dot dot-blue"></span>';
      html += `<div class="list-row">`;
      html += `<span>${dot} <strong>${PRODUCT_NAMES[i]}</strong></span>`;
      html += `<span class="list-val">${machineState.armedQty[i]}</span>`;
      html += `<button class="btn btn-red" data-slot="${i}">Cancel</button>`;
      html += `</div>`;
    }
  }
  if (!has) html = '<span class="muted">—</span>';
  container.innerHTML = html;
  container.querySelectorAll('.btn-red').forEach(btn => {
    btn.addEventListener('click', () => cancelSlot(parseInt(btn.dataset.slot)));
  });
}

function renderQueue() {
  const container = document.getElementById('queue-list');
  let html = '';
  let has = false;
  for (let i = 1; i <= 4; i++) {
    if (machineState.queueDepth[i] > 0) {
      has = true;
      html += `<div class="list-row">`;
      html += `<span><strong>${PRODUCT_NAMES[i]}</strong></span>`;
      html += `<span class="list-val">${machineState.queueDepth[i]} pending</span>`;
      html += `</div>`;
    }
  }
  if (!has) html = '<span class="muted">—</span>';
  container.innerHTML = html;
}

function renderAlerts() {
  const container = document.getElementById('alert-list');
  let html = '';
  for (let i = 1; i <= 4; i++) {
    if (machineState.wlvl[i]) {
      html += `<div class="list-row" style="color:var(--red);">`;
      html += `<span><span class="dot dot-red"></span> Slot ${String(i).padStart(2,'0')}: ${PRODUCT_NAMES[i]}</span>`;
      html += `<span class="status-bracket error">[EMPTY]</span>`;
      html += `</div>`;
    }
  }
  if (!machineState.connected) {
    html += `<div class="list-row" style="color:var(--red);">`;
    html += `<span><span class="dot dot-red"></span> Machine offline</span>`;
    html += `<span class="status-bracket error">[DISCONNECTED]</span>`;
    html += `</div>`;
  }

  // Dark alert card for critical issues
  if (html) {
    container.innerHTML = `<div class="alert-card" style="margin-bottom:12px;"><div class="alert-title">⚠ Issues Detected</div>${html.replace(/<div class="list-row"/g, '<div class="list-row"').replace(/<\/div>\s*$/,'')}</div>`;
  } else {
    container.innerHTML = '<span class="muted">—</span>';
  }
}

function renderUnclaimed() {
  const container = document.getElementById('unclaimed-list');
  if (unclaimedItems.length === 0) { container.innerHTML = '<span class="muted">—</span>'; return; }
  let html = '';
  unclaimedItems.forEach((item, idx) => {
    html += `<div class="list-row" style="color:var(--yellow);">`;
    html += `<span><span class="dot dot-yellow"></span> Slot ${String(item.slot).padStart(2,'0')}: ${item.qty}u — ₱${item.amount}</span>`;
    html += `<span class="unclaimed-actions">`;
    html += `<button class="btn-sm retry" data-resolve="${idx}" data-action="retry">Retry</button>`;
    html += `<button class="btn-sm dismiss" data-resolve="${idx}" data-action="dismiss">Dismiss</button>`;
    html += `</span></div>`;
  });
  container.innerHTML = html;
  container.querySelectorAll('[data-resolve]').forEach(btn => {
    btn.addEventListener('click', () => resolveUnclaimed(parseInt(btn.dataset.resolve), btn.dataset.action));
  });
}

// ---------------------------------------------------------------------------
// Sale Entry
// ---------------------------------------------------------------------------

function selectProduct(productId) {
  if (productId < 1 || productId > ACTIVE_SLOTS) return;
  if (machineState.wlvl[productId]) return;
  selectedProduct = productId;
  renderProductGrid();
  document.querySelectorAll('.btn-amount').forEach(b => b.disabled = false);
}

function stageItem(productId, amount) {
  const qty = AMOUNT_TO_QTY[amount] || 1;
  stagedItems.push({ productId, productName: PRODUCT_NAMES[productId], amount, qty });
  selectedProduct = null;
  renderStagedItems();
  renderProductGrid();
  updateArmButton();
  document.querySelectorAll('.btn-amount').forEach(b => b.disabled = true);
}

function removeStagedItem(index) {
  stagedItems.splice(index, 1);
  renderStagedItems();
  updateArmButton();
}

function renderStagedItems() {
  const container = document.getElementById('staged-items');
  if (stagedItems.length === 0) {
    container.innerHTML = '<span class="muted">[Select a product, then tap an amount]</span>';
    document.getElementById('sale-total').textContent = '₱0';
    return;
  }
  let html = '';
  let total = 0;
  stagedItems.forEach((item, idx) => {
    total += item.amount;
    html += `<div class="staged-row">`;
    html += `<span><strong>${item.productName}</strong></span>`;
    html += `<span class="staged-price">₱${item.amount} <span style="font-size:11px;color:var(--text-muted);">(${item.qty}u)</span></span>`;
    html += `<button class="btn-remove" data-idx="${idx}">×</button>`;
    html += `</div>`;
  });
  container.innerHTML = html;
  document.getElementById('sale-total').textContent = `₱${total}`;
  container.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => removeStagedItem(parseInt(btn.dataset.idx)));
  });
}

function updateArmButton() {
  const btn = document.getElementById('btn-arm');
  btn.disabled = (stagedItems.length === 0);
  btn.textContent = stagedItems.length > 0 ? `Arm ${stagedItems.length} Slot${stagedItems.length > 1 ? 's' : ''}` : 'Arm';
}

async function executeArm() {
  if (stagedItems.length === 0) return;
  const btn = document.getElementById('btn-arm');
  btn.disabled = true;
  btn.textContent = 'Arming…';
  const saleId = 'SALE-' + Date.now() + '-' + (++saleIdCounter);
  try {
    const resp = await fetch('/api/arm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saleId, items: stagedItems.map(i => ({ productId: i.productId, qty: i.qty })) }),
    });
    const data = await resp.json();
    const failures = data.results.filter(r => !r.success);
    if (failures.length > 0) {
      alert('[ERROR] ' + failures.map(f => `Slot ${String(f.productId).padStart(2,'0')}: ${f.error}`).join('\n'));
    } else {
      stagedItems = []; selectedProduct = null;
      renderStagedItems(); renderProductGrid(); updateArmButton();
      document.querySelectorAll('.btn-amount').forEach(b => b.disabled = true);
    }
  } catch (e) { alert('[ERROR] ' + e.message); }
  finally { updateArmButton(); }
}

async function cancelSlot(productId) {
  try { await fetch('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId }) }); }
  catch (e) { console.error('Cancel failed:', e); }
}

async function resolveUnclaimed(idx, action) {
  const item = unclaimedItems[idx];
  try {
    await fetch('/api/unclaimed/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: item.slot, qty: item.qty, amount: item.amount, action }) });
    unclaimedItems.splice(idx, 1); renderUnclaimed();
  } catch (e) { console.error('Resolve failed:', e); }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.querySelectorAll('.btn-amount').forEach(btn => {
  btn.disabled = true;
  btn.addEventListener('click', () => { if (selectedProduct !== null) stageItem(selectedProduct, parseInt(btn.dataset.amount)); });
});
document.getElementById('btn-add-more').addEventListener('click', () => {
  selectedProduct = null; renderProductGrid();
  document.querySelectorAll('.btn-amount').forEach(b => b.disabled = true);
});
document.getElementById('btn-clear-sale').addEventListener('click', () => {
  stagedItems = []; selectedProduct = null;
  renderStagedItems(); renderProductGrid(); updateArmButton();
  document.querySelectorAll('.btn-amount').forEach(b => b.disabled = true);
});
document.getElementById('btn-arm').addEventListener('click', executeArm);

renderProductGrid();
connectSSE();
