// app/src/lib/theme.test.ts
import { test, expect, beforeAll, afterAll, vi } from "vitest";
import {
  resolveTheme, schemeOf, swatchOf, listThemes, applyTheme, applyThemeAsync, customThemeInfo,
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
    "--ps-custom-themes": '"paper,tokyo-night"',
    "--ps-scheme-custom-paper": "light",
  }));
  const list = listThemes(read);
  const custom = list.filter((e) => e.custom);
  expect(custom.map((e) => e.id)).toEqual(["custom:paper", "custom:tokyo-night"]);
  expect(custom[0].scheme).toBe("light");
  expect(custom[0].colors).toBeNull(); // agent 没给预览色时画空色板，不画错色板
  // 自定义排在内置之后，内置的相对顺序不受影响。
  expect(list[0].id).toBe(DEFAULT_THEME);
});

test("listThemes 给自定义主题带上展示名（原文件名），内置的 name 为 null", () => {
  // id 是文件名 slug 化的产物，拿 id 当名字显示等于替用户把主题改了名。
  const read = reader(builtinCss({
    "--ps-custom-themes": '"tokyo-night,3024-day"',
    "--ps-name-custom-tokyo-night": '"Tokyo Night"',
    // 3024-day 没给 --ps-name-*：老 agent 的情况，回落成 id 而不是空白。
  }));
  const custom = listThemes(read).filter((e) => e.custom);
  expect(custom.map((e) => e.name)).toEqual(["Tokyo Night", "3024-day"]);
  expect(listThemes(read).find((e) => !e.custom)?.name).toBeNull();
});

test("listThemes 丢掉自定义清单里不安全的名字", () => {
  const read = reader(builtinCss({ "--ps-custom-themes": '"ok,bad name,../esc"' }));
  expect(listThemes(read).filter((e) => e.custom).map((e) => e.id)).toEqual(["custom:ok"]);
});

// ── customThemeInfo：为什么我的文件没出现 ──

test("customThemeInfo 报出截断与跳过", () => {
  const read = reader({
    "--ps-custom-themes": '"a,b"',
    "--ps-custom-total": "5",
    "--ps-custom-truncated": "1",
    "--ps-custom-skipped": '"parse:junk.ghostty"',
  });
  expect(customThemeInfo(read)).toEqual({
    total: 5,
    shown: 2,
    truncated: true,
    skipped: [{ reason: "parse", file: "junk.ghostty" }],
  });
});

test("customThemeInfo 在 agent 没接入时是干净的空态", () => {
  // demo 站与离线：/theme/custom.css 404，这些令牌一个都读不到。不能因此
  // 在设置面板上冒出「共 0 个主题文件」这类噪音。
  expect(customThemeInfo(reader({}))).toEqual({ total: 0, shown: 0, truncated: false, skipped: [] });
});

test("有文件被跳过 ≠ 被截断（total > shown 不能当判据）", () => {
  // 实测抓到的 bug：目录里 1 个好主题 + 2 个坏文件，total=3、shown=1，用
  // total>shown 推就会显示「共 3 个主题文件，只显示前 1 个」——那是假话，
  // 真正的原因（两个文件读不出来）就写在它下面一行。
  const read = reader({
    "--ps-custom-themes": '"good"',
    "--ps-custom-total": "3",
    "--ps-custom-truncated": "0",
    "--ps-custom-skipped": '"parse:broken.ghostty,parse:incomplete.ghostty"',
  });
  const info = customThemeInfo(read);
  expect(info.truncated).toBe(false);
  expect(info.skipped).toHaveLength(2);
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

// ── applyThemeAsync：切自定义主题要先把样式表换过来 ──
// agent 只把选中那套的完整令牌写进 CSS（设计 4.5，否则 50 套就是四分之一兆字节
// 换一套配色），所以切过去之前必须重新请求一次。在 CSS 到位前写 data-theme，
// 屏幕上就是一帧没有任何令牌的白。

/** 装一个假的 <link data-ps-theme="custom">，并让设 href 立刻触发 load。 */
function withLink(fn: (link: HTMLLinkElement) => Promise<void>): Promise<void> {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.dataset.psTheme = "custom";
  link.setAttribute("href", "/theme/custom.css");
  // jsdom 不发请求也不触发 load，自己补一个（异步，模拟真实的一次往返）。
  const obs = new MutationObserver(() => setTimeout(() => link.dispatchEvent(new Event("load")), 0));
  obs.observe(link, { attributes: true, attributeFilter: ["href"] });
  document.head.appendChild(link);
  return fn(link).finally(() => { obs.disconnect(); link.remove(); });
}

test("切到自定义主题会把 link 换成带 ?t= 的地址，并等它加载完再写 data-theme", async () => {
  await withLink(async (link) => {
    let hrefWhenApplied = "";
    const o = new MutationObserver(() => { hrefWhenApplied = link.getAttribute("href") ?? ""; });
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    await applyThemeAsync("custom:paper");
    o.disconnect();
    expect(link.getAttribute("href")).toBe("/theme/custom.css?t=paper");
    // data-theme 是在新 href 生效之后才写的，不是之前。
    expect(hrefWhenApplied).toBe("/theme/custom.css?t=paper");
    expect(document.documentElement.dataset.theme).toBe("custom:paper");
  });
});

test("切回内置主题会把 ?t= 去掉", async () => {
  await withLink(async (link) => {
    await applyThemeAsync("custom:paper");
    await applyThemeAsync("nord");
    expect(link.getAttribute("href")).toBe("/theme/custom.css");
    expect(document.documentElement.dataset.theme).toBe("nord");
  });
});

test("换成同一个 href 不重新请求（点两下同一套主题不该多走一次网络）", async () => {
  await withLink(async (link) => {
    await applyThemeAsync("custom:paper");
    let changed = false;
    const o = new MutationObserver(() => { changed = true; });
    o.observe(link, { attributes: true, attributeFilter: ["href"] });
    await applyThemeAsync("custom:paper");
    o.disconnect();
    expect(changed).toBe(false);
  });
});

test("样式表加载失败也照常换主题，不把整个动作失败掉", async () => {
  // agent 没接入（demo 站）、离线、主题被别的设备删了——都会 404。
  // 该做的是回落到内置令牌继续渲染。
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.dataset.psTheme = "custom";
  link.setAttribute("href", "/theme/custom.css");
  const obs = new MutationObserver(() => setTimeout(() => link.dispatchEvent(new Event("error")), 0));
  obs.observe(link, { attributes: true, attributeFilter: ["href"] });
  document.head.appendChild(link);
  try {
    expect(await applyThemeAsync("custom:gone")).toBe("custom:gone");
    expect(document.documentElement.dataset.theme).toBe("custom:gone");
  } finally { obs.disconnect(); link.remove(); }
});

test("页面上没有那个 link 时 applyThemeAsync 照样工作", async () => {
  // 演示构建与单测里都没有它。
  expect(await applyThemeAsync("gruvbox-dark")).toBe("gruvbox-dark");
  expect(document.documentElement.dataset.theme).toBe("gruvbox-dark");
});

test("自定义主题名会被 URL 编码", async () => {
  // 名字来自文件名，agent 侧已经收得很紧，但拼 URL 的一方不该假设这一点。
  await withLink(async (link) => {
    await applyThemeAsync("custom:a_b-2");
    expect(link.getAttribute("href")).toBe("/theme/custom.css?t=a_b-2");
  });
});
