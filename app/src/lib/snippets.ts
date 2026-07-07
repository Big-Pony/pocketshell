// app/src/lib/snippets.ts
// Built-in snippets were removed by product decision (2026-07-07). The panel now
// shows only user-added custom snippets, which the backend persists and syncs.
// mergeSnippets stays as the single place that groups the panel's rows.
import type { Snippet } from "./protocol";

export const BUILTIN_SNIPPETS: Snippet[] = [];

export interface SnippetGroup { group: string; items: Snippet[] }

export function mergeSnippets(customs: Snippet[]): SnippetGroup[] {
  const order: string[] = [];
  const map = new Map<string, Snippet[]>();
  const push = (s: Snippet) => {
    if (!map.has(s.group)) { map.set(s.group, []); order.push(s.group); }
    map.get(s.group)!.push(s);
  };
  for (const s of BUILTIN_SNIPPETS) push(s);
  for (const s of customs) push(s);
  return order.map((group) => ({ group, items: map.get(group)! }));
}
