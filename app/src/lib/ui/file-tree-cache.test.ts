import { test, expect, beforeEach } from "vitest";
import { getBrowseCache, setBrowseCache, resetBrowseCache } from "./file-tree-cache";

beforeEach(() => { localStorage.clear(); resetBrowseCache(); });

test("cache starts empty, unloaded, at project-root default", () => {
  const c = getBrowseCache();
  expect(c.root).toBe("/");
  expect(c.nodes).toEqual([]);
  expect(c.query).toBe("");
  expect(c.scrollTop).toBe(0);
  expect(c.loaded).toBe(false);
});

test("setBrowseCache patches fields and later reads see them", () => {
  setBrowseCache({ loaded: true, scrollTop: 120, query: "app" });
  const c = getBrowseCache();
  expect(c.loaded).toBe(true);
  expect(c.scrollTop).toBe(120);
  expect(c.query).toBe("app");
  expect(c.nodes).toEqual([]); // untouched fields keep prior value
});

test("resetBrowseCache re-seeds root from persisted project root", () => {
  localStorage.setItem("pocketshell.projectRoot", "/Users/me/proj");
  resetBrowseCache();
  expect(getBrowseCache().root).toBe("/Users/me/proj");
});
