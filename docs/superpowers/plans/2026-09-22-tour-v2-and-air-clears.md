# Tour v2 + Air Clear History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Show every air-clear (prime) run in Settings.
- Extend the first-run tour to 9 steps, including a demo of the Credits button that only appears after Unlock.

**Architecture:**
- A small Node module, `lib/prime_log.js`, reads the controller's prime log. `server.js` uses it for today's count and for a new `/api/prime/history` endpoint.
- The Settings sheet gets a "View All" button that opens an "Air Clears" panel, built like the existing Price Changes panel.
- The tour gains three steps. The Credits step is forced visible by a CSS class, `tour-demo`, set on `<html>` only while that step is showing.

**Tech Stack:** vanilla JS, Express, plain CSS, and Node `assert` checks.

**Spec:** `docs/superpowers/specs/2026-09-22-first-run-tour-design.md`, section "Revision 2".

## Global Constraints

- No new dependencies.
- Colours come only from existing `v2.css` tokens.
- The tour never changes real state. The demo is CSS-only.
- Never change the controller or the prime log format.
- Commit messages carry no attribution lines. Do not push.

---

### Task 1: Air clear history (server + Settings panel)

**Files:**
- Create: `cashier_dashboard/lib/prime_log.js`
- Create: `cashier_dashboard/tests/prime_log.test.js`
- Modify: `cashier_dashboard/package.json` (`test` script)
- Modify: `cashier_dashboard/server.js`
  - `readPrimeCounts()`, ~lines 443-470;
  - a new route next to `app.get('/api/prime', …)`, ~line 473;
  - the require block at the top.
- Modify: `cashier_dashboard/public/v2.html`
  - the Maintenance group, ~line 285;
  - a new panel after `#history-panel`.
- Modify: `cashier_dashboard/public/js/v2.js`
  - after `closeHistory`, ~line 994;
  - `loadPrimeInfo`, ~line 1103;
  - `closeSettings`, ~line 1343;
  - the Escape handler, ~line 1708;
  - the listeners, ~lines 1736 and 1780.
- Modify: `cashier_dashboard/public/css/v2.css`
  - the panel selectors at ~lines 121, 934, 941, 943 and 949.

**Interfaces:**
- Produces:
  - `readPrimeRecords(file) -> Array<{machine_id, slot, seconds, date_created}>`, oldest first;
  - `latestPrimeRuns(file, limit = 200) -> Array`, newest first;
  - `GET /api/prime/history -> { runs: [...] }`;
  - DOM ids `#btn-prime-history`, `#prime-last`, `#prime-panel`, `#prime-count` and `#prime-runs`.

- [ ] **Step 1: Write the failing check**

Create `cashier_dashboard/tests/prime_log.test.js`:

```js
// Reading the controller's prime log. Run with `npm test`.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPrimeRecords, latestPrimeRuns } = require('../lib/prime_log.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prime-'));
const file = path.join(dir, 'prime_events.jsonl');

// No log yet (a fresh machine): empty, not an error.
assert.deepStrictEqual(readPrimeRecords(file), []);

const lines = [];
for (let n = 1; n <= 205; n++) {
  lines.push(JSON.stringify({ machine_id: 'M1', slot: String((n % 6) + 1),
                              seconds: 3, date_created: 'run' + n }));
}
lines.splice(10, 0, '{not json');            // one bad line must not hide the rest
fs.writeFileSync(file, lines.join('\n') + '\n\n');

assert.strictEqual(readPrimeRecords(file).length, 205);
const latest = latestPrimeRuns(file);
assert.strictEqual(latest.length, 200);      // capped
assert.strictEqual(latest[0].date_created, 'run205');   // newest first
assert.strictEqual(latest[199].date_created, 'run6');
assert.strictEqual(latestPrimeRuns(file, 3).length, 3);

fs.rmSync(dir, { recursive: true, force: true });
console.log('prime log: ok');
```

In `cashier_dashboard/package.json`, set the test script to:

```json
    "test": "node tests/tour_place.test.js && node tests/prime_log.test.js"
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd cashier_dashboard && npm test`
Expected: `tour placement: ok`, then FAIL with `Cannot find module '../lib/prime_log.js'`.

- [ ] **Step 3: Create `cashier_dashboard/lib/prime_log.js`**

```js
// The controller's prime log (logs/prime_events.jsonl): one JSON object per
// line, {machine_id, slot, seconds, date_created}, appended oldest first.
const fs = require('fs');

// Every record, oldest first. One malformed line must not hide the rest.
function readPrimeRecords(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip one bad line */ }
  }
  return out;
}

// The latest `limit` runs, newest first.
function latestPrimeRuns(file, limit = 200) {
  return readPrimeRecords(file).reverse().slice(0, limit);
}

module.exports = { readPrimeRecords, latestPrimeRuns };
```

- [ ] **Step 4: Run it and see it pass**

Run: `cd cashier_dashboard && npm test`
Expected: `tour placement: ok` and `prime log: ok`.

- [ ] **Step 5: Use it in `server.js`**

Near the other requires at the top, add:

```js
const { readPrimeRecords, latestPrimeRuns } = require('./lib/prime_log');
```

Replace the body of `readPrimeCounts()` with the version below. The date logic is unchanged; only the file reading moves out:

```js
function readPrimeCounts() {
  const counts = {};
  let total = 0;
  try {
    // Local date, matching the controller's localtime timestamps.
    const now = new Date();
    const today = `${now.getFullYear()}-`
                + `${String(now.getMonth() + 1).padStart(2, '0')}-`
                + `${String(now.getDate()).padStart(2, '0')}`;

    for (const rec of readPrimeRecords(PRIME_LOG_PATH)) {
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
```

Directly after the `app.get('/api/prime', …)` handler, add:

```js
// Every air clear, newest first -- the list behind Settings > Maintenance >
// View All. Capped: the log only grows, and 200 runs is weeks of gallon changes.
app.get('/api/prime/history', (req, res) => {
  let runs = [];
  try { runs = latestPrimeRuns(PRIME_LOG_PATH, 200); }
  catch (e) { console.error(`[dashboard] Could not read prime log: ${e.message}`); }
  res.json({ runs });
});
```

Check that it loads: `cd cashier_dashboard && node -e "require('./lib/prime_log')" && node --check server.js`. Expected: no output.

- [ ] **Step 6: Markup in `v2.html`**

In the Maintenance group, directly after `<div id="prime-list"></div>`, add:

```html
          <div class="v2-history-row">
            <div id="prime-last" class="v2-history"></div>
            <button id="btn-prime-history" class="v2-btn v2-btn-ghost v2-btn-set" type="button" disabled>View All</button>
          </div>
```

Directly after the closing `</div>` of `#history-panel`, add:

```html
  <!-- ================== AIR CLEARS ==================
       Every prime run, newest first. A prime moves product and books no sale,
       so every one of them has to be visible without opening a log over SSH. -->
  <div id="prime-panel" hidden>
    <div class="v2-credits-card" role="dialog" aria-modal="true" aria-labelledby="prime-title">
      <div class="v2-today-head">
        <h2 id="prime-title">Air Clears</h2>
        <p class="v2-credits-sub"><span id="prime-count">0</span> recorded</p>
      </div>
      <div class="v2-credits-body">
        <div id="prime-runs" class="v2-hist-list"></div>
      </div>
    </div>
  </div>
```

- [ ] **Step 7: Behaviour in `v2.js`**

(a) Directly after `const closeHistory = () => { $('history-panel').hidden = true; };`, add:

```js

  // ---- air clears ---------------------------------------------------------
  // Same shape as price history: a one-line summary in Settings, the full
  // list behind View All.
  let primeRuns = [];
  const primeHistOpen = () => !$('prime-panel').hidden;

  async function loadPrimeHistory() {
    try {
      const d = await (await fetch('/api/prime/history')).json();
      primeRuns = (d && d.runs) || [];
      $('btn-prime-history').disabled = !primeRuns.length;
      const r = primeRuns[0];
      $('prime-last').textContent = r
        ? 'Last: ' + (PRODUCT[parseInt(r.slot, 10)] || ('Slot ' + r.slot))
          + '   ' + (r.date_created || '')
        : 'No air clears recorded yet.';
      if (primeHistOpen()) renderPrimeHistory();
    } catch (e) { /* context, not essential */ }
  }

  function renderPrimeHistory() {
    $('prime-count').textContent = primeRuns.length;
    if (!primeRuns.length) {
      $('prime-runs').innerHTML =
        '<div class="v2-empty-note">No air clears recorded yet.</div>';
      return;
    }
    let h = '';
    for (const r of primeRuns) {
      const slot = parseInt(r.slot, 10);
      const name = PRODUCT[slot] || ('Slot ' + r.slot);
      h += '<div class="v2-hist-row">'
         + '<span class="v2-hist-dot" style="background:' + (SLOT_DOT[slot] || '#98A2B3') + '"></span>'
         + '<span class="v2-hist-name">' + esc(name) + ' &middot; Slot ' + esc(r.slot)
         +   '<span class="v2-hist-when">' + esc(r.date_created || '') + '</span>'
         + '</span>'
         + '<span class="v2-hist-move">' + esc(r.seconds) + 's</span>'
         + '</div>';
    }
    $('prime-runs').innerHTML = h;
  }

  function openPrimeHistory() {
    $('prime-panel').hidden = false;
    renderPrimeHistory();
    loadPrimeHistory();
  }
  const closePrimeHistory = () => { $('prime-panel').hidden = true; };
```

(b) In `loadPrimeInfo()`, directly after the line `renderPrime();` inside its `try`, add `loadPrimeHistory();`. Settings calls `loadPrimeInfo` when it opens and again after every prime, so the summary stays current.

(c) In `closeSettings()`, directly after `closeHistory();`, add `closePrimeHistory();`.

(d) In the Escape handler, directly before the `history-panel` line, add:

```js
      if (!$('prime-panel').hidden) { closePrimeHistory(); return; }
```

(e) Directly after `$('btn-price-history').addEventListener('click', openHistory);`, add:

```js
    $('btn-prime-history').addEventListener('click', openPrimeHistory);
```

and directly after the `history-panel` backdrop listener block (the one ending `closeHistory();   // the backdrop only` then `});`), add:

```js
    $('prime-panel').addEventListener('click', (ev) => {
      if (ev.target === $('prime-panel')) closePrimeHistory();   // the backdrop only
    });
```

- [ ] **Step 8: Styles in `v2.css`**

The panel reuses the history styles. Make these five edits:
1. After `  :root[data-theme="dark"] #history-panel,` (~line 121), add the line `  :root[data-theme="dark"] #prime-panel,`.
2. `#today-panel, #credits-panel, #history-panel {` (~line 934, the one with `position: fixed`) becomes `#today-panel, #credits-panel, #history-panel, #prime-panel {`.
3. `#history-panel { z-index: 56; }` becomes `#history-panel, #prime-panel { z-index: 56; }`.
4. The same selector inside the `@supports (backdrop-filter…)` block (~line 943) gets `, #prime-panel` too.
5. `#today-panel[hidden], #credits-panel[hidden], #history-panel[hidden] { display: none; }` gets `, #prime-panel[hidden]`.

- [ ] **Step 9: Verify**

1. Run `cd cashier_dashboard && npm test && node --check server.js`. Expected: both checks print ok.
2. Check it in headless Chrome over CDP, not with `chrome --screenshot`. Copy `$TEMP/t2cdp.js` and change it as follows:
   - Load `cashier_dashboard/public/v2.html` from disk at 1280×800.
   - Dismiss the tour: dispatch Escape.
   - Because `/api/prime/history` can't be reached from `file://`, inject sample data with `Runtime.evaluate`. Override `window.fetch` before the page script runs: use `Page.addScriptToEvaluateOnNewDocument` so that `/api/prime/history` returns `{runs:[{slot:"3",seconds:3,date_created:"2026-09-22 14:59:03"},{slot:"1",seconds:3,date_created:"2026-09-22 09:12:40"}]}`.
   - Click `#btn-settings`, then `#btn-prime-history`.
   - Take a screenshot.
3. Open the PNG with Read and confirm:
   - the Air Clears panel is on top of Settings, with 2 rows, dots, "· Slot 3", times and "3s";
   - "Last: …" shows in Settings under the pump list.
4. Dispatch Escape. Expected: the panel closes and Settings stays open.

- [ ] **Step 10: Commit**

```bash
git add cashier_dashboard/lib/prime_log.js cashier_dashboard/tests/prime_log.test.js cashier_dashboard/package.json cashier_dashboard/server.js cashier_dashboard/public/v2.html cashier_dashboard/public/js/v2.js cashier_dashboard/public/css/v2.css
git commit -m "feat(dashboard): list every air clear in Settings > Maintenance"
```

---

### Task 2: Tour 6 → 9 steps with the Credits demo

**Files:**
- Modify: `cashier_dashboard/public/js/tour.js` (`STEPS`, `start`, `render`, `finish`)
- Modify: `cashier_dashboard/public/css/v2.css` (the TOUR block, before `/* === end TOUR`)

**Interfaces:**
- Consumes: the existing ids `#btn-clear-cart`, `#btn-credits`, `#credits-count` and `#chip-waiting`.
- Produces: the class `tour-demo` on `<html>`, present only while a `demo: true` step is showing.

- [ ] **Step 1: Replace `STEPS` in `tour.js`**

```js
  const STEPS = [
    { sel: '#v2-grid .v2-prod',
      text: 'Tap a product to add one press. Tap again for more, or − to remove one. A red glow means the machine is offline; gray means the tank is empty.' },
    { sel: '#btn-one-each',
      text: 'Adds one press of every product at once.' },
    { sel: '#btn-clear-cart',
      text: 'Empties the cart if the customer changes their mind. Only the cart — buttons already unlocked are not touched.' },
    { sel: '#v2-cart .v2-totals',
      text: 'Check the quantity and total, then take the cash.' },
    { sel: '#btn-arm',
      text: 'After payment, tap Unlock. The cards turn teal and say Unlocked, and the customer presses the machine’s buttons — one press, one serving.' },
    // Hidden until something is owed, so the tour shows a sample of it
    // (see .tour-demo in v2.css) rather than skip the one button that
    // appears on its own.
    { sel: '#btn-credits', demo: true,
      text: 'This appears after Unlock: presses the customer has paid for but not used yet. Tap it to see them. Cancel only if they are not coming back — cancelling writes off money already taken.' },
    { sel: '#chip-waiting',
      text: 'The same count at a glance. It lights up while a customer still has presses left.' },
    { sel: '#chip-today',
      text: 'Today’s sales and presses.' },
    { sel: '#btn-settings',
      text: 'Change prices, clear air after a gallon change, see every air clear, and replay this tutorial.' },
  ];
```

- [ ] **Step 2: Wire the demo class**

- In `start()`, change the filter to `steps = STEPS.filter((s) => s.demo || visible(document.querySelector(s.sel)));`.
- In `render()`, add this as the first line: `document.documentElement.classList.toggle('tour-demo', !!steps[i].demo);`
- In `finish()`, add this as the first line: `document.documentElement.classList.remove('tour-demo');`

- [ ] **Step 3: CSS in the TOUR block of `v2.css`**

Directly before the line `/* ============================== end TOUR`, add:

```css
/* The Credits step shows the button even when nothing is owed, with a sample
   count, so the cashier has seen it before it first appears for real. Only
   while [hidden]: when credits really are owed, the real button and count
   stay untouched. Beats the global [hidden] !important on specificity. */
.tour-demo #btn-credits[hidden] { display: inline-flex !important; }
.tour-demo #btn-credits[hidden] #credits-count { font-size: 0; }
.tour-demo #btn-credits[hidden] #credits-count::after { content: '2'; font-size: 17px; }
```

- [ ] **Step 4: Verify**

1. Run `cd cashier_dashboard && npm test`. Expected: both checks print ok.
2. Using the CDP script approach from Task 1, at 1280×800 and at 390×844, click `.tour-next` to reach each step and screenshot steps 3, 6 and 7. Confirm:
   - the count reads `n / 9`;
   - step 3 rings the trash icon;
   - step 6 rings a visible coin button showing "2", with the right text, and `document.documentElement.classList.contains('tour-demo')` is true;
   - step 7 rings the Waiting chip;
   - after step 6, and again after Skip, `tour-demo` is gone and `#btn-credits` is hidden again.
3. On the phone, each spotlight must be on screen, because of the scroll-into-view behaviour.

- [ ] **Step 5: Commit**

```bash
git add cashier_dashboard/public/js/tour.js cashier_dashboard/public/css/v2.css
git commit -m "feat(dashboard): tour covers clear cart, the credits button and waiting"
```
