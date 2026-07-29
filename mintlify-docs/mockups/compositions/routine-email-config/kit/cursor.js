/* kit/cursor.js — window.impCursor: deterministic simulated-cursor helper.
 *
 * Adds cursor motion (and optionally a click pulse + ripple) to a PAUSED GSAP
 * timeline at absolute times. Seek-safe by construction: every tween is placed
 * at an explicit position on the caller's timeline; no Date.now(), no
 * Math.random(), no event listeners.
 *
 *   window.impCursor(tl, {
 *     from: [x, y],        // optional — set start position at `at`
 *     to:   [x, y],        // optional — glide target
 *     at:   seconds,       // absolute timeline position (default 0)
 *     click: boolean,      // press tick + ripple pulse after arrival
 *     duration: seconds,   // glide duration (default 0.45)
 *     show: boolean,       // fade the cursor in at `at` (default true)
 *     hide: boolean,       // fade the cursor out at the end (default false)
 *     cursor: selector,    // default ".imp-cursor"
 *   });
 *
 * Returns the timeline position at which the gesture ends, so calls chain:
 *   let t = impCursor(tl, { from: [1200, 900], to: [640, 380], at: 1.0, click: true });
 *   impCursor(tl, { to: [820, 520], at: t + 0.4, click: true, show: false });
 */
(function () {
  "use strict";

  window.impCursor = function impCursor(tl, opts) {
    var o = opts || {};
    var cursor = o.cursor || ".imp-cursor";
    var pointer = o.pointer || cursor + " svg";
    var ripple = o.ripple || cursor + " .imp-click-ripple";
    var at = typeof o.at === "number" ? o.at : 0;
    var duration = typeof o.duration === "number" ? o.duration : 0.45;
    var show = o.show !== false;
    var hide = o.hide === true;
    var t = at;

    if (o.from) tl.set(cursor, { x: o.from[0], y: o.from[1] }, t);
    if (show) tl.to(cursor, { opacity: 1, duration: 0.15, ease: "power1.out" }, t);

    if (o.to) {
      tl.to(cursor, { x: o.to[0], y: o.to[1], duration: duration, ease: "power2.inOut" }, t + 0.02);
      t = t + 0.02 + duration;
    }

    if (o.click) {
      /* press tick on the pointer glyph + one accent ripple pulse */
      tl.to(pointer, { scale: 0.85, duration: 0.09, ease: "power1.in", transformOrigin: "20% 15%" }, t);
      tl.to(pointer, { scale: 1, duration: 0.12, ease: "power1.out", transformOrigin: "20% 15%" }, t + 0.09);
      tl.fromTo(
        ripple,
        { scale: 0.5, opacity: 0.85 },
        { scale: 1.2, opacity: 0, duration: 0.24, ease: "power2.out", transformOrigin: "50% 50%", immediateRender: false },
        t + 0.02
      );
      tl.set(ripple, { scale: 0, opacity: 0 }, t + 0.3);
      t += 0.3;
    }

    if (hide) {
      tl.to(cursor, { opacity: 0, duration: 0.16, ease: "power1.out" }, t);
      t += 0.16;
    }

    return t;
  };
})();
