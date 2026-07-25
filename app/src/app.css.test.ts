import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { THEMES } from "./lib/settings";
import { THEME_SWATCHES, schemeOf, type ResolvedTheme } from "./lib/theme";

// 主题是「一套令牌名 × N 组值」：组件只引用语义令牌，所以加配色本该是零改动的。
// 前提是**每套主题都给全同一套令牌**——漏一个就会静默回落到 :root 的深色值，
// 在浅色主题上就是一处刺眼的漏网，而且人眼走查很容易放过。这些用例把这个前提
// 焊死。vitest 环境不注入 app.css（document.styleSheets 恒为空），故直接解析源文件。

const CSS = readFileSync(resolve(__dirname, "./app.css"), "utf8");

/** 抓出 `:root` / `:root[data-theme="x"]` 块体，按大括号配对而非贪婪匹配。 */
function themeBlocks(): Map<string, string> {
  const out = new Map<string, string>();
  const head = /^:root(?:\[data-theme="([a-z]+)"\])?\s*\{/gm;
  for (let m = head.exec(CSS); m; m = head.exec(CSS)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth > 0 && i < CSS.length) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}") depth--;
      i++;
    }
    out.set(m[1] ?? "dark", CSS.slice(start, i - 1));
  }
  return out;
}

function declaredTokens(body: string): string[] {
  return [...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
}

// :root 里这几个不是配色：4 个圆角 + 2 个安全区是结构量，全主题共用；
// --teal 是指向 --ok 的兼容别名，随 --ok 自动跟随。故不要求各主题重写。
const SHARED = new Set([
  "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl",
  "--safe-bottom", "--safe-top", "--teal",
]);

const BLOCKS = themeBlocks();
const PALETTE_THEMES = THEMES.filter((t): t is ResolvedTheme => t !== "system");

test("every theme in ThemePref has a token block in app.css (and vice versa)", () => {
  expect([...BLOCKS.keys()].sort()).toEqual([...PALETTE_THEMES].sort());
});

test("every theme declares the full token set — no silent fallback to :root", () => {
  const expected = declaredTokens(BLOCKS.get("dark")!).filter((t) => !SHARED.has(t));
  for (const [name, body] of BLOCKS) {
    if (name === "dark") continue;
    const got = new Set(declaredTokens(body));
    const missing = expected.filter((t) => !got.has(t));
    expect(missing, `主题 "${name}" 缺少令牌（会静默回落到 :root 的深色值）`).toEqual([]);
  }
});

test("no theme declares a token the base :root does not have", () => {
  // 反向：某套主题独有的令牌意味着其它主题拿不到值，同样是漏网。
  const base = new Set(declaredTokens(BLOCKS.get("dark")!));
  for (const [name, body] of BLOCKS) {
    if (name === "dark") continue;
    const extra = [...new Set(declaredTokens(body))].filter((t) => !base.has(t));
    expect(extra, `主题 "${name}" 有 :root 里没有的令牌`).toEqual([]);
  }
});

test("no theme declares the same token twice", () => {
  for (const [name, body] of BLOCKS) {
    const toks = declaredTokens(body);
    const dupes = [...new Set(toks.filter((t, i) => toks.indexOf(t) !== i))];
    expect(dupes, `主题 "${name}" 有重复声明（后者静默覆盖前者）`).toEqual([]);
  }
});

test("the theme picker offers exactly the palettes that exist", () => {
  expect(THEME_SWATCHES.map((s) => s.id).sort()).toEqual([...PALETTE_THEMES].sort());
});

test("each swatch matches its theme's real --bg/--panel/--accent/--ok/--text", () => {
  // 选色板是唯一允许写死颜色的地方（要在别的主题生效时展示这套主题长什么样）。
  // 代价是它会和 app.css 漂移，所以这里逐值比对。
  const TOKENS = ["--bg", "--panel", "--accent", "--ok", "--text"] as const;
  for (const sw of THEME_SWATCHES) {
    const body = BLOCKS.get(sw.id)!;
    TOKENS.forEach((token, i) => {
      const m = body.match(new RegExp(`^\\s*${token}\\s*:\\s*([^;]+);`, "m"));
      const actual = m![1].split("/*")[0].trim().toLowerCase();
      expect(actual, `${sw.id} 的 ${token} 与选色板第 ${i + 1} 块对不上`).toBe(sw.colors[i].toLowerCase());
    });
  }
});

test("swatch scheme matches schemeOf", () => {
  for (const sw of THEME_SWATCHES) expect(sw.scheme).toBe(schemeOf(sw.id));
});

test("the terminal stays dark in every theme", () => {
  // 项目既定约束：终端/代码预览区所有主题都是深色。--term-bg 一旦被调成浅色，
  // 终端上的 ANSI 前景色（xterm 自带的 16 色，不吃令牌）会当场糊掉。
  for (const [name, body] of BLOCKS) {
    const bg = body.match(/^\s*--term-bg\s*:\s*([^;]+);/m)![1].trim();
    const hex = bg.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    expect(lum, `主题 "${name}" 的 --term-bg 不够深`).toBeLessThan(0.25);
  }
});
