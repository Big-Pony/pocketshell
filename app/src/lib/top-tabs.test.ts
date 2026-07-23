import { test, expect, describe } from "vitest";
import { fileTabId, openFileTab, closeFileTab, cycle, stepClamp, appendOrder, removeOrder, visibleOrder, filePathFromTabId, type TopTab } from "./top-tabs";

test("fileTabId is stable per path+mode", () => {
  expect(fileTabId("/a.ts", "code")).toBe("file:code:/a.ts");
  expect(fileTabId("/a.ts", "diff")).not.toBe(fileTabId("/a.ts", "code"));
});

test("openFileTab appends once, dedupes on repeat", () => {
  let tabs: TopTab[] = [];
  tabs = openFileTab(tabs, "/a.ts", "code");
  tabs = openFileTab(tabs, "/a.ts", "code");
  expect(tabs.length).toBe(1);
  expect(tabs[0]).toMatchObject({ kind: "file", path: "/a.ts", mode: "code", title: "a.ts" });
});

test("closeFileTab removes by id", () => {
  let tabs: TopTab[] = openFileTab([], "/a.ts", "code");
  tabs = closeFileTab(tabs, fileTabId("/a.ts", "code"));
  expect(tabs.length).toBe(0);
});

test("cycle steps forward and wraps", () => {
  const order = ["s1", "s2", "file:code:/a.ts"];
  expect(cycle(order, "s1", 1)).toBe("s2");
  expect(cycle(order, "file:code:/a.ts", 1)).toBe("s1");
  expect(cycle(order, "s1", -1)).toBe("file:code:/a.ts");
});

test("stepClamp steps forward/back but does not wrap", () => {
  const order = ["s1", "s2", "s3"];
  expect(stepClamp(order, "s1", 1)).toBe("s2");
  expect(stepClamp(order, "s3", 1)).toBe("s3");   // clamped at end, no wrap
  expect(stepClamp(order, "s1", -1)).toBe("s1");  // clamped at start, no wrap
  expect(stepClamp([], "s1", 1)).toBe("s1");      // empty -> unchanged
});

describe("interleaved tab order", () => {
  test("appendOrder adds new ids and ignores duplicates", () => {
    expect(appendOrder(["a"], "b")).toEqual(["a", "b"]);
    expect(appendOrder(["a", "b"], "a")).toEqual(["a", "b"]);
  });
  test("removeOrder drops the id", () => {
    expect(removeOrder(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
  test("visibleOrder keeps stored order, drops invalid, appends new extras", () => {
    const order = ["s1", "file:code:/x", "s2"];
    const valid = new Set(["s1", "s2", "s3", "file:code:/x"]);
    expect(visibleOrder(order, valid, ["s1", "s2", "s3"])).toEqual([
      "s1", "file:code:/x", "s2", "s3",
    ]);
  });
  test("visibleOrder removes ids no longer valid", () => {
    const order = ["s1", "file:code:/x", "s2"];
    const valid = new Set(["s1", "s2"]);
    expect(visibleOrder(order, valid, ["s1", "s2"])).toEqual(["s1", "s2"]);
  });
});

test("filePathFromTabId returns the path for a file tab, null otherwise", () => {
  let tabs = openFileTab([], "/Users/me/proj/a.ts", "code");
  const id = fileTabId("/Users/me/proj/a.ts", "code");
  expect(filePathFromTabId(tabs, id)).toBe("/Users/me/proj/a.ts");
  expect(filePathFromTabId(tabs, "nope")).toBeNull();
  expect(filePathFromTabId([{ kind: "term", id: "s1", title: "s1" }], "s1")).toBeNull();
});
