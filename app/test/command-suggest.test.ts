import { test, expect } from "vitest";
import { suggest, delta, dedupe } from "../src/lib/command-suggest";

test("without input returns recent history (deduped, ordered)", () => {
  expect(suggest("", ["ls", "pwd", "ls"], [], ["git status"])).toEqual(["ls", "pwd"]);
});

test("with input filters by prefix and history comes before catalog", () => {
  const out = suggest("git ", ["git pull"], [], ["git status", "git push"]);
  expect(out[0]).toBe("git pull");
  expect(out).toContain("git status");
  expect(out).toContain("git push");
});

test("prefix matching is case-insensitive", () => {
  expect(suggest("GIT s", [], [], ["git status"])).toEqual(["git status"]);
});

test("excludes entries equal to current input", () => {
  expect(suggest("ls", ["ls"], [], ["ls"])).toEqual([]);
});

test("deduplicates across history and catalog", () => {
  expect(suggest("g", ["git status"], [], ["git status", "grep -r "])).toEqual([
    "git status",
    "grep -r ",
  ]);
});

test("自定义条目排在历史之后、内置之前", () => {
  const out = suggest("g", ["git pull"], ["git graph"], ["git status"]);
  expect(out).toEqual(["git pull", "git graph", "git status"]);
});

test("自定义与内置重复时只留自定义那份", () => {
  expect(suggest("g", [], ["git status"], ["git status"])).toEqual(["git status"]);
});

test("无输入时自定义也参与（历史在前）", () => {
  expect(suggest("", ["ls"], ["my-cmd"], ["git status"])).toEqual(["ls", "my-cmd"]);
});

test("dedupe 是导出的共享实现", () => {
  expect(dedupe(["a", "b", "a"])).toEqual(["a", "b"]);
});

test("delta returns the remaining part after the typed prefix", () => {
  expect(delta("git st", "git status")).toBe("atus");
});

test("delta is case-insensitive for the prefix", () => {
  expect(delta("GIT ", "git status")).toBe("status");
});

test("delta returns the whole string when not a prefix (safe fallback)", () => {
  expect(delta("xyz", "git status")).toBe("git status");
});
