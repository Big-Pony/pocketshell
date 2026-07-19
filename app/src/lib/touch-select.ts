// req 7-5: let a mobile long-press select STATIC terminal text.
//
// xterm's DOM renderer only keeps the visible rows in the DOM (scrollback is
// virtual), so it reimplements touch scrolling itself: a `touchmove` on the
// terminal runs `viewport.scrollTop += delta`. During a stationary long-press
// the finger still jitters a few pixels, which fires `touchmove` → xterm scrolls
// a pixel or two → the browser reclassifies the gesture as a pan and never
// raises the OS text-selection handles. (The file preview has no such handler,
// which is why long-press selection works there but not in the terminal.)
//
// Fix: gate xterm's touch-scroll by a small movement slop. While the finger
// stays within TOUCH_SLOP of the touchstart point we swallow the `touchmove`
// (xterm never scrolls → the native long-press selection can begin); once it
// travels past the slop it's a real drag, so we release every following
// `touchmove` to xterm and scrollback navigation keeps working.

export const TOUCH_SLOP = 10;

// True when the point is still within the slop box around the origin — i.e. a
// near-stationary long-press whose scroll should be suppressed. False once the
// finger has clearly moved (a drag), which should scroll as usual.
export function withinTouchSlop(dx: number, dy: number, slop: number = TOUCH_SLOP): boolean {
  return Math.abs(dx) <= slop && Math.abs(dy) <= slop;
}
