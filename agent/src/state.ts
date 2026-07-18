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

// WP-3a flip hysteresis on top of inferState's raw output. The raw inference
// is twitchy: RUN_WINDOW_MS (400ms) sits below the 1s scan period, so bursty
// output flips run/wait back and forth — and every flip used to trigger a
// full list()+broadcast round. StateHysteresis publishes a new state only
// after the raw inference repeats it for `threshold` consecutive observations
// (2 scan ticks in production), so a single-tick blip never reaches clients.
export class StateHysteresis {
  private published: SessionState;
  private candidate: SessionState | null = null;
  private streak = 0;

  constructor(initial: SessionState, private readonly threshold = 2) {
    this.published = initial;
  }

  get state(): SessionState {
    return this.published;
  }

  // Feed one raw inference. Returns true exactly when the published state
  // flips (the caller's cue to notify listeners).
  next(inferred: SessionState): boolean {
    if (inferred === this.published) {
      this.candidate = null;
      this.streak = 0;
      return false;
    }
    this.streak = inferred === this.candidate ? this.streak + 1 : 1;
    this.candidate = inferred;
    if (this.streak >= this.threshold) {
      this.published = inferred;
      this.candidate = null;
      this.streak = 0;
      return true;
    }
    return false;
  }
}
