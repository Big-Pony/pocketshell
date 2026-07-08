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
