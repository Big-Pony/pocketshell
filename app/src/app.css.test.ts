import { test, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { FONTS } from "./lib/font";

// 主题是「一套令牌名 × N 组值」：组件只引用语义令牌，所以加配色本该是零改动的。
// 前提是**每套主题都给全同一套令牌**——漏一个就会静默回落到默认（无属性 :root）
// 那套的值，在浅色主题上就是一处刺眼的漏网，而且人眼走查很容易放过。
//
// 2026-08-05 起颜色令牌不再手写在 app.css 里，而是由 app/themes/*.ghostty 经
// agent/src/theme-derive.ts 派生、`bun run gen:themes` 写进 src/theme-tokens.css。
// 派生函数出所有主题，理论上不可能缺令牌；这些用例是对**生成物**的复核——
// 生成器改坏了、或有人手改了生成物，都在这里当场翻车。
// vitest 环境不注入 CSS（document.styleSheets 恒为空），故直接解析源文件。

/** 默认主题渲染为无属性 `:root`（首帧还没写 data-theme 时也得有整套令牌）。 */
const DEFAULT_THEME = "cream-dark";

const TOKENS_CSS = readFileSync(resolve(__dirname, "./theme-tokens.css"), "utf8");
const APP_CSS = readFileSync(resolve(__dirname, "./app.css"), "utf8");

/** 抓出 `:root` / `:root[data-theme="x"]` 块体，按大括号配对而非贪婪匹配。
 *  无属性的 `:root` 有两个：清单块（含 --ps-themes）和默认主题块，按内容区分。 */
function rootBlocks(css: string): { manifest: string; themes: Map<string, string> } {
  const themes = new Map<string, string>();
  let manifest = "";
  const head = /^:root(?:\[data-theme="([a-z0-9-]+)"\])?\s*\{/gm;
  for (let m = head.exec(css); m; m = head.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    const body = css.slice(start, i - 1);
    if (!m[1] && /--ps-themes\s*:/.test(body)) manifest = body;
    else themes.set(m[1] ?? DEFAULT_THEME, body);
  }
  return { manifest, themes };
}

function declaredTokens(body: string): string[] {
  return [...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
}

function tokenValue(body: string, token: string): string | null {
  const m = body.match(new RegExp(`^\\s*${token}\\s*:\\s*([^;]+);`, "m"));
  return m ? m[1].split("/*")[0].trim().toLowerCase() : null;
}

/** 相对亮度，只用来判「深底还是浅底」，与 theme-derive 的判据同阈值（0.4）。
 *  这里刻意不 import 派生函数：用生成器自己的工具校验生成物等于没校验。 */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const { manifest: MANIFEST, themes: BLOCKS } = rootBlocks(TOKENS_CSS);
const MANIFEST_IDS = (MANIFEST.match(/--ps-themes\s*:\s*"([^"]*)"/)?.[1] ?? "").split(",").filter(Boolean);

test("--ps-themes 清单与 theme-tokens.css 里实际存在的主题块一一对应", () => {
  // 清单是前端拿到「有哪些主题」的唯一来源（设计 4.4：零额外请求，颜色与清单同
  // 文件），对不上就会出现「菜单里有、切过去没令牌」或反过来「有令牌但看不到」。
  // 注：settings.ts 的 THEMES 与本清单的对齐由 Task 7 负责，本用例不依赖它。
  expect([...MANIFEST_IDS].sort()).toEqual([...BLOCKS.keys()].sort());
  expect(MANIFEST_IDS, "默认主题必须在清单里").toContain(DEFAULT_THEME);
});

test("every theme declares the full token set — no silent fallback to :root", () => {
  const expected = declaredTokens(BLOCKS.get(DEFAULT_THEME)!);
  for (const [name, body] of BLOCKS) {
    if (name === DEFAULT_THEME) continue;
    const got = new Set(declaredTokens(body));
    const missing = expected.filter((t) => !got.has(t));
    expect(missing, `主题 "${name}" 缺少令牌（会静默回落到默认主题的值）`).toEqual([]);
  }
});

test("no theme declares a token the default theme does not have", () => {
  // 反向：某套主题独有的令牌意味着其它主题拿不到值，同样是漏网。
  const base = new Set(declaredTokens(BLOCKS.get(DEFAULT_THEME)!));
  for (const [name, body] of BLOCKS) {
    if (name === DEFAULT_THEME) continue;
    const extra = [...new Set(declaredTokens(body))].filter((t) => !base.has(t));
    expect(extra, `主题 "${name}" 有默认主题里没有的令牌`).toEqual([]);
  }
});

test("no theme declares the same token twice", () => {
  for (const [name, body] of BLOCKS) {
    const toks = declaredTokens(body);
    const dupes = [...new Set(toks.filter((t, i) => toks.indexOf(t) !== i))];
    expect(dupes, `主题 "${name}" 有重复声明（后者静默覆盖前者）`).toEqual([]);
  }
});

test("终端底与 --bg 同明暗", () => {
  // 2026-08-05 废除「终端一律深色」：ANSI 16 色现在由主题调色板驱动，浅色主题的
  // 终端就该是浅色的（用作者为浅底设计的那套前景色）。要焊死的是**别劈叉**——
  // 浅色机身配深色终端底（或反过来）会让 ANSI 前景色糊在错误的底上。
  for (const [name, body] of BLOCKS) {
    const bg = tokenValue(body, "--bg")!;
    const term = tokenValue(body, "--term-bg")!;
    const side = (l: number) => (l < 0.25 ? "dark" : l > 0.4 ? "light" : "middle");
    expect(side(luminance(term)), `主题 "${name}" 的 --term-bg (${term}) 落在明暗中间地带`).not.toBe("middle");
    expect(side(luminance(term)), `主题 "${name}" 的 --term-bg (${term}) 与 --bg (${bg}) 明暗劈叉`)
      .toBe(side(luminance(bg)));
  }
});

test("每套主题都给全 ANSI 16 色，且取自它自己的 .ghostty palette", () => {
  // 2026-08-05 之前终端根本没吃 ANSI 16 色（xterm 用自带那套），所以「6 套主题」
  // 只换了机身、终端里 ls 的目录蓝从来没变过。这条焊住新行为：令牌必须存在，
  // 而且必须**逐字**等于源文件的 palette —— 语义色（--ok/--red/--amber）会被
  // 色相与对比度修正，ANSI 不能，否则终端就和同一套主题在 Ghostty 里长得不一样。
  const NAMES = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "bright-black", "bright-red", "bright-green", "bright-yellow",
    "bright-blue", "bright-magenta", "bright-cyan", "bright-white",
  ];
  for (const [id, body] of BLOCKS) {
    const src = readFileSync(resolve(__dirname, `../themes/${id}.ghostty`), "utf8");
    const palette = new Map<number, string>();
    for (const m of src.matchAll(/^\s*palette\s*=\s*(\d+)\s*=\s*#?([0-9a-fA-F]{6})/gm)) {
      palette.set(Number(m[1]), `#${m[2].toLowerCase()}`);
    }
    NAMES.forEach((name, i) => {
      expect(tokenValue(body, `--term-ansi-${name}`), `${id} 缺 --term-ansi-${name}`)
        .toBe(palette.get(i)!);
    });
  }
});

test("--sw-<id>-* 预览色与该主题真实的 --bg/--panel/--accent/--ok/--text 一致", () => {
  // 预览色住在无属性 :root 里，因为设置面板要在 A 主题激活时展示 B 主题长什么样
  // ——读实时令牌会把所有色块画成同一套。代价是它可能与主题真值漂移，故逐值比对。
  // （Task 7 会删掉 theme.ts 里硬编码的 THEME_SWATCHES，改读这些令牌。）
  const PAIRS = [
    ["bg", "--bg"], ["panel", "--panel"], ["accent", "--accent"],
    ["ok", "--ok"], ["text", "--text"],
  ] as const;
  for (const [id, body] of BLOCKS) {
    for (const [suffix, token] of PAIRS) {
      const preview = tokenValue(MANIFEST, `--sw-${id}-${suffix}`);
      expect(preview, `清单里缺 --sw-${id}-${suffix}`).not.toBeNull();
      expect(preview, `${id} 的 --sw-${id}-${suffix} 与真实 ${token} 对不上`).toBe(tokenValue(body, token));
    }
  }
});

test("--ps-scheme-<id> 与该主题 --bg 的明暗一致", () => {
  // data-scheme 的结构性覆盖（html[data-scheme="light"] .x）挂在这个判定上，
  // 判错了就是浅色主题吃到深色专属的阴影/边框。
  for (const [id, body] of BLOCKS) {
    const declared = tokenValue(MANIFEST, `--ps-scheme-${id}`);
    expect(declared, `清单里缺 --ps-scheme-${id}`).not.toBeNull();
    expect(declared, `主题 "${id}" 的明暗标记与 --bg 不符`)
      .toBe(luminance(tokenValue(body, "--bg")!) > 0.4 ? "light" : "dark");
  }
});

test("app.css 只留非颜色令牌，颜色一律来自 theme-tokens.css", () => {
  // 瘦身后的 app.css 里若再冒出颜色令牌，它只会有一套值、盖不住也跟不上主题
  // 切换——正是这套体系要消灭的那类 bug。圆角与安全区是全主题共用的几何量。
  const { themes } = rootBlocks(APP_CSS);
  expect([...themes.keys()]).toEqual([DEFAULT_THEME]); // app.css 只剩一个无属性 :root
  expect(declaredTokens(themes.get(DEFAULT_THEME)!).sort()).toEqual([
    "--radius-lg", "--radius-md", "--radius-sm", "--radius-xl", "--safe-bottom", "--safe-top",
  ]);
});

const FONTS_CSS = readFileSync(resolve(__dirname, "./fonts.css"), "utf8");

/** fonts.css 里的字体 id 清单——直接从 lib/font.ts 的 FONTS 派生，
 *  这样新增第 6 套字体时漏改 fonts.css 会在这里当场翻车，而不是悄悄放过。 */
const FONT_IDS = FONTS.map((f) => f.id);

test("每套字体都有 --font-mono-<id> 令牌", () => {
  // 设置面板的预览行按 id 拼令牌名渲染；缺一个就是那一行预览显示成默认字体，
  // 用户以为「这两套长得一样」。
  for (const id of FONT_IDS) {
    expect(FONTS_CSS, `缺 --font-mono-${id}`).toMatch(new RegExp(`--font-mono-${id}\\s*:`));
  }
});

test("每套字体都有 :root[data-font] 块把 --font-mono 指过去", () => {
  for (const id of FONT_IDS) {
    const re = new RegExp(`:root\\[data-font="${id}"\\]\\s*\\{[^}]*--font-mono\\s*:\\s*var\\(--font-mono-${id}\\)`);
    expect(FONTS_CSS, `${id} 没有把 --font-mono 指向自己的令牌`).toMatch(re);
  }
});

test("默认字体渲染为无属性 :root —— 首帧还没写 data-font 时也得有字体", () => {
  const bare = /^:root\s*\{([^}]*)\}/m.exec(FONTS_CSS);
  expect(bare, "fonts.css 里没有无属性 :root 块").not.toBeNull();
  expect(bare![1]).toMatch(/--font-mono\s*:\s*var\(--font-mono-maple-mono\)/);
});

test("@font-face 的 src 路径都指向真实存在的文件", () => {
  // 改文件名而漏改 CSS 是静默失败：浏览器 404 之后直接回落系统字体，不报错。
  const srcs = [...FONTS_CSS.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  expect(srcs.length, "一个 @font-face src 都没找到").toBeGreaterThanOrEqual(10);
  for (const s of srcs) {
    expect(s, `src 应以 /fonts/ 开头：${s}`).toMatch(/^\/fonts\//);
    const p = resolve(__dirname, "../public", s.replace(/^\//, ""));
    expect(existsSync(p), `${s} 指向的文件不存在`).toBe(true);
  }
});

test("回落链里保留 CJK 与 emoji —— 这几套字体都没有中文字形", () => {
  // 中文靠 OS 回落。删掉这段的话手机上中文会掉到某个非等宽字体，终端对齐全乱。
  for (const id of FONT_IDS) {
    const m = new RegExp(`--font-mono-${id}\\s*:([^;]+);`).exec(FONTS_CSS);
    expect(m, `没找到 --font-mono-${id}`).not.toBeNull();
    expect(m![1], `${id} 的回落链缺 PingFang SC`).toContain("PingFang SC");
    expect(m![1], `${id} 的回落链末尾必须是 monospace`).toMatch(/monospace\s*$/);
  }
});

test("app.css 里不再硬编码等宽字体族", () => {
  // 这条是「令牌名不改、只换值」那条规矩在字体上的落地。回潮的话这里当场翻车。
  //
  // **只管等宽**：app.css:80 的 `html, body` 是正文 sans-serif 字体链
  // （-apple-system / PingFang SC / …），本需求不碰它——把它也换成 --font-mono
  // 会让整个界面变等宽。判据是「这行提到了 monospace 或某个等宽族名」。
  const MONO_HINT = /monospace|JetBrains Mono|SF Mono|Maple Mono|Menlo|Consolas/;
  const offenders = APP_CSS.split("\n").filter(
    (l) => /font-family:\s*(?!inherit|var\()/.test(l) && MONO_HINT.test(l),
  );
  expect(offenders.join("\n"), "app.css 里还有硬编码的等宽字体链").toBe("");
});

/** 所有组件源文件。 */
function componentFiles(): string[] {
  const dir = resolve(__dirname, "./components");
  return readdirSync(dir).filter((f) => f.endsWith(".svelte")).map((f) => `${dir}/${f}`);
}

test("组件里不再有硬编码的等宽字体族 —— 一律走 var(--font-mono)", () => {
  // 「令牌名不改、只换值」那条规矩在字体上的落地。漏一处的症状是：切了字体，
  // 终端变了而 git 分支名没变——一眼看不出，却处处不协调。
  //
  // 允许 inherit 与 var(...)。**只管等宽**：组件若要指定正文 sans-serif
  // 字体不在本需求范围内，判据是这行提没提 monospace 或某个等宽族名。
  const MONO_HINT = /monospace|JetBrains Mono|SF Mono|Maple Mono|Menlo|Consolas|MonaspiceNe|GoogleSansCode|UbuntuMono/;
  const offenders: string[] = [];
  for (const file of componentFiles()) {
    const src = readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      // CSS 里的 font-family: 与 JS 里的 fontFamily: 都要管
      const m = /(?:font-family|fontFamily)\s*:\s*(.+)/.exec(line);
      if (!m) return;
      const val = m[1].trim();
      if (val.startsWith("inherit") || val.startsWith("var(")) return;
      if (!MONO_HINT.test(line)) return;
      offenders.push(`${file.split("/").pop()}:${i + 1}  ${line.trim()}`);
    });
  }
  expect(offenders.join("\n"), "这些地方还在写死等宽字体族").toBe("");
});
