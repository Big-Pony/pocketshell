// P1 unified top-area tab model. Terminal tabs (kind:"term") come from live
// sessions; file preview tabs (kind:"file") are opened from the file panel.
// Both share one ordered list so Fn+←/→ cycles across them uniformly.
export type TopTab =
  | { kind: "term"; id: string; title: string }
  | { kind: "file"; id: string; title: string; path: string; mode: "code" | "diff" };

export function fileTabId(path: string, mode: "code" | "diff"): string {
  return `file:${mode}:${path}`;
}

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export function openFileTab(tabs: TopTab[], path: string, mode: "code" | "diff"): TopTab[] {
  const id = fileTabId(path, mode);
  if (tabs.some((t) => t.id === id)) return tabs;
  const title = mode === "diff" ? `${baseName(path)} ✎` : baseName(path);
  return [...tabs, { kind: "file", id, title, path, mode }];
}

export function closeFileTab(tabs: TopTab[], id: string): TopTab[] {
  return tabs.filter((t) => t.id !== id);
}

export function cycle(order: string[], activeId: string, delta: number): string {
  if (!order.length) return activeId;
  const i = Math.max(0, order.indexOf(activeId));
  return order[(i + delta + order.length) % order.length];
}

export function stepClamp(order: string[], activeId: string, delta: number): string {
  if (!order.length) return activeId;
  const i = Math.max(0, order.indexOf(activeId));
  const next = Math.max(0, Math.min(order.length - 1, i + delta));
  return order[next];
}

export function appendOrder(order: string[], id: string): string[] {
  return order.includes(id) ? order : [...order, id];
}

export function removeOrder(order: string[], id: string): string[] {
  return order.filter((x) => x !== id);
}

export function filePathFromTabId(tabs: TopTab[], id: string): string | null {
  const t = tabs.find((x) => x.id === id);
  return t && t.kind === "file" ? t.path : null;
}

// Tap gesture FSM for a top tab (requirement 11 / phase-9 bug fix). Single tap =
// select (immediate, no latency), double tap = close, triple tap (file tabs
// only) = copy absolute path. Long-press was dropped because on phones it
// triggers the native text-selection / callout menu.
//
// A double tap must NOT preempt a possible third, so the close action is
// DEFERRED: on the 2nd tap of a file tab the component schedules a timer; a 3rd
// tap within the window cancels it and copies instead. Term tabs have no third
// action, so their 2nd tap opens the close dialog immediately.
export type TapKind = "term" | "file";
export interface TapState { id: string; count: number; at: number }
export type TapAction =
  | { type: "select" } // count 1
  | { type: "deferClose" } // count 2, file: start timer -> open close dialog
  | { type: "closeNow" } // count 2, term: open close dialog now
  | { type: "copy" } // count 3, file: cancel pending close, copy path
  | { type: "none" }; // a drag/scroll, or an unreachable term triple

export const TAP_WINDOW_MS = 300;
export const TAP_RESET: TapState = { id: "", count: 0, at: 0 };

export function stepTap(
  prev: TapState,
  tap: { id: string; kind: TapKind; t: number; dragged: boolean },
): { state: TapState; action: TapAction } {
  // A drag/scroll is never a tap; it also breaks any in-progress sequence.
  if (tap.dragged) return { state: TAP_RESET, action: { type: "none" } };

  const continues = prev.id === tap.id && tap.t - prev.at < TAP_WINDOW_MS;
  const count = continues ? prev.count + 1 : 1;
  const state: TapState = { id: tap.id, count, at: tap.t };

  if (count === 1) return { state, action: { type: "select" } };
  if (count === 2) {
    return tap.kind === "file"
      ? { state, action: { type: "deferClose" } }
      : { state: TAP_RESET, action: { type: "closeNow" } };
  }
  // count >= 3: only file tabs have a copy action; reset the sequence either way.
  return { state: TAP_RESET, action: { type: tap.kind === "file" ? "copy" : "none" } };
}

// Filter `order` to ids that are still valid, then append any `extras` (e.g.
// live session names that were never recorded in order — external/adopted
// sessions) that are valid and not already placed. Dedups, preserves order.
export function visibleOrder(order: string[], valid: Set<string>, extras: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) if (valid.has(id) && !seen.has(id)) { out.push(id); seen.add(id); }
  for (const id of extras) if (valid.has(id) && !seen.has(id)) { out.push(id); seen.add(id); }
  return out;
}
