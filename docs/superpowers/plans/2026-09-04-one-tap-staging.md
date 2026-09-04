# One-Tap Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adding a product to a sale takes one tap instead of four. Tapping a
card stages it at one press; tapping again makes it two. Quantity is adjusted
on the staged card itself, where the cashier can already see what they are
changing.

**Architecture:** `stageItem()` already merges by product id — staging the same
product twice adds to the existing entry rather than duplicating it. That is
the whole mechanism this needs. `selectProduct()` stops holding a highlight and
calls `stageItem(id, 1)` directly; the top stepper and the Add button are
deleted along with the `selProduct` / `multiSelect` / `currentQty` state they
drove; the staged card grows `−` and `+`. The controller, the socket protocol
and every endpoint are untouched — this is one file.

**Tech Stack:** vanilla JS in `cashier_dashboard/public/index.html`

## Global Constraints

- **The grid is rebuilt on a 500ms STATUS beat.** Replacing `innerHTML`
  destroys the element under the user's finger, and a click only fires when
  press and release land on the same element — so a tap spanning a redraw is
  silently swallowed. Every new control binds through delegation on a stable
  parent, and `gridSig` must include anything new that is drawn.
- **Touch targets stay at least 44px.** This runs on a tablet at a counter,
  operated at speed, often one-handed.
- **No new dependencies.** The dashboard has zero external deps and the machine
  may have no internet.
- Nothing here may change what is sent to the controller. `ARM,<slot>,<qty>`
  and `ARM_BATCH` keep their current shape and meaning.

## On testing

There is no JavaScript test harness in this repo — the controller has 583
checks, the dashboard has none. Standing one up is a larger decision than this
feature should make on its own, so each task below ends with **precise manual
verification** against the live mock instead of an automated test. Every step
names what to tap and what must happen. This is a deliberate, stated gap, not
an oversight; a front-end harness is worth its own conversation.

---

## What is being replaced

Today, adding two products takes eight interactions:

```
tap card -> card highlights -> [- 1 +] -> Add
tap card -> card highlights -> [- 1 +] -> Add
                                            -> Unlock Buttons
```

After:

```
tap card -> staged
tap card -> staged
             -> Unlock Buttons
```

A quantity above one is either repeated taps on the card (natural up to three
or four) or `−`/`+` on the staged card.

**One behaviour is deliberately traded away.** Tapping a selected card
currently un-selects it — added on request, because Clear List was too blunt
for "I picked the wrong one". Under one-tap staging that gesture means
"add another", so un-picking moves to the `×` already on the staged card, and
to `−` at a count of one. That is arguably the better home for it: the item is
visible in the sale strip when it is removed, rather than vanishing from a card
the cashier has to remember they touched.

---

## File Structure

| File | Responsibility |
|---|---|
| `cashier_dashboard/public/index.html` | the whole change: markup, CSS and script |

One file, because it is one file today — the dashboard is a single self-
contained page by design, and splitting it is out of scope here.

---

## Task 1: A tap stages the product

**Files:**
- Modify: `cashier_dashboard/public/index.html` — `selectProduct()` at `:1324`,
  `clearSelection()` at `:1332`, `renderGrid()` at `:1201`, card CSS at `:256`

**Interfaces:**
- Consumes: `stageItem(id, qtyOverride)`, `staged` (array of
  `{ id, name, qty, ml }`), `renderStaged()`, `updateArm()`
- Produces: `stagedQty(id) -> number`, used by Task 2 and Task 3

- [ ] **Step 1: Add a helper for the staged count**

Above `selectProduct()`:

```js
  // How many presses of this product are already in the sale. Drives both the
  // card badge and the +/- controls.
  function stagedQty(id) {
    const it = staged.find(x => x.id === id);
    return it ? it.qty : 0;
  }
```

- [ ] **Step 2: Make a tap stage**

Replace `selectProduct()` and `clearSelection()` with:

```js
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
```

The `btn-select-all` listener calls `clearSelection()`, which the edit above
deletes, and `enableQtyStepper()`, which Task 2 deletes. Leaving it would throw
on tap between commits, so repoint it now — Task 3 finishes the job with the
empty-case message, the label and the styling:

```js
  $('btn-select-all').addEventListener('click', () => {
    for (let s = 1; s <= ACTIVE; s++) {
      if (S.wlvl[s]) continue;                    // tank empty
      if (stagedQty(s) >= MAX_QTY) continue;
      stageItem(s, 1);
    }
  });
```

- [ ] **Step 3: Stop `stageItem` clearing state that no longer exists**

Replace the reset line inside `stageItem()`:

```js
    renderStaged(); renderGrid(); updateArm();
```

That is, drop `selProduct = null; $('btn-stage').disabled = true; currentQty = 1; $('qty-value').value = 1;`
from that function — none of those elements survive Task 2, and the grid must
redraw so the badge updates.

- [ ] **Step 4: Draw the badge**

In `renderGrid()`, replace the signature line so the badge redraws when the
sale changes:

```js
    let sig = '';
    for (let s = 1; s <= TOTAL; s++)
      sig += '|' + (S.armedQty[s] || 0) + S.busy[s] + S.wlvl[s] + ':' + stagedQty(s);
    if (sig === gridSig) return;
    gridSig = sig;
```

Replace the `sel` and `cls` lines:

```js
      const act = s <= ACTIVE, armed = S.armedQty[s] || 0, busy = S.busy[s],
            empty = S.wlvl[s], inSale = stagedQty(s);
      let cls = 'product-card';
      if (!act) cls += ' inactive'; else if (busy) cls += ' busy';
      else if (empty) cls += ' empty'; else if (armed > 0 && !inSale) cls += ' armed';
      if (inSale) cls += ' selected';
```

Replace the `else if (sel)` line in the status-dot chain:

```js
      else if (inSale) { dotHtml = '<span class="dot dot-accent"></span> In sale';   dotColor = 'var(--accent-action)'; }
```

and the `qCls` line, which referenced `sel`:

```js
      const qCls = !act || armed === 0 ? 'is-zero' : (busy ? 'is-busy' : (inSale ? 'is-selected' : 'is-armed'));
```

Add the badge as the first child inside the card div:

```js
      h += '<div class="'+cls+'" data-slot="'+s+'" data-product="'+s+'">';
      if (inSale) h += '<div class="staged-badge">'+inSale+'</div>';
      h += '<div class="product-icon">'+PRODUCT_ICON[s]+'</div>';
```

Delete the `btn-select-all` textContent line at the end of `renderGrid()` —
Task 3 replaces that button's behaviour and it no longer has two states.

- [ ] **Step 5: Style the badge**

Add to the `.product-card` rule at `:256` if it is not already there:

```css
  position: relative;
```

and after the `.product-card .armed-qty` rules:

```css
.product-card .staged-badge {
  position: absolute; top: 6px; right: 6px;
  min-width: 24px; height: 24px; padding: 0 7px;
  border-radius: 12px;
  background: var(--accent-action); color: #fff;
  font-size: 13px; font-weight: 700; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;   /* the tap belongs to the card underneath */
}
```

The toast has only `.success` and `.error` styling today, and "you have hit the
maximum" is neither. Add a third beside them at `:536`:

```css
#toast.caution { border-color: var(--status-caution); color: var(--status-caution); }
```

- [ ] **Step 6: Verify by hand**

Start the mock dashboard and, in a browser:

1. Tap **Ariel Powder** once. It appears in the sale strip at `1×`, the card
   shows a badge reading `1`, the card reads **In sale**, and the total shows
   the price and `1 press`.
2. Tap it twice more. Badge reads `3`, the strip still shows **one** card
   reading `3×`, the total is three times the price.
3. Tap a second product. Two cards in the strip, both badges correct.
4. Watch for ten seconds without touching anything — the badge must not
   flicker or reset as STATUS arrives every 500ms.
5. Tap one card rapidly ten times. The count must reach exactly 10, with no
   taps swallowed by a redraw.
6. Tap past `MAX_QTY`. A toast appears and the count stops rising.
7. Tap **Clear List**. All badges clear.

- [ ] **Step 7: Commit**

```bash
git add cashier_dashboard/public/index.html
git commit -m "feat(dashboard): one tap stages a product"
```

---

## Task 2: Adjust quantity on the staged card

**Files:**
- Modify: `cashier_dashboard/public/index.html` — `renderStaged()` at `:1350`,
  the sale-strip markup at `:917-924`, stepper CSS at `:198-224`,
  listeners at `:1931-1957`

**Interfaces:**
- Consumes: `stagedQty(id)` (Task 1), `staged`, `renderStaged()`, `renderGrid()`,
  `updateArm()`
- Produces: `adjustStaged(id, delta)`, used by the delegated listener

- [ ] **Step 1: Add the adjuster**

Beside `removeStaged()`:

```js
  // Down to zero removes the item. A staged card showing 0x would be a thing
  // the cashier has to tidy up by hand for no reason.
  function adjustStaged(id, delta) {
    const i = staged.findIndex(x => x.id === id);
    if (i < 0) return;
    const it = staged[i];
    const next = it.qty + delta;
    if (next < 1) { staged.splice(i, 1); }
    else if (next > MAX_QTY) {
      toast('Maximum ' + MAX_QTY + ' presses per product', 'caution');
      return;
    } else {
      it.qty = next;
      it.ml = next * (PRODUCT_ML[id] || 0);
    }
    renderStaged(); renderGrid(); updateArm();
  }
```

- [ ] **Step 2: Draw the controls**

In `renderStaged()`, replace the line that builds each staged card:

```js
      h += '<div class="staged-card">'
         + '<button class="staged-card-remove" data-idx="'+i+'">&times;</button>'
         + '<span class="staged-card-name">'+it.name+'</span>'
         + '<span class="staged-card-qty">'+it.qty+'\xD7 \xB7 '+it.ml+'ml</span>'
         + '<div class="staged-card-steps">'
         + '<button class="staged-step" data-id="'+it.id+'" data-delta="-1" aria-label="One less">&minus;</button>'
         + '<button class="staged-step" data-id="'+it.id+'" data-delta="1" aria-label="One more">+</button>'
         + '</div>'
         + '</div>';
```

Delete the trailing `querySelectorAll('.staged-card-remove')` loop at the end
of `renderStaged()` — Step 4 replaces it with delegation.

- [ ] **Step 3: Style the controls**

Change the staged-card grid at `:171` to make room for a third row:

```css
#sale-strip .staged-card {
  display: grid; grid-template-columns: 1fr 22px;
  grid-template-rows: auto auto auto;
  align-items: center;
  background: var(--bg-surface-secondary);
  border: 1px solid var(--accent-action); border-radius: 8px;
  padding: 8px 10px 8px 14px; width: 100%; min-width: 0; max-width: none;
  min-height: 52px;
}
```

Change `.staged-card .staged-card-remove` to span only the first two rows so
it does not stretch over the new controls:

```css
.staged-card .staged-card-remove {
  grid-column: 2; grid-row: 1 / 3;
  background: none; border: none; color: var(--text-content-secondary);
  cursor: pointer; font-size: 16px; line-height: 1;
  padding: 4px; text-align: center; align-self: start;
}
```

Add after it:

```css
.staged-card .staged-card-steps {
  grid-column: 1 / 3; grid-row: 3;
  display: flex; gap: 6px; margin-top: 6px;
}
.staged-card .staged-step {
  flex: 1; height: 34px;
  background: var(--bg-surface-tertiary); color: var(--text-content-primary);
  border: 1px solid var(--border-default); border-radius: 6px;
  font-size: 18px; font-weight: 700; line-height: 1; cursor: pointer;
  font-family: 'Poppins', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
```

The 34px button sits inside a 52px+ card with 6px of margin, so the effective
target clears 44px vertically. On the mobile breakpoint the staged grid drops
to fewer columns and the buttons widen, which only helps.

- [ ] **Step 4: Bind by delegation**

`#staged-items` is rebuilt whenever the sale changes, so bind once on the
container. Add beside the other delegated listeners:

```js
  $('staged-items').addEventListener('click', (ev) => {
    const step = ev.target.closest('.staged-step');
    if (step) { adjustStaged(+step.dataset.id, +step.dataset.delta); return; }
    const rm = ev.target.closest('.staged-card-remove');
    if (rm) { removeStaged(+rm.dataset.idx); return; }
  });
```

- [ ] **Step 5: Delete the top stepper and Add**

Remove this markup from the sale strip at `:917-922`:

```html
    <div class="qty-stepper" id="qty-stepper">
      <button class="stepper-btn" id="stepper-down">−</button>
      <input type="text" id="qty-value" value="1" inputmode="numeric" pattern="[0-9]*" readonly>
      <button class="stepper-btn" id="stepper-up">+</button>
    </div>
    <button id="btn-stage" class="btn btn-outline" disabled>Add</button>
```

Remove the listeners for `stepper-up`, `stepper-down` and `btn-stage`, and the
`enableQtyStepper()` function.

Remove `currentQty` from the declaration at `:1063`, and the
`currentQty = 1; $('qty-value').value = 1;` fragments at `:1095`, `:1098` and
`:1390`. `selProduct` and `multiSelect` come out in Task 3, so leave them for
now if it keeps this commit compiling.

Remove the `.qty-stepper` CSS rules at `:198-224`, the `#btn-stage` and
`.qty-stepper` entries in the mobile-breakpoint rules at `:579-580` and `:603`,
and drop `.stepper-btn` from the shared selector lists at `:623` and `:631`.

- [ ] **Step 6: Verify by hand**

1. Stage three of one product. The staged card shows `3× · <ml>ml` with `−`
   and `+` beneath.
2. Tap `+`. Count is 4, the card badge in the grid is 4, the peso total rises
   by one unit price.
3. Tap `−` three times. Count reaches 1.
4. Tap `−` once more. The card disappears from the strip and the grid badge
   clears.
5. Tap `+` up to `MAX_QTY` and once past it — a toast appears, the count holds.
6. With two products staged, adjust one; the other must not change.
7. Hold a finger on `+` while STATUS updates arrive. No swallowed taps.
8. Check the strip on a narrow window — the controls must not overflow the
   card.

- [ ] **Step 7: Commit**

```bash
git add cashier_dashboard/public/index.html
git commit -m "feat(dashboard): adjust quantity on the staged card"
```

---

## Task 3: Make "Select All Products" mean what it says

The button reads **Select All Products** but enters a multi-select mode where
the cashier then picks several and taps Add. It has always promised the
opposite of what it does. With one-tap staging the mode is redundant, and the
label can finally be honest: one tap stages every in-stock product.

**Files:**
- Modify: `cashier_dashboard/public/index.html` — the listener at `:1952`,
  the button at `:932`, and the last `multiSelect` / `selProduct` references

**Interfaces:**
- Consumes: `stagedQty(id)` (Task 1), `stageItem(id, qtyOverride)`, `S.wlvl`,
  `ACTIVE`, `MAX_QTY`

- [ ] **Step 1: Say so when there is nothing to add**

Task 1 already repointed this listener at `stageItem`. It is silent when every
tank is empty or everything is already at `MAX_QTY`, which reads as a dead
button. Replace it with:

```js
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
```

- [ ] **Step 2: Fix the label**

At `:932`, change the button text to **Add One Of Each**, which is what it now
does:

```html
    <button id="btn-select-all" class="btn btn-outline" style="margin-top:10px;width:100%;padding:12px;font-size:14px;">Add One Of Each</button>
```

It also drops from `btn-primary` to `btn-outline`. Unlock Buttons is the
primary action in this column; two competing primaries made the real one
harder to find.

- [ ] **Step 3: Delete the last of the old selection state**

Remove `selProduct` and `multiSelect` from the declaration at `:1063`, leaving:

```js
  let staged = [], unclaimed = [], saleCtr = 0;
```

Remove the `selProduct = null; multiSelect = false;` fragments at `:1095`,
`:1961` and anywhere else they survive.

Confirm nothing references the removed names:

```bash
grep -n "multiSelect\|selProduct\|currentQty\|btn-stage\|qty-stepper\|enableQtyStepper\|clearSelection" cashier_dashboard/public/index.html
```
Expected: no output.

- [ ] **Step 4: Verify by hand**

1. On a machine with all six in stock, tap **Add One Of Each**. Six cards in
   the strip, every badge `1`, the total is the sum of all six prices.
2. Tap it again. Every count goes to `2`.
3. Mark a tank empty in the mock. Tap it again — the empty product is skipped,
   the others rise.
4. With every product at `MAX_QTY`, tap it — a toast appears and nothing
   changes.
5. Tap **Unlock Buttons** and confirm the controller arms exactly the slots and
   quantities shown, by checking the armed counts on the cards against the
   strip.

- [ ] **Step 5: Commit**

```bash
git add cashier_dashboard/public/index.html
git commit -m "change(dashboard): Select All actually adds one of each"
```

---

## Out of scope

- **A JavaScript test harness.** Noted above under *On testing*. Worth doing,
  too big to smuggle in here.
- **Long-press for a keypad.** Considered and rejected: invisible to a cashier
  nobody told, and awkward on a resistive panel.
- **Reordering the grid by how often a product sells.** The sales archive now
  has the data to do it, but a grid that moves under a cashier who has learned
  its layout is a step backwards at counter speed.
