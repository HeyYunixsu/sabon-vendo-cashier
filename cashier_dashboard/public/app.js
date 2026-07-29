/**
 * Sabon Vendo — Cashier Dashboard Client (v2 — Fast Tap-Based Sale Entry)
 *
 * Flow: Tap product → Tap amount (₱5/₱10/₱15/₱20) → product+amount staged
 *       → optionally add more products → Tap "Arm" to commit all at once.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRODUCT_NAMES = {
  1: 'Deesh Premium',
  2: 'Lanz Blossom',
  3: 'Lanz Dainty',
  4: 'Switch',
  5: 'Slot 5',
  6: 'Slot 6',
};

const AMOUNT_TO_QTY = { 5: 1, 10: 2, 15: 3, 20: 4 };  // ₱ → units
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

// Sale staging
let selectedProduct = null;          // product ID selected for current staging
let stagedItems = [];                // [{productId, productName, amount, qty}]
let saleIdCounter = 0;

// Unclaimed tracking (from server)
let unclaimedItems = [];

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------

function connectSSE() {
  const es = new EventSource('/api/status/stream');
  es.addEventListener('message', (e) => {
    if (e.data === 'connected') {
      machineState.connected = true;
      updateStatusBar();
      return;
    }
    if (e.data.startsWith('UNCLAIMED:')) {
      parseUnclaimed(e.data);
      return;
    }
    parseStatus(e.data);
  });
  es.addEventListener('error', () => {
    machineState.connected = false;
    updateStatusBar();
  });
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
  // Format: UNCLAIMED:<slot>,<qty>,<amount>,<timestamp>
  const parts = raw.substring(10).split(',');
  if (parts.length >= 3) {
    unclaimedItems.push({
      slot: parseInt(parts[0]),
      qty: parseInt(parts[1]),
      amount: parseFloat(parts[2]),
      time: parts[3] || '',
    });
    renderUnclaimed();
  }
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function updateAll() {
  updateStatusBar();
  renderProductGrid();
  renderArmedSlots();
  renderQueue();
  renderAlerts();
  renderUnclaimed();
}

function updateStatusBar() {
  const statusEl = document.getElementById('machine-status');
  const pauseEl  = document.getElementById('pause-indicator');
  const updateEl = document.getElementById('last-update');

  if (machineState.connected) {
    statusEl.textContent = '● Online';
    statusEl.className = 'badge badge-online';
  } else {
    statusEl.textContent = '● Offline';
    statusEl.className = 'badge badge-offline';
  }
  pauseEl.classList.toggle('hidden', !machineState.paused);
  if (machineState.lastUpdate) {
    updateEl.textContent = machineState.lastUpdate.toLocaleTimeString();
  }
}

function renderProductGrid() {
  const container = document.getElementById('grid-container');
  let html = '';
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    const active = i <= ACTIVE_SLOTS;
    const armed = machineState.armedQty[i] || 0;
    const busy = machineState.busy[i];
    const empty = machineState.wlvl[i];
    const qDepth = machineState.queueDepth[i];
    const selected = (selectedProduct === i);

    let cls = 'product-card';
    if (!active) cls += ' not-available';
    else if (busy) cls += ' busy';
    else if (empty) cls += ' empty';
    else if (armed > 0) cls += ' armed';
    if (selected) cls += ' selected';

    html += `<div class="${cls}" data-slot="${i}">`;
    html += `<div class="product-name">${PRODUCT_NAMES[i]}</div>`;
    if (!active) {
      html += `<div class="not-avail-overlay"><span class="badge badge-notavail">N/A</span></div>`;
    } else {
      html += `<div class="armed-qty${armed === 0 ? ' zero' : ''}">${armed}</div>`;
      html += `<div class="product-status">`;
      html += busy ? `<span class="badge badge-busy">Dispensing</span>`
        : (armed > 0 ? `<span class="badge badge-armed">Armed</span>`
        : `<span class="badge badge-idle">Idle</span>`);
      html += empty ? `<span class="badge badge-empty">Empty</span>`
        : `<span class="badge badge-full">Full</span>`;
      if (qDepth > 0) html += `<span class="badge badge-busy">Q:${qDepth}</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }
  container.innerHTML = html;

  // Attach click handlers
  container.querySelectorAll('.product-card').forEach(card => {
    card.addEventListener('click', () => {
      const slot = parseInt(card.dataset.slot);
      if (slot <= ACTIVE_SLOTS && !machineState.wlvl[slot]) {
        selectProduct(slot);
      }
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
      html += `<div class="armed-row">`;
      html += `<span><strong>Slot ${i}: ${PRODUCT_NAMES[i]}</strong></span>`;
      html += `<span>Qty: ${machineState.armedQty[i]}</span>`;
      html += `<button class="btn btn-cancel" data-slot="${i}">Cancel</button>`;
      html += `</div>`;
    }
  }
  if (!has) html = '<p class="muted">No armed slots</p>';
  container.innerHTML = html;

  container.querySelectorAll('.btn-cancel').forEach(btn => {
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
      html += `<div class="queue-row">`;
      html += `<span><strong>Slot ${i}</strong>: ${PRODUCT_NAMES[i]}</span>`;
      html += `<span>${machineState.queueDepth[i]} pending</span>`;
      html += `</div>`;
    }
  }
  if (!has) html = '<p class="muted">No pending orders</p>';
  container.innerHTML = html;
}

function renderAlerts() {
  const container = document.getElementById('alert-list');
  let html = '';
  for (let i = 1; i <= 4; i++) {
    if (machineState.wlvl[i]) {
      html += `<div class="alert-row danger">⚠ Slot ${i} (${PRODUCT_NAMES[i]}): EMPTY — refill needed</div>`;
    }
  }
  if (!machineState.connected) {
    html += `<div class="alert-row danger">⚠ Machine offline — cannot dispense</div>`;
  }
  if (!html) html = '<p class="muted">No alerts</p>';
  container.innerHTML = html;
}

function renderUnclaimed() {
  const container = document.getElementById('unclaimed-list');
  if (unclaimedItems.length === 0) {
    container.innerHTML = '<p class="muted">None</p>';
    return;
  }
  let html = '';
  unclaimedItems.forEach((item, idx) => {
    html += `<div class="alert-row warning">`;
    html += `<span>⚠ Slot ${item.slot}: ${item.qty} unit(s) — ₱${item.amount}</span>`;
    html += `<span>`;
    html += `<button class="btn btn-sm" data-resolve="${idx}" data-action="retry">Retry</button> `;
    html += `<button class="btn btn-sm" data-resolve="${idx}" data-action="dismiss">Dismiss</button>`;
    html += `</span>`;
    html += `</div>`;
  });
  container.innerHTML = html;

  container.querySelectorAll('[data-resolve]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.resolve);
      const action = btn.dataset.action;
      resolveUnclaimed(idx, action);
    });
  });
}

// ---------------------------------------------------------------------------
// Tap-based Sale Entry
// ---------------------------------------------------------------------------

function selectProduct(productId) {
  if (productId < 1 || productId > ACTIVE_SLOTS) return;
  if (machineState.wlvl[productId]) return;  // can't select empty slots
  selectedProduct = productId;
  renderProductGrid();
  // Enable amount buttons
  document.querySelectorAll('.btn-amount').forEach(b => b.disabled = false);
}

function stageItem(productId, amount) {
  const qty = AMOUNT_TO_QTY[amount] || 1;
  stagedItems.push({
    productId,
    productName: PRODUCT_NAMES[productId],
    amount,
    qty,
  });
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
    container.innerHTML = '<p class="muted">Tap a product, then tap an amount</p>';
    document.getElementById('sale-total').textContent = 'Total: ₱0';
    return;
  }
  let html = '';
  let total = 0;
  stagedItems.forEach((item, idx) => {
    total += item.amount;
    html += `<div class="staged-row">`;
    html += `<span><strong>${item.productName}</strong> — ₱${item.amount} (${item.qty}u)</span>`;
    html += `<button class="btn-remove" data-idx="${idx}">✕</button>`;
    html += `</div>`;
  });
  container.innerHTML = html;
  document.getElementById('sale-total').textContent = `Total: ₱${total}`;

  container.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => removeStagedItem(parseInt(btn.dataset.idx)));
  });
}

function updateArmButton() {
  const btn = document.getElementById('btn-arm');
  btn.disabled = (stagedItems.length === 0);
  if (stagedItems.length > 0) {
    btn.textContent = `Arm ${stagedItems.length} Product${stagedItems.length > 1 ? 's' : ''}`;
  } else {
    btn.textContent = 'Arm Selected';
  }
}

async function executeArm() {
  if (stagedItems.length === 0) return;

  const btn = document.getElementById('btn-arm');
  btn.disabled = true;
  btn.textContent = 'Arming...';

  const saleId = 'SALE-' + Date.now() + '-' + (++saleIdCounter);
  try {
    const resp = await fetch('/api/arm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saleId, items: stagedItems.map(i => ({ productId: i.productId, qty: i.qty })) }),
    });
    const data = await resp.json();

    const failures = data.results.filter(r => !r.success);
    if (failures.length > 0) {
      alert('Some items failed:\n' + failures.map(f => `Slot ${f.productId}: ${f.error}`).join('\n'));
    } else {
      // Success — clear staged items
      stagedItems = [];
      selectedProduct = null;
      renderStagedItems();
      renderProductGrid();
      updateArmButton();
      document.querySelectorAll('.btn-amount').forEach(b => b.disabled = true);
    }
  } catch (e) {
    alert('Failed to send sale: ' + e.message);
  } finally {
    updateArmButton();
  }
}

async function cancelSlot(productId) {
  try {
    await fetch('/api/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId }),
    });
  } catch (e) {
    console.error('Cancel failed:', e);
  }
}

async function resolveUnclaimed(idx, action) {
  const item = unclaimedItems[idx];
  try {
    await fetch('/api/unclaimed/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: item.slot, qty: item.qty, amount: item.amount, action }),
    });
    unclaimedItems.splice(idx, 1);
    renderUnclaimed();
  } catch (e) {
    console.error('Resolve failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

document.querySelectorAll('.btn-amount').forEach(btn => {
  btn.addEventListener('click', () => {
    if (selectedProduct === null) return;
    const amount = parseInt(btn.dataset.amount);
    stageItem(selectedProduct, amount);
  });
});

document.getElementById('btn-add-more').addEventListener('click', () => {
  // Deselect current product so user picks next one
  selectedProduct = null;
  renderProductGrid();
  document.querySelectorAll('.btn-amount').forEach(b => b.disabled = true);
});

document.getElementById('btn-clear-sale').addEventListener('click', () => {
  stagedItems = [];
  selectedProduct = null;
  renderStagedItems();
  renderProductGrid();
  updateArmButton();
  document.querySelectorAll('.btn-amount').forEach(b => b.disabled = true);
});

document.getElementById('btn-arm').addEventListener('click', executeArm);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.querySelectorAll('.btn-amount').forEach(b => b.disabled = true);
renderProductGrid();
connectSSE();
