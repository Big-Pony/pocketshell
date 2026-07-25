// app/src/lib/theme.test.ts
import { test, expect } from "vitest";
import { resolveTheme, schemeOf } from "./theme";
import { THEMES } from "./settings";

test("resolveTheme passes through explicit dark/light", () => {
  expect(resolveTheme("dark", true)).toBe("dark");
  expect(resolveTheme("dark", false)).toBe("dark");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("light", false)).toBe("light");
});

test("resolveTheme passes through the palette themes regardless of the OS scheme", () => {
  // 选了具体配色就是固定它，不再跟随系统——只有 "system" 会看 OS。
  for (const t of ["osc", "blackout", "prussian", "vermilion"] as const) {
    expect(resolveTheme(t, true)).toBe(t);
    expect(resolveTheme(t, false)).toBe(t);
  }
});

test("resolveTheme follows the OS scheme for system", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
});

test("resolveTheme never returns system", () => {
  // "system" 是指针不是配色；漏了这层解析就会把 data-theme="system" 写进 DOM，
  // 而 app.css 里没有这个块，页面会静默拿到 :root 的默认深色。
  for (const pref of THEMES) {
    expect(resolveTheme(pref, true)).not.toBe("system");
    expect(resolveTheme(pref, false)).not.toBe("system");
  }
});

test("schemeOf classifies every palette theme", () => {
  expect(schemeOf("dark")).toBe("dark");
  expect(schemeOf("osc")).toBe("dark");
  expect(schemeOf("blackout")).toBe("dark");
  expect(schemeOf("prussian")).toBe("dark");
  expect(schemeOf("light")).toBe("light");
  expect(schemeOf("vermilion")).toBe("light");
});
