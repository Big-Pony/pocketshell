import { test, expect } from "vitest";
import { suggest, delta } from "../src/lib/command-suggest";

test("without input returns recent history (deduped, ordered)", () => {
  expect(suggest("", ["ls", "pwd", "ls"], ["git status"])).toEqual(["ls", "pwd"]);
});

test("with input filters by prefix and history comes before catalog", () => {
  const out = suggest("git ", ["git pull"], ["git status", "git push"]);
  expect(out[0]).toBe("git pull");
  expect(out).toContain("git status");
  expect(out).toContain("git push");
});

test("prefix matching is case-insensitive", () => {
  expect(suggest("GIT s", [], ["git status"])).toEqual(["git status"]);
});

test("excludes entries equal to current input", () => {
  expect(suggest("ls", ["ls"], ["ls"])).toEqual([]);
});

test("deduplicates across history and catalog", () => {
  expect(suggest("g", ["git status"], ["git status", "grep -r "])).toEqual([
    "git status",
    "grep -r ",
  ]);
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
