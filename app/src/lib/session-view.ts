// Shared, testable view helpers for the session tabs + task panel.
import type { SessionMeta, SessionState } from "./protocol";

export interface LocalSession extends SessionMeta {
  closed?: boolean;
}

export function stateDotClass(state: SessionState): "dot-run" | "dot-wait" | "dot-done" {
  return state === "run" ? "dot-run" : state === "wait" ? "dot-wait" : "dot-done";
}

// A live session (run/wait) needs a confirm before kill; a done one does not.
export function needsKillConfirm(state: SessionState): boolean {
  return state === "run" || state === "wait";
}

// Merge local sessions with incoming from server: upsert active, tombstone absent, append new.
export function mergeSessions(local: LocalSession[], incoming: SessionMeta[]): LocalSession[] {
  const inc = new Map(incoming.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const result: LocalSession[] = [];
  for (const s of local) {
    const hit = inc.get(s.name);
    if (hit) {
      result.push({ ...hit, closed: false });
      seen.add(s.name);
    } else {
      result.push({ ...s, closed: true, state: "done" });
    }
  }
  for (const s of incoming) {
    if (!seen.has(s.name)) result.push({ ...s, closed: false });
  }
  return result;
}

// Mark a session as closed and done.
export function tombstone(local: LocalSession[], id: string): LocalSession[] {
  return local.map((s) => (s.name === id ? { ...s, closed: true, state: "done" } : s));
}

// Remove a session from the list.
export function closeTab(local: LocalSession[], id: string): LocalSession[] {
  return local.filter((s) => s.name !== id);
}
