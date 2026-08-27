# Product Card Layout Fix

Companion to `CASHIER_DASHBOARD.md` §14 (Product Photography Integration). That section covered getting the 1:1 photos into the cards without cropping; this covers cleaning up the result now that it's live.

## Problem

From the live screenshot: every card has a large dead-space gap between its text content and the card's right edge. Most visible on slot 2 (Detergent 2) — content ends after "● Armed" and the white panel just keeps going for a few hundred more pixels with nothing in it. Same pattern on all six cards, just harder to notice where the status text runs longer.

The `D1`/`D2`/`F1`/`F2`/`Z1`/`Z2` circular badge is also redundant — each card now carries three separate identifiers for the same slot (`SLOT 0X` label, the initial badge, and the product name), and the real photo plus product name already do the identification job the badge was standing in for before photos existed.

## Root cause

Two effects stacking on top of each other:

1. **The card is stretched to fill its grid column** — if the grid uses `1fr`-style column tracks, each card is as wide as the grid math hands it, regardless of what's inside.
2. **The text panel inside the card is stretched to fill whatever's left after the square photo zone** — if the panel uses `flex: 1` (or similar), it claims all remaining card width even though its actual content (a short label, a name, one digit, a status word) is much narrower.

A wide card produces a wide leftover panel, and a flex-grow panel then fills that width no matter how little content is in it. Fixing either alone helps a little; fixing both is what actually closes the gap.

## Fix

Not a grid/panel resize — just give the text some breathing room from the photo edge. Right now the panel's left padding is small enough that `SLOT 0X`, the name, the qty, and the status all read as one dense cluster jammed right against the photo boundary, which is the "congested" feeling. Push it right:

```css
.card-info {
  padding-left: 28px;   /* was: ~8-12px, text was hugging the photo edge */
}
```

That's the whole fix — no grid or flex changes, no card resizing. The dead space on the *far right* of the panel is untouched by this (that's the separate, bigger change from before, which is off the table for now) — this only addresses the left side, giving the text block some margin so it reads as placed rather than squeezed in.

### Remove the initial badge
Drop the circular `D1`/`D2`/etc. badge entirely. Keep:
- **`SLOT 0X`** — still operationally useful, matches the physical slot number on the machine for troubleshooting
- **Product name** — now the primary identifier, reinforced by the actual product photo sitting right next to it

One less element in that stack also means the padding change above has less to push against, so the two fixes help each other.

## What doesn't change
The photo zone itself — square, matched to card height, `background-size: cover`/`contain`, uncropped — stays exactly as specified in `CASHIER_DASHBOARD.md` §14. Only the text panel's width behavior and the badge element are in scope here.
