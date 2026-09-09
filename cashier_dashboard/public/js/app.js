(function() {
  'use strict';

  // Placeholders only. The real names and volumes come from config.env via
  // /api/info, because what is loaded in each slot differs per client -- these
  // were hardcoded, so every machine claimed to sell the same six things.
  let PRODUCT    = { 1:'Product 1', 2:'Product 2', 3:'Product 3',
                     4:'Product 4', 5:'Product 5', 6:'Product 6' };
  let PRODUCT_ML = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const PRODUCT_ICON = {
    1: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c4.2 4.6 6.5 8.1 6.5 11a6.5 6.5 0 0 1-13 0c0-2.9 2.3-6.4 6.5-11z"/></svg>',
    2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c4.2 4.6 6.5 8.1 6.5 11a6.5 6.5 0 0 1-13 0c0-2.9 2.3-6.4 6.5-11z"/></svg>',
    3: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8l1 3-2 1v9a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V8L7 7l1-3z"/><path d="M10 4V2.5M14 4V2.5"/></svg>',
    4: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8l1 3-2 1v9a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V8L7 7l1-3z"/><path d="M10 4V2.5M14 4V2.5"/></svg>',
    5: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v3l2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V8l2-2V3z"/><path d="M15 9h1.5a1.5 1.5 0 0 1 1.5 1.5V15a1.5 1.5 0 0 1-1.5 1.5H15"/></svg>',
    6: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v3l2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V8l2-2V3z"/><path d="M15 9h1.5a1.5 1.5 0 0 1 1.5 1.5V15a1.5 1.5 0 0 1-1.5 1.5H15"/></svg>',
  };
  // ACTIVE must match TOTAL_SLOTS in coin_slot/includes/hardware_config.h.
  const ACTIVE = 6, TOTAL = 6;
  const MAX_QTY = 10;
  // STATUS field count: "STATUS" + 5 arrays of ACTIVE + paused/phase/bundle.
  const STATUS_FIELDS = 5 * ACTIVE + 4;

  const S = {
    armedQty: new Array(TOTAL + 1).fill(0), remaining: new Array(TOTAL + 1).fill(0),
    wlvl: new Array(TOTAL + 1).fill(false), busy: new Array(TOTAL + 1).fill(false),
    queueDepth: new Array(TOTAL + 1).fill(0), paused: false,
    phase: 0, bundleComplete: false,
    lastUpdate: null, connected: false,
  };
  let staged = [], unclaimed = [], saleCtr = 0;
  let prevArmed = new Array(TOTAL + 1).fill(0);
  let prevBusy  = new Array(TOTAL + 1).fill(false);
  let prevArmedQty = new Array(TOTAL + 1).fill(0); // pulse-on-arm detection
  const $ = (id) => document.getElementById(id);

  // Toast
  let toastTmr;
  function toast(msg, type) {
    const el = $('toast'); el.textContent = msg;
    el.className = 'visible' + (type ? ' ' + type : '');
    clearTimeout(toastTmr); toastTmr = setTimeout(() => el.className = '', 2600);
  }

  // The uploader archives a sale a moment after the pump stops, so give it
  // time before re-reading rather than racing it.
  let todayTmr = null;
  function scheduleTodayRefresh() {
    clearTimeout(todayTmr);
    todayTmr = setTimeout(() => { loadToday(); loadInterrupted(); loadUnclaimed(); }, 1500);
  }

  // SSE
  function connectSSE() {
    const es = new EventSource('/api/status/stream');
    es.addEventListener('message', (e) => {
      if (e.data === 'connected') {
        // Fresh connection — reset all state
        S.connected = true;
        S.armedQty.fill(0); S.remaining.fill(0); S.wlvl.fill(false);
        S.busy.fill(false); S.queueDepth.fill(0); S.paused = false;
        S.phase = 0; S.bundleComplete = false;
        staged = []; unclaimed = [];
        unclaimedSig = null;  // force a fresh draw; the reset above may coincide with the last signature
        loadToday();   // authoritative, and survives the reload that cleared the rest
        renderStaged(); updateArm();
        refresh(); return;
      }
      if (e.data.startsWith('PRIME_ACK')) { onPrimeAck(e.data); return; }
      if (e.data.startsWith('PRICES:'))   { onPrices(e.data); return; }
      if (e.data.startsWith('PRICE_ACK')) { onPriceAck(e.data); return; }
      parse(e.data);
    });
    es.addEventListener('error', () => { S.connected = false; refresh(); });
  }

  function parse(raw) {
    const p = raw.split(','); if (p.length < STATUS_FIELDS) return;
    let i = 1;
    for (let s = 1; s <= ACTIVE; s++) S.armedQty[s]   = parseInt(p[i++]) || 0;
    for (let s = 1; s <= ACTIVE; s++) S.remaining[s]  = parseInt(p[i++]) || 0;
    for (let s = 1; s <= ACTIVE; s++) S.wlvl[s]       = p[i++] === '1';
    for (let s = 1; s <= ACTIVE; s++) S.busy[s]       = p[i++] === '1';
    for (let s = 1; s <= ACTIVE; s++) S.queueDepth[s] = parseInt(p[i++]) || 0;
    S.paused = p[i++] === '1';
    S.phase = parseInt(p[i++]) || 0;     // 0=IDLE, 1=ARMED, 2=DISPENSING, 3=COMPLETE
    S.bundleComplete = p[i] === '1';

    // A pump finishing is the cue to re-read the day's takings. Counting the
    // transitions here instead would count a line being cleared of air as a
    // sale, and would reset to zero on every page reload.
    for (let s = 1; s <= ACTIVE; s++) {
      if (!S.busy[s] && prevBusy[s]) scheduleTodayRefresh();
      prevBusy[s] = S.busy[s];
    }
    S.lastUpdate = new Date(); refresh();
  }

  // KPIs
  function refresh() {
    updateStatus();
    updateKPIs();
    renderGrid();
    renderArmed();
    renderQueue();
    renderAlerts();
    renderUnclaimed();
    renderPrime();
    updatePanelVisibility();
  }

  // The right panel earns its 260px only when one of its sections has content.
  // Each section already hides itself when empty, so this just asks whether any
  // of them is showing and lets the column collapse if not. Runs after the
  // renders, never before -- it is reading what they just decided.
  function updatePanelVisibility() {
    const sections = ['armed-section', 'dispensing-section',
                      'attention-section', 'alerts-section'];
    const anyVisible = sections.some(id => {
      const el = $(id);
      return el && el.style.display !== 'none';
    });
    document.querySelector('main').classList.toggle('panel-hidden', !anyVisible);
  }

  function updateStatus() {
    // The banner is the whole of the offline story now. The status dot said
    // the same thing in a quieter voice, and the state chip carries it too.
    $('offline-banner').style.display = S.connected ? 'none' : 'block';
    if (S.lastUpdate) {
      // Built by hand rather than toLocaleTimeString: en-US with hour12:false
      // drops the leading zero before 10am, so the field changed width twice a
      // day and nudged everything beside it.
      const d = S.lastUpdate;
      $('last-update').textContent =
          String(d.getHours()).padStart(2, '0') + ':'
        + String(d.getMinutes()).padStart(2, '0') + ':'
        + String(d.getSeconds()).padStart(2, '0');
    }
  }

  function updateKPIs() {
    let armed = 0, inStock = 0;
    for (let s = 1; s <= ACTIVE; s++) { armed += S.armedQty[s]; if (!S.wlvl[s]) inStock++; }
    $('kpi-armed').textContent = armed;
    // Lit only while presses are owed, so a lit chip carries meaning.
    $('chip-waiting').classList.toggle('is-live', armed > 0);
    $('kpi-active').textContent = inStock + '/' + ACTIVE;
    $('kpi-active').style.color = inStock === ACTIVE ? 'var(--status-positive)'
      : (inStock >= Math.ceil(ACTIVE / 2) ? 'var(--status-caution)' : 'var(--status-negative)');

    // One chip, always true. Offline outranks everything -- a stale "Ready"
    // beside a dead link would be worse than saying nothing -- then paused,
    // then the phase. Plain words, not the C++ enum names: a cashier reads
    // this, not an engineer.
    const phases = ['Ready', 'Buttons Unlocked', 'Dispensing', 'Done'];
    let state, stateColor;
    if (!S.connected) {
      state = 'Offline';  stateColor = 'var(--status-negative)';
    } else if (S.paused) {
      state = 'Paused';   stateColor = 'var(--status-caution)';
    } else {
      state = phases[S.phase] || 'Ready';
      stateColor = S.bundleComplete ? 'var(--status-positive)'
                 : (S.phase === 3 ? 'var(--accent-action)' : 'var(--text-content-primary)');
    }
    $('kpi-bundle').textContent = state;
    $('kpi-bundle').style.color = stateColor;
    // Today's figure comes from the sales archive via loadToday(), not from
    // anything counted here.
  }

  // Grid
  let gridSig = null;

  function renderGrid() {
    // STATUS arrives every 500ms and refresh() calls this each time. Replacing
    // innerHTML destroys the card under the user's finger, and a click only
    // fires if press and release land on the same element -- so a tap that
    // spanned a redraw was silently swallowed. Redraw only on real change.
    let sig = '';
    for (let s = 1; s <= TOTAL; s++)
      sig += '|' + (S.armedQty[s] || 0) + S.busy[s] + S.wlvl[s] + ':' + stagedQty(s);
    if (sig === gridSig) return;
    gridSig = sig;

    let h = '';
    for (let s = 1; s <= TOTAL; s++) {
      const act = s <= ACTIVE, armed = S.armedQty[s] || 0, busy = S.busy[s],
            empty = S.wlvl[s], inSale = stagedQty(s);
      let cls = 'product-card';
      if (!act) cls += ' inactive'; else if (busy) cls += ' busy';
      else if (empty) cls += ' empty'; else if (armed > 0 && !inSale) cls += ' armed';
      if (inSale) cls += ' selected';

      let dotHtml, dotColor;
      if (!act)      { dotHtml = '<span class="dot dot-neutral"></span> N/A';      dotColor = 'var(--text-content-secondary)'; }
      else if (busy) { dotHtml = '<span class="dot dot-caution"></span> Dispensing'; dotColor = 'var(--status-caution)'; }
      else if (empty){ dotHtml = '<span class="dot dot-negative"></span> Empty';   dotColor = 'var(--status-negative)'; }
      else if (inSale) { dotHtml = '<span class="dot dot-accent"></span> In sale';   dotColor = 'var(--accent-action)'; }
      else if (armed){ dotHtml = '<span class="dot dot-positive"></span> Unlocked'; dotColor = 'var(--status-positive)'; }
      else           { dotHtml = '<span class="dot dot-ready"></span> Ready';      dotColor = 'var(--text-content-secondary)'; }

      const justArmed = act && !prevArmedQty[s] && armed > 0;
      prevArmedQty[s] = armed;
      const qCls = !act || armed === 0 ? 'is-zero' : (busy ? 'is-busy' : (inSale ? 'is-selected' : 'is-armed'));
      const pulseCls = justArmed ? ' pulse-arm' : '';

      h += '<div class="'+cls+'" data-slot="'+s+'" data-product="'+s+'">';
      if (inSale) h += '<div class="staged-badge">'+inSale+'</div>';
      h += '<div class="product-icon">'+PRODUCT_ICON[s]+'</div>';
      // Name and state stack on the left, the count sits out on the right.
      // Stacking all four made the card 131px; as a row it is about half that,
      // which is what puts the whole dashboard on one screen.
      h += '<div class="text-panel">';
      h += '<div class="product-name"><span class="slot-num">'+String(s).padStart(2,'0')+'</span>'+PRODUCT[s]+'</div>';
      h += '<div class="status-row" style="color:'+dotColor+'">'+dotHtml+'</div>';
      h += '</div>';
      h += '<div class="armed-qty '+qCls+pulseCls+'">'+(act ? armed : '--')+'</div>';
      h += '</div>';
    }
    $('grid-container').innerHTML = h;
  }

  // Right panel
  let armedSig = null;

  function renderArmed() {
    let sig = '';
    for (let s = 1; s <= ACTIVE; s++)
      sig += '|' + (S.armedQty[s] || 0) + S.busy[s];
    if (sig === armedSig) return;
    armedSig = sig;

    let h = '', cnt = 0;
    for (let s = 1; s <= ACTIVE; s++) {
      if (S.armedQty[s] > 0 || S.busy[s]) {
        cnt += S.armedQty[s];
        const dot = S.busy[s] ? '<span class="dot dot-caution"></span>' : '<span class="dot dot-positive"></span>';
        h += '<div class="list-row">'+dot+'<span class="list-name">'+PRODUCT[s]+'</span>';
        h += '<span class="list-val">'+S.armedQty[s]+'</span>';
        h += '<button class="btn-negative" data-slot="'+s+'">Cancel</button></div>';
      }
    }
    $('armed-count').textContent = cnt;
    $('armed-list').innerHTML = h || '<span class="muted">--</span>';
    $('btn-cancel-all').style.display = h ? 'block' : 'none';
    $('armed-section').style.display = h ? 'block' : 'none';
  }

  function renderQueue() {
    let h = '', cnt = 0;
    for (let s = 1; s <= ACTIVE; s++) {
      if (S.busy[s]) {
        cnt++;
        let pct = S.remaining[s] > 0 ? Math.round(100 - (S.remaining[s] / 2500) * 100) : 100;
        h += '<div class="list-row"><span style="font-weight:600;">'+PRODUCT[s]+'</span><span class="list-val">'+pct+'%</span></div>';
      }
    }
    $('queue-count').textContent = cnt;
    $('queue-list').innerHTML = h || '<span class="muted">--</span>';
    $('dispensing-section').style.display = h ? 'block' : 'none';
  }

  function renderAlerts() {
    let issues = '';
    for (let s = 1; s <= ACTIVE; s++) {
      if (S.wlvl[s]) issues += '<div class="list-row" style="color:var(--status-negative);"><span><span class="dot dot-negative"></span> SLOT '+String(s).padStart(2,'0')+': '+PRODUCT[s]+'</span><span>[EMPTY]</span></div>';
    }
    if (!S.connected) issues += '<div class="list-row" style="color:var(--status-negative);"><span><span class="dot dot-negative"></span> Machine offline</span><span>[OFFLINE]</span></div>';
    if (issues) {
      let issueCount = (issues.match(/list-row/g) || []).length;
      $('alert-list').innerHTML = '<div class="alert-card"><div class="alert-heading">'+issueCount+' issue(s) detected</div>'+issues+'</div>';
      $('alerts-section').style.display = 'block';
    } else {
      $('alert-list').innerHTML = '<span class="muted">--</span>';
      $('alerts-section').style.display = 'none';
    }
  }

  let unclaimedSig = null;

  function renderUnclaimed() {
    // renderInterrupted() only ever sets #attention-section to display:block
    // -- it never hides it. This function is the only place the hide happens,
    // so that decision is made every call, unconditionally, before the redraw
    // guard below. Putting it behind the guard would leave the panel stuck on
    // screen forever if the last row settled on a refresh the guard suppressed.
    $('attention-section').style.display = (unclaimed.length || interrupted.length) ? 'block' : 'none';

    // STATUS arrives every 500ms and refresh() calls this each time. These
    // rows carry Unlock Again / Write Off buttons -- a click only fires if
    // press and release land on the same element, so an unguarded rebuild
    // drops a real fraction of taps on the controls that settle the till.
    let sig = interrupted.length + '|' + unclaimed.map(it => it.key + ':' + it.qty).join(',');
    if (sig === unclaimedSig) return;
    unclaimedSig = sig;

    if (!unclaimed.length) {
      $('unclaimed-list').innerHTML = '';
      return;
    }
    let h = '';
    unclaimed.forEach((it) => {
      const at = String(it.date_created || '').slice(11, 16);
      h += '<div class="interrupted-row">'
         + '<div class="i-head"><span>' + it.name + '</span>'
         + '<span>₱' + it.amount + (at ? ' · ' + at : '') + '</span></div>'
         + '<div class="i-why">' + it.qty + ' press' + (it.qty !== 1 ? 'es' : '')
         + ' paid for but never used — the button timed out</div>'
         + '<div class="i-actions">'
         + '<button class="btn btn-sm" data-key="' + it.key + '" data-qty="' + it.qty
         + '" data-act="rearm">Unlock Again</button>'
         + '<button class="btn btn-sm btn-outline" data-key="' + it.key
         + '" data-qty="' + it.qty
         + '" data-act="writeoff">Write Off</button>'
         + '</div></div>';
    });
    $('unclaimed-list').innerHTML = h;
  }

  // Sale
  // How many presses of this product are already in the sale. Drives both the
  // card badge and the +/- controls.
  function stagedQty(id) {
    const it = staged.find(x => x.id === id);
    return it ? it.qty : 0;
  }

  // One tap adds one press. Tapping again adds another -- stageItem merges by
  // product id, so the sale strip shows one card with a rising count rather
  // than a row per tap. Removing is the x on the staged card, or - at one.
  function selectProduct(id) {
    if (stagedQty(id) >= MAX_QTY) {
      toast('Maximum ' + MAX_QTY + ' presses per product', 'caution');
      return;
    }
    stageItem(id, 1);
  }

  function stageItem(id, qty) {
    const ml = qty * (PRODUCT_ML[id] || 0);
    // Merge: if product already staged, add to existing qty
    const existing = staged.find(it => it.id === id);
    if (existing) { existing.qty += qty; existing.ml += ml; }
    else { staged.push({ id, name: PRODUCT[id], qty, ml }); }
    renderStaged(); renderGrid(); updateArm();
  }
  function removeStaged(i) { staged.splice(i,1); renderStaged(); renderGrid(); updateArm(); }
  // Down to zero removes the item. A staged card showing 0x would be a thing
  // the cashier has to tidy up by hand for no reason.
  function adjustStaged(id, delta) {
    const i = staged.findIndex(x => x.id === id);
    if (i < 0) return;
    const it = staged[i];
    const next = it.qty + delta;
    // Removing an item changes the list itself, so this one has to redraw.
    if (next < 1) { staged.splice(i, 1); renderStaged(); renderGrid(); updateArm(); return; }
    if (next > MAX_QTY) {
      toast('Maximum ' + MAX_QTY + ' presses per product', 'caution');
      return;
    }
    it.qty = next;
    it.ml = next * (PRODUCT_ML[id] || 0);

    // Update the count in place rather than rebuilding the list. innerHTML
    // destroys the button under the finger mid-press: the replacement is a
    // different element that never received the pointerdown, so :active does
    // not apply to it and the press state vanishes after a frame. A control
    // that flashes and dies reads as broken, which is worse than one that
    // never lit up at all.
    const card = $('staged-items').querySelector('.staged-card[data-id="'+id+'"]');
    const qtyEl = card && card.querySelector('.staged-card-qty');
    if (qtyEl) {
      qtyEl.textContent = next + '×';
      // Remove, force a reflow, re-add. Without the reflow the engine never
      // sees the class leave, so a second press inside the animation's own
      // duration would not replay it -- which is exactly when a cashier is
      // tapping fastest.
      qtyEl.classList.remove('pop');
      void qtyEl.offsetWidth;
      qtyEl.classList.add('pop');
    } else {
      renderStaged();
    }
    updateSaleTotal(); renderGrid(); updateArm();
  }
  function renderStaged() {
    if (!staged.length) {
      $('staged-items').innerHTML = '<span class="muted">Tap a product to add it</span>';
      updateSaleTotal();
      return;
    }
    let h = '';
    staged.forEach((it, i) => {
      // data-id is what lets a quantity change find its own card and update
      // in place instead of rebuilding the whole list. See adjustStaged.
      h += '<div class="staged-card" data-id="'+it.id+'">'
         + '<div class="staged-card-text">'
         + '<span class="staged-card-name">'+it.name+'</span>'
         + '<span class="staged-card-ml">'+(PRODUCT_ML[it.id] || 0)+'ml</span>'
         + '</div>'
         + '<span class="staged-card-qty">'+it.qty+'\xD7</span>'
         + '<button class="staged-step" data-id="'+it.id+'" data-delta="-1" aria-label="One less">&minus;</button>'
         + '<button class="staged-step" data-id="'+it.id+'" data-delta="1" aria-label="One more">+</button>'
         + '</div>';
    });
    $('staged-items').innerHTML = h;
    updateSaleTotal();
  }

  // Split out of renderStaged so a quantity change can refresh the total
  // without rebuilding the list underneath the finger that caused it.
  //
  // Pesos only. The per-product press count is already on each staged card,
  // and that is the number that matters -- the customer presses each
  // product's own button its own number of times, so a total across products
  // was never something anyone acts on. Falls back to presses if any staged
  // product has no price, so the strip still says something true rather than
  // a total that isn't.
  function updateSaleTotal() {
    if (!staged.length) { $('sale-total').textContent = '₱0'; return; }
    let pesos = 0, priced = true, totalQty = 0;
    staged.forEach((it) => {
      totalQty += it.qty;
      if (prices[it.id] == null) priced = false;
      else pesos += prices[it.id] * it.qty;
    });
    const presses = totalQty + ' press' + (totalQty !== 1 ? 'es' : '');
    $('sale-total').textContent = priced ? '₱' + pesos : presses;
  }
  function updateArm() {
    $('btn-arm').disabled = !staged.length;
    $('btn-arm').textContent = staged.length
      ? 'Unlock '+staged.length+' Button'+(staged.length>1?'s':'')
      : 'Unlock Buttons';
  }

  // API
  async function executeArm() {
    if (!staged.length) return;
    // Busy, not merely disabled -- see .btn.is-busy. "Please wait..." on a
    // button faded to 25% reads as broken; the shimmer reads as working.
    $('btn-arm').disabled = true;
    $('btn-arm').classList.add('is-busy');
    $('btn-arm').textContent = 'Unlocking…';
    const sid = 'SALE-'+Date.now()+'-'+(++saleCtr);
    // Build ARM_BATCH payload: slot:qty,slot:qty,...
    const batch = staged.map(i => i.id+':'+i.qty).join(',');
    try {
      const r = await fetch('/api/arm', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ saleId:sid, batch }) });
      const d = await r.json();
      if (d.success) {
        toast('Buttons unlocked: '+staged.map(i=>i.name+' ('+i.qty+'x)').join(', '), 'success');
        staged = [];
        renderStaged(); renderGrid(); updateArm();
      } else {
        toast('Could not unlock: '+ (d.error || 'unknown'), 'error');
      }
    } catch(e) { toast('Error: '+e.message, 'error'); }
    finally { $('btn-arm').classList.remove('is-busy'); updateArm(); }
  }
  async function cancelSlot(id) {
    try {
      await fetch('/api/cancel', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({productId:id}) });
      toast((PRODUCT[id] || ('Slot ' + id)) + ' cancelled', 'info');
    } catch(e) { /* silent */ }
  }

  async function cancelAll() {
    // S.armedQty is an Array(TOTAL + 1) indexed from 1, not a map. CANCEL_ALL
    // on the controller writes off armedQty PLUS everything drained from
    // pendingQueue -- a slot can be busy (armedQty back to 0) with paid-for
    // presses queued behind it, so counting only armedQty here would let a
    // real write-off through with no prompt at all. queueDepth counts queued
    // *entries*, not presses, so the two are named separately rather than
    // summed as if they were the same unit.
    let armed = 0, queued = 0;
    for (let s = 1; s <= TOTAL; s++) {
      armed += (S.armedQty[s] || 0);
      queued += (S.queueDepth[s] || 0);
    }
    if (armed > 0 || queued > 0) {
      const bits = [];
      if (armed > 0) bits.push(armed + ' armed press' + (armed !== 1 ? 'es' : ''));
      if (queued > 0) bits.push(queued + ' queued credit' + (queued !== 1 ? 's' : ''));
      const ok = await askConfirm(
        'Cancel ' + bits.join(' and ') + ' — already paid for?', 'Cancel Credits');
      if (!ok) return;
    }
    try {
      await fetch('/api/cancel-all', { method:'POST', headers:{'Content-Type':'application/json'} });
      toast('All cancelled', 'info');
    } catch(e) { /* silent */ }
  }

  // ---------------------------------------------------------------------
  // Maintenance: prime / purge
  //
  // A prime dispenses product and books no sale, so the UI works against
  // casual use: collapsed by default, and a tap only arms the button -- a
  // second tap fires it. The count beside each line is the controller's own
  // record, shown back to staff so a prime is never an invisible act.
  // ---------------------------------------------------------------------
  let primeCounts = {}, primeSeconds = 3, primeArmedSlot = null, primeArmTmr = null;
  let primeSig = null;

  async function loadPrimeInfo() {
    try {
      const r = await fetch('/api/prime');
      const d = await r.json();
      primeCounts  = d.today || {};
      primeSeconds = d.seconds || 3;
      $('prime-secs').textContent = primeSeconds;
      $('prime-today').textContent = d.todayTotal || 0;
      renderPrime();
    } catch (e) { /* panel still usable without the count */ }
  }

  function disarmPrime() {
    primeArmedSlot = null;
    clearTimeout(primeArmTmr);
    renderPrime();
  }

  function renderPrime() {
    const el = $('prime-list');
    if (!el || $('settings-sheet').hidden) return;

    // STATUS arrives every 500ms and refresh() calls this each time. Rebuilding
    // the rows blindly would swap the button out from under a finger mid-tap,
    // so only redraw when something actually changed.
    let sig = String(primeArmedSlot) + '|' + S.paused + '|' + S.connected;
    for (let s = 1; s <= ACTIVE; s++)
      sig += '|' + (primeCounts[s] || 0) + S.wlvl[s] + S.busy[s];
    if (sig === primeSig) return;
    primeSig = sig;

    let h = '';
    for (let s = 1; s <= ACTIVE; s++) {
      const n = primeCounts[s] || 0;
      // Say WHY it cannot be pressed. A dead button with no explanation sends
      // people hunting for a fault that is not there. Armed credits are no
      // longer a reason -- priming beside a waiting customer is the whole point.
      const why = !S.connected ? 'machine offline'
                : S.paused     ? 'machine paused'
                : S.wlvl[s]    ? 'tank empty — refill first'
                : S.busy[s]    ? 'dispensing now'
                : null;
      const armed = primeArmedSlot === s;
      h += '<div class="prime-row">'
         + '<span class="prime-name">' + PRODUCT[s]
         + (why ? '<span class="prime-why">' + why + '</span>' : '')
         + '</span>'
         + '<span class="prime-count' + (n > 0 ? ' busy' : '') + '">'
         + (n > 0 ? n + ' today' : '&mdash;') + '</span>'
         + '<button class="btn btn-sm' + (armed ? ' confirm' : '') + '" data-prime="' + s + '"'
         + (why ? ' disabled' : '') + '>'
         + (armed ? 'Tap again' : 'Clear Air') + '</button>'
         + '</div>';
    }
    el.innerHTML = h;
  }

  function onPrimeTap(slot) {
    if (primeArmedSlot !== slot) {
      // First tap only arms. A pump that starts on a single mis-tap is the
      // one thing this panel must not do.
      primeArmedSlot = slot;
      renderPrime();
      clearTimeout(primeArmTmr);
      primeArmTmr = setTimeout(disarmPrime, 5000);
      toast('Tap again to clear air from ' + PRODUCT[slot], 'info');
      return;
    }
    disarmPrime();
    doPrime(slot);
  }

  async function doPrime(slot) {
    try {
      const r = await fetch('/api/prime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot }),
      });
      const d = await r.json();
      if (!d.success) {
        toast(d.reason === 'controller_offline'
              ? 'Machine unreachable — nothing was sent'
              : 'Could not clear air: ' + (d.reason || 'unknown'), 'error');
      }
      // A success here only means the command was sent. The controller
      // decides, and answers with PRIME_ACK over SSE.
    } catch (e) {
      toast('Could not clear air: ' + e.message, 'error');
    }
  }

  function onPrimeAck(raw) {
    const p = raw.split(',');
    const slot = parseInt(p[1], 10);
    const result = (p[2] || '').trim();
    const name = PRODUCT[slot] || ('Slot ' + slot);

    if (result === 'started') {
      toast('Clearing air from ' + name + ' — ' + primeSeconds + 's, no sale recorded', 'success');
      // Re-read the controller's log rather than incrementing locally, so the
      // number staff see is always the one on disk.
      setTimeout(loadPrimeInfo, (primeSeconds * 1000) + 500);
      return;
    }

    const why = {
      slot_busy:    name + ' is dispensing right now. Try again in a moment.',
      slot_empty:   name + ' reads empty. Replace the gallon first.',
      paused:       'Machine is paused.',
      max_active:   'Two pumps already running. Try again in a moment.',
      invalid_slot: 'Unknown product.',
    };
    toast(why[result] || ('Could not clear air: ' + result), 'error');
  }

  // ---------------------------------------------------------------------
  // Interrupted sales
  //
  // A tank ran dry part-way through a pour. The customer was charged in full,
  // so the sale is recorded in full -- but they may not have received what
  // they paid for, and only a person standing there can settle that.
  // ---------------------------------------------------------------------
  let interrupted = [];

  async function loadInterrupted() {
    try {
      const d = await (await fetch('/api/interrupted')).json();
      interrupted = d.entries || [];
      renderInterrupted();
    } catch (e) { /* the panel is not worth breaking the till for */ }
  }

  async function loadUnclaimed() {
    try {
      const d = await (await fetch('/api/unclaimed')).json();
      unclaimed = d.entries || [];
      renderUnclaimed();
    } catch (e) { /* leave the last good list on screen */ }
  }

  function renderInterrupted() {
    let h = '';
    interrupted.forEach((it) => {
      const at = String(it.date_created || '').slice(11, 16);
      h += '<div class="interrupted-row">'
         + '<div class="i-head"><span>' + it.name + '</span>'
         + '<span>₱' + it.amount + (at ? ' · ' + at : '') + '</span></div>'
         + '<div class="i-why">tank ran dry mid-pour — charged in full, '
         + 'check the customer got their product</div>'
         + '</div>';
    });
    $('interrupted-list').innerHTML = h;
    if (h) $('attention-section').style.display = 'block';
  }

  // ---------------------------------------------------------------------
  // Today's takings
  //
  // Read from the sales archive rather than counted in the browser. The old
  // counter was a variable that reset on every reload -- and it counted any
  // pump start, so clearing air from a line inflated the day's sales.
  //
  // Chosen to stay legible on an iPad in daylight and to a colour-blind
  // reader: every slice is labelled, and colour never carries meaning alone.
  // ---------------------------------------------------------------------
  const MIX_COLOURS = ['#3B6DF0', '#34D399', '#FBBF24', '#F87171', '#8B5CF6', '#22D3EE'];
  let todayPesos = 0, todayPresses = 0;

  async function loadToday() {
    try {
      const d = await (await fetch('/api/sales/today')).json();
      todayPesos = d.pesos || 0;
      todayPresses = d.presses || 0;
      $('kpi-today').textContent = '₱' + todayPesos;
      renderToday(d);
    } catch (e) { /* the machine still sells without its report */ }
  }

  function renderToday(d) {
    if ($('today-panel').hidden) return;

    $('today-pesos').textContent = '₱' + (d.pesos || 0);
    $('today-presses').textContent = (d.presses || 0) + ' press'
                                   + ((d.presses || 0) !== 1 ? 'es' : '');

    const rows = (d.products || []).slice().sort((a, b) => b.pesos - a.pesos);
    const total = d.pesos || 0;

    let bar = '';
    rows.forEach((r) => {
      if (!r.pesos || !total) return;
      const pct = (r.pesos / total) * 100;
      bar += '<span style="width:' + pct.toFixed(2) + '%;background:'
           + MIX_COLOURS[(r.slot - 1) % MIX_COLOURS.length]
           + '" title="' + r.name + '"></span>';
    });
    $('today-mix').innerHTML = bar;
    $('today-mix').style.display = bar ? 'flex' : 'none';

    let h = '';
    rows.forEach((r) => {
      const share = total ? Math.round((r.pesos / total) * 100) : 0;
      h += '<div class="today-row' + (r.presses ? '' : ' zero') + '">'
         + '<span class="swatch" style="background:'
         + MIX_COLOURS[(r.slot - 1) % MIX_COLOURS.length] + '"></span>'
         + '<span>' + r.name + '</span>'
         + '<span class="t-presses">' + r.presses + ' ×'
         + (r.presses && total ? '  · ' + share + '%' : '') + '</span>'
         + '<span class="t-pesos">₱' + r.pesos + '</span>'
         + '</div>';
    });
    $('today-list').innerHTML = h;

    const note = $('today-note');
    if (!d.presses) {
      note.textContent = 'No sales recorded yet today.';
    } else {
      note.textContent = 'Counted when a pump finishes a press, so clearing air '
                       + 'is not included. Each sale is recorded at the price in '
                       + 'force at the time, so changing a price does not rewrite '
                       + 'earlier takings.'
                       + (d.lastSaleAt ? '  Last sale ' + d.lastSaleAt + '.' : '');
    }
  }

  function todayOpen() { return !$('today-panel').hidden; }

  function openToday() {
    const panel = $('today-panel');
    panel.hidden = false;
    $('kpi-today-card').setAttribute('aria-expanded', 'true');
    loadToday();

    // Travel to it. A panel that simply appeared below the fold would look
    // like the tap did nothing at all.
    const reduced = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      panel.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
    } catch (_) {
      panel.scrollIntoView();   // older Safari takes no options
    }

    panel.classList.remove('arrived');
    // Force a reflow so the animation restarts on a second tap.
    void panel.offsetWidth;
    panel.classList.add('arrived');
  }

  function closeToday() {
    $('today-panel').hidden = true;
    $('kpi-today-card').setAttribute('aria-expanded', 'false');
    // Back to the chip that opened it, so the screen does not just jump.
    $('kpi-today-card').scrollIntoView({ block: 'nearest' });
  }

  function toggleToday() { todayOpen() ? closeToday() : openToday(); }

  // ---------------------------------------------------------------------
  // Prices
  //
  // Set per client, so they are edited here rather than compiled in. The
  // controller owns the value and audits every change; this screen only
  // proposes one. Nothing is applied until Save, and the controller can still
  // refuse -- it will not move a price with a sale in progress.
  // ---------------------------------------------------------------------
  let prices = {}, priceDirty = false;

  function onPrices(raw) {
    try { prices = JSON.parse(raw.slice(7)) || {}; } catch (_) { return; }
    // Never redraw over someone mid-edit; their unsaved figures would vanish.
    if (!priceDirty) renderPrices();
    renderStaged();
  }

  function renderPrices() {
    const el = $('price-list');
    if (!el || $('settings-sheet').hidden) return;
    let h = '';
    for (let s = 1; s <= ACTIVE; s++) {
      const v = prices[s] != null ? prices[s] : '';
      h += '<div class="price-row">'
         + '<span class="price-name">' + PRODUCT[s] + '</span>'
         + '<span class="peso">₱</span>'
         + '<input type="number" inputmode="numeric" min="0" max="10000" step="1"'
         + ' data-price="' + s + '" value="' + v + '" aria-label="' + PRODUCT[s] + ' price">'
         + '</div>';
    }
    el.innerHTML = h;
    priceDirty = false;
    $('btn-save-prices').disabled = true;
  }

  function markPriceDirty(input) {
    const slot = parseInt(input.dataset.price, 10);
    const changed = String(prices[slot] != null ? prices[slot] : '') !== input.value.trim();
    input.classList.toggle('dirty', changed);

    priceDirty = false;
    $('price-list').querySelectorAll('[data-price]').forEach((i) => {
      if (i.classList.contains('dirty')) priceDirty = true;
    });
    $('btn-save-prices').disabled = !priceDirty;
  }

  async function savePrices() {
    const body = {};
    let bad = null;
    $('price-list').querySelectorAll('[data-price]').forEach((i) => {
      const slot = parseInt(i.dataset.price, 10);
      const val = parseInt(i.value, 10);
      if (!Number.isFinite(val) || val < 0 || val > 10000) { bad = PRODUCT[slot]; return; }
      body[slot] = val;
    });

    if (bad) { toast('Price for ' + bad + ' is not a whole number of pesos', 'error'); return; }

    $('btn-save-prices').disabled = true;
    try {
      const r = await fetch('/api/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices: body }),
      });
      const d = await r.json();
      if (!d.success) {
        toast(d.reason === 'controller_offline'
              ? 'Machine unreachable — prices not changed'
              : 'Prices rejected: ' + (d.reason || 'unknown'), 'error');
        $('btn-save-prices').disabled = false;
        return;
      }
      if (!d.changed) { toast('No price changed', 'info'); renderPrices(); return; }
      // The controller answers each change with PRICE_ACK; wait for it rather
      // than claiming success for something it may refuse.
      priceDirty = false;
    } catch (e) {
      toast('Could not save prices: ' + e.message, 'error');
      $('btn-save-prices').disabled = false;
    }
  }

  function onPriceAck(raw) {
    const p = raw.split(',');
    const slot = parseInt(p[1], 10);
    const result = (p[2] || '').trim();
    const name = PRODUCT[slot] || ('Slot ' + slot);

    if (result === 'ok') { toast(name + ' price saved', 'success'); loadPriceHistory(); return; }

    const why = {
      sale_in_progress: 'Cannot change prices while a sale is waiting. Finish or cancel it first.',
      invalid_price:    name + ': price must be a whole number of pesos.',
      invalid_slot:     'Unknown product.',
      not_saved:        name + ' changed, but could NOT be saved — it will revert on restart.',
    };
    toast(why[result] || (name + ': ' + result), 'error');
  }

  async function loadPriceHistory() {
    try {
      const d = await (await fetch('/api/prices/history')).json();
      const el = $('price-history');
      if (!d.changes || !d.changes.length) { el.textContent = ''; return; }
      const c = d.changes[0];
      const name = PRODUCT[parseInt(c.slot, 10)] || ('Slot ' + c.slot);
      el.textContent = 'Last change: ' + name + '  ₱' + c.from
                     + ' → ₱' + c.to + '   ' + (c.date_created || '');
    } catch (e) { /* history is context, not essential */ }
  }

  // ---------------------------------------------------------------------
  // Settings sheet
  // ---------------------------------------------------------------------
  function settingsOpen() { return !$('settings-sheet').hidden; }

  function openSettings() {
    $('settings-backdrop').hidden = false;
    $('settings-sheet').hidden = false;
    loadInfo();
    loadPrimeInfo();
    loadPrices();
    loadPriceHistory();
  }

  function closeSettings() {
    $('settings-backdrop').hidden = true;
    $('settings-sheet').hidden = true;
    primeSig = null;   // force a fresh draw next time it opens
    // Never leave a prime half-confirmed behind a closed sheet.
    disarmPrime();
    // Unsaved price edits are discarded rather than silently kept: reopening
    // to figures that were never applied is worse than losing the typing.
    priceDirty = false;
  }

  async function loadPrices() {
    try {
      const d = await (await fetch('/api/prices')).json();
      prices = d.prices || {};
      renderPrices();
      renderStaged();
    } catch (e) { /* the panel still opens without them */ }
  }

  $('kpi-today-card').addEventListener('click', toggleToday);
  $('kpi-today-card').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleToday(); }
  });
  $('today-close').addEventListener('click', closeToday);

  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-backdrop').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (settingsOpen()) closeSettings();
    else if (todayOpen()) closeToday();
  });

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
        // The grid was drawn with placeholders; force it past the redraw guard.
        gridSig = null; armedSig = null; primeSig = null;
        refresh();
      }

      // Settings is the only place the machine id appears now -- it never
      // changes while anyone is watching, so it does not earn header space.
      $('info-machine').textContent = d.machineId || '--';
      $('info-url').textContent = d.lanUrl || location.origin;
      const conn = $('info-controller');
      conn.textContent = d.controllerConnected ? 'Connected' : 'Not connected';
      conn.className = 'sheet-val ' + (d.controllerConnected ? 'good' : 'bad');
    } catch (e) {
      $('info-url').textContent = location.origin;
    }
  }

  // Theme
  const html = document.documentElement;
  const saved = localStorage.getItem('sabon-theme');
  if (saved) html.setAttribute('data-theme', saved);
  function themeLabel() {
    return html.getAttribute('data-theme') === 'dark' ? 'Switch to Light' : 'Switch to Dark';
  }
  $('theme-toggle').textContent = themeLabel();
  $('theme-toggle').addEventListener('click', () => {
    const nxt = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', nxt);
    localStorage.setItem('sabon-theme', nxt);
    $('theme-toggle').textContent = themeLabel();
  });

  // ---- Press feedback, driven by pointer events --------------------------
  // Chrome on Android does not apply :active the moment a finger lands. It
  // waits until it is sure the gesture is not the start of a scroll, and
  // inside a scrolling container a quick tap can be over before it decides --
  // so the press state never becomes visible. A mouse has no such ambiguity,
  // which is why Windows looked fine and the tablet looked dead.
  //
  // Driving the class from pointerdown removes the guesswork. :active is kept
  // in the stylesheet alongside it for mouse and keyboard.
  const PRESSABLE = '.btn, .product-card, .staged-step,'
                  + ' .chip-today, .tab, button';
  let pressedEl = null;
  function setPressed(el) {
    if (pressedEl === el) return;
    if (pressedEl) pressedEl.classList.remove('is-pressed');
    pressedEl = el;
    if (el) el.classList.add('is-pressed');
  }
  document.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest(PRESSABLE);
    if (el && !el.disabled) setPressed(el);
  }, { passive: true });
  // pointercancel is the one that matters on touch: the browser fires it the
  // moment it decides the gesture is a scroll, which is exactly when the press
  // state should be dropped rather than left stuck on a card sliding away.
  ['pointerup', 'pointercancel', 'pointerleave', 'blur', 'scroll'].forEach((e) =>
    document.addEventListener(e, () => setPressed(null), { passive: true, capture: true }));

  // ---- Kiosk -------------------------------------------------------------
  // Keep the screen awake while the till is open. A cashier should never have
  // to wake the tablet with a customer waiting, and the counter device is on
  // mains power. Every failure path here is silent on purpose: the lock is
  // refused on low battery, in a background tab, and on browsers that have no
  // Wake Lock at all, and none of those are worth interrupting a sale for.
  let wakeLock = null;
  async function holdScreenAwake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      // The browser drops the lock whenever the page is hidden, so the
      // release handler is what lets the visibility listener below re-take it.
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* not available, not permitted, or battery too low */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wakeLock) holdScreenAwake();
  });
  holdScreenAwake();

  // Fullscreen for Android and the counter PC. iOS Safari implements the
  // Fullscreen API for video only, so on an iPad the whole row is hidden and
  // the chromeless path is Add to Home Screen instead -- see docs/KIOSK.md.
  //
  // The preference is remembered, because fullscreen itself cannot be. A
  // reload or a reboot drops it, and no page is allowed to put itself
  // fullscreen on load -- browsers require a user gesture, or every pop-up ad
  // would take the screen. So the tablet comes up in a normal window and
  // enters fullscreen on the first touch of the shift, which is a gesture and
  // is therefore permitted.
  const FS_KEY = 'sabon-fullscreen';
  if (document.documentElement.requestFullscreen && document.exitFullscreen) {
    const btn = $('btn-fullscreen');
    $('row-fullscreen').hidden = false;

    let fsWanted = false;
    try { fsWanted = localStorage.getItem(FS_KEY) === '1'; } catch (e) {}

    function paintFs() {
      btn.textContent = fsWanted ? 'On' : 'Off';
      btn.classList.toggle('is-on', fsWanted);
      btn.setAttribute('aria-pressed', fsWanted ? 'true' : 'false');
    }
    function rememberFs(on) {
      fsWanted = on;
      try { on ? localStorage.setItem(FS_KEY, '1') : localStorage.removeItem(FS_KEY); } catch (e) {}
      paintFs();
    }
    function goFullscreen() {
      if (document.fullscreenElement) return null;
      const p = document.documentElement.requestFullscreen();
      // A refusal is not worth a toast -- but it IS worth retrying, so the
      // promise is handed back rather than swallowed here.
      if (p && p.catch) p.catch(() => {});
      return p;
    }

    // Restoring fullscreen after a reload has to wait for a gesture, and on
    // touch the gesture is not where it looks. Chrome grants user activation
    // on touchend/click, NOT on pointerdown -- so an attempt fired from
    // pointerdown is refused for having no activation, which is exactly how
    // this failed on the tablet: fullscreen worked when toggled by hand, then
    // never came back after a reload.
    //
    // It also stays armed until it succeeds. One refused attempt used to end
    // the matter silently.
    let armed = false;
    function tryRestore() {
      if (!fsWanted || document.fullscreenElement) { disarmRestore(); return; }
      const p = goFullscreen();
      if (p && p.then) p.then(disarmRestore, () => {});   // refused: keep listening
      else disarmRestore();
    }
    function armRestore() {
      if (armed) return;
      armed = true;
      document.addEventListener('click', tryRestore, true);
      document.addEventListener('touchend', tryRestore, true);
      document.addEventListener('keyup', tryRestore, true);
    }
    function disarmRestore() {
      armed = false;
      document.removeEventListener('click', tryRestore, true);
      document.removeEventListener('touchend', tryRestore, true);
      document.removeEventListener('keyup', tryRestore, true);
    }

    btn.addEventListener('click', () => {
      if (fsWanted) {
        // The toggle is the only thing that turns the preference off.
        rememberFs(false);
        disarmRestore();
        if (document.fullscreenElement) {
          const p = document.exitFullscreen();
          if (p && p.catch) p.catch(() => {});
        }
      } else {
        rememberFs(true);
        goFullscreen();               // inside a gesture, so this is allowed
      }
    });

    // Anything else that ends fullscreen -- a stray swipe down on Android,
    // Escape on a PC, the browser dropping it on its own -- is treated as
    // accidental and re-armed, so the next tap puts it back.
    //
    // This used to switch the preference off instead, on the reasoning that
    // someone who just got out should stay out. On a till that was wrong: one
    // accidental swipe disabled fullscreen permanently and the toggle had to
    // be found again in Settings. Deliberately leaving is what the toggle is
    // for, and it is two taps away.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && fsWanted) armRestore();
    });

    if (fsWanted) armRestore();
    paintFs();
  }

  // Tap handling is delegated to the containers, which are never replaced.
  // A listener bound to a card or row dies with it on the next redraw, and a
  // tap that spans one would be lost -- when the element under the finger is
  // swapped between press and release the browser dispatches the click on the
  // nearest surviving ancestor, which is the container.
  $('grid-container').addEventListener('click', (e) => {
    const card = e.target.closest('.product-card');
    if (!card) return;
    const s = +card.dataset.slot;
    if (s <= ACTIVE && !S.wlvl[s]) selectProduct(s);
  });

  $('armed-list').addEventListener('click', (e) => {
    const b = e.target.closest('.btn-negative');
    if (b) cancelSlot(+b.dataset.slot);
  });

  $('unclaimed-list').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const body = { key: b.dataset.key, action: b.dataset.act };
    // Sent for both actions: the re-arm needs it to arm the right number, and
    // the write-off needs it recorded, because how many presses were lost is
    // the whole point of the settlement log.
    body.qty = +b.dataset.qty;
    try {
      const r = await (await fetch('/api/unclaimed/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })).json();
      if (!r.success) { toast(r.error || 'Could not settle that', 'error'); return; }
      // Another device got there first. Saying "unlocked again" here would send
      // the customer to press a button that carries no credit.
      if (r.already) { toast('Already settled on another device', 'caution'); loadUnclaimed(); return; }
      toast(b.dataset.act === 'rearm' ? 'Button unlocked again' : 'Written off', 'success');
      loadUnclaimed();
    } catch (e) { toast('Could not settle that', 'error'); }
  });

  $('price-list').addEventListener('input', (e) => {
    const i = e.target.closest('[data-price]');
    if (i) markPriceDirty(i);
  });
  $('btn-save-prices').addEventListener('click', savePrices);

  $('prime-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-prime]');
    if (b && !b.disabled) onPrimeTap(parseInt(b.dataset.prime, 10));
  });

  // Offline retry
  $('offline-retry').addEventListener('click', () => { connectSSE(); });

  // Sale events
  // Staged cards: -/+ steppers and the remove (x) button are both rebuilt on
  // every renderStaged(), so bind once on the stable parent instead of on the
  // buttons themselves.
  $('staged-items').addEventListener('click', (ev) => {
    const step = ev.target.closest('.staged-step');
    // The hold already removed the item; the click that follows the release
    // would otherwise take one off whatever is now in that position.
    if (holdFired) { holdFired = false; return; }
    if (step) { adjustStaged(+step.dataset.id, +step.dataset.delta); return; }
  });

  // Ask the cashier something, without handing the screen to the browser.
  // window.confirm() would be one line, but a native dialog is drawn outside
  // the page: Android Chrome leaves fullscreen to show it and re-enters
  // afterwards, so the kiosk flickers back to a normal window mid-sale.
  //
  // Resolves true or false, so call sites read almost the same as before.
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
        if (ev.key === 'Escape') { ev.stopPropagation(); done(false); }
        // Enter is deliberately NOT wired to yes. Every one of these questions
        // guards something destructive, and a stray keypress should not be
        // able to answer it.
      }
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
      back.addEventListener('click', onNo);
      document.addEventListener('keydown', onKey, true);
      // Focus the safe choice, not the destructive one.
      no.focus();
    });
  }

  // Hold a staged card to bring up its remove popup. Minus still just takes
  // one off, at every quantity, and at one press it removes the item as it
  // always has.
  //
  // 500ms: long enough that nobody trips it while tapping quickly, short
  // enough that it does not feel broken while you wait for it.
  const HOLD_MS = 500;
  const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/></svg>';
  let holdTimer = null, holdCard = null, holdFired = false;
  // The popup opens while the finger is still down, and it opens directly
  // UNDER that finger. Lifting then produces a compatibility click on
  // whichever button has just materialised there -- which is Remove. Measured:
  // one hold deleted the item outright, popup=false cards=1, no confirmation
  // shown at all. So the popup is inert for a moment after it appears: long
  // enough to swallow the release, short enough that nobody waiting to tap
  // Remove ever notices it.
  const CONFIRM_DEAD_MS = 400;
  let confirmOpenedAt = 0;
  const confirmIsLive = () => Date.now() - confirmOpenedAt >= CONFIRM_DEAD_MS;

  function cancelHold() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    if (holdCard) holdCard.classList.remove('holding');
    holdCard = null;
  }
  function closeConfirm() {
    const open = $('staged-items').querySelector('.staged-confirm');
    if (open) open.remove();
  }
  function openConfirm(card) {
    closeConfirm();                       // only ever one at a time
    const id = +card.dataset.id;
    if (!staged.some(x => x.id === id)) return;
    const box = document.createElement('div');
    box.className = 'staged-confirm';
    // Cancel first, Remove second -- the same order as the Clear List and
    // Cancel All dialogs. It used to be the other way round, so the safe
    // button was on the right in one popup and the destructive one was on the
    // right in the other; a cashier who learned either position had it wrong
    // half the time, on a control that voids a paid-for credit.
    box.innerHTML =
        '<button class="confirm-cancel" type="button">Cancel</button>'
      + '<button class="confirm-remove" type="button">' + TRASH_SVG + 'Remove</button>';
    box.querySelector('.confirm-remove').addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!confirmIsLive()) return;
      // Look the index up now, not when the popup opened: the list can have
      // changed underneath it, and splicing a stale index removes the wrong
      // product -- silently, and for a customer who is standing right there.
      const i = staged.findIndex(x => x.id === id);
      closeConfirm();
      if (i < 0) return;
      const name = staged[i].name;
      removeStaged(i);
      toast(name + ' removed', 'caution');
    });
    box.querySelector('.confirm-cancel').addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!confirmIsLive()) return;
      closeConfirm();
    });
    card.appendChild(box);
    confirmOpenedAt = Date.now();
  }

  $('staged-items').addEventListener('pointerdown', (ev) => {
    // Reset on every press anywhere in the strip. Otherwise a hold that fired
    // would leave the flag set and swallow the next tap, on any card.
    holdFired = false;
    if (ev.target.closest('.staged-confirm')) return;   // taps inside the popup
    // A hold that starts on a stepper is a hold on the stepper, not on the
    // card. Without this, resting a finger on minus would both take one off
    // and raise a remove popup.
    if (ev.target.closest('.staged-step')) return;
    const card = ev.target.closest('.staged-card');
    if (!card) return;
    holdCard = card;
    card.classList.add('holding');
    holdTimer = setTimeout(() => {
      holdTimer = null;
      holdFired = true;
      card.classList.remove('holding');
      openConfirm(card);
    }, HOLD_MS);
  });
  // pointercancel is what fires when the browser decides the gesture is a
  // scroll, so a finger that lands on a card and then drags the page does not
  // leave a popup behind it.
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((e) =>
    $('staged-items').addEventListener(e, cancelHold));
  // Android raises the text-selection menu on a long press. There is nothing
  // selectable in here and the menu would land on top of the popup.
  $('staged-items').addEventListener('contextmenu', (ev) => ev.preventDefault());
  // Anywhere else dismisses it, which is what everyone tries first.
  document.addEventListener('pointerdown', (ev) => {
    // Same dead window. A finger that drifts off the card before lifting would
    // otherwise dismiss the popup on the very release that opened it.
    if (!confirmIsLive()) return;
    if (!ev.target.closest('.staged-confirm')) closeConfirm();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeConfirm();
  });

  // Genuinely all of them now. Empty and inactive slots are skipped -- staging
  // a product the machine cannot pour only produces a refusal at Unlock time.
  $('btn-select-all').addEventListener('click', () => {
    let added = 0;
    for (let s = 1; s <= ACTIVE; s++) {
      if (S.wlvl[s]) continue;                    // tank empty
      if (stagedQty(s) >= MAX_QTY) continue;
      stageItem(s, 1);
      added++;
    }
    if (!added) toast('Nothing available to add', 'caution');
  });

  // Clear
  $('btn-clear-sale').addEventListener('click', async () => {
    // A six-product sale is a lot of tapping to lose to one stray touch.
    // Nothing is at stake but the typing, so this asks rather than warns --
    // and only when there is actually something to throw away.
    if (staged.length) {
      const n = staged.reduce((a, it) => a + it.qty, 0);
      const what = staged.length === 1
        ? staged[0].name
        : staged.length + ' products';
      const ok = await askConfirm('Clear ' + what + ' (' + n + ' press'
                   + (n !== 1 ? 'es' : '') + ') from this sale?', 'Clear List');
      if (!ok) return;
    }
    staged = [];
    renderStaged(); renderGrid(); updateArm();
  });

  // Arm
  $('btn-arm').addEventListener('click', executeArm);

  // Cancel all
  $('btn-cancel-all').addEventListener('click', cancelAll);


  // Init
  renderGrid();
  connectSSE();
  loadInfo();
  // Prices were only fetched when the Settings sheet was opened, so on a fresh
  // page load every product looked unpriced and the sale strip fell back to a
  // press count -- the cashier had no idea what to charge unless they happened
  // to open Settings first. They are needed on the very first sale, so they
  // are fetched at startup.
  loadPrices();
  loadToday();
  loadInterrupted();
  setInterval(loadInterrupted, 60000);
  loadUnclaimed();
  setInterval(loadUnclaimed, 30000);
  // The archive is only written when the uploader confirms a sale, so a slow
  // link means today's figure lands late rather than never. Re-read on a slow
  // beat as well as on each completed dispense.
  setInterval(loadToday, 60000);

  // Skeleton timeout: if no STATUS data after 4s, show demo
  setTimeout(() => {
    if (!S.lastUpdate) {
      S.armedQty[1] = 2; S.armedQty[2] = 1; S.busy[3] = true;
      S.wlvl[4] = true; S.queueDepth[2] = 1;
      S.armedQty[6] = 3; S.busy[6] = true;   // slot 6 live — no longer inactive
      S.lastUpdate = new Date(); refresh();
    }
  }, 4000);
})();
