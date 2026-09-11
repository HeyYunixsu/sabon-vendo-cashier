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
     - A card takes a press if the slot exists, the link is up and the tank
       is not dry. Armed, queued and dispensing are shown, not enforced.
     - The cart is never frozen. Nothing in it is paid for until Unlock is
       pressed, so a second sale can be built while the first is still
       waiting to be pressed.
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

  // ONE colour per slot, used in two places: the dot beside a row in Today's
  // Sales, and the glow around that product's card when it is in the cart. The
  // same product is the same colour wherever it appears, so the cashier learns
  // six colours instead of two unrelated sets.
  const SLOT_DOT = { 1: '#1F86FF', 2: '#8B5CF6', 3: '#EC4A73',
                     4: '#9B5DE5', 5: '#7FC8F8', 6: '#F5B93B' };

  // The glow is the slot colour at low alpha. Built here rather than with
  // colour-mix() so it works on any browser that reaches this till, and cached
  // because renderGrid runs on every status frame.
  const SLOT_GLOW = (() => {
    const out = {};
    for (const k in SLOT_DOT) {
      const h = SLOT_DOT[k];
      out[k] = 'rgba(' + parseInt(h.slice(1, 3), 16) + ','
                       + parseInt(h.slice(3, 5), 16) + ','
                       + parseInt(h.slice(5, 7), 16) + ',.55)';
    }
    return out;
  })();

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

  // -------------------------------------------------------------------------
  // ONE FLUID SCALE
  //
  // A small tablet gets the LARGE layout shrunk, not a different, more cramped
  // one. The shell is laid out as though it were DESIGN_W wide and zoomed down
  // to fit, so a 1280px tablet renders the same three-column card -- stepper
  // beside the name, photo at full height -- at 80% size, instead of falling
  // back to the compromise arrangement.
  //
  // Below 901 the layout stacks and scrolls on purpose, so it is left alone.
  // -------------------------------------------------------------------------
  const DESIGN_W = 1600;
  // The shortest the shell can be laid out and still hold six cards, measured
  // rather than guessed: at scale 1 and 1600 wide the grid is clean down to
  // 660px and overflows by 3px at 655. Scaling on height as well as width is
  // what lets .v2-grid stop being a scroll container -- see the note there.
  const DESIGN_H = 660;
  // The live scale. Nothing reads it today -- the Today card is centred by CSS
  // rather than positioned from a rect -- but anything that DOES position
  // against getBoundingClientRect() must divide by it: rects come back in
  // visual pixels while style.top/left are set in the zoomed space, and mixing
  // the two puts an element at scale x scale.
  let curScale = 1;
  // 0.6, not 0.72. The floor decides how small the shell may be told it is:
  // at 0.72 a 1024px screen laid out as 1422 wide, whose CONTENT box (padding
  // removed, which is what a container query measures) fell just under the
  // 1400 breakpoint -- so it dropped back into the cramped branch and the
  // bottle collapsed to 41px. A lower floor keeps the effective width pinned
  // at DESIGN_W for every real tablet, which is the entire point.
  const MIN_SCALE = 0.6;
  // A soft keyboard is not a shorter screen, and the difference matters a great
  // deal here. The scale drives a CSS zoom over the whole shell: recomputing it
  // when the keyboard opens relayouts and repaints everything at a new size
  // -- on a 1280x800 tablet the keyboard takes the window to about 400px, which
  // moved the scale from 0.80 to 0.61 -- and it drags the focused field out
  // from under the browser's own scroll-into-view on the way.
  //
  // So while a field has focus the scale is frozen at whatever it was. Nothing
  // is lost: the cashier is not resizing the window while typing into it.
  const typing = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  };

  function setScale() {
    if (typing()) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Whichever axis runs out first decides. Width alone was not enough: a wide
    // but short window stayed at scale 1, the grid could not fit six cards, and
    // it fell back to scrolling -- which is the thing this layout exists to
    // avoid.
    const s = w < 901
      ? 1
      : Math.min(1, Math.max(MIN_SCALE, Math.min(w / DESIGN_W, h / DESIGN_H)));
    const root = document.documentElement;
    curScale = s;
    root.style.setProperty('--s', s.toFixed(4));
    root.classList.toggle('scaled', s < 0.999);
  }

  // The height the shell should actually occupy. In a normal window this is
  // just the window; in FULLSCREEN the layout viewport does not shrink for the
  // keyboard -- only the visual viewport does -- which is exactly why the sheet
  // stayed put behind the keyboard in fullscreen and moved correctly outside
  // it. Reading visualViewport makes the two cases behave the same.
  function applyViewportHeight() {
    const vv = window.visualViewport;
    const h = vv ? Math.round(vv.height) : window.innerHeight;
    document.documentElement.style.setProperty('--vh', h + 'px');

    // How much of the WINDOW the keyboard is covering, which is what the price
    // editor docks against. The sum works in both cases without a branch:
    // outside fullscreen the layout viewport shrinks too, so this comes out 0
    // and bottom:0 already sits on the keyboard; in fullscreen it does not, and
    // this is the gap.
    const kb = vv
      ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      : 0;
    document.documentElement.style.setProperty('--kb', kb + 'px');
  }

  function onViewportChange() {
    applyViewportHeight();
    setScale();
  }

  applyViewportHeight();
  setScale();
  window.addEventListener('resize', onViewportChange);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', applyViewportHeight);
    // The visual viewport also SCROLLS when the keyboard is open, and the shell
    // has to follow or it drifts out from under the finger.
    window.visualViewport.addEventListener('scroll', applyViewportHeight);
  }
  // Rotating a tablet fires resize on every engine, but orientationchange can
  // land first with the old innerWidth, so both are wired.
  window.addEventListener('orientationchange', () => setTimeout(onViewportChange, 60));

  // Bring a focused field above the keyboard. The browser does this itself when
  // the layout viewport shrinks, and does nothing in fullscreen where it does
  // not -- so it is done here, against the sheet's own scrollport, which is a
  // calculation that holds either way.
  //
  // The rects come back in VISUAL pixels and scrollTop is read in the ZOOMED
  // space, so the delta is divided by the scale on the way in. The delay is the
  // keyboard's own animation; measuring before it settles centres the field on
  // where the screen used to end.
  let revealTmr;
  function revealFocused(el) {
    const body = el.closest('.v2-sheet-body, .v2-credits-body');
    if (!body) return;
    clearTimeout(revealTmr);
    revealTmr = setTimeout(() => {
      const b = body.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      // Already comfortably in view -- on a desktop, or a field near the top
      // of a short list -- so leave it alone. Centring every focus would make
      // clicking from one price to the next jump the sheet for no reason.
      const pad = 8;
      if (r.top >= b.top + pad && r.bottom <= b.bottom - pad
          && r.top >= 0 && r.bottom <= window.innerHeight) return;
      const delta = (r.top + r.height / 2) - (b.top + b.height / 2);
      body.scrollTop += delta / (curScale || 1);
    }, 320);
  }

  // ---- price editor -------------------------------------------------------
  // The bar that docks to the keyboard. Only on a touch screen: with a mouse
  // there is no keyboard to be covered by, and pulling focus out of the field
  // somebody just clicked would be worse than the problem.
  const touchScreen = () => {
    try { return window.matchMedia('(pointer: coarse)').matches; }
    catch (e) { return false; }
  };

  let edSlot = null;

  const edRow = (slot) =>
    document.querySelector('#price-list [data-price="' + slot + '"]');

  // Points the bar at a row. Focus is NOT moved between rows -- the bar keeps
  // it the whole time -- so stepping through six products never disturbs the
  // keyboard.
  function edPointAt(slot) {
    const row = edRow(slot);
    if (!row) return;
    edSlot = slot;
    $('ed-name').textContent = PRODUCT[slot] || ('Slot ' + slot);
    $('ed-input').value = row.value;
    $('ed-prev').disabled = slot <= 1;
    $('ed-next').disabled = slot >= ACTIVE;
  }

  function edOpen(slot) {
    clearTimeout(revealTmr);          // the sheet must not also go hunting
    $('price-editor').hidden = false;
    edPointAt(slot);
    const inp = $('ed-input');
    inp.focus();
    // Caret at the end, so the first key appends rather than replacing. select()
    // would wipe the price on the first digit, which is not what "edit" means.
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {}
  }

  function edClose() {
    $('price-editor').hidden = true;
    edSlot = null;
  }

  document.addEventListener('focusin', (ev) => {
    const el = ev.target;
    if (!el) return;
    if (el.id === 'ed-input') return;              // the bar's own field
    if (el.dataset && el.dataset.price && touchScreen()) {
      edOpen(parseInt(el.dataset.price, 10));
      return;
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') revealFocused(el);
  });
  document.addEventListener('focusout', (ev) => {
    clearTimeout(revealTmr);
    // Closed only when focus has genuinely left the bar. A tap on Prev, Next or
    // Done fires focusout first, and tearing the bar down there would take the
    // keyboard with it before the button had done anything.
    if (ev.target && ev.target.id === 'ed-input') {
      setTimeout(() => {
        const a = document.activeElement;
        if (!a || !a.closest || !a.closest('#price-editor')) edClose();
      }, 80);
    }
    // The keyboard is on its way out; the scale it was frozen at may no longer
    // be the right one for the window that is coming back.
    setTimeout(onViewportChange, 120);
  });

  // Belt and braces for the CSS above. CSS user-drag is not standard on every
  // engine, and dragstart is the event that actually carries the image out to
  // another window -- cancelling it here works everywhere, including on the
  // photos, which are rebuilt by renderGrid and so cannot be wired one by one.
  document.addEventListener('dragstart', (ev) => ev.preventDefault());
  // Long press on a touch screen raises the same save/copy menu that a right
  // click does. Inputs keep theirs, so a mistyped price can still be pasted
  // over.
  document.addEventListener('contextmenu', (ev) => {
    if (!ev.target.closest('input, textarea')) ev.preventDefault();
  });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Armed or dispensing: the sale is with the machine and the cart must not
  // move under it. Phase 0 idle, 1 armed, 2 dispensing, 3 complete.
  //
  // BUT the phase alone is not enough, and trusting it bricked the till. A
  // live machine was found sitting in phase 1 (ARMED) with armedQty and
  // queueDepth all zero -- nothing outstanding, nothing dispensing, yet every
  // stepper disabled, Add One Of Each and Cancel All returning early and
  // Unlock greyed out. The cashier saw the button press and nothing happen,
  // because the press was real and the handler was refusing.
  //
  // So lock on the WORK, not on the flag: a transaction is in flight only if
  // the machine is actually holding presses, has some queued, or is pumping.
  // v1 never locked on phase at all, which is why it never showed this.
  // Whether a slot will take another press. This is v1's rule and the only one
  // the machine actually enforces -- /api/arm imposes no lock of its own, and
  // v1's guard is `s <= ACTIVE && !S.wlvl[s]`, nothing more.
  //
  // v2 used to freeze the entire cart while the controller held any credit.
  // That is wrong on a shop counter: the customer who paid may not press for
  // minutes, and the till was refusing the next customer that whole time.
  // Armed, queued and dispensing are things to SHOW on the card, not reasons
  // to refuse a sale.
  const canAddTo = (s) => s <= ACTIVE && S.connected && !S.wlvl[s];

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

  // A toast says one line and goes. This says what happened AND what it means,
  // and is used for the one action that changes the whole cart at once --
  // adding six products should be seen confirmed, not counted off the
  // steppers.
  const NOTICE_ICON = {
    success: '<path d="M4 12.5l5.5 5.5L20 7"/>',
    error:   '<path d="M6 6l12 12M18 6L6 18"/>',
    caution: '<path d="M12 4.4 2.6 19.6h18.8z"/><path d="M12 10v4"/><path d="M12 16.8v.1"/>',
  };

  let noticeTmr;
  function notice(title, sub, opts) {
    const o = opts || {};
    const kind = o.kind || 'success';
    const el = $('notice');
    $('notice-title').textContent = title;
    $('notice-sub').textContent = sub || '';
    $('notice-sub').hidden = !sub;
    $('notice-cart').hidden = !o.cart;
    // The kind is carried on both: the tick uses it for its fill, the notice
    // for the strip down its edge.
    el.classList.remove('is-success', 'is-error', 'is-caution');
    el.classList.add('is-' + kind);
    const tick = el.querySelector('.v2-notice-tick');
    tick.className = 'v2-notice-tick is-' + kind;
    tick.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="3" stroke-linecap="round" stroke-linejoin="round">'
      + (NOTICE_ICON[kind] || NOTICE_ICON.success) + '</svg>';
    el.hidden = false;
    // Two frames, not one: the element has to be laid out at its start state
    // before the class that transitions it can mean anything.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-in')));
    clearTimeout(noticeTmr);
    // A failure stays longer than a confirmation. Something that did not work
    // needs reading; something that did only needs noticing.
    noticeTmr = setTimeout(hideNotice, kind === 'success' ? 5000 : 8000);
  }
  function hideNotice() {
    clearTimeout(noticeTmr);
    const el = $('notice');
    el.classList.remove('is-in');
    // Hidden only after it has finished sliding out, or it vanishes instead.
    noticeTmr = setTimeout(() => { el.hidden = true; }, 260);
  }

  // -------------------------------------------------------------------------
  // Confirm dialog
  //
  // Not window.confirm(). A native dialog is drawn by the browser rather than
  // the page, and Android Chrome leaves fullscreen to show it -- the kiosk
  // visibly falls back to a normal window mid-sale.
  // -------------------------------------------------------------------------
  const ASK_ICON = {
    lock:  '<path d="M4 10.5h16v10H4z"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>',
    warn:  '<path d="M12 3.6 1.8 20.4h20.4z"/><path d="M12 9.6v4.8"/><path d="M12 17.6v.1"/>',
    coins: '<ellipse cx="12" cy="6.4" rx="7.2" ry="3.1"/>'
         + '<path d="M4.8 6.4v4.6c0 1.71 3.22 3.1 7.2 3.1s7.2-1.39 7.2-3.1V6.4"/>'
         + '<path d="M4.8 11v4.6c0 1.71 3.22 3.1 7.2 3.1s7.2-1.39 7.2-3.1V11"/>',
  };

  // Takes an object, and the shape is the point: a question about money should
  // show the money. Built like the sale-done panel -- icon, heading, one plain
  // sentence, then the figures the decision turns on -- because "Cancel 3
  // armed presses?" in a bare line of text does not convey that somebody has
  // already paid for them.
  //
  //   { icon, kind, title, body, stats: [{ v, k }], yes }
  //
  // `kind` styles the icon and the confirm button: 'danger' (the default) for
  // anything that throws work or money away, 'primary' for a step forward that
  // merely cannot be undone. Unlock is the second kind -- the most-pressed
  // control in the shop, and a red button pressed fifty times a shift stops
  // meaning "careful", which is exactly what has to survive for Clear Cart and
  // Cancel Credits.
  //
  // A plain string is still accepted, so a caller with only a sentence to ask
  // does not have to invent a shape for it.
  function askConfirm(opts, yesLabel, kindArg) {
    const o = typeof opts === 'string'
      ? { title: opts, yes: yesLabel, kind: kindArg }
      : (opts || {});
    return new Promise((resolve) => {
      const back = $('ask-backdrop'), box = $('ask');
      const yes = $('ask-yes'), no = $('ask-no');
      // Three kinds now. 'caution' is not a choice at all -- it reports that a
      // control could do nothing and why -- so it takes a single button and an
      // amber icon rather than a red one, which would read as a threat.
      const caution = o.kind === 'caution';
      const danger = !caution && o.kind !== 'primary';

      $('ask-text').textContent = o.title || '';
      const sub = $('ask-sub');
      sub.textContent = o.body || '';
      sub.hidden = !o.body;

      const icon = $('ask-icon');
      const glyph = ASK_ICON[o.icon];
      icon.hidden = !glyph;
      icon.className = 'v2-ask-icon'
        + (caution ? ' is-caution' : danger ? ' is-danger' : ' is-primary');
      icon.innerHTML = glyph
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
          + ' stroke-linecap="round" stroke-linejoin="round">' + glyph + '</svg>'
        : '';

      const strip = $('ask-stats');
      const stats = o.stats || [];
      strip.hidden = !stats.length;
      strip.innerHTML = stats.map(function (st, i) {
        return (i ? '<div class="v2-ask-rule"></div>' : '')
          + '<div class="v2-ask-stat"><span class="v2-ask-v">' + esc(String(st.v))
          + '</span><span class="v2-ask-k">' + esc(st.k) + '</span></div>';
      }).join('');

      yes.textContent = (o.yes || yesLabel) || 'Confirm';
      yes.className = 'v2-btn ' + (danger ? 'v2-btn-danger' : 'v2-btn-primary');
      // Nothing to decline when there was no choice offered.
      no.hidden = !!(caution || o.single);
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
        // Never redraw over someone mid-edit; their unsaved figures would vanish.
        if (!priceDirty) renderPrices();
        renderCart();
        return;
      }
      if (e.data.startsWith('PRIME_ACK')) { onPrimeAck(e.data); return; }
      if (e.data.startsWith('PRICE_ACK')) { onPriceAck(e.data); return; }
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

    // Credits earns its place in the cart header only while the machine owes
    // somebody a press. If the last one is voided with the panel open the
    // panel stays -- it says so in words -- rather than vanishing under the
    // finger that just voided it.
    $('btn-credits').hidden = waiting === 0;
    $('credits-count').textContent = waiting;

    const stock = $('kpi-stock');
    stock.textContent = inStock + '/' + ACTIVE;
    stock.className = 'v2-chip-v ' + (inStock === ACTIVE ? 'is-full'
      : inStock >= Math.ceil(ACTIVE / 2) ? 'is-low' : 'is-critical');

    // One chip, always true. Offline outranks everything -- a stale "Ready"
    // beside a dead link is worse than saying nothing -- then paused, then the
    // phase. Plain words, not the C++ enum names: a cashier reads this.
    const phases = ['Ready', 'Unlocked', 'Dispensing', 'Done'];
    let state, colour;
    if (!S.connected)   { state = 'Offline'; colour = 'var(--red)'; }
    else if (S.paused)  { state = 'Paused';  colour = '#B26A00'; }
    else {
      state = phases[S.phase] || 'Ready';
      colour = S.bundleComplete ? 'var(--green)'
             : (S.phase === 3 ? 'var(--brand-strong)' : 'var(--ink)');
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
    let sig = S.connected ? 'C' : 'D';
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
      // The badge still says Unlocked or Dispensing -- the cashier needs to
      // see that. It just no longer refuses the tap.
      const canAdd = canAddTo(s) && qty < MAX_QTY;
      const canSub = qty > 0;

      let cls = 'v2-prod';
      if (st === 'off') cls += ' is-inactive';
      else if (st === 'empty' || st === 'offline') cls += ' is-empty';
      // Two different borders for two different things, per the design: blue
      // for in this cart, teal for presses the machine is already holding.
      if (qty > 0) cls += ' in-cart';
      else if (st === 'unlocked') cls += ' is-armed';

      const tint = SLOT_DOT[s] || 'var(--brand)';
      h += '<div class="' + cls + '" data-slot="' + s + '"'
         +   ' style="--slot:' + tint + ';--slot-glow:' + (SLOT_GLOW[s] || 'transparent') + '">'
         + '<div class="v2-badge' + badge.cls + '"><span class="v2-dot"></span>' + badge.label + '</div>'
         + '<div class="v2-prod-img">'
         +   '<img src="' + PRODUCT_IMG(s) + '" alt="" loading="lazy" draggable="false">'
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
           +   ' data-remove="' + it.id + '"'
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
    $('btn-arm').disabled = !items;
    $('btn-arm-label').textContent = items
      ? 'Unlock ' + cart.length + ' Button' + (cart.length > 1 ? 's' : '')
      : 'Unlock Buttons';

    $('btn-clear-cart').disabled = !cart.length;
  }

  function renderAll() {
    renderHeader(); renderGrid(); renderCart();
    if (!$('settings-panel').hidden) renderPrime();
    if (creditsOpen()) renderWaiting();
  }

  // =========================================================================
  // SETTINGS
  //
  // Ported from v1 rather than reinvented: the price editor is the same
  // two-step contract with the controller, and the prime panel keeps the same
  // arm-then-fire guard. The one addition is Waiting credits, which v1 showed
  // in its right-hand panel and this layout otherwise had nowhere for.
  // =========================================================================
  const settingsOpen = () => !$('settings-panel').hidden;
  const creditsOpen  = () => !$('credits-panel').hidden;

  // ---- prices -------------------------------------------------------------
  let priceDirty = false;
  // A price is a whole number of pesos. 1000 is the ceiling the cashier is
  // given, and four characters is exactly what it takes to type it.
  const MAX_PRICE = 1000;

  function renderPrices() {
    const el = $('price-list');
    if (!el || !settingsOpen()) return;
    let h = '';
    for (let s = 1; s <= ACTIVE; s++) {
      const v = prices[s] != null ? prices[s] : '';
      h += '<div class="v2-price-row">'
         + '<span>' + esc(PRODUCT[s]) + '</span>'
         + '<span class="v2-peso">₱</span>'
         // type=text, not number. A number field draws Chrome's spinner --
         // two 8px arrows beside a figure meant for a thumb -- and still lets
         // "e", "+" and "-" through, which are not prices. Digits are filtered
         // on input instead, so nothing else can ever reach the field.
         + '<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4"'
         + ' autocomplete="off"'
         + ' data-price="' + s + '" value="' + v + '"'
         + ' aria-label="' + esc(PRODUCT[s]) + ' price, pesos, maximum ' + MAX_PRICE + '">'
         + '</div>';
    }
    el.innerHTML = h;
    priceDirty = false;
    $('btn-save-prices').disabled = true;
  }

  // Strips anything that is not a digit and holds the ceiling, in place, as
  // the cashier types. Doing it here rather than at Save means a bad character
  // never appears at all -- there is nothing to notice and correct.
  function sanitisePrice(input) {
    const before = input.value;
    let v = before.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
    if (v !== '' && parseInt(v, 10) > MAX_PRICE) v = String(MAX_PRICE);
    if (v === before) return;
    // Keep the caret where the cashier left it, minus whatever was removed to
    // its left, or every rejected keystroke jumps them to the end of the field.
    const pos = input.selectionStart;
    const removedBefore = before.slice(0, pos).replace(/[0-9]/g, '').length;
    input.value = v;
    try { input.setSelectionRange(pos - removedBefore, pos - removedBefore); } catch (e) {}
  }

  function markPriceDirty(input) {
    sanitisePrice(input);
    const slot = parseInt(input.dataset.price, 10);
    const changed = String(prices[slot] != null ? prices[slot] : '') !== input.value.trim();
    input.classList.toggle('dirty', changed);
    priceDirty = false;
    $('price-list').querySelectorAll('[data-price]').forEach((i) => {
      if (i.classList.contains('dirty')) priceDirty = true;
    });
    $('btn-save-prices').disabled = !priceDirty;
  }

  // The old figure, captured at save time. By the time PRICE_ACK comes back
  // over SSE the controller has already pushed the new PRICES, so `prices` no
  // longer holds what it was -- and "from what" is the half of a price change
  // worth confirming.
  let priceBefore = {};

  async function savePrices() {
    const body = {};
    let bad = null;
    $('price-list').querySelectorAll('[data-price]').forEach((i) => {
      const slot = parseInt(i.dataset.price, 10);
      const val = parseInt(i.value, 10);
      if (!Number.isFinite(val) || val < 0 || val > MAX_PRICE) { bad = PRODUCT[slot]; return; }
      if (prices[slot] !== val) priceBefore[slot] = prices[slot];
      body[slot] = val;
    });
    if (bad) {
      notice('Prices not saved',
        bad + ' must be a whole number of pesos, 0 to ' + MAX_PRICE + '.',
        { kind: 'error' });
      return;
    }

    $('btn-save-prices').disabled = true;
    try {
      const r = await fetch('/api/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices: body }),
      });
      const d = await r.json();
      if (!d.success) {
        notice('Prices not saved',
          d.reason === 'controller_offline'
            ? 'The machine is unreachable. Nothing was changed.'
            : (d.reason || 'The machine refused, and did not say why.'),
          { kind: 'error' });
        $('btn-save-prices').disabled = false;
        return;
      }
      if (!d.changed) {
        notice('Nothing to save', 'Every price is already what it was.',
               { kind: 'caution' });
        renderPrices();
        return;
      }
      // The controller answers each change with PRICE_ACK. Wait for it rather
      // than claiming success for something it may still refuse.
      priceDirty = false;
    } catch (e) {
      notice('Prices not saved', e.message, { kind: 'error' });
      $('btn-save-prices').disabled = false;
    }
  }

  function onPriceAck(raw) {
    const p = raw.split(',');
    const slot = parseInt(p[1], 10);
    const result = (p[2] || '').trim();
    const name = PRODUCT[slot] || ('Slot ' + slot);
    if (result === 'ok') {
      const was = priceBefore[slot];
      delete priceBefore[slot];
      notice('Price saved',
        was == null
          ? name + ' updated. Every later sale is worth the new price.'
          : name + ': ₱' + was + ' → ₱' + prices[slot]
            + '. Every later sale is worth the new price.');
      loadPriceHistory();
      return;
    }
    const why = {
      sale_in_progress: 'A sale is still waiting. Finish or cancel it, then save again.',
      invalid_price:    'A price must be a whole number of pesos, 0 to ' + MAX_PRICE + '.',
      invalid_slot:     'The machine does not recognise that product.',
      not_saved:        'The machine took the change but could not write it down — '
                      + 'it will revert when the controller restarts.',
    };
    notice(name + ' price not saved', why[result] || result, {
      // not_saved is the odd one: the change IS live, it just will not survive
      // a restart. That is a warning to act on, not a failure to retry.
      kind: result === 'not_saved' ? 'caution' : 'error',
    });
  }

  // Held so View All can render without a second round trip, and so the panel
  // shows the same set the summary line was drawn from.
  let priceChanges = [];

  async function loadPriceHistory() {
    try {
      const d = await (await fetch('/api/prices/history')).json();
      priceChanges = (d && d.changes) || [];
      const el = $('price-history');
      $('btn-price-history').disabled = !priceChanges.length;
      if (!priceChanges.length) { el.textContent = 'No price has been changed yet.'; return; }
      const c = priceChanges[0];
      const name = PRODUCT[parseInt(c.slot, 10)] || ('Slot ' + c.slot);
      el.textContent = 'Last change: ' + name + '  ₱' + c.from + ' → ₱' + c.to
                     + '   ' + (c.date_created || '');
      if (historyOpen()) renderHistory();
    } catch (e) { /* history is context, not essential */ }
  }

  function showDone(presses, pesos, summary) {
    $('done-amount').textContent = pesos == null ? '—' : '₱' + pesos;
    $('done-items').textContent = presses;
    $('done-when').textContent = new Date().toLocaleTimeString([],
      { hour: 'numeric', minute: '2-digit' });
    // What was unlocked, in the sub-line -- the figures alone do not say which
    // buttons the customer is now able to press.
    $('done-panel').querySelector('.v2-done-sub').textContent =
      summary ? summary : 'The customer can press their buttons now.';
    $('done-panel').hidden = false;
  }
  const closeDone = () => { $('done-panel').hidden = true; };

  const historyOpen = () => !$('history-panel').hidden;

  function renderHistory() {
    $('history-count').textContent = priceChanges.length;
    if (!priceChanges.length) {
      $('history-list').innerHTML =
        '<div class="v2-empty-note">No price has been changed yet.</div>';
      return;
    }
    let h = '';
    for (const c of priceChanges) {
      const slot = parseInt(c.slot, 10);
      const name = PRODUCT[slot] || ('Slot ' + c.slot);
      // Up or down is the thing being looked for, so it is shown rather than
      // left to be worked out by comparing two figures.
      const up = Number(c.to) > Number(c.from);
      h += '<div class="v2-hist-row">'
         + '<span class="v2-hist-dot" style="background:' + (SLOT_DOT[slot] || '#98A2B3') + '"></span>'
         + '<span class="v2-hist-name">' + esc(name)
         +   '<span class="v2-hist-when">' + esc(c.date_created || '') + '</span>'
         + '</span>'
         + '<span class="v2-hist-move' + (up ? ' is-up' : ' is-down') + '">'
         +   '₱' + c.from + ' → ₱' + c.to
         + '</span>'
         + '</div>';
    }
    $('history-list').innerHTML = h;
  }

  function openHistory() {
    $('history-panel').hidden = false;
    renderHistory();
    loadPriceHistory();
  }
  const closeHistory = () => { $('history-panel').hidden = true; };

  // ---- waiting credits ----------------------------------------------------
  // The one thing the mockup has no room for. These are presses a customer has
  // paid for; cancelling one writes it off, so each is its own button behind a
  // confirmation rather than a bulk sweep. It has its own screen, off the
  // Credits button, because voiding taken money is not a settings change.
  let waitSig = null;

  function renderWaiting() {
    const el = $('waiting-list');
    if (!el || !creditsOpen()) return;

    let sig = '', total = 0;
    for (let s = 1; s <= ACTIVE; s++) {
      const owed = (S.armedQty[s] || 0) + (S.queueDepth[s] || 0);
      total += owed;
      sig += '|' + owed + S.busy[s];
    }
    $('waiting-total').textContent = total;
    $('btn-cancel-all').disabled = total === 0;
    if (sig === waitSig) return;
    waitSig = sig;

    let h = '';
    for (let s = 1; s <= ACTIVE; s++) {
      const armed = S.armedQty[s] || 0, queued = S.queueDepth[s] || 0;
      if (!armed && !queued) continue;
      const bits = [];
      if (armed) bits.push(armed + ' armed');
      // queueDepth counts queued ENTRIES, not presses, so it is never summed
      // with armed as though they were the same unit.
      if (queued) bits.push(queued + ' queued');
      h += '<div class="v2-wait-row">'
         + '<span class="v2-wait-name">' + esc(PRODUCT[s])
         +   (S.busy[s] ? '<span class="v2-wait-why">dispensing now</span>' : '')
         + '</span>'
         + '<span class="v2-wait-qty">' + bits.join(' + ') + '</span>'
         + '<button class="v2-btn v2-btn-danger-ghost v2-btn-set" type="button"'
         +   ' data-void="' + s + '">Cancel</button>'
         + '</div>';
    }
    el.innerHTML = h || '<div class="v2-empty-note">Nobody is waiting on a press.</div>';
  }

  async function voidAll() {
    let armed = 0, queued = 0;
    for (let s = 1; s <= ACTIVE; s++) {
      armed  += (S.armedQty[s] || 0);
      queued += (S.queueDepth[s] || 0);
    }
    if (!armed && !queued) return;
    const bits = [];
    if (armed)  bits.push(armed + ' armed press' + (armed !== 1 ? 'es' : ''));
    if (queued) bits.push(queued + ' queued credit' + (queued !== 1 ? 's' : ''));
    const ok = await askConfirm({
      icon: 'coins', kind: 'danger',
      title: 'Write off every waiting credit?',
      body: 'All of these have already been paid for. Cancelling refunds nobody.',
      stats: [
        armed  ? { v: armed,  k: 'Armed Press' + (armed !== 1 ? 'es' : '') } : null,
        queued ? { v: queued, k: 'Queued Credit' + (queued !== 1 ? 's' : '') } : null,
      ].filter(Boolean),
      yes: 'Cancel All Credits',
    });
    if (!ok) return;
    try {
      await fetch('/api/cancel-all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      });
      waitSig = null;
      toast('All waiting credits cancelled', 'caution');
    } catch (e) { toast('Could not cancel: ' + e.message, 'error'); }
  }

  async function voidSlot(slot) {
    const armed = S.armedQty[slot] || 0, queued = S.queueDepth[slot] || 0;
    const bits = [];
    if (armed) bits.push(armed + ' armed press' + (armed !== 1 ? 'es' : ''));
    if (queued) bits.push(queued + ' queued credit' + (queued !== 1 ? 's' : ''));
    if (!bits.length) return;
    const ok = await askConfirm({
      icon: 'coins', kind: 'danger',
      title: 'Write off this credit?',
      body: 'The customer has already paid for it. Cancelling does not refund them.',
      stats: [
        { v: PRODUCT[slot] || ('Slot ' + slot), k: 'Product' },
        armed  ? { v: armed,  k: 'Armed Press' + (armed !== 1 ? 'es' : '') } : null,
        queued ? { v: queued, k: 'Queued Credit' + (queued !== 1 ? 's' : '') } : null,
      ].filter(Boolean),
      yes: 'Cancel Credits',
    });
    if (!ok) return;
    try {
      await fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: slot }),
      });
      waitSig = null;
      toast((PRODUCT[slot] || ('Slot ' + slot)) + ' cancelled', 'caution');
    } catch (e) { toast('Could not cancel: ' + e.message, 'error'); }
  }

  // ---- prime / clear air --------------------------------------------------
  let primeCounts = {}, primeArmedSlot = null, primeArmTmr = null, primeSig = null;
  // Held, not only written to the DOM, because the confirmation quotes it.
  let primeSeconds = 3;

  async function loadPrimeInfo() {
    try {
      const d = await (await fetch('/api/prime')).json();
      primeCounts = d.today || {};
      primeSeconds = d.seconds || 3;
      $('prime-secs').textContent = primeSeconds;
      $('prime-today').textContent = d.todayTotal || 0;
      primeSig = null;
      renderPrime();
    } catch (e) { /* the panel is still usable without the count */ }
  }

  function disarmPrime() {
    primeArmedSlot = null;
    clearTimeout(primeArmTmr);
    primeSig = null;
    renderPrime();
  }

  function renderPrime() {
    const el = $('prime-list');
    if (!el || !settingsOpen()) return;

    // STATUS arrives twice a second. Rebuilding blindly would swap the button
    // out from under a finger mid-tap.
    let sig = String(primeArmedSlot) + '|' + S.paused + '|' + S.connected;
    for (let s = 1; s <= ACTIVE; s++) sig += '|' + (primeCounts[s] || 0) + S.wlvl[s] + S.busy[s];
    if (sig === primeSig) return;
    primeSig = sig;

    let h = '';
    for (let s = 1; s <= ACTIVE; s++) {
      const n = primeCounts[s] || 0;
      // Say WHY it cannot be pressed. A dead button with no explanation sends
      // people hunting for a fault that is not there.
      const why = !S.connected ? 'machine offline'
                : S.paused     ? 'machine paused'
                : S.wlvl[s]    ? 'tank empty — refill first'
                : S.busy[s]    ? 'dispensing now'
                : null;
      const armed = primeArmedSlot === s;
      h += '<div class="v2-prime-row">'
         + '<span class="v2-prime-name">' + esc(PRODUCT[s])
         +   (why ? '<span class="v2-prime-why">' + why + '</span>' : '')
         + '</span>'
         + '<span class="v2-prime-count' + (n > 0 ? ' busy' : '') + '">'
         +   (n > 0 ? n + ' today' : '—') + '</span>'
         + '<button class="v2-btn v2-btn-ghost v2-btn-set' + (armed ? ' confirm' : '') + '"'
         +   ' type="button" data-prime="' + s + '"' + (why ? ' disabled' : '') + '>'
         +   (armed ? 'Tap again' : 'Clear Air') + '</button>'
         + '</div>';
    }
    el.innerHTML = h;
  }

  function onPrimeTap(slot) {
    if (primeArmedSlot !== slot) {
      // The first tap only arms. A pump that starts on a single mis-tap is the
      // one thing this panel must not do.
      primeArmedSlot = slot;
      primeSig = null;
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
        body: JSON.stringify({ slot: slot }),
      });
      const d = await r.json();
      if (!d.success) {
        notice('Could not clear air',
          d.reason === 'controller_offline'
            ? 'The machine is unreachable, so nothing was sent to the pump.'
            : (d.reason || 'The machine refused, and did not say why.'),
          { kind: 'error' });
      }
      // Success here only means the command was sent. The controller decides,
      // and answers with PRIME_ACK over SSE.
    } catch (e) {
      notice('Could not clear air', e.message, { kind: 'error' });
    }
  }

  function onPrimeAck(raw) {
    const p = raw.split(',');
    const slot = parseInt(p[1], 10);
    const result = (p[2] || '').trim();
    const name = PRODUCT[slot] || ('Slot ' + slot);
    // 'started', not 'ok'. The controller's tokens are in pump_control.cpp and
    // v1 has always matched them; v2 was checking for a word the machine never
    // sends, so every successful prime reported a failure -- and because the
    // success branch is what re-reads the log, the count never moved either.
    if (result === 'started') {
      notice('Clearing air from ' + name,
        'Running for ' + primeSeconds + 's. No sale is recorded and no credit is '
        + 'touched.');
      // Present tense, because the pump is still going: the ACK says the burst
      // STARTED. And the controller writes its log when the burst finishes, so
      // reading the count now would return the figure from before it ran.
      setTimeout(loadPrimeInfo, (primeSeconds * 1000) + 500);
      return;
    }
    // These are the controller's own tokens too. v2 had invented tank_empty and
    // machine_paused, so a refusal for either fell through and showed the raw
    // word, and max_active was missing altogether.
    const why = {
      slot_busy:    name + ' is dispensing right now. Try again in a moment.',
      slot_empty:   name + ' reads empty. Replace the gallon first.',
      paused:       'The machine is paused, so nothing was run.',
      max_active:   'Two pumps are already running. Try again in a moment.',
      invalid_slot: 'The machine does not recognise that product.',
    };
    notice('Could not clear air', why[result] || (name + ': ' + result), { kind: 'error' });
  }

  // ---- theme --------------------------------------------------------------
  // Remembered per device. A till should render the same way at the start of
  // every shift, so this is an explicit choice stored locally rather than
  // anything that follows the tablet's own night schedule.
  const THEME_KEY = 'sabon-v2-theme';
  function setupTheme() {
    const btn = $('btn-theme');
    // Dark unless this device has explicitly chosen light. A till lives under
    // shop lighting for a whole shift; the bright screen is the exception.
    let dark = true;
    try { dark = localStorage.getItem(THEME_KEY) !== 'light'; } catch (e) {}

    function paint() {
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      // The button says where it will take you, not where you are -- which is
      // how the design labels it ("Dark Mode" while the screen is light).
      btn.textContent = dark ? 'Light Mode' : 'Dark Mode';
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', dark ? '#0F141B' : '#034EA2');
    }
    btn.addEventListener('click', () => {
      dark = !dark;
      // Both choices are written. Clearing the key for light used to be
      // enough when light was the default; now an absent key MEANS dark, so
      // removing it would throw the cashier's choice away on the next reload.
      try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
      paint();
    });
    paint();
  }

  // ---- fullscreen ---------------------------------------------------------
  // Remembered, because fullscreen itself cannot be: no page may put itself
  // fullscreen on load, so the tablet comes up windowed and enters on the
  // first touch, which is a gesture and therefore allowed.
  const FS_KEY = 'sabon-v2-fullscreen';
  function setupFullscreen() {
    const root = document.documentElement;
    if (!root.requestFullscreen || !document.exitFullscreen) return;  // iOS: video only
    const btn = $('btn-fullscreen');
    $('row-fullscreen').hidden = false;

    let want = false;
    try { want = localStorage.getItem(FS_KEY) === '1'; } catch (e) {}

    const paint = () => {
      btn.textContent = want ? 'On' : 'Off';
      btn.classList.toggle('is-on', want);
      btn.setAttribute('aria-pressed', want ? 'true' : 'false');
    };
    const remember = (on) => {
      want = on;
      try { on ? localStorage.setItem(FS_KEY, '1') : localStorage.removeItem(FS_KEY); } catch (e) {}
      paint();
    };
    const go = () => {
      if (document.fullscreenElement) return null;
      const p = root.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
      return p;
    };

    btn.addEventListener('click', () => {
      if (want) {
        remember(false);
        if (document.fullscreenElement) {
          const p = document.exitFullscreen();
          if (p && p.catch) p.catch(() => {});
        }
      } else { remember(true); go(); }
    });

    // Re-arm rather than give up. Chrome grants activation on click/touchend,
    // never on pointerdown, and a refused request must not clear the setting.
    let armed = false;
    function arm() {
      if (armed) return;
      armed = true;
      ['click', 'touchend', 'keyup'].forEach((e) =>
        document.addEventListener(e, tryRestore, true));
    }
    function disarm() {
      armed = false;
      ['click', 'touchend', 'keyup'].forEach((e) =>
        document.removeEventListener(e, tryRestore, true));
    }
    function tryRestore() {
      if (!want || document.fullscreenElement) { disarm(); return; }
      const p = go();
      if (p && p.then) p.then(disarm, () => {});   // refused: stay armed
      else disarm();
    }
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && want) arm();
    });
    if (want) arm();
    paint();
  }

  async function loadMachineInfo() {
    try {
      const d = await (await fetch('/api/info')).json();
      $('info-machine').textContent = d.machineId || '--';
      $('info-url').textContent = d.lanUrl || location.origin;
      $('info-controller').textContent = d.controllerConnected ? 'Connected' : 'Not connected';
    } catch (e) { /* the sheet still opens */ }
  }

  function openSettings() {
    $('settings-panel').hidden = false;
    primeSig = null;
    renderPrices(); renderPrime();
    loadPrimeInfo(); loadPriceHistory(); loadMachineInfo();
  }
  function closeSettings() {
    $('settings-panel').hidden = true;
    closeHistory();
    edClose();          // the bar belongs to the sheet that opened it
    disarmPrime();
  }

  // The signature is cleared on open so the list is rebuilt from live status
  // rather than from whatever it held the last time the panel was closed.
  function openCredits() {
    $('credits-panel').hidden = false;
    $('btn-credits').setAttribute('aria-expanded', 'true');
    waitSig = null;
    renderWaiting();
  }
  function closeCredits() {
    $('credits-panel').hidden = true;
    $('btn-credits').setAttribute('aria-expanded', 'false');
  }

  // -------------------------------------------------------------------------
  // Cart mutation  --  the only place `cart` changes
  // -------------------------------------------------------------------------
  function step(id, delta) {
    if (id < 1 || id > ACTIVE) return;

    const i = cart.findIndex((x) => x.id === id);
    if (delta > 0) {
      if (!canAddTo(id)) return;
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
    const i = cart.findIndex((x) => x.id === id);
    if (i < 0) return;
    const name = cart[i].name;
    cart.splice(i, 1);
    renderGrid(); renderCart();
    toast(name + ' removed', 'caution');
  }

  // Clears this screen's cart. Nothing has been charged yet, so it asks
  // rather than warns.
  //
  // NOTE: it does not touch credits already unlocked on the machine. Those are
  // paid for and live on the controller -- they are voided one at a time from
  // the Credits panel, which is a different action against different money.
  async function clearCart(label) {
    if (!cart.length) return;
    const presses = cart.reduce((a, it) => a + it.qty, 0);
    const what = cart.length === 1 ? cart[0].name : cart.length + ' products';
    let pesos = 0, priced = true;
    for (const it of cart) {
      if (prices[it.id] == null) priced = false; else pesos += prices[it.id] * it.qty;
    }
    const stats = [
      { v: cart.length, k: 'Product' + (cart.length !== 1 ? 's' : '') },
      { v: presses, k: 'Press' + (presses !== 1 ? 'es' : '') },
    ];
    if (priced) stats.push({ v: '₱' + pesos, k: 'Not Yet Charged' });
    const ok = await askConfirm({
      icon: 'trash', kind: 'danger',
      title: 'Clear the cart?',
      body: 'Nothing has been charged yet — this only empties the screen.',
      stats: stats,
      yes: label || 'Clear Cart',
    });
    if (!ok) return;
    cart = [];
    renderGrid(); renderCart();
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  async function executeArm() {
    if (!cart.length) return;

    // Unlock is the moment money is committed: the presses become the
    // customer's whether or not they press them, and only a write-off from the
    // Credits panel undoes it. Every other irreversible control on this screen
    // asks first; this one is the most irreversible of them and did not.
    let presses = 0, pesos = 0, priced = true;
    for (const it of cart) {
      presses += it.qty;
      if (prices[it.id] == null) priced = false;
      else pesos += prices[it.id] * it.qty;
    }
    const armStats = [];
    if (priced) armStats.push({ v: '₱' + pesos, k: 'Total Amount' });
    armStats.push({ v: presses, k: 'Press' + (presses !== 1 ? 'es' : '') });
    armStats.push({ v: cart.length, k: 'Product' + (cart.length !== 1 ? 's' : '') });
    const ok = await askConfirm({
      icon: 'lock', kind: 'primary',
      title: 'Unlock these buttons?',
      body: 'Take the payment first. Once unlocked the presses are the '
          + 'customer’s, whether or not they press them.',
      stats: armStats,
      yes: 'Unlock Buttons',
    });
    if (!ok) return;

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
        showDone(presses, priced ? pesos : null, summary);
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
      // d is { prices: {...}, connected: bool } -- the ENVELOPE, not the map.
      // Assigning it whole left prices[1] undefined, so every product read as
      // unpriced: the settings fields came up blank and the cart showed a dash
      // however many times the price had been saved. The controller had them
      // the entire time.
      prices = (d && d.prices) || {};
      renderPrices();
      renderCart();
    } catch (e) { /* unpriced is a legible state; leave it */ }
  }

  async function loadToday() {
    try {
      const d = await (await fetch('/api/sales/today')).json();
      const pesos = d.pesos || 0;
      $('kpi-today').textContent = '₱' + pesos;
      $('today-pesos').textContent = '₱' + pesos;
      $('today-presses').textContent = d.presses || 0;

      // Every slot, in slot order, including the ones that sold nothing -- the
      // zeroes are the point. A list that hides them makes "nothing sold" look
      // the same as "that product is missing from the report".
      const bySlot = {};
      (d.products || []).forEach((r) => { if (r.slot) bySlot[r.slot] = r; });
      let h = '';
      for (let s = 1; s <= ACTIVE; s++) {
        const r = bySlot[s] || {};
        h += '<div class="v2-today-row">'
           + '<span class="v2-today-dot" style="background:' + (SLOT_DOT[s] || '#98A2B3') + '"></span>'
           + '<span class="v2-today-name">' + esc(r.name || PRODUCT[s]) + '</span>'
           + '<span class="v2-today-qty">x' + (r.presses || 0) + '</span>'
           + '<span class="v2-today-pesos">₱' + (r.pesos || 0) + '</span>'
           + '</div>';
      }
      $('today-rows').innerHTML = h;
    } catch (e) { /* leave the last known figure rather than blanking it */ }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // A wave out from the point pressed.
  //
  // It is drawn into #v2-fx, not into the button. A stepper tap changes a
  // quantity, which changes renderGrid's signature, which replaces the grid's
  // innerHTML -- so a span parented to the button is gone one frame after the
  // press, which is the only moment it exists to cover. Proved it: after a
  // real pointerdown-then-click the button node itself is a different object.
  //
  // #v2-fx also sits outside the zoomed shell, so every number here is a plain
  // viewport pixel and there is no visual-vs-zoomed conversion to get wrong.
  // The one thing that does need scaling is the corner radius, because the
  // button's computed 12px is pre-zoom.
  function ripple(btn, ev) {
    const r = btn.getBoundingClientRect();
    if (!r.width) return;
    const host = document.createElement('div');
    host.className = 'v2-ripple-host';
    host.style.left = r.left + 'px';
    host.style.top = r.top + 'px';
    host.style.width = r.width + 'px';
    host.style.height = r.height + 'px';
    host.style.borderRadius =
      (parseFloat(getComputedStyle(btn).borderTopLeftRadius) || 12) * curScale + 'px';

    const d = Math.hypot(r.width, r.height) * 2;
    const el = document.createElement('span');
    el.className = 'v2-ripple';
    el.style.width = el.style.height = d + 'px';
    el.style.left = (ev.clientX - r.left - d / 2) + 'px';
    el.style.top = (ev.clientY - r.top - d / 2) + 'px';
    el.style.color = getComputedStyle(btn).color;
    // Belt and braces: animationend is the normal path, but a tab backgrounded
    // mid-press never fires it, and a till left running for a week would then
    // accumulate one dead node per tap.
    const done = () => host.remove();
    el.addEventListener('animationend', done);
    setTimeout(done, 1200);

    host.appendChild(el);
    $('v2-fx').appendChild(host);
  }

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

    // The wave starts under the finger, so it has to be placed from the event.
    // pointerdown, not click: the feedback belongs to the press, and on a
    // touchscreen click does not land until the finger lifts.
    $('v2-grid').addEventListener('pointerdown', (ev) => {
      const btn = ev.target.closest('.v2-step');
      if (btn && !btn.disabled) ripple(btn, ev);
    });

    $('v2-cart-list').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-remove]');
      if (!btn || btn.disabled) return;
      removeLine(parseInt(btn.dataset.remove, 10));
    });

    // Adds one of each EVERY press, not only the first. It used to skip any
    // slot already in the cart, which made the second tap a no-op that
    // announced "Nothing available to add" -- so a cashier building two of
    // everything had to fall back to twelve taps on the steppers.
    //
    // The merge is step(id, +1)'s, deliberately: same MAX_QTY ceiling, same
    // insertion order for new lines. It is inlined rather than looped over
    // step() so the grid and cart are rebuilt once instead of six times.
    $('btn-one-each').addEventListener('click', () => {
      let added = 0, maxed = 0;
      for (let s = 1; s <= ACTIVE; s++) {
        if (!canAddTo(s)) continue;
        const i = cart.findIndex((x) => x.id === s);
        if (i < 0) cart.push({ id: s, name: PRODUCT[s], qty: 1 });   // insertion order
        else if (cart[i].qty >= MAX_QTY) { maxed++; continue; }
        else cart[i].qty += 1;
        added++;
      }
      renderGrid(); renderCart();
      // Three different outcomes, three different things to say. "Nothing
      // available" when the real reason is a full cart sends the cashier
      // hunting for a fault that is not there.
      if (added) {
        notice('Added ' + added + ' product' + (added !== 1 ? 's' : '') + ' to your cart',
               'One press of each was added.', { cart: true });
      } else if (maxed) {
        // A toast for this was wrong: the cashier pressed a button, nothing
        // moved, and a line that fades in two seconds is the easiest thing on
        // the screen to miss. It gets the same treatment every other answer
        // does.
        askConfirm({
          icon: 'warn', kind: 'caution',
          title: 'Nothing left to add',
          body: 'Every product in this cart is already at the maximum per sale.',
          stats: [
            { v: maxed, k: 'Product' + (maxed !== 1 ? 's' : '') + ' At Maximum' },
            { v: MAX_QTY, k: 'Presses Each' },
          ],
          yes: 'Got It',
        });
      } else {
        askConfirm({
          icon: 'warn', kind: 'caution',
          title: 'Nothing available to add',
          body: 'No product can take a press right now — check the tanks '
              + 'and the link to the machine.',
          yes: 'Got It',
        });
      }
    });

    // One handler for both, as the handoff requires.
    // One handler, one control -- addEventListener on a null would have thrown
    // here and killed every listener wired after it.
    $('btn-clear-cart').addEventListener('click', () => clearCart('Clear Cart'));
    $('btn-arm').addEventListener('click', executeArm);

    $('offline-retry').addEventListener('click', () => location.reload());

    // Today's sales, centred on the screen. It used to hang off the chip, which
    // needed a rect calculation that had to be converted out of the zoomed
    // coordinate space by hand; centring is done by the flex parent and cannot
    // drift or land off a short screen.
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
    $('today-panel').addEventListener('click', (ev) => {
      if (ev.target === $('today-panel')) closeToday();   // the backdrop only
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      // Innermost first, so Escape does not shut the sheet behind a dialog.
      if (!$('ask').hidden) return;                        // the dialog owns it
      // Outermost first: the sale-done panel is the newest thing on screen, so
      // Escape belongs to it before anything underneath.
      if (!$('done-panel').hidden) { closeDone(); return; }
      if (!$('today-panel').hidden) { closeToday(); return; }
      if (!$('credits-panel').hidden) { closeCredits(); return; }
      // History sits ON TOP of settings, so it has to be offered Escape first.
      if (!$('history-panel').hidden) { closeHistory(); return; }
      if (!$('settings-panel').hidden) closeSettings();
    });

    // Credits
    $('btn-credits').addEventListener('click', openCredits);
    $('credits-panel').addEventListener('click', (ev) => {
      if (ev.target === $('credits-panel')) closeCredits();   // the backdrop only
    });

    // Settings
    $('btn-settings').addEventListener('click', openSettings);
    // No close button: the design's header has none. Tapping outside and
    // Escape both close it, which is what the backdrop listener below is.
    $('settings-panel').addEventListener('click', (ev) => {
      if (ev.target === $('settings-panel')) closeSettings();   // the backdrop only
    });

    // Delegated: all three lists are rebuilt from scratch as status arrives.
    $('price-list').addEventListener('input', (ev) => {
      if (ev.target.dataset.price) markPriceDirty(ev.target);
    });
    $('btn-save-prices').addEventListener('click', savePrices);
    $('btn-price-history').addEventListener('click', openHistory);

    // What is typed in the bar IS the price: it is written straight through to
    // the row, which then runs the same sanitiser and dirty check a directly
    // typed field would. One rule for what a price may be, in one place.
    $('ed-input').addEventListener('input', () => {
      const row = edRow(edSlot);
      if (!row) return;
      row.value = $('ed-input').value;
      markPriceDirty(row);
      // markPriceDirty may have stripped a character; the bar has to show what
      // was actually accepted, or the two disagree about the price.
      if ($('ed-input').value !== row.value) {
        const caret = row.value.length;
        $('ed-input').value = row.value;
        try { $('ed-input').setSelectionRange(caret, caret); } catch (e) {}
      }
    });
    // pointerdown, not click: the default action of pressing a button steals
    // focus from the field, and on a tablet that pulls the keyboard down.
    const edHold = (ev) => ev.preventDefault();
    ['ed-prev', 'ed-next', 'ed-done'].forEach((id) => {
      $(id).addEventListener('pointerdown', edHold);
    });
    $('ed-prev').addEventListener('click', () => {
      if (edSlot > 1) edPointAt(edSlot - 1);
    });
    $('ed-next').addEventListener('click', () => {
      if (edSlot < ACTIVE) edPointAt(edSlot + 1);
    });
    $('ed-done').addEventListener('click', () => { $('ed-input').blur(); edClose(); });
    $('notice-x').addEventListener('click', hideNotice);
    $('notice-cart').addEventListener('click', () => {
      hideNotice();
      // On a phone the layout stacks and the cart is below the fold, which is
      // the case this link exists for. On a tablet it is already on screen and
      // this is a harmless no-op.
      $('v2-cart').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    $('done-ok').addEventListener('click', closeDone);
    $('done-close').addEventListener('click', closeDone);
    $('done-panel').addEventListener('click', (ev) => {
      if (ev.target === $('done-panel')) closeDone();   // the backdrop only
    });
    $('history-panel').addEventListener('click', (ev) => {
      if (ev.target === $('history-panel')) closeHistory();   // the backdrop only
    });
    $('prime-list').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-prime]');
      if (b && !b.disabled) onPrimeTap(parseInt(b.dataset.prime, 10));
    });
    $('btn-cancel-all').addEventListener('click', voidAll);
    $('waiting-list').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-void]');
      if (b) voidSlot(parseInt(b.dataset.void, 10));
    });

    setupTheme();
    setupFullscreen();
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  // Applied before the first render, or the screen flashes light and then
  // switches once the sheet is built.
  let bootDark = true;
  try { bootDark = localStorage.getItem(THEME_KEY) !== 'light'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', bootDark ? 'dark' : 'light');

  wire();
  renderAll();
  tickClock();
  setInterval(tickClock, 1000);
  loadInfo();
  loadPrices();
  loadToday();
  connectSSE();
})();
