// Shared, testable view helpers for the session tabs + task panel.
import type { SessionMeta, SessionState } from "./protocol";

export interface LocalSession extends SessionMeta {
  closed?: boolean;
}

export function stateDotClass(state: SessionState): "dot-run" | "dot-wait" | "dot-done" | "dot-idle" {
  return state === "run" ? "dot-run"
    : state === "wait" ? "dot-wait"
    : state === "idle" ? "dot-idle"
    : "dot-done";
}

// Any non-terminated session needs a confirm before kill. For idle (foreign,
// activity unknown) we cannot tell run vs wait, so confirm to be safe.
export function needsKillConfirm(state: SessionState): boolean {
  return state !== "done";
}

// Lowest free `sN` against ALL current session names (incl. foreign), so an
// auto-created session never collides with (and silently attaches to) another.
export function nextSessionName(existing: string[]): string {
  const set = new Set(existing);
  let n = 1;
  while (set.has(`s${n}`)) n++;
  return `s${n}`;
}

// Card action i18n key. Un-adopted (foreign/idle) sessions are "open" (tapping
// attaches/adopts them); adopted ones are "enter"; tombstones are "close".
// Rendered via $t('tasks.action.' + actionLabel(s)) in TaskPanel.
export function actionLabel(s: LocalSession): "open" | "enter" | "close" {
  if (s.closed) return "close";
  return s.attached ? "enter" : "open";
}

// Whether selecting this session should trigger a backend adopt (attach).
export function shouldAdopt(s: LocalSession): boolean {
  return !s.closed && !s.attached;
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
