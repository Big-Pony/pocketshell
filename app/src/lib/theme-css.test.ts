// app/src/lib/theme-css.test.ts
import { test, expect } from "vitest";
import {
  parseThemeList, parseCustomThemeList, schemeFromCss, swatchFromCss, isSafeThemeId,
  customThemeId, customThemeName, isCustomTheme, tokenIdOf, parseSkips, totalFromCss,
  truncatedFromCss, slugThemeId, nameFromCss, type CssReader,
} from "./theme-css";
// 跨包 import：agent 侧的 slug 是同一条规则的另一份实现，两份漂移不会编译报错，
// 只会让同一个文件在「拷进 keyDir」和「前端算 id」两条路径上得到不同的 id。
// 与 gen-themes.ts import theme-derive 同理，这是构建/测试期 import，不进 bundle。
import { slugThemeId as agentSlug } from "../../../agent/src/theme-store";

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

test("parseCustomThemeList 给不带前缀的 id 补上 custom:", () => {
  // agent 的 --ps-custom-themes 列的是 slug 化之后的 id，不带前缀。
  expect(parseCustomThemeList('"paper,tokyo-night,3024-day"'))
    .toEqual(["custom:paper", "custom:tokyo-night", "custom:3024-day"]);
});

test("parseCustomThemeList 只认 slug 形状，agent 发来别的形状即视为坏数据", () => {
  // 2026-08-05 之后 id 一定是 slugThemeId() 的产物（小写 kebab）。大写/下划线/点
  // 出现在这里说明 agent 与前端的 slug 规则漂移了，放行只会让它更难查。
  expect(parseCustomThemeList('"ok-name,My_Theme,gruvbox.2,bad name,../escape,a\\"b"'))
    .toEqual(["custom:ok-name"]);
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

test("isSafeThemeId 放行内置 id 与 slug 化的自定义 id", () => {
  for (const id of ["cream-dark", "nord", "gruvbox-dark", "tokyonight", "blackout"]) {
    expect(isSafeThemeId(id), id).toBe(true);
  }
  for (const id of ["custom:foo", "custom:tokyo-night", "custom:3024-day", "custom:theme-1a2b3c4d"]) {
    expect(isSafeThemeId(id), id).toBe(true);
  }
});

test("isSafeThemeId 对自定义 id 与内置 id 同一套语法", () => {
  // 以前自定义名额外放行大写/下划线/点（那时 id 就是文件名）。现在 id 是
  // slugThemeId() 的产物，一定是小写 kebab；放宽只会让「两侧 slug 规则漂移」
  // 这类不一致静默通过。旧的 custom:My_Theme 落到这里回落默认，与「文件已改名」
  // 是同一种结局。
  for (const id of ["custom:My_Theme", "custom:gruvbox.2", "custom:a-b_c.d"]) {
    expect(isSafeThemeId(id), id).toBe(false);
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

test("isSafeThemeId 的长度上限量的是去掉 custom: 之后的那段", () => {
  // agent 的文件名上限与 slug 截断都是 64；把 `custom:` 这 7 个字节也算进来，
  // 一个刚好 64 字符的合法 slug 会在这里被判不安全——主题有令牌却切不过去。
  expect(isSafeThemeId(`custom:${"x".repeat(64)}`)).toBe(true);
  expect(isSafeThemeId(`custom:${"x".repeat(65)}`)).toBe(false);
});

// ── slugThemeId：与 agent 的 theme-store.ts 逐字一致（下面有对拍） ──

test("slugThemeId 把上游主题名转成合法 id", () => {
  expect(slugThemeId("Tokyo Night")).toBe("tokyo-night");
  expect(slugThemeId("3024 Day")).toBe("3024-day");
  expect(slugThemeId("Solarized Dark Higher Contrast")).toBe("solarized-dark-higher-contrast");
  expect(slugThemeId("gruvbox.2")).toBe("gruvbox-2");
  expect(slugThemeId("My_Theme")).toBe("my-theme");
  expect(slugThemeId("a  -  b")).toBe("a-b");
  expect(slugThemeId("-lead-")).toBe("lead");
});

test("slugThemeId 把重音折成 ASCII，纯非 ASCII 名字兜底成哈希", () => {
  expect(slugThemeId("Café Noir")).toBe("cafe-noir");
  expect(slugThemeId("我的主题")).toMatch(/^theme-[0-9a-f]{8}$/);
  expect(slugThemeId("我的主题")).toBe(slugThemeId("我的主题"));
  expect(slugThemeId("我的主题")).not.toBe(slugThemeId("另一个主题"));
  expect(slugThemeId("...")).toMatch(/^theme-[0-9a-f]{8}$/);
});

test("slugThemeId 的输出恒是 isSafeThemeId 认可的自定义 id", () => {
  // 这条是整个改动立足的性质：slug 出来的东西必须能进选择器与令牌名。
  for (const n of ["Tokyo Night", "3024 Day", "我的主题", "...", "Café", "x".repeat(80), "9lives"]) {
    expect(isSafeThemeId(`custom:${slugThemeId(n)}`), n).toBe(true);
  }
});

test("slugThemeId 与 agent 侧逐字一致（对拍）", () => {
  // 真正的真相在 agent：id 是它写进 CSS 的。前端这份是镜像，只在需要预判 id 时用。
  // 两侧不一致的后果是静默的——前端算出的 id 在 CSS 里没有对应的令牌块。
  const names = [
    "Tokyo Night", "3024 Day", "Solarized Dark Higher Contrast", "gruvbox.2", "My_Theme",
    "already-kebab", "a  -  b", "-lead-", "__x__", "Café Noir", "Über Dark",
    "我的主题", "另一个主题", "テーマ", "Тема 1", "...", "___", "9lives",
    "x".repeat(80), `${"a".repeat(63)} tail`, "a", "A", "",
  ];
  for (const n of names) expect(slugThemeId(n), JSON.stringify(n)).toBe(agentSlug(n));
});

// ── nameFromCss：展示名 ──

test("nameFromCss 读 --ps-name-<tokenId> 并剥引号", () => {
  const read = reader({ "--ps-name-custom-tokyo-night": ' "Tokyo Night" ' });
  expect(nameFromCss("custom:tokyo-night", read)).toBe("Tokyo Night");
});

test("nameFromCss 读不到时回落 id 的裸名，而不是空白", () => {
  // 老 agent、demo 站、CSS 还没到位都会走这条。显示一个 slug 也好过什么都没有。
  expect(nameFromCss("custom:tokyo-night", reader({}))).toBe("tokyo-night");
  expect(nameFromCss("custom:x", reader({ "--ps-name-custom-x": '""' }))).toBe("x");
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
