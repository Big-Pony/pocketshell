// app/src/lib/snippets.test.ts
import { test, expect } from "vitest";
import { BUILTIN_SNIPPETS, mergeSnippets } from "./snippets";

test("builtins are non-empty and id-prefixed", () => {
  expect(BUILTIN_SNIPPETS.length).toBeGreaterThan(0);
  expect(BUILTIN_SNIPPETS.every((s) => s.id.startsWith("builtin:"))).toBe(true);
});

test("mergeSnippets groups builtins then customs under the same group", () => {
  const customs = [{ id: "c1", group: "Git", label: "amend", command: "git commit --amend", autoEnter: false }];
  const groups = mergeSnippets(customs);
  const git = groups.find((g) => g.group === "Git")!;
  expect(git.items.some((i) => i.id === "c1")).toBe(true);
  // builtin git items precede the custom one
  const idx = git.items.findIndex((i) => i.id === "c1");
  expect(git.items.slice(0, idx).every((i) => i.id.startsWith("builtin:"))).toBe(true);
});

test("a custom group not present in builtins still appears", () => {
  const groups = mergeSnippets([{ id: "c2", group: "Mine", label: "x", command: "echo x", autoEnter: true }]);
  expect(groups.find((g) => g.group === "Mine")?.items).toHaveLength(1);
});
