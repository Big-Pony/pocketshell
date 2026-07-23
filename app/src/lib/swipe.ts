// app/src/lib/swipe.ts
// Pure horizontal-swipe detection for top-area tab switching. Filters out
// vertical scrolls (terminal viewport handles its own vertical touch) and
// slow drags. dx = endX - startX; negative = left swipe, positive = right.

export interface Gesture { dx: number; dy: number; dt: number }
export interface SwipeOpts { minDist?: number; ratio?: number; maxDt?: number }
export type SwipeDir = "left" | "right" | null;

export function detectSwipe(g: Gesture, opts: SwipeOpts = {}): SwipeDir {
  const minDist = opts.minDist ?? 50;
  const ratio = opts.ratio ?? 1.5;
  const maxDt = opts.maxDt ?? 600;
  if (g.dt > maxDt) return null;
  if (Math.abs(g.dx) < minDist) return null;
  if (Math.abs(g.dx) < Math.abs(g.dy) * ratio) return null;
  return g.dx < 0 ? "left" : "right";
}

// Minimal pointer shape the tracker needs (a real PointerEvent satisfies it).
export interface SwipePoint { clientX: number; clientY: number; timeStamp: number }
export interface SwipeTracker {
  down(e: SwipePoint): void;
  move(e: SwipePoint): void;
  up(e: SwipePoint): void;
  cancel(): void;
}

// Stateful pointer→swipe tracker shared by the top (tab) and bottom (panel)
// areas. Beyond down/up it handles the case a scrollable descendant claims the
// touch and the browser fires `pointercancel` instead of `pointerup`: the last
// move position is remembered so the gesture is still evaluated from its
// last-known delta (a vertical scroll evaluates to null and is ignored; a real
// horizontal swipe still registers). Wire cancel to both pointercancel and
// pointerleave; wire move to pointermove.
export function makeSwipeTracker(onSwipe: (dir: "left" | "right") => void, opts: SwipeOpts = {}): SwipeTracker {
  type Pt = { x: number; y: number; t: number };
  let start: Pt | null = null;
  let last: Pt | null = null;
  function evaluate(p: Pt) {
    if (!start) return;
    const s = start;
    start = null;
    last = null;
    const dir = detectSwipe({ dx: p.x - s.x, dy: p.y - s.y, dt: p.t - s.t }, opts);
    if (dir) onSwipe(dir);
  }
  return {
    down(e) { start = { x: e.clientX, y: e.clientY, t: e.timeStamp }; last = start; },
    move(e) { if (start) last = { x: e.clientX, y: e.clientY, t: e.timeStamp }; },
    up(e) { evaluate({ x: e.clientX, y: e.clientY, t: e.timeStamp }); },
    cancel() { if (last) evaluate(last); start = null; last = null; },
  };
}
