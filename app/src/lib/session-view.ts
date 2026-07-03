// Shared, testable view helpers for the session tabs + task panel.
import type { SessionState } from "./protocol";

export function stateDotClass(state: SessionState): "dot-run" | "dot-wait" | "dot-done" {
  return state === "run" ? "dot-run" : state === "wait" ? "dot-wait" : "dot-done";
}

// A live session (run/wait) needs a confirm before kill; a done one does not.
export function needsKillConfirm(state: SessionState): boolean {
  return state === "run" || state === "wait";
}
