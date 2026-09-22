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
