import { describe, it, expect } from "vitest";
import { loadTabs, saveTabs, type PersistedTabs } from "./tab-store";

function memStore(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("tab-store", () => {
  it("round-trips persisted tabs", () => {
    const s = memStore();
    const state: PersistedTabs = {
      tabOrder: ["s1", "file:code:/a"],
      fileTabs: [{ kind: "file", id: "file:code:/a", title: "a", path: "/a", mode: "code" }],
      activeTop: "file:code:/a",
      activeId: "s1",
      backgrounded: ["s2"],
    };
    saveTabs(state, s);
    expect(loadTabs(s)).toEqual(state);
  });
  it("returns null when nothing stored", () => {
    expect(loadTabs(memStore())).toBeNull();
  });
  it("returns null on malformed json", () => {
    const s = memStore();
    s.setItem("ps.openTabs", "{not json");
    expect(loadTabs(s)).toBeNull();
  });
});
