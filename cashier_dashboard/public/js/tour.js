/* First-run tour. Six tips pointed at the real controls, shown once per
   device and replayable from Settings -> Help. It only points: the overlay
   swallows every tap, so the tour cannot add to a cart or unlock a slot.
   See docs/superpowers/specs/2026-09-22-first-run-tour-design.md. */
(function () {
  'use strict';

  // Where the tip card goes. Pure, so Node can check it
  // (tests/tour_place.test.js). Below the target if it fits, else above;
  // centred on it, clamped to the viewport.
  function placeTip(t, tip, vw, vh, gap, margin) {
    const left = Math.max(margin,
      Math.min(t.left + t.width / 2 - tip.width / 2, vw - margin - tip.width));
    const below = t.bottom + gap;
    const top = below + tip.height <= vh - margin
      ? below
      : Math.max(margin, t.top - gap - tip.height);
    return { left, top };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { placeTip };
    return;
  }

  const SEEN_KEY = 'sabon.tourSeen';
  const STEPS = [
    { sel: '#v2-grid .v2-prod',
      text: 'Tap a product to add one press. Tap again for more, or − to remove one. A red glow means the machine is offline; gray means the tank is empty.' },
    { sel: '#btn-one-each',
      text: 'Adds one press of every product at once.' },
    { sel: '#v2-cart .v2-totals',
      text: 'Check the quantity and total, then take the cash.' },
    { sel: '#btn-arm',
      text: 'After payment, tap Unlock. The customer presses the machine’s buttons — one press, one serving. Unused presses wait under the coin button in the cart header.' },
    { sel: '#chip-today',
      text: 'Today’s sales and presses.' },
    { sel: '#btn-settings',
      text: 'Change prices, clear air after a gallon change, and replay this tutorial.' },
  ];
  const PAD = 6;       // spotlight breathing room around the control
  const GAP = 12;      // between spotlight and tip card
  const MARGIN = 16;   // tip card never closer than this to the screen edge

  let root = null;
  let steps = [];
  let i = 0;

  // Missing, [hidden] (or inside one), or collapsed to nothing: skip it.
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
  }

  // Outside #v2 on purpose, like #v2-fx: #v2 is zoomed, and out here
  // getBoundingClientRect() coordinates can be used as-is.
  function build() {
    root = document.createElement('div');
    root.id = 'tour';
    root.hidden = true;
    root.innerHTML =
      '<div class="tour-spot"></div>' +
      '<div class="tour-tip" role="dialog" aria-modal="true" aria-labelledby="tour-text">' +
        '<p class="tour-count"></p>' +
        '<p class="tour-text" id="tour-text"></p>' +
        '<div class="tour-actions">' +
          '<button class="v2-btn v2-btn-ghost tour-skip" type="button">Skip</button>' +
          '<button class="v2-btn v2-btn-primary tour-next" type="button">Next</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    root.querySelector('.tour-skip').addEventListener('click', finish);
    root.querySelector('.tour-next').addEventListener('click', next);
  }

  function position() {
    const el = document.querySelector(steps[i].sel);
    if (!visible(el)) { next(); return; }   // vanished since start: move on
    const r = el.getBoundingClientRect();
    const box = { left: r.left - PAD, top: r.top - PAD,
                  width: r.width + PAD * 2, bottom: r.bottom + PAD };
    const spot = root.querySelector('.tour-spot');
    spot.style.left = box.left + 'px';
    spot.style.top = box.top + 'px';
    spot.style.width = box.width + 'px';
    spot.style.height = (r.height + PAD * 2) + 'px';
    const tip = root.querySelector('.tour-tip');
    const p = placeTip(box, tip.getBoundingClientRect(), innerWidth, innerHeight, GAP, MARGIN);
    tip.style.left = p.left + 'px';
    tip.style.top = p.top + 'px';
  }

  function render() {
    root.querySelector('.tour-count').textContent = (i + 1) + ' / ' + steps.length;
    root.querySelector('.tour-text').textContent = steps[i].text;
    const btn = root.querySelector('.tour-next');
    btn.textContent = i === steps.length - 1 ? 'Done' : 'Next';
    // On a phone the page scrolls, and steps 3-4 sit below the fold.
    const el = document.querySelector(steps[i].sel);
    if (el) el.scrollIntoView({ block: 'center' });
    position();
    btn.focus();
  }

  function next() {
    i += 1;
    if (i >= steps.length) finish(); else render();
  }

  function finish() {
    if (root) root.hidden = true;
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* shows again next load */ }
  }

  function start() {
    steps = STEPS.filter((s) => visible(document.querySelector(s.sel)));
    if (!steps.length) return;
    if (!root) build();
    root.hidden = false;
    i = 0;
    render();
  }

  // Capture phase, so the tour takes Escape before v2.js's document
  // listener can close whatever sheet sits underneath.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !root || root.hidden) return;
    ev.stopPropagation();
    finish();
  }, true);

  function reflow() { if (root && !root.hidden) position(); }
  window.addEventListener('resize', reflow);
  window.addEventListener('orientationchange', reflow);
  // Capture, so a scroll inside any panel moves the spotlight too.
  document.addEventListener('scroll', reflow, true);

  window.sabonTour = { start };

  // First run on this device: wait for the grid, then start. Every 250 ms,
  // up to 10 s; give up quietly if it never renders.
  if (!seen()) {
    let tries = 0;
    const wait = setInterval(() => {
      if (document.querySelector('#v2-grid .v2-prod')) { clearInterval(wait); start(); }
      else if (++tries >= 40) clearInterval(wait);
    }, 250);
  }
})();
