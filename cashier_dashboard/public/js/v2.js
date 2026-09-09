/* ===========================================================================
   V2 LAYOUT  --  behaviour for v2.html only.

   Built to sabon-express-ui-v2-handoff.md. Speaks the SAME protocol as
   js/app.js -- the SSE status stream, /api/arm, /api/info, /api/prices,
   /api/sales/today -- so both dashboards can be open at once and stay in step.
   The controller is the one source of truth; neither page caches machine state
   the other cannot see.

   Its own closure rather than shared with app.js: the two pages have no DOM in
   common (#staged-items and #sale-strip do not exist here), so sharing would
   mean guarding every function with "which layout am I on".

   From the handoff, the rules that are easy to lose in a refactor:
     - The card BODY is inert. Only the steppers change quantity.
     - The stepper and the cart line are two views of ONE state. `cart` below
       is that state; the cart panel keeps no copy of its own.
     - Cart lines stay in INSERTION order, not slot order.
     - A card is non-interactive in any state but Ready.
     - Once unlocked or dispensing the whole cart locks -- no stepper, no
       cancel, no clear -- until the transaction finishes.
   =========================================================================== */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Constants and state
  // -------------------------------------------------------------------------

  // ACTIVE must match TOTAL_SLOTS in coin_slot/includes/hardware_config.h.
  const ACTIVE = 6, TOTAL = 6;
  const MAX_QTY = 10;
  // "STATUS" + 5 arrays of ACTIVE + paused/phase/bundle.
  const STATUS_FIELDS = 5 * ACTIVE + 4;

  // Placeholders. Real names and volumes arrive from config.env via /api/info,
  // because what is loaded in each slot differs per machine. The handoff is
  // explicit that the display label is the only thing that changes -- the slot
  // index and pump mapping behind it are untouched.
  let PRODUCT    = { 1:'Product 1', 2:'Product 2', 3:'Product 3',
                     4:'Product 4', 5:'Product 5', 6:'Product 6' };
  let PRODUCT_ML = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  let prices     = {};

  // ---- product photos ------------------------------------------------------
  // Keyed by SLOT, not by name: the name is whatever config.env says and it
  // changes per machine, but slot 3 is always the third pump. Drop a photo in
  // as img/products/<slot>.webp and it appears; if the file is missing the card
  // falls back to a drawn glyph, so a fresh machine is never broken by an
  // absent image and never waits on one.
  //
  // WebP at 480px wide. The supplied art is 1024x1536 PNG at ~1.4MB each --
  // 8.6MB of bottles on a screen whose image box is 118px wide, re-fetched by
  // every device that opens the dashboard on a Pi's LAN. Re-encoded the set is
  // 214KB. Every browser this machine targets has supported WebP for years.
  const PRODUCT_IMG = (slot) => 'img/products/' + slot + '.webp';

  const GLYPH_BOTTLE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"' +
    ' stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 3h4v3l2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V8l2-2V3z"/>' +
    '<path d="M15 9h1.5a1.5 1.5 0 0 1 1.5 1.5V15a1.5 1.5 0 0 1-1.5 1.5H15"/></svg>';

  const ICO_MINUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"' +
    ' stroke-linecap="round"><path d="M5 12h14"/></svg>';
  const ICO_PLUS  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"' +
    ' stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  const ICO_X     = '<svg class="v2-cancel-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const S = {
    armedQty: new Array(TOTAL + 1).fill(0),
    remaining: new Array(TOTAL + 1).fill(0),
    wlvl: new Array(TOTAL + 1).fill(false),
    busy: new Array(TOTAL + 1).fill(false),
    queueDepth: new Array(TOTAL + 1).fill(0),
    paused: false, phase: 0, bundleComplete: false,
    connected: false,
  };

  // THE cart -- the single source of truth the handoff asks for. Client-side
  // only until Unlock: nothing is charged, dispensed or owed while it sits
  // here, which is why clearing it needs no round trip to the controller.
  // Order is insertion order and stays that way.
  let cart = [];
  let saleCtr = 0;
  let prevBusy = new Array(TOTAL + 1).fill(false);

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Armed or dispensing: the sale is with the machine now and the cart must
  // not move under it. Phase 0 idle, 1 armed, 2 dispensing, 3 complete.
  const isLocked = () => S.phase === 1 || S.phase === 2;

  // One function decides what a slot is, so the badge, the stepper and the
  // "can this be added" test can never disagree about it.
  function slotState(s) {
    if (s > ACTIVE)      return 'off';
    if (!S.connected)    return 'offline';
    if (S.busy[s])       return 'dispensing';
    if (S.wlvl[s])       return 'empty';
    if (S.armedQty[s])   return 'unlocked';
    return 'ready';
  }
  const BADGE = {
    ready:      { label: 'Ready',      cls: '' },
    dispensing: { label: 'Dispensing', cls: ' is-busy' },
    empty:      { label: 'Empty',      cls: ' is-empty' },
    unlocked:   { label: 'Unlocked',   cls: ' is-armed' },
    offline:    { label: 'Offline',    cls: ' is-offline' },
    off:        { label: 'N/A',        cls: ' is-off' },
  };

  // -------------------------------------------------------------------------
  // Toast
  // -------------------------------------------------------------------------
  let toastTmr;
  function toast(msg, type) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'visible' + (type ? ' ' + type : '');
    clearTimeout(toastTmr);
    toastTmr = setTimeout(() => { el.className = ''; }, 2600);
  }

  // -------------------------------------------------------------------------
  // Confirm dialog
  //
  // Not window.confirm(). A native dialog is drawn by the browser rather than
  // the page, and Android Chrome leaves fullscreen to show it -- the kiosk
  // visibly falls back to a normal window mid-sale.
  // -------------------------------------------------------------------------
  function askConfirm(message, yesLabel) {
    return new Promise((resolve) => {
      const back = $('ask-backdrop'), box = $('ask');
      const yes = $('ask-yes'), no = $('ask-no');
      $('ask-text').textContent = message;
      yes.textContent = yesLabel || 'Confirm';
      back.hidden = false; box.hidden = false;

      function done(answer) {
        back.hidden = true; box.hidden = true;
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
        back.removeEventListener('click', onNo);
        document.removeEventListener('keydown', onKey, true);
        resolve(answer);
      }
      function onYes() { done(true); }
      function onNo() { done(false); }
      function onKey(ev) {
        // Enter is deliberately NOT wired to yes: these questions guard
        // something destructive.
        if (ev.key === 'Escape') { ev.stopPropagation(); done(false); }
      }
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
      back.addEventListener('click', onNo);
      document.addEventListener('keydown', onKey, true);
      no.focus();                       // the safe choice, not the destructive one
    });
  }

  // -------------------------------------------------------------------------
  // SSE
  // -------------------------------------------------------------------------
  function connectSSE() {
    const es = new EventSource('/api/status/stream');
    es.addEventListener('message', (e) => {
      if (e.data === 'connected') {
        S.connected = true;
        S.armedQty.fill(0); S.remaining.fill(0); S.wlvl.fill(false);
        S.busy.fill(false); S.queueDepth.fill(0);
        S.paused = false; S.phase = 0; S.bundleComplete = false;
        // The cart is this screen's own scratch space. A reconnect says nothing
        // about it, so it is left alone rather than silently emptied while
        // someone is halfway through building a sale.
        loadToday();
        renderAll();
        return;
      }
      if (e.data.startsWith('PRICES:')) {
        try { prices = JSON.parse(e.data.slice(7)) || {}; } catch (_) { return; }
        renderCart();
        return;
      }
      // PRIME_ACK / PRICE_ACK belong to maintenance screens this layout does
      // not carry. Ignored rather than mis-parsed as a STATUS row.
      if (e.data.startsWith('PRIME_ACK') || e.data.startsWith('PRICE_ACK')) return;
      parseStatus(e.data);
    });
    es.addEventListener('error', () => { S.connected = false; renderAll(); });
  }

  function parseStatus(raw) {
    const p = raw.split(',');
    if (p.length < STATUS_FIELDS) return;
    let i = 1;
    for (let s = 1; s <= ACTIVE; s++) S.armedQty[s]   = parseInt(p[i++], 10) || 0;
    for (let s = 1; s <= ACTIVE; s++) S.remaining[s]  = parseInt(p[i++], 10) || 0;
    for (let s = 1; s <= ACTIVE; s++) S.wlvl[s]       = p[i++] === '1';
    for (let s = 1; s <= ACTIVE; s++) S.busy[s]       = p[i++] === '1';
    for (let s = 1; s <= ACTIVE; s++) S.queueDepth[s] = parseInt(p[i++], 10) || 0;
    S.paused = p[i++] === '1';
    S.phase = parseInt(p[i++], 10) || 0;
    S.bundleComplete = p[i] === '1';
    S.connected = true;

    // A pump finishing is the cue to re-read the day's takings. Counting
    // transitions here instead would count a line being cleared of air as a
    // sale, and would reset to zero on every reload.
    for (let s = 1; s <= ACTIVE; s++) {
      if (!S.busy[s] && prevBusy[s]) scheduleTodayRefresh();
      prevBusy[s] = S.busy[s];
    }
    renderAll();
  }

  let todayTmr = null;
  function scheduleTodayRefresh() {
    // The uploader archives a sale a moment after the pump stops, so give it
    // time rather than racing it.
    clearTimeout(todayTmr);
    todayTmr = setTimeout(loadToday, 1500);
  }

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------
  function renderHeader() {
    let waiting = 0, inStock = 0;
    for (let s = 1; s <= ACTIVE; s++) {
      waiting += (S.armedQty[s] || 0) + (S.queueDepth[s] || 0);
      if (!S.wlvl[s]) inStock++;
    }

    $('kpi-waiting').textContent = waiting;
    $('chip-waiting').classList.toggle('is-live', waiting > 0);

    const stock = $('kpi-stock');
    stock.textContent = inStock + '/' + ACTIVE;
    stock.className = 'v2-chip-v ' + (inStock === ACTIVE ? 'is-full'
      : inStock >= Math.ceil(ACTIVE / 2) ? 'is-low' : 'is-critical');

    // One chip, always true. Offline outranks everything -- a stale "Ready"
    // beside a dead link is worse than saying nothing -- then paused, then the
    // phase. Plain words, not the C++ enum names: a cashier reads this.
    const phases = ['Ready', 'Buttons Unlocked', 'Dispensing', 'Done'];
    let state, colour;
    if (!S.connected)   { state = 'Offline'; colour = 'var(--red)'; }
    else if (S.paused)  { state = 'Paused';  colour = '#B26A00'; }
    else {
      state = phases[S.phase] || 'Ready';
      colour = S.bundleComplete ? 'var(--green)'
             : (S.phase === 3 ? 'var(--teal-strong)' : 'var(--ink)');
    }
    $('kpi-state').textContent = state;
    $('kpi-state').style.color = colour;

    $('offline-banner').hidden = S.connected;
  }

  function tickClock() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    $('v2-clock').textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // -------------------------------------------------------------------------
  // Product grid
  // -------------------------------------------------------------------------
  const qtyOf = (id) => { const it = cart.find((x) => x.id === id); return it ? it.qty : 0; };

  // Rebuilding the grid on every STATUS frame -- twice a second -- would
  // destroy the button under a finger mid-press. A signature of everything the
  // markup depends on lets an unchanged frame do nothing at all.
  let gridSig = null;

  function renderGrid() {
    const locked = isLocked();
    let sig = locked ? 'L' : 'U';
    for (let s = 1; s <= TOTAL; s++) {
      sig += '|' + slotState(s) + qtyOf(s) + PRODUCT[s] + PRODUCT_ML[s];
    }
    if (sig === gridSig) return;
    gridSig = sig;

    let h = '';
    for (let s = 1; s <= TOTAL; s++) {
      const st = slotState(s);
      const qty = qtyOf(s);
      const badge = BADGE[st];
      // The handoff: a card is non-interactive in any state but Ready, and the
      // whole cart is frozen while the machine has the sale.
      const canAdd = st === 'ready' && !locked && qty < MAX_QTY;
      const canSub = qty > 0 && !locked;

      let cls = 'v2-prod';
      if (st === 'off') cls += ' is-inactive';
      else if (st === 'empty' || st === 'offline') cls += ' is-empty';
      if (qty > 0) cls += ' in-cart';

      h += '<div class="' + cls + '" data-slot="' + s + '">'
         + '<div class="v2-badge' + badge.cls + '"><span class="v2-dot"></span>' + badge.label + '</div>'
         + '<div class="v2-prod-img">'
         +   '<img src="' + PRODUCT_IMG(s) + '" alt="" loading="lazy">'
         + '</div>'
         + '<div class="v2-prod-text">'
         +   '<div class="v2-prod-name">' + esc(PRODUCT[s]) + '</div>'
         +   '<div class="v2-prod-ml">' + (PRODUCT_ML[s] || 0) + 'ml</div>'
         + '</div>'
         + '<div class="v2-step-row">'
         +   '<button class="v2-step v2-step-minus" type="button" data-slot="' + s + '" data-delta="-1"'
         +     ' aria-label="One less ' + esc(PRODUCT[s]) + '"' + (canSub ? '' : ' disabled') + '>' + ICO_MINUS + '</button>'
         +   '<span class="v2-step-qty">' + qty + '</span>'
         +   '<button class="v2-step v2-step-plus" type="button" data-slot="' + s + '" data-delta="1"'
         +     ' aria-label="One more ' + esc(PRODUCT[s]) + '"' + (canAdd ? '' : ' disabled') + '>' + ICO_PLUS + '</button>'
         + '</div>'
         + '</div>';
    }
    $('v2-grid').innerHTML = h;

    // The fallback is wired here rather than as an inline onerror="" attribute.
    // The glyph is SVG and full of double quotes, which closed the attribute
    // early and leaked the remainder onto the card as the literal text '">.
    // A listener has no escaping to get wrong.
    $('v2-grid').querySelectorAll('.v2-prod-img img').forEach((img) => {
      img.addEventListener('error', function () {
        this.parentNode.innerHTML = GLYPH_BOTTLE;
      }, { once: true });
    });
  }

  // -------------------------------------------------------------------------
  // Cart
  // -------------------------------------------------------------------------
  function renderCart() {
    const list = $('v2-cart-list');
    const empty = $('v2-cart-empty');
    const locked = isLocked();

    if (!cart.length) {
      list.innerHTML = '';
      list.hidden = true;
      empty.hidden = false;
    } else {
      empty.hidden = true;
      list.hidden = false;
      let h = '';
      // Insertion order, exactly as built. Re-sorting by slot would move a row
      // out from under a finger that is reaching for its Cancel.
      for (const it of cart) {
        const unit = prices[it.id];
        const line = unit == null ? null : unit * it.qty;
        h += '<li class="v2-cart-row" data-slot="' + it.id + '">'
           + '<span class="v2-dot"></span>'
           + '<span class="v2-cart-name"><b>' + esc(it.name) + '</b>'
           +   '<span>' + (PRODUCT_ML[it.id] || 0) + 'ml</span></span>'
           + '<span class="v2-cart-qty">' + it.qty + 'x</span>'
           // An unpriced product shows a dash, never "₱0" -- a zero here reads
           // as free, and would be taken as the price by whoever is counting.
           + '<span class="v2-cart-price">' + (line == null ? '&mdash;' : '&#8369;' + line) + '</span>'
           + '<button class="v2-btn v2-btn-danger-ghost v2-btn-sm" type="button"'
           +   ' data-remove="' + it.id + '"' + (locked ? ' disabled' : '')
           +   ' aria-label="Remove ' + esc(it.name) + ' from the cart">'
           +   '<span class="v2-cancel-word">Cancel</span>' + ICO_X
           + '</button>'
           + '</li>';
      }
      list.innerHTML = h;
    }

    let items = 0, pesos = 0, priced = true;
    for (const it of cart) {
      items += it.qty;
      if (prices[it.id] == null) priced = false;
      else pesos += prices[it.id] * it.qty;
    }
    $('total-items').textContent = items;
    // Prices come from the controller per product. Nothing is hardcoded here,
    // so whatever the pricing rule turns out to be, this total follows it.
    $('total-amount').textContent = priced ? '₱' + pesos : '—';

    // The mockup draws Unlock teal on an empty cart; the handoff says that is a
    // mockup artifact and it must be disabled. It is.
    $('btn-arm').disabled = !items || locked;
    $('btn-arm-label').textContent = items
      ? 'Unlock ' + cart.length + ' Button' + (cart.length > 1 ? 's' : '')
      : 'Unlock Buttons';

    const noClear = !cart.length || locked;
    $('btn-clear-cart').disabled = noClear;
    $('btn-cancel-all').disabled = noClear;
  }

  function renderAll() { renderHeader(); renderGrid(); renderCart(); }

  // -------------------------------------------------------------------------
  // Cart mutation  --  the only place `cart` changes
  // -------------------------------------------------------------------------
  function step(id, delta) {
    if (id < 1 || id > ACTIVE) return;
    if (isLocked()) return;

    const i = cart.findIndex((x) => x.id === id);
    if (delta > 0) {
      if (slotState(id) !== 'ready') return;
      if (i < 0) cart.push({ id: id, name: PRODUCT[id], qty: 1 });
      else if (cart[i].qty >= MAX_QTY) { toast('Maximum ' + MAX_QTY + ' per product', 'caution'); return; }
      else cart[i].qty += 1;
    } else {
      if (i < 0) return;
      // Hitting zero removes the line outright, which is what the handoff
      // asks for and what keeps the stepper and the cart one state.
      if (cart[i].qty <= 1) cart.splice(i, 1);
      else cart[i].qty -= 1;
    }
    renderGrid(); renderCart();
  }

  function removeLine(id) {
    if (isLocked()) return;
    const i = cart.findIndex((x) => x.id === id);
    if (i < 0) return;
    const name = cart[i].name;
    cart.splice(i, 1);
    renderGrid(); renderCart();
    toast(name + ' removed', 'caution');
  }

  // Cancel All and the trash icon are ONE action, per the handoff. Both call
  // this. It clears this screen's cart; nothing has been charged yet, so it
  // asks rather than warns.
  //
  // NOTE: it does not touch credits already unlocked on the machine. Those are
  // paid for, live on the controller, and this layout has no waiting-list panel
  // to void them from yet -- the header's Waiting count is the only sign of
  // them. Voiding those still needs the old dashboard.
  async function clearCart(label) {
    if (!cart.length || isLocked()) return;
    const presses = cart.reduce((a, it) => a + it.qty, 0);
    const what = cart.length === 1 ? cart[0].name : cart.length + ' products';
    const ok = await askConfirm(
      'Clear ' + what + ' (' + presses + ' press' + (presses !== 1 ? 'es' : '') + ') from this cart?',
      label || 'Clear Cart');
    if (!ok) return;
    cart = [];
    renderGrid(); renderCart();
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  async function executeArm() {
    if (!cart.length || isLocked()) return;
    const btn = $('btn-arm');
    btn.disabled = true;
    btn.classList.add('is-busy');
    $('btn-arm-label').textContent = 'Unlocking…';

    const sid = 'SALE-' + Date.now() + '-' + (++saleCtr);
    const batch = cart.map((i) => i.id + ':' + i.qty).join(',');
    const summary = cart.map((i) => i.name + ' (' + i.qty + 'x)').join(', ');
    try {
      const r = await fetch('/api/arm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ saleId: sid, batch: batch }),
      });
      const d = await r.json();
      if (d.success) {
        toast('Buttons unlocked: ' + summary, 'success');
        cart = [];
      } else {
        toast('Could not unlock: ' + (d.error || 'unknown'), 'error');
      }
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    } finally {
      btn.classList.remove('is-busy');
      gridSig = null;                 // force past the redraw guard
      renderAll();
    }
  }

  async function loadInfo() {
    try {
      const d = await (await fetch('/api/info')).json();
      if (d.products) {
        for (const k of Object.keys(d.products)) {
          const slot = parseInt(k, 10);
          if (!(slot >= 1 && slot <= TOTAL)) continue;
          if (d.products[k].name) PRODUCT[slot] = d.products[k].name;
          PRODUCT_ML[slot] = d.products[k].ml || 0;
        }
        // A cart row captured its name when it was added, so refresh those too
        // rather than leaving "Product 3" sitting in the cart.
        for (const it of cart) it.name = PRODUCT[it.id] || it.name;
        gridSig = null;
        renderAll();
      }
    } catch (e) { /* the placeholders stand; the page still works */ }
  }

  async function loadPrices() {
    // The stream pushes PRICES: on connect, but a page opened between pushes
    // would show every product unpriced until the next one.
    try {
      const d = await (await fetch('/api/prices')).json();
      if (d && typeof d === 'object') { prices = d; renderCart(); }
    } catch (e) { /* unpriced is a legible state; leave it */ }
  }

  async function loadToday() {
    try {
      const d = await (await fetch('/api/sales/today')).json();
      const pesos = d.pesos || 0;
      $('kpi-today').textContent = '₱' + pesos;
      $('today-pesos').textContent = '₱' + pesos;

      const rows = (d.products || []).slice().sort((a, b) => (b.pesos || 0) - (a.pesos || 0));
      $('today-rows').innerHTML = rows.length
        ? rows.map((r) => '<div class="v2-today-row"><span>' + esc(r.name || '')
            + '</span><span>₱' + (r.pesos || 0) + '</span></div>').join('')
        : '<div class="v2-today-empty">Nothing sold yet today.</div>';
    } catch (e) { /* leave the last known figure rather than blanking it */ }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  function wire() {
    // Delegated, because the grid and the cart are both rebuilt from scratch.
    // Note this listens for the STEPPERS only -- the card body is inert by
    // design, so a stray tap on the photo cannot add a press to a paid sale.
    $('v2-grid').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.v2-step');
      if (!btn || btn.disabled) return;
      step(parseInt(btn.dataset.slot, 10), parseInt(btn.dataset.delta, 10));
    });

    $('v2-cart-list').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-remove]');
      if (!btn || btn.disabled) return;
      removeLine(parseInt(btn.dataset.remove, 10));
    });

    $('btn-one-each').addEventListener('click', () => {
      if (isLocked()) return;
      let added = 0;
      for (let s = 1; s <= ACTIVE; s++) {
        if (slotState(s) !== 'ready' || qtyOf(s) > 0) continue;
        cart.push({ id: s, name: PRODUCT[s], qty: 1 });   // insertion order
        added++;
      }
      renderGrid(); renderCart();
      toast(added ? added + ' product' + (added !== 1 ? 's' : '') + ' added'
                  : 'Nothing available to add', added ? 'success' : 'caution');
    });

    // One handler for both, as the handoff requires.
    $('btn-clear-cart').addEventListener('click', () => clearCart('Clear Cart'));
    $('btn-cancel-all').addEventListener('click', () => clearCart('Cancel All'));
    $('btn-arm').addEventListener('click', executeArm);

    $('offline-retry').addEventListener('click', () => location.reload());

    // Today panel
    const openToday = () => {
      loadToday();
      $('today-panel').hidden = false;
      $('chip-today').setAttribute('aria-expanded', 'true');
    };
    const closeToday = () => {
      $('today-panel').hidden = true;
      $('chip-today').setAttribute('aria-expanded', 'false');
    };
    $('chip-today').addEventListener('click', openToday);
    $('btn-today-close').addEventListener('click', closeToday);
    $('today-panel').addEventListener('click', (ev) => {
      if (ev.target === $('today-panel')) closeToday();   // the backdrop only
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !$('today-panel').hidden) closeToday();
    });

    // The handoff keeps Settings unchanged behind the gear, but that screen is
    // not ported to this layout yet. Saying so beats a button that swallows the
    // tap and looks broken.
    $('btn-settings').addEventListener('click', () => {
      toast('Settings still lives on the old dashboard', 'caution');
    });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  wire();
  renderAll();
  tickClock();
  setInterval(tickClock, 1000);
  loadInfo();
  loadPrices();
  loadToday();
  connectSSE();
})();
