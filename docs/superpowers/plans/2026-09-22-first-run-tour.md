# First-Run Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show cashiers a six-step spotlight tour of the v2 dashboard the first time it opens on a device, and let them replay it from Settings.

**Architecture:** A self-contained `public/js/tour.js` builds its own overlay (`#tour`), appended to `<body>` outside the zoomed `#v2` shell. It positions a spotlight box and a tip card from `getBoundingClientRect()`. The placement math is a pure function, `placeTip`, that Node can require and test. A `localStorage` key records that the tour has been seen. Settings gets a Help row that calls `window.sabonTour.start()`.

**Tech Stack:** Vanilla JS (ES2017, no build step), plain CSS using the existing `v2.css` tokens, and Node's `assert` for the one check. Headless Chrome is used for screenshots.

**Spec:** `docs/superpowers/specs/2026-09-22-first-run-tour-design.md`

## Global Constraints

- No new dependencies and no library. The tablet may be offline.
- Colours come only from existing `v2.css` tokens (`--surface`, `--ink`, `--ink-2`, `--brand`, `--r-panel`, `--shadow`, `--font`), so dark and light themes both work.
- The tour never clicks, arms or changes anything. It only points.
- Storage key: `sabon.tourSeen`, value `'1'`. Every storage access is wrapped in try/catch.
- Commit messages must not contain attribution lines.
- Do not touch `CONFIG/config.env` or any transaction files.

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `cashier_dashboard/public/js/tour.js` | Create | Step table, `placeTip`, overlay, auto-start, `window.sabonTour.start()` |
| `cashier_dashboard/tests/tour_place.test.js` | Create | Node assert check of `placeTip` |
| `cashier_dashboard/package.json` | Modify `scripts` | `"test": "node tests/tour_place.test.js"` |
| `cashier_dashboard/public/css/v2.css` | Append a block before the `prefers-reduced-motion` media query | Tour overlay, spotlight and tip styles |
| `cashier_dashboard/public/v2.html` | Modify | Add `<script src="js/tour.js">` after `v2.js`, and a Help group in Settings |
| `cashier_dashboard/public/js/v2.js` | Modify, next to the `btn-settings` listener (~line 1717) | `#btn-tour` click handler: close Settings, then start the tour |

---

### Task 1: Tip placement function with its check

**Files:**
- Create: `cashier_dashboard/public/js/tour.js` (placement function and Node export only)
- Create: `cashier_dashboard/tests/tour_place.test.js`
- Modify: `cashier_dashboard/package.json`

**Interfaces:**
- Produces: `placeTip(target, tip, vw, vh, gap, margin) -> { left, top }`
  - `target` is `{ left, top, width, bottom }` in viewport px.
  - `tip` is `{ width, height }`.
  - The tip is centred horizontally on the target and clamped to `[margin, vw - margin - tip.width]`.
  - It goes below the target (`bottom + gap`) if it fits above `vh - margin`. Otherwise it goes above (`top - gap - tip.height`), never less than `margin`.
  - In Node, `require('../public/js/tour.js')` returns `{ placeTip }`.

- [ ] **Step 1: Write the failing test**

Create `cashier_dashboard/tests/tour_place.test.js`:

```js
// The one piece of tour logic that is pure arithmetic: where the tip card
// lands. Run with `npm test` from cashier_dashboard/.
const assert = require('assert');
const { placeTip } = require('../public/js/tour.js');

const tip = { width: 300, height: 100 };
const place = (t) => placeTip(t, tip, 1280, 800, 12, 16);

// Room below: centred under the target.
assert.deepStrictEqual(place({ left: 400, top: 100, width: 100, bottom: 150 }), { left: 300, top: 162 });
// No room below: flips above.
assert.deepStrictEqual(place({ left: 400, top: 700, width: 100, bottom: 750 }), { left: 300, top: 588 });
// Near the left edge: clamped to the margin.
assert.strictEqual(place({ left: 0, top: 100, width: 40, bottom: 140 }).left, 16);
// Near the right edge: clamped so the card ends at the margin.
assert.strictEqual(place({ left: 1260, top: 100, width: 20, bottom: 140 }).left, 1280 - 16 - 300);
// Tall target near the top with no room either side: never above the margin.
assert.strictEqual(placeTip({ left: 0, top: 20, width: 100, bottom: 780 }, tip, 1280, 800, 12, 16).top, 16);

console.log('tour placement: ok');
```

In `cashier_dashboard/package.json`, change `scripts` to:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node tests/tour_place.test.js"
  },
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd cashier_dashboard && npm test`
Expected: FAIL with `Cannot find module '../public/js/tour.js'`

- [ ] **Step 3: Write the minimal implementation**

Create `cashier_dashboard/public/js/tour.js`:

```js
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
})();
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `cd cashier_dashboard && npm test`
Expected: `tour placement: ok`

- [ ] **Step 5: Commit**

```bash
git add cashier_dashboard/public/js/tour.js cashier_dashboard/tests/tour_place.test.js cashier_dashboard/package.json
git commit -m "feat(dashboard): tour tip placement, with a node check"
```

---

### Task 2: The tour overlay and first-run auto-start

**Files:**
- Modify: `cashier_dashboard/public/js/tour.js`. Add the browser part after the `module.exports` guard.
- Modify: `cashier_dashboard/public/css/v2.css`. Insert the tour block immediately before the line `@media (prefers-reduced-motion: reduce) {` (~line 1648). The global reduced-motion rule there already cuts the spotlight's transition, so no extra rule is needed.
- Modify: `cashier_dashboard/public/v2.html`. Add a script tag after `<script src="js/v2.js"></script>` (line 440).

**Interfaces:**
- Consumes: `placeTip` from Task 1 (same file).
- Produces: `window.sabonTour.start()`. It always runs, ignoring the seen flag, and restarts at step 1 if a tour is already open. It creates `#tour` on first use.

- [ ] **Step 1: Add the browser code to `tour.js`**

Replace the closing `})();` of `tour.js` with the following, so the browser code follows the `module.exports` guard inside the same IIFE:

```js

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
```

- [ ] **Step 2: Add the tour styles to `v2.css`**

Insert this immediately before the line `@media (prefers-reduced-motion: reduce) {`:

```css
/* ================================ TOUR ====================================
   First-run tour (js/tour.js). #tour is appended to <body>, outside the
   zoomed shell, so every size here is real viewport pixels. It covers the
   whole screen on purpose: the tour points at controls, it never lets a tap
   reach them. Above every other layer (the price editor and toast sit at 70). */
#tour { position: fixed; inset: 0; z-index: 80; }
#tour[hidden] { display: none; }
.tour-spot {
  position: fixed;
  border-radius: var(--r-panel);
  /* ring, then a shadow big enough to dim the rest of the screen */
  box-shadow: 0 0 0 3px var(--brand), 0 0 0 9999px rgba(8, 12, 18, .62);
  pointer-events: none;
  transition: left .25s ease, top .25s ease, width .25s ease, height .25s ease;
}
.tour-tip {
  position: fixed;
  box-sizing: border-box;
  width: 340px;
  max-width: calc(100vw - 32px);
  padding: 18px 20px;
  border-radius: var(--r-panel);
  background: var(--surface);
  color: var(--ink);
  box-shadow: var(--shadow);
  font-family: var(--font);
}
.tour-count { margin: 0 0 6px; font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.tour-text { margin: 0 0 16px; font-size: 16px; line-height: 1.45; }
.tour-actions { display: flex; justify-content: flex-end; gap: 10px; }
/* ============================== end TOUR ================================== */

```

- [ ] **Step 3: Load the script in `v2.html`**

After line 440, `<script src="js/v2.js"></script>`, add:

```html
<script src="js/tour.js"></script>
```

- [ ] **Step 4: Make sure the Node check still passes**

Run: `cd cashier_dashboard && npm test`
Expected: `tour placement: ok`. The browser code sits after the `return`, so Node never runs it.

- [ ] **Step 5: Check it visually in headless Chrome**

Run from `cashier_dashboard/public` in Git Bash. Each headless run gets a fresh profile, so the tour auto-starts:

```bash
C="/c/Program Files/Google/Chrome/Application/chrome.exe"
U="file:///$(cygpath -m "$PWD")/v2.html"
OUT="$(cygpath -w "$TEMP")"
"$C" --headless=new --disable-gpu --window-size=1280,800 --virtual-time-budget=3000 --screenshot="$OUT\\tour_tablet.png" "$U"
"$C" --headless=new --disable-gpu --window-size=390,844  --virtual-time-budget=3000 --screenshot="$OUT\\tour_phone.png"  "$U"
```

Open both PNGs. For each, check:
- the screen is dimmed except the first product card, which has a blue ring;
- the tip card reads `1 / 6`, or fewer on the phone if some controls are hidden;
- the tip text starts "Tap a product…";
- the card has Skip and Next buttons;
- the card sits fully on screen, below or above the card, and doesn't cover it.

- [ ] **Step 6: Commit**

```bash
git add cashier_dashboard/public/js/tour.js cashier_dashboard/public/css/v2.css cashier_dashboard/public/v2.html
git commit -m "feat(dashboard): first-run spotlight tour for cashiers"
```

---

### Task 3: Show tutorial button in Settings

**Files:**
- Modify: `cashier_dashboard/public/v2.html`. Add a Help group after the "This Machine" `<section>` (it ends at ~line 304, before the `</div>` that closes `.v2-sheet-body`).
- Modify: `cashier_dashboard/public/js/v2.js`. Add the handler right after `$('btn-settings').addEventListener('click', openSettings);` (~line 1717).

**Interfaces:**
- Consumes: `window.sabonTour.start()` (Task 2) and `closeSettings()` (existing, `v2.js` ~line 1341).

- [ ] **Step 1: Add the Help group to Settings**

In `v2.html`, after the closing `</section>` of the "This Machine" group, add:

```html
        <section class="v2-group">
          <h3 class="v2-group-label">Help</h3>
          <div class="v2-set-row">
            <span class="v2-set-k">How to use this screen</span>
            <button id="btn-tour" class="v2-btn v2-btn-ghost v2-btn-set" type="button">Show tutorial</button>
          </div>
        </section>
```

- [ ] **Step 2: Wire the button in `v2.js`**

After `$('btn-settings').addEventListener('click', openSettings);` add:

```js
    // The tour points at the main screen, so the sheet has to be out of the way.
    $('btn-tour').addEventListener('click', () => {
      closeSettings();
      if (window.sabonTour) window.sabonTour.start();
    });
```

- [ ] **Step 3: Check it manually in a desktop browser**

Open `cashier_dashboard/public/v2.html` from disk in Chrome, then:
1. The tour auto-starts. Press **Escape**. The tour closes and nothing else changes.
2. Reload. The tour does **not** start.
3. Open Settings (the gear) and scroll to **Help**, then tap **Show tutorial**. Settings closes and the tour starts at `1 / 6`.
4. Tap **Next** through to the last step. The button reads **Done**. Tap it and the tour closes.
5. Tap the Theme button to switch to light, then replay. The tip card and ring are readable in light too.
6. With the tour open, tap anywhere on the dimmed area. Nothing gets added to the cart.

To reset the seen flag during testing, run `localStorage.removeItem('sabon.tourSeen')` in DevTools.

- [ ] **Step 4: Commit**

```bash
git add cashier_dashboard/public/v2.html cashier_dashboard/public/js/v2.js
git commit -m "feat(dashboard): replay the tour from Settings > Help"
```

---

## After merge, on the Pi

```bash
cd ~/Desktop/sabon-vendo-cashier && git pull
```

Then hard-refresh the tablet. These are static files, so there's no rebuild or restart.
