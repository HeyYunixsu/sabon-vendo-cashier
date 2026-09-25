# System Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a Claude session that has never seen this repo everything it needs in two files: `CLAUDE.md` for the rules and the map, `docs/SYSTEM_REFERENCE.md` for the detail.

**Architecture:** Documentation plus a guard. `tools/check_docs.js` is a dependency-free Node script that fails when the docs and the code disagree: a file path that no longer exists, a PM2 process name that was renamed, a GPIO pin that moved. The docs are written to pass it.

**Tech Stack:** Markdown, Node (no dependencies, uses `fs` only).

**Spec:** `docs/superpowers/specs/2026-09-25-standalone-kiosk-design.md`, section "Documentation deliverable" (piece 0 of the build order).

## Global Constraints

- No new dependencies. `tools/check_docs.js` runs on stock Node.
- Facts in the docs are copied from the code, never remembered. Every factual claim has a source file named next to it in this plan.
- The six sales JSON keys are `machine_id`, `vendor_id`, `voucher_id`, `amount`, `slot`, `date_created`, and must be documented as unchangeable.
- `CONFIG/config.env` is per-machine and untracked. Never paste a real machine or vendor ID into any doc.
- Commit messages carry no attribution lines. Do not push.

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `tools/check_docs.js` | Create | Fails when docs and code disagree |
| `CLAUDE.md` | Create | First file a Claude session reads: map, commands, invariants |
| `docs/SYSTEM_REFERENCE.md` | Rewrite | Full detail: protocol, server, client, uploaders, hardware |
| `README.md` | Modify (one line) | Point at both |

---

### Task 1: Doc-rot checker and `CLAUDE.md`

**Files:**
- Create: `tools/check_docs.js`
- Create: `CLAUDE.md`

**Interfaces:**
- Produces: `node tools/check_docs.js`, exit 0 when the docs match the code, exit 1 with the mismatch named. Task 2 relies on it covering `docs/SYSTEM_REFERENCE.md` as well, which it does by checking every file in its `DOCS` list.

- [ ] **Step 1: Write the checker**

Create `tools/check_docs.js`:

```js
// Fails when the docs and the code disagree. Run: node tools/check_docs.js
//
// Three things rot on their own: file paths that get moved, PM2 process names
// that get renamed, and GPIO pins that get reassigned. Each is checked against
// the file that actually decides it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = ['CLAUDE.md', 'docs/SYSTEM_REFERENCE.md'];
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const fails = [];

// Paths that only exist on a deployed machine, not in the repo.
const RUNTIME_ONLY = /^(logs\/|transaction\/|archive\/|CONFIG\/config\.env$)/;
const LOOKS_LIKE_PATH = /^(controller|cashier_dashboard|uploaders|CONFIG|docs|tools|kiosk_exit_tool|\.claude)\//;

for (const doc of DOCS) {
  if (!fs.existsSync(path.join(ROOT, doc))) { fails.push(`missing doc: ${doc}`); continue; }
  const text = read(doc);

  // 1. Every backticked repo path must exist.
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1].replace(/[.,:;)]+$/, '');
    if (!LOOKS_LIKE_PATH.test(p) || RUNTIME_ONLY.test(p)) continue;
    if (p.includes('*') || p.includes('<')) continue;         // globs and placeholders
    const bare = p.split('#')[0].split(':')[0];               // strip #L12 and :123
    if (!fs.existsSync(path.join(ROOT, bare))) fails.push(`${doc}: path does not exist: ${bare}`);
  }

  // 2. PM2 names must match setup_and_run.sh exactly.
  const real = new Set([...read('setup_and_run.sh').matchAll(/"(0\d_[A-Za-z_]+)"/g)].map((x) => x[1]));
  for (const m of text.matchAll(/\b(0\d_[A-Za-z_]+)\b/g)) {
    if (!real.has(m[1])) fails.push(`${doc}: unknown PM2 process: ${m[1]}`);
  }

  // 3. Pin lists must match the controller's defaults.
  const hw = read('controller/src/hardware_config.cpp');
  for (const kind of ['BTN', 'PUMP', 'LED']) {
    const nums = [...hw.matchAll(new RegExp(`${kind}(\\d)\\s*=\\s*(\\d+)`, 'g'))]
      .sort((a, b) => a[1] - b[1]).map((m) => m[2]);
    if (nums.length !== 6) { fails.push(`hardware_config.cpp: expected 6 ${kind} pins, found ${nums.length}`); continue; }
    const wanted = nums.join(', ');
    if (text.includes(kind + ' pins') && !text.includes(wanted)) {
      fails.push(`${doc}: ${kind} pins must read "${wanted}"`);
    }
  }
}

if (fails.length) { console.error('docs check FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('docs check: ok');
```

- [ ] **Step 2: Run it to see it fail**

Run: `node tools/check_docs.js`
Expected: FAIL with `missing doc: CLAUDE.md`.

- [x] **Step 3: Write `CLAUDE.md`** — done 2026-09-25

`CLAUDE.md` now exists at the repo root and is the source of truth. It was not
written from this plan's earlier draft, which had two facts wrong: it said the
button hold was 200 ms (the code says `BUTTON_HOLD_MS = 100`) and that an
interrupted pour is refunded as credit (it is charged at full price, one record
per press, and logged to `interrupted_sales.jsonl` — verified in
`controller/src/pump_control.cpp`, which never returns anything to `armedQty`).

The draft has been removed rather than corrected, so there is only one copy of
these facts. What remains of this task is to check the file against the code
with the commands in Step 5 and commit it.


- [ ] **Step 4: Run the checker to see it pass**

Run: `node tools/check_docs.js`
Expected: `docs check: ok`.

If it names a path, fix `CLAUDE.md` rather than the checker. If it names pins,
the pins moved in the code and the doc is the thing that is wrong.

- [ ] **Step 5: Verify the claims that the checker cannot**

Run each of these and confirm the doc matches:

```bash
grep -nE "^int (BTN|PUMP|LED)" controller/src/hardware_config.cpp   # pin defaults
grep -n "PUMP_TRIGGER_HIGH\|WATER_SENSOR_EMPTY_HIGH" controller/src/hardware_config.cpp
grep -n "BUTTON_HOLD_MS" controller/includes/hardware_config.h       # 100
grep -n "SOCKET_PORT\|DASHBOARD_PORT" cashier_dashboard/server.js    # 8080, 80
grep -n "STALE_MS\|RETRY_MS" cashier_dashboard/public/js/v2.js       # 6000, 15000
grep -oE '"(machine_id|vendor_id|voucher_id|amount|slot|date_created)"' controller/src/transaction.cpp | sort -u
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md tools/check_docs.js
git commit -m "docs: CLAUDE.md plus a checker that fails when docs drift"
```

---

### Task 2: Rewrite `docs/SYSTEM_REFERENCE.md`

**Files:**
- Rewrite: `docs/SYSTEM_REFERENCE.md` (839 lines today)
- Modify: `README.md` — one line pointing at `CLAUDE.md` and this file

**Interfaces:**
- Consumes: `node tools/check_docs.js` from Task 1, which already covers this file.

**Why it is being rewritten, not edited:** the current file documents
`cashier_dashboard/public/index.html`, the v1 dashboard that nothing serves
except a `/v1` bookmark and that the kiosk spec drops. It also numbers two
sections 11 and two sections 12, and predates the tour, air clears and offline
detection.

- [ ] **Step 1: Read the sources before writing a word**

Every section below names the file that decides its facts. Read them:

```bash
sed -n 1,60p controller/includes/app_state.h        # the state a slot carries
grep -n "isFirstWordTest" controller/src/socket_server.cpp   # every command
sed -n 120,150p controller/src/socket_server.cpp    # STATUS field order
grep -nE "^app\.(get|post)" cashier_dashboard/server.js      # every route
grep -n "const STATUS_FIELDS\|const ACTIVE" cashier_dashboard/public/js/v2.js
sed -n 1,120p CONFIG/config.env.sample              # every setting
grep -n "^## " docs/QUICK_INSTALL.md                # install steps, do not repeat them
```

- [ ] **Step 2: Write the file with these sections, in this order**

1. **What this machine is** — one paragraph, then the five processes and the
   data flow diagram (copy the shapes from `CLAUDE.md`; do not contradict it).
2. **Repo layout** — one line per directory, what lives there and what does not.
3. **Configuration** — every key in `CONFIG/config.env.sample` in a table:
   name, what it does, default. Say plainly that the file is per-machine and
   untracked, and that the last duplicate key wins because `loadEnv` assigns
   into a map.
4. **Controller** — the main loop in `pump_control.cpp`: button debounce (4
   samples), the 200 ms hold, the 200 ms start cooldown, pours measured in
   calibrated seconds, credits (`armedQty`), the queue, what happens when a
   tank empties mid-pour, and the four audit logs: `prime_events.jsonl`,
   `interrupted_sales.jsonl`, `unclaimed_credits.jsonl`, `price_changes.jsonl`.
5. **Socket protocol** — every command with its exact format and its reply, and
   the STATUS line with its 34 fields listed in order. State the formula
   `5 × slots + 4` so it survives a change in slot count.
6. **Sale records** — the six fields, the filename pattern, where files are
   written and where they move after upload. Use synthetic IDs in examples.
7. **Dashboard server** — every route from `grep -nE "^app\.(get|post)"`, the
   SSE stream and its keepalive, the controller socket with its 3 s reconnect,
   and the local queue for commands sent while the controller is down.
8. **Dashboard client** — the screens (product grid, cart, unlock, today's
   sales, credits, settings, price history, air clears), the first-run tour,
   the card states (offline, empty, in-cart, armed) and the liveness rules.
9. **Uploaders** — what each sends, how often, what it does on failure, and the
   30 s request timeout.
10. **Hardware** — the pin tables, the wiring rules, the `config.txt` block,
    and the `pinctrl` diagnostics.
11. **Testing** — `make test` for the controller, `npm test` for the dashboard,
    and the headless-Chrome sampling method used for screen behaviour.
12. **Known issues** — the damaged pins, the API port, and anything the tests
    deliberately do not cover.
13. **Making changes** — where to add a socket command, a settings panel, a
    config key, or an audit log, each with the files to touch.

Rules while writing: no section may contradict `CLAUDE.md`; do not restate
`docs/QUICK_INSTALL.md`, link to it; every number comes from a file you read in
Step 1; remove every mention of `index.html` and `app.js` except one line in
section 2 saying they are the unused v1 dashboard.

- [ ] **Step 3: Point at both docs from the README**

In `README.md`, directly under the title, add:

```markdown
**Start here:** [CLAUDE.md](CLAUDE.md) for the map and the rules,
[docs/SYSTEM_REFERENCE.md](docs/SYSTEM_REFERENCE.md) for the detail.
```

- [ ] **Step 4: Verify**

```bash
node tools/check_docs.js                                   # docs check: ok
grep -c "" docs/SYSTEM_REFERENCE.md                        # length, sanity only
grep -n "index.html\|app.js" docs/SYSTEM_REFERENCE.md      # one line, in section 2
grep -n "^## " docs/SYSTEM_REFERENCE.md                    # 13 sections, numbered once each
```

Then read the file top to bottom once, checking three things: every command in
section 5 appears in `grep -n "isFirstWordTest" controller/src/socket_server.cpp`,
every route in section 7 appears in `grep -nE "^app\.(get|post)" cashier_dashboard/server.js`,
and no number contradicts `CLAUDE.md`.

- [ ] **Step 5: Commit**

```bash
git add docs/SYSTEM_REFERENCE.md README.md
git commit -m "docs: rewrite the system reference around what actually runs"
```
