import { test, expect } from "vitest";
import { shouldSyncRoot } from "./root-follow";

const base = { panel: "file", follow: true, activeTopId: "s1", pwd: "/proj", currentRoot: "/old" };

test("returns the pwd when a terminal is focused, follow is on, and roots differ", () => {
  expect(shouldSyncRoot(base)).toBe("/proj");
});
test("no-op when not the file panel", () => {
  expect(shouldSyncRoot({ ...base, panel: "task" })).toBeNull();
});
test("no-op when follow is off", () => {
  expect(shouldSyncRoot({ ...base, follow: false })).toBeNull();
});
test("no-op when the focused tab is a file, not a terminal", () => {
  expect(shouldSyncRoot({ ...base, activeTopId: "file:code:/a.ts" })).toBeNull();
});
test("no-op when pwd is empty (shell session / unavailable)", () => {
  expect(shouldSyncRoot({ ...base, pwd: "" })).toBeNull();
});
test("no-op when pwd already equals the current root", () => {
  expect(shouldSyncRoot({ ...base, pwd: "/old" })).toBeNull();
});
