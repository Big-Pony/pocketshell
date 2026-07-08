import { test, expect, beforeEach, describe } from "vitest";
import { loadProjectRoot, saveProjectRoot, clearProjectRoot, toFileNodes, setChildren, collapse, filterTree, loadRootHistory, pushRootHistory, loadRootFollow, saveRootFollow, type FileNode } from "./file-tree";

beforeEach(() => localStorage.clear());

test("project root defaults to / and persists", () => {
  expect(loadProjectRoot()).toBe("/");
  saveProjectRoot("/Users/me/proj");
  expect(loadProjectRoot()).toBe("/Users/me/proj");
  clearProjectRoot();
  expect(loadProjectRoot()).toBe("/");
});

test("toFileNodes builds child paths without double slashes", () => {
  const rootNodes = toFileNodes("/", [{ name: "src", type: "dir", hasChildren: true }]);
  expect(rootNodes[0].path).toBe("/src");
  const sub = toFileNodes("/src", [{ name: "a.ts", type: "file" }]);
  expect(sub[0].path).toBe("/src/a.ts");
});

test("setChildren attaches + expands the target node immutably", () => {
  const tree = toFileNodes("/", [{ name: "src", type: "dir", hasChildren: true }]);
  const next = setChildren(tree, "/src", toFileNodes("/src", [{ name: "a.ts", type: "file" }]));
  expect(next).not.toBe(tree);
  expect(next[0].expanded).toBe(true);
  expect(next[0].children?.[0].name).toBe("a.ts");
});

test("collapse hides children but keeps them loaded", () => {
  let tree = toFileNodes("/", [{ name: "src", type: "dir", hasChildren: true }]);
  tree = setChildren(tree, "/src", toFileNodes("/src", [{ name: "a.ts", type: "file" }]));
  const next = collapse(tree, "/src");
  expect(next[0].expanded).toBe(false);
  expect(next[0].children?.length).toBe(1);
});

test("filterTree keeps matches and their ancestors", () => {
  let tree = toFileNodes("/", [{ name: "src", type: "dir", hasChildren: true }, { name: "readme.md", type: "file" }]);
  tree = setChildren(tree, "/src", toFileNodes("/src", [{ name: "app.ts", type: "file" }, { name: "b.ts", type: "file" }]));
  const out = filterTree(tree, "app");
  expect(out.map((n) => n.name)).toContain("src");
  expect(out.find((n) => n.name === "src")!.children!.map((c) => c.name)).toEqual(["app.ts"]);
  expect(out.find((n) => n.name === "readme.md")).toBeUndefined();
});

test("root history dedups, most-recent-first, capped at 10", () => {
  expect(loadRootHistory()).toEqual([]);
  pushRootHistory("/a");
  pushRootHistory("/b");
  pushRootHistory("/a"); // moves /a back to front, no duplicate
  expect(loadRootHistory()).toEqual(["/a", "/b"]);
  for (let i = 0; i < 12; i++) pushRootHistory("/p" + i);
  const h = loadRootHistory();
  expect(h).toHaveLength(10);
  expect(h[0]).toBe("/p11");
  expect(h).not.toContain("/a");
});

test("loadRootHistory tolerates corrupt storage", () => {
  localStorage.setItem("pocketshell.projectRootHistory", "{not json");
  expect(loadRootHistory()).toEqual([]);
});

describe("root follow flag", () => {
  test("defaults to false", () => {
    expect(loadRootFollow()).toBe(false);
  });
  test("round-trips true/false", () => {
    saveRootFollow(true);
    expect(loadRootFollow()).toBe(true);
    saveRootFollow(false);
    expect(loadRootFollow()).toBe(false);
  });
});
