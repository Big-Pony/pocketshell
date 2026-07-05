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
