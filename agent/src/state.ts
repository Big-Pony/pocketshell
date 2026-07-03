// Heuristic three-state session inference. No TUI parsing, no tmux calls here —
// pure so it can be unit-tested; the caller supplies hasSession + timestamps.
import type { SessionState } from "./protocol";

// A session counts as "run" if it emitted output within this many ms.
export const RUN_WINDOW_MS = 400;

export function inferState(x: { hasSession: boolean; lastOutputAt: number; now: number }): SessionState {
  if (!x.hasSession) return "done";
  if (x.now - x.lastOutputAt < RUN_WINDOW_MS) return "run";
  return "wait";
}
