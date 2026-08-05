// app/src/lib/theme.test.ts
import { test, expect, beforeAll, afterAll, vi } from "vitest";
import {
  resolveTheme, schemeOf, swatchOf, listThemes, applyTheme,
  DEFAULT_THEME, SYSTEM_LIGHT,
} from "./theme";
import { THEMES } from "./settings";
import type { CssReader } from "./theme-css";

/** 假装 CSS。真实读取器 `cssReader()` 在 jsdom 下拿不到值（不注入样式表），
 *  所以凡是读令牌的用例一律注入——这正是把读取函数做成参数的理由。 */
function reader(map: Record<string, string>): CssReader {
  return (prop) => map[prop] ?? "";
}

test("resolveTheme passes through explicit themes", () => {
  expect(resolveTheme("cream-dark", true)).toBe("cream-dark");
  expect(resolveTheme("cream-dark", false)).toBe("cream-dark");
  expect(resolveTheme("cream-light", true)).toBe("cream-light");
  expect(resolveTheme("cream-light", false)).toBe("cream-light");
});

test("resolveTheme passes through the palette themes regardless of the OS scheme", () => {
  // 选了具体配色就是固定它，不再跟随系统——只有 "system" 会看 OS。
  for (const t of ["gruvbox-dark", "tokyonight", "nord", "mocha", "blackout"] as const) {
    expect(resolveTheme(t, true)).toBe(t);
    expect(resolveTheme(t, false)).toBe(t);
  }
});

test("resolveTheme passes through custom themes", () => {
  expect(resolveTheme("custom:my-paper", true)).toBe("custom:my-paper");
  expect(resolveTheme("custom:my-paper", false)).toBe("custom:my-paper");
});

test("resolveTheme follows the OS scheme for system", () => {
  expect(resolveTheme("system", true)).toBe(DEFAULT_THEME);
  expect(resolveTheme("system", false)).toBe(SYSTEM_LIGHT);
});

test("resolveTheme never returns system", () => {
  // "system" 是指针不是配色；漏了这层解析就会把 data-theme="system" 写进 DOM，
  // 而 theme-tokens.css 里没有这个块，页面会静默拿到默认（无属性 :root）那套。
  for (const pref of THEMES) {
    expect(resolveTheme(pref, true)).not.toBe("system");
    expect(resolveTheme(pref, false)).not.toBe("system");
  }
});

test("system 的两端一深一浅", () => {
  // 两个都是深色的话「跟随系统」白天黑夜长一个样，功能等于不存在。
  const read = reader({ "--ps-scheme-cream-dark": "dark", "--ps-scheme-cream-light": "light" });
  expect(schemeOf(DEFAULT_THEME, read)).toBe("dark");
  expect(schemeOf(SYSTEM_LIGHT, read)).toBe("light");
});

// ── schemeOf / swatchOf：不再有硬编码清单，一律读 CSS ──

test("schemeOf 读 CSS 的 --ps-scheme-<id>", () => {
  const read = reader({ "--ps-scheme-cream-light": "light", "--ps-scheme-nord": "dark" });
  expect(schemeOf("cream-light", read)).toBe("light");
  expect(schemeOf("nord", read)).toBe("dark");
});

test("schemeOf 读不到令牌时回落 dark", () => {
  // 自定义主题的 CSS 还没到、或离线拿不到 /theme/custom.css 时会走这里。
  expect(schemeOf("custom:unknown", reader({}))).toBe("dark");
});

test("swatchOf 取 5 色，缺任一色返回 null", () => {
  const full = {
    "--sw-nord-bg": "#2e3440", "--sw-nord-panel": "#373d49", "--sw-nord-accent": "#88c0d0",
    "--sw-nord-ok": "#a0c083", "--sw-nord-text": "#d8dee9",
  };
  expect(swatchOf("nord", reader(full))).toHaveLength(5);
  const { "--sw-nord-text": _drop, ...partial } = full;
  expect(swatchOf("nord", reader(partial))).toBeNull();
});

// ── listThemes ──

/** 内置 7 套的完整清单令牌（照 theme-tokens.css 的形状）。 */
function builtinCss(extra: Record<string, string> = {}): Record<string, string> {
  const ids = THEMES.filter((t) => t !== "system");
  const map: Record<string, string> = { "--ps-themes": `"${ids.join(",")}"` };
  for (const id of ids) {
    map[`--ps-scheme-${id}`] = id.endsWith("-light") ? "light" : "dark";
    for (const s of ["bg", "panel", "accent", "ok", "text"]) map[`--sw-${id}-${s}`] = "#123456";
  }
  return { ...map, ...extra };
}

test("listThemes 列出 CSS 清单里的内置主题，带明暗与色板", () => {
  const list = listThemes(reader(builtinCss()));
  expect(list.map((e) => e.id)).toEqual(THEMES.filter((t) => t !== "system"));
  expect(list.every((e) => e.colors?.length === 5)).toBe(true);
  expect(list.find((e) => e.id === "cream-light")!.scheme).toBe("light");
  expect(list.every((e) => e.custom === false)).toBe(true);
});

test("listThemes 不列出 CSS 里没有的内置主题", () => {
  // 白名单里有、生成物里没有 = 切过去拿不到令牌，静默显示成默认主题。
  const list = listThemes(reader(builtinCss({ "--ps-themes": '"cream-dark,nord"' })));
  expect(list.map((e) => e.id)).toEqual(["cream-dark", "nord"]);
});

test("listThemes 在读不到清单时不过滤（否则菜单会整个空掉）", () => {
  // jsdom 下、以及 CSS 尚未到位的那一瞬间：宁可多列也不要给用户一个空菜单。
  expect(listThemes(reader({})).map((e) => e.id)).toEqual(THEMES.filter((t) => t !== "system"));
});

test("listThemes 追加 --ps-custom-themes 里的自定义主题并打标", () => {
  const read = reader(builtinCss({
    "--ps-custom-themes": '"paper,my.theme"',
    "--ps-scheme-custom-paper": "light",
  }));
  const list = listThemes(read);
  const custom = list.filter((e) => e.custom);
  expect(custom.map((e) => e.id)).toEqual(["custom:paper", "custom:my.theme"]);
  expect(custom[0].scheme).toBe("light");
  expect(custom[0].colors).toBeNull(); // agent 没给预览色时画空色板，不画错色板
  // 自定义排在内置之后，内置的相对顺序不受影响。
  expect(list[0].id).toBe(DEFAULT_THEME);
});

test("listThemes 丢掉自定义清单里不安全的名字", () => {
  const read = reader(builtinCss({ "--ps-custom-themes": '"ok,bad name,../esc"' }));
  expect(listThemes(read).filter((e) => e.custom).map((e) => e.id)).toEqual(["custom:ok"]);
});

// ── applyTheme：写 DOM + 回写首帧缓存 ──

// jsdom 没有 matchMedia，applyTheme 会用它解析 "system"。这里固定成「系统深色」，
// 与本组用例都传字面主题无关，只是别让它抛。
let origMatchMedia: typeof window.matchMedia;
beforeAll(() => {
  origMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true, addEventListener() {}, removeEventListener() {},
  }) as unknown as typeof window.matchMedia;
});
afterAll(() => { window.matchMedia = origMatchMedia; });

test("applyTheme 写 data-theme / data-scheme", () => {
  applyTheme("nord");
  expect(document.documentElement.dataset.theme).toBe("nord");
  // jsdom 无样式表，--ps-scheme-nord 读不到 → 回落 dark。
  expect(document.documentElement.dataset.scheme).toBe("dark");
});

test("applyTheme 把 --bg-deep 与 scheme 存进 localStorage 供下次首帧用", () => {
  // 这是防闪烁的全部机制：内联脚本只读这两个值，不需要知道有哪些主题。
  document.documentElement.style.setProperty("--bg-deep", "#242524");
  try {
    localStorage.clear();
    applyTheme("cream-dark");
    const s = JSON.parse(localStorage.getItem("ps.settings")!);
    expect(s.bootBg).toBe("#242524");
    expect(s.scheme).toBe("dark");
    expect(s.theme).toBe("cream-dark");
  } finally {
    document.documentElement.style.removeProperty("--bg-deep");
    localStorage.clear();
  }
});

test("applyTheme 在读不到 --bg-deep 时不写脏值", () => {
  // 宁可让下次首帧走硬编码兜底，也不要把空串存进去当背景色。
  localStorage.clear();
  applyTheme("mocha");
  const raw = localStorage.getItem("ps.settings");
  expect(raw === null || JSON.parse(raw).bootBg === undefined).toBe(true);
  localStorage.clear();
});
