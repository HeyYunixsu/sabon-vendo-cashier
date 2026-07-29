/**
 * Sabon Vendo — Cashier Dashboard Client
 *
 * Connects to the dashboard server via SSE for live STATUS pushes,
 * renders the product grid / armed slots / queue / alerts,
 * and sends ARM commands on "Sell".
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const PRODUCT_NAMES = {
  1: 'Deesh Premium',
  2: 'Lanz Blossom',
  3: 'Lanz Dainty',
  4: 'Switch',
  5: 'Slot 5',
  6: 'Slot 6',
};

const ACTIVE_SLOTS = 4;   // slots 1-4 wired; 5-6 marked Not Available
const TOTAL_SLOTS  = 6;

let machineState = {
  armedQty:     [0,0,0,0,0,0,0],   // index 1-6
  remaining:    [0,0,0,0,0],
  wlvl:         [false,false,false,false,false],
  busy:         [false,false,false,false,false,false,false],
  queueDepth:   [0,0,0,0,0,0,0],
  paused:       false,
  lastUpdate:   null,
  connected:    false,
};

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
    parseStatus(e.data);
  });

  es.addEventListener('error', () => {
    machineState.connected = false;
    updateStatusBar();
    // EventSource auto-reconnects
  });
}

function parseStatus(raw) {
  // Format: STATUS,armedQty1-4,remaining1-4,wlvl1-4,busy1-4,qDepth1-4,paused
  const parts = raw.split(',');
  if (parts.length < 18) return;  // not a valid STATUS line
  // parts[0] = "STATUS"
  let idx = 1;
  for (let i = 1; i <= 4; i++) machineState.armedQty[i]   = parseInt(parts[idx++]) || 0;
  for (let i = 1; i <= 4; i++) machineState.remaining[i]  = parseInt(parts[idx++]) || 0;
  for (let i = 1; i <= 4; i++) machineState.wlvl[i]       = parts[idx++] === '1';
  for (let i = 1; i <= 4; i++) machineState.busy[i]       = parts[idx++] === '1';
  for (let i = 1; i <= 4; i++) machineState.queueDepth[i] = parseInt(parts[idx++]) || 0;
  machineState.paused = parts[idx] === '1';
  machineState.lastUpdate = new Date();

  updateStatusBar();
  renderProductGrid();
  renderArmedSlots();
  renderQueue();
  renderAlerts();
}

// ---------------------------------------------------------------------------
// Render: Status Bar
// ---------------------------------------------------------------------------

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
    updateEl.textContent = 'Last update: ' + machineState.lastUpdate.toLocaleTimeString();
  }
}

// ---------------------------------------------------------------------------
// Render: Product Grid
// ---------------------------------------------------------------------------

function renderProductGrid() {
  const container = document.getElementById('grid-container');
  let html = '';

  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    const isActive = i <= ACTIVE_SLOTS;
    const armed = machineState.armedQty[i] || 0;
    const busy = machineState.busy[i];
    const empty = machineState.wlvl[i];
    const qDepth = machineState.queueDepth[i];

    let cardClass = 'product-card';
    if (!isActive) cardClass += ' not-available';
    else if (busy) cardClass += ' busy';
    else if (empty) cardClass += ' empty';
    else if (armed > 0) cardClass += ' armed';

    html += `<div class="${cardClass}" id="card-${i}">`;
    html += `<div class="product-name">Slot ${i}: ${PRODUCT_NAMES[i]}</div>`;

    if (!isActive) {
      html += `<div class="not-avail-overlay"><span class="badge badge-notavail">Not Available</span></div>`;
    } else {
      html += `<div class="armed-qty${armed === 0 ? ' zero' : ''}">${armed}</div>`;
      html += `<div class="product-status">`;
      if (busy) {
        html += `<span class="badge badge-busy">Dispensing</span>`;
      } else if (armed > 0) {
        html += `<span class="badge badge-armed">Armed</span>`;
      } else {
        html += `<span class="badge badge-idle">Idle</span>`;
      }
      html += empty
        ? `<span class="badge badge-empty">Empty</span>`
        : `<span class="badge badge-full">Full</span>`;
      if (qDepth > 0) {
        html += `<span class="badge badge-busy">Queue: ${qDepth}</span>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
  }

  container.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Render: Armed Slots
// ---------------------------------------------------------------------------

function renderArmedSlots() {
  const container = document.getElementById('armed-list');
  let html = '';
  let hasArmed = false;

  for (let i = 1; i <= 4; i++) {
    if (machineState.armedQty[i] > 0 || machineState.busy[i]) {
      hasArmed = true;
      html += `<div class="armed-row">`;
      html += `<span><strong>Slot ${i}: ${PRODUCT_NAMES[i]}</strong></span>`;
      html += `<span>Qty: ${machineState.armedQty[i]}</span>`;
      html += `<button class="btn btn-cancel" onclick="cancelSlot(${i})">Cancel</button>`;
      html += `</div>`;
    }
  }

  if (!hasArmed) html = '<p class="muted">No armed slots</p>';
  container.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Render: Queue
// ---------------------------------------------------------------------------

function renderQueue() {
  const container = document.getElementById('queue-list');
  let html = '';
  let hasQueue = false;

  for (let i = 1; i <= 4; i++) {
    if (machineState.queueDepth[i] > 0) {
      hasQueue = true;
      html += `<div class="queue-row">`;
      html += `<span><strong>Slot ${i}</strong>: ${PRODUCT_NAMES[i]}</span>`;
      html += `<span>${machineState.queueDepth[i]} pending</span>`;
      html += `</div>`;
    }
  }

  if (!hasQueue) html = '<p class="muted">No pending orders</p>';
  container.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Render: Alerts
// ---------------------------------------------------------------------------

function renderAlerts() {
  const container = document.getElementById('alert-list');
  let html = '';

  for (let i = 1; i <= 4; i++) {
    if (machineState.wlvl[i]) {
      html += `<div class="alert-row danger">⚠ Slot ${i} (${PRODUCT_NAMES[i]}): Water level low — EMPTY</div>`;
    }
  }

  if (!machineState.connected) {
    html += `<div class="alert-row danger">⚠ Machine offline — cannot communicate with coin_slot</div>`;
  }

  if (!html) html = '<p class="muted">No alerts</p>';
  container.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Sale Entry
// ---------------------------------------------------------------------------

function createSaleRow(productId = 1, qty = 1) {
  const row = document.createElement('div');
  row.className = 'sale-item-row';

  const select = document.createElement('select');
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Slot ${i}: ${PRODUCT_NAMES[i]}` + (i > ACTIVE_SLOTS ? ' (N/A)' : '');
    opt.disabled = i > ACTIVE_SLOTS;
    if (i === productId) opt.selected = true;
    select.appendChild(opt);
  }

  const input = document.createElement('input');
  input.type = 'number';
  input.min = 1;
  input.max = 99;
  input.value = qty;

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove';
  removeBtn.textContent = '✕';
  removeBtn.onclick = () => row.remove();

  row.appendChild(select);
  row.appendChild(input);
  row.appendChild(removeBtn);

  return row;
}

document.getElementById('btn-add-product').addEventListener('click', () => {
  const container = document.getElementById('sale-items');
  // Default to first active slot not already selected
  container.appendChild(createSaleRow(1, 1));
});

document.getElementById('btn-sell').addEventListener('click', async () => {
  const rows = document.querySelectorAll('.sale-item-row');
  const items = [];

  rows.forEach(row => {
    const select = row.querySelector('select');
    const input = row.querySelector('input');
    const productId = parseInt(select.value);
    const qty = parseInt(input.value) || 1;
    items.push({ productId, qty });
  });

  if (items.length === 0) {
    alert('Add at least one product to the sale.');
    return;
  }

  try {
    const resp = await fetch('/api/arm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const data = await resp.json();

    // Check for failures
    const failures = data.results.filter(r => !r.success);
    if (failures.length > 0) {
      alert('Some items failed:\n' + failures.map(f => `Slot ${f.productId}: ${f.error}`).join('\n'));
    }

    // Clear sale form on success
    if (data.results.some(r => r.success)) {
      document.getElementById('sale-items').innerHTML = '';
      document.getElementById('sale-items').appendChild(createSaleRow(1, 1));
    }
  } catch (e) {
    alert('Failed to send sale: ' + e.message);
  }
});

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

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// Add one default sale row
document.getElementById('sale-items').appendChild(createSaleRow(1, 1));

// Render initial state
renderProductGrid();

// Connect SSE
connectSSE();
