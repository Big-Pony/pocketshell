// app/src/lib/theme.test.ts
import { test, expect } from "vitest";
import { resolveTheme } from "./theme";

test("resolveTheme passes through explicit dark/light", () => {
  expect(resolveTheme("dark", true)).toBe("dark");
  expect(resolveTheme("dark", false)).toBe("dark");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("light", false)).toBe("light");
});

test("resolveTheme follows the OS scheme for system", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
});
