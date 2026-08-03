// Persist the open top-area tabs (interleaved order + file tabs + focus +
// backgrounded set) so switching away from the PWA and back does not lose the
// tab strip. Session tabs are re-joined with the server's live session list on
// restore (see App.svelte); this module only stores/loads the raw shape.
import type { TopTab } from "./top-tabs";

const KEY = "ps.openTabs";

export interface PersistedTabs {
  tabOrder: string[];
  fileTabs: TopTab[];
  activeTop: string;
  activeId: string;
  backgrounded: string[];
}

export function loadTabs(store: Storage = localStorage): PersistedTabs | null {
  const raw = store.getItem(KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!p || !Array.isArray(p.tabOrder) || !Array.isArray(p.fileTabs)) return null;
    return {
      tabOrder: p.tabOrder.filter((x: unknown) => typeof x === "string"),
      fileTabs: p.fileTabs.filter((t: any) => t && t.kind === "file" && typeof t.id === "string"),
      activeTop: typeof p.activeTop === "string" ? p.activeTop : "",
      activeId: typeof p.activeId === "string" ? p.activeId : "",
      backgrounded: Array.isArray(p.backgrounded) ? p.backgrounded.filter((x: unknown) => typeof x === "string") : [],
    };
  } catch {
    return null;
  }
}

export function saveTabs(state: PersistedTabs, store: Storage = localStorage): void {
  store.setItem(KEY, JSON.stringify(state));
}
