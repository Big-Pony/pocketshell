// Pure shell helpers for the S5 app skeleton. No DOM, no side effects.
export type BottomPanel = "file" | "task" | "kbd" | "snip" | "set";

const MIN = 0.15;
const MAX = 0.85;

/** Clamp the top-area height ratio so neither region collapses. */
export function clampSplit(ratio: number): number {
  if (Number.isNaN(ratio)) return MIN;
  return Math.min(MAX, Math.max(MIN, ratio));
}
