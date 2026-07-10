import { test, expect } from "vitest";
import { CATALOG } from "../src/lib/command-catalog";

test("CATALOG contains common commands and follows format rules", () => {
  expect(CATALOG).toContain("git status");
  expect(CATALOG).toContain("git commit");
  expect(CATALOG).toContain("cd ");
  // No empty strings, no leading whitespace (trailing whitespace is allowed
  // intentionally for argument prefixes like "cd ").
  for (const c of CATALOG) {
    expect(c.length).toBeGreaterThan(0);
    expect(c).toBe(c.replace(/^\s+/, ""));
  }
});

test("CATALOG has no duplicates", () => {
  expect(new Set(CATALOG).size).toBe(CATALOG.length);
});
