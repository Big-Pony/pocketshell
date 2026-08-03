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

// Field-equal check across everything the view reads (SessionMeta + the local
// `closed` flag). `attached`/`closed` are normalized with !! so an absent flag
// and an explicit false count as equal.
function sameSession(a: LocalSession, b: LocalSession): boolean {
  return a.name === b.name && a.state === b.state && a.cols === b.cols &&
    a.rows === b.rows && a.lastLine === b.lastLine && a.createdAt === b.createdAt &&
    !!a.attached === !!b.attached && !!a.closed === !!b.closed;
}

// Merge local sessions with incoming from server: upsert active, tombstone absent, append new.
// R5: reference-preserving. The server rebroadcasts the full list every ~3s,
// usually unchanged — keep the existing array/element references whenever the
// content is identical so Svelte's $state sees no update and the tab strip,
// TaskPanel and the persist $effect stay idle. New references only where a
// field actually changed (or a session appeared/disappeared).
export function mergeSessions(local: LocalSession[], incoming: SessionMeta[]): LocalSession[] {
  const inc = new Map(incoming.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const result: LocalSession[] = [];
  for (const s of local) {
    const hit = inc.get(s.name);
    if (hit) {
      const next: LocalSession = { ...hit, closed: false };
      result.push(sameSession(s, next) ? s : next);
      seen.add(s.name);
    } else {
      // Already a tombstone (closed+done): keep the element ref, otherwise a
      // dead session would force a fresh array on every broadcast forever.
      result.push(s.closed && s.state === "done" ? s : { ...s, closed: true, state: "done" });
    }
  }
  for (const s of incoming) {
    if (!seen.has(s.name)) result.push({ ...s, closed: false });
  }
  if (result.length === local.length && result.every((s, i) => s === local[i])) return local;
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
