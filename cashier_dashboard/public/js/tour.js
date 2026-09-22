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
