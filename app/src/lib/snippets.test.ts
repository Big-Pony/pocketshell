// app/src/lib/snippets.test.ts
import { test, expect } from "vitest";
import { BUILTIN_SNIPPETS, mergeSnippets } from "./snippets";

test("no built-in snippets ship by default", () => {
  expect(BUILTIN_SNIPPETS).toHaveLength(0);
});

test("mergeSnippets groups customs by their group in first-seen order", () => {
  const groups = mergeSnippets([
    { id: "c1", group: "Git", label: "amend", command: "git commit --amend", autoEnter: false },
    { id: "c2", group: "Mine", label: "x", command: "echo x", autoEnter: true },
    { id: "c3", group: "Git", label: "status", command: "git status", autoEnter: true },
  ]);
  expect(groups.map((g) => g.group)).toEqual(["Git", "Mine"]);
  expect(groups.find((g) => g.group === "Git")!.items.map((i) => i.id)).toEqual(["c1", "c3"]);
});

test("empty customs yields no groups", () => {
  expect(mergeSnippets([])).toEqual([]);
});
