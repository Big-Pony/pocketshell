// app/src/lib/theme-css.test.ts
import { test, expect } from "vitest";
import {
  parseThemeList, parseCustomThemeList, schemeFromCss, swatchFromCss, isSafeThemeId,
  customThemeId, customThemeName, isCustomTheme, tokenIdOf, parseSkips, totalFromCss,
  truncatedFromCss, type CssReader,
} from "./theme-css";

/** 用一个普通对象假装 CSS——这正是把读取函数做成参数的理由。 */
function reader(map: Record<string, string>): CssReader {
  return (prop) => map[prop] ?? "";
}

// ── parseThemeList ──

test("parseThemeList 拆逗号分隔的清单", () => {
  expect(parseThemeList("a,b,c")).toEqual(["a", "b", "c"]);
});

test("parseThemeList 剥掉 getPropertyValue 带回来的引号", () => {
  // CSS 里写的是 --ps-themes: "a,b"，读出来连引号一起给。
  expect(parseThemeList('"cream-dark,nord"')).toEqual(["cream-dark", "nord"]);
  expect(parseThemeList("'cream-dark,nord'")).toEqual(["cream-dark", "nord"]);
});

test("parseThemeList 空串与空清单都得到 []", () => {
  expect(parseThemeList("")).toEqual([]);
  expect(parseThemeList('""')).toEqual([]);
  expect(parseThemeList("   ")).toEqual([]);
  expect(parseThemeList(",,,")).toEqual([]);
});

test("parseThemeList 容错空格与换行", () => {
  expect(parseThemeList('  " a , b ,\n c "  ')).toEqual(["a", "b", "c"]);
});

test("parseThemeList 去重，保留首次出现的顺序", () => {
  expect(parseThemeList("a,b,a,c,b")).toEqual(["a", "b", "c"]);
});

test("parseThemeList 丢掉不安全的 id 而不是整份作废", () => {
  // 一个坏名字不该让用户的全部主题消失——这是 agent 侧 theme-store
  // 「坏文件跳过」的同一条原则在前端的镜像。
  expect(parseThemeList('a,b"c,{d},e')).toEqual(["a", "e"]);
});

test("parseThemeList 认自定义主题 id", () => {
  expect(parseThemeList("cream-dark,custom:my-theme")).toEqual(["cream-dark", "custom:my-theme"]);
});

test("parseCustomThemeList 给不带前缀的名字补上 custom:", () => {
  // agent 的 --ps-custom-themes 列的是 keyDir 里的文件名，不带前缀。
  expect(parseCustomThemeList('"paper,My_Theme,gruvbox.2"'))
    .toEqual(["custom:paper", "custom:My_Theme", "custom:gruvbox.2"]);
});

test("parseCustomThemeList 用自定义名的规则校验，不是内置 id 的规则", () => {
  // 内置 id 只认小写 kebab；用户的 .ghostty 文件名常带大写/下划线/点，不能一刀切。
  expect(parseCustomThemeList('"Ok_Name,bad name,../escape,a\\"b"')).toEqual(["custom:Ok_Name"]);
});

// ── id 编解码 ──

test("custom id 编解码往返", () => {
  expect(customThemeId("foo")).toBe("custom:foo");
  expect(customThemeName("custom:foo")).toBe("foo");
  expect(customThemeName("cream-dark")).toBeNull();
  expect(isCustomTheme("custom:foo")).toBe(true);
  expect(isCustomTheme("cream-dark")).toBe(false);
});

test("customThemeId 不重复加前缀", () => {
  expect(customThemeId("custom:foo")).toBe("custom:foo");
});

test("tokenIdOf 把冒号换成连字符（CSS 属性名里冒号不合法）", () => {
  // --ps-scheme-custom:foo 会被解析器整条丢掉，主题看着就是「切了没反应」。
  expect(tokenIdOf("cream-dark")).toBe("cream-dark");
  expect(tokenIdOf("custom:foo")).toBe("custom-foo");
});

// ── isSafeThemeId ──

test("isSafeThemeId 放行内置 kebab id 与自定义名", () => {
  for (const id of ["cream-dark", "nord", "gruvbox-dark", "tokyonight", "blackout"]) {
    expect(isSafeThemeId(id), id).toBe(true);
  }
  for (const id of ["custom:foo", "custom:My_Theme", "custom:gruvbox.2", "custom:a-b_c.d"]) {
    expect(isSafeThemeId(id), id).toBe(true);
  }
});

test("isSafeThemeId 拒绝会破坏 CSS 选择器的字符", () => {
  // 这些不会报错，只会让 [data-theme="…"] 静默失配或提前闭合——最难查的那种。
  const bad = [
    '', 'custom:', 'custom:a"b', "custom:a'b", "custom:a\nb", "custom:a b",
    "custom:a]b", "custom:a{b}", "custom:a;b", "custom:a\\b", "custom:../x",
    "custom:/etc/passwd", "Cream-Dark", "cream_dark", "-lead", "trail-",
    "custom:" + "x".repeat(100),
  ];
  for (const id of bad) expect(isSafeThemeId(id), JSON.stringify(id)).toBe(false);
});

test("isSafeThemeId 对非字符串不抛", () => {
  expect(isSafeThemeId(undefined as unknown as string)).toBe(false);
  expect(isSafeThemeId(42 as unknown as string)).toBe(false);
});

// ── schemeFromCss ──

test("schemeFromCss 读 --ps-scheme-<id>", () => {
  const read = reader({ "--ps-scheme-cream-light": " light ", "--ps-scheme-nord": "dark" });
  expect(schemeFromCss("cream-light", read)).toBe("light");
  expect(schemeFromCss("nord", read)).toBe("dark");
});

test("schemeFromCss 缺失时回落 dark", () => {
  // jsdom 里没有 CSS，真机上自定义主题的 CSS 也可能还没到——回落必须是安全的。
  expect(schemeFromCss("whatever", reader({}))).toBe("dark");
});

test("schemeFromCss 对自定义主题读连字符形式的令牌", () => {
  expect(schemeFromCss("custom:paper", reader({ "--ps-scheme-custom-paper": "light" }))).toBe("light");
});

test("schemeFromCss 把无法识别的值当 dark", () => {
  expect(schemeFromCss("x", reader({ "--ps-scheme-x": "bright" }))).toBe("dark");
});

// ── swatchFromCss ──

const FULL_SWATCH = {
  "--sw-nord-bg": "#2e3440",
  "--sw-nord-panel": "#373d49",
  "--sw-nord-accent": "#88c0d0",
  "--sw-nord-ok": "#a0c083",
  "--sw-nord-text": "#d8dee9",
};

test("swatchFromCss 按 机身/面板/主色/运行灯/文字 的顺序取 5 色", () => {
  expect(swatchFromCss("nord", reader(FULL_SWATCH)))
    .toEqual(["#2e3440", "#373d49", "#88c0d0", "#a0c083", "#d8dee9"]);
});

test("swatchFromCss 缺任意一色返回 null 而不是抛，也不是半截色板", () => {
  for (const drop of Object.keys(FULL_SWATCH)) {
    const partial = { ...FULL_SWATCH } as Record<string, string>;
    delete partial[drop];
    expect(swatchFromCss("nord", reader(partial)), `缺 ${drop} 时应为 null`).toBeNull();
  }
  expect(swatchFromCss("nord", reader({}))).toBeNull();
});

test("swatchFromCss 对自定义主题读连字符形式的令牌", () => {
  const read = reader({
    "--sw-custom-paper-bg": "#fff", "--sw-custom-paper-panel": "#eee",
    "--sw-custom-paper-accent": "#c00", "--sw-custom-paper-ok": "#080",
    "--sw-custom-paper-text": "#111",
  });
  expect(swatchFromCss("custom:paper", read)).toEqual(["#fff", "#eee", "#c00", "#080", "#111"]);
});

// ── parseSkips / totalFromCss ──
// 「我把主题拷进去了但列表里没有」是这个功能最容易出的问题。这两项是它唯一的
// 出口：样式表是 <link> 拉的，响应头（agent 也发了 X-Theme-Truncated）前端看不到。

test("parseSkips 拆 reason:file 条目", () => {
  expect(parseSkips('"parse:junk.ghostty,name:bad one.ghostty"')).toEqual([
    { reason: "parse", file: "junk.ghostty" },
    { reason: "name", file: "bad one.ghostty" },
  ]);
});

test("parseSkips 空清单得到 []", () => {
  for (const raw of ["", '""', "   ", ",,"]) expect(parseSkips(raw), raw).toEqual([]);
});

test("parseSkips 丢掉认不出的原因和缺文件名的条目，而不是整份作废", () => {
  // 与 agent 侧「一个坏文件只损失它自己」同一条原则。
  expect(parseSkips('"parse:a,bogus:b,:c,d,read:e"')).toEqual([
    { reason: "parse", file: "a" },
    { reason: "read", file: "e" },
  ]);
});

test("totalFromCss 读不到或不是正数时得到 0", () => {
  expect(totalFromCss(reader({ "--ps-custom-total": " 12 " }))).toBe(12);
  for (const v of ["", "abc", "0", "-3"]) {
    expect(totalFromCss(reader({ "--ps-custom-total": v })), v).toBe(0);
  }
});

test("truncatedFromCss 只认 agent 明说的 1，其余一律 false", () => {
  // 宁可不提示也别误报：读不到（agent 没接入）时提示「只显示了前 0 个」是噪音。
  expect(truncatedFromCss(reader({ "--ps-custom-truncated": " 1 " }))).toBe(true);
  for (const v of ["", "0", "true", "yes"]) {
    expect(truncatedFromCss(reader({ "--ps-custom-truncated": v })), v).toBe(false);
  }
});
