// app/src/index.html.test.ts
// index.html / demo.html 内联防闪烁脚本的防漂移。
//
// 那段脚本必须在首帧之前跑完，所以它**不能 import 任何模块**。2026-08-05 之前
// 它因此手抄了三份东西：主题列表、浅色集合、每套主题的 --boot-bg 色值，而且
// index.html 与 demo.html 各抄一遍。漂移是静默的——加一套主题漏抄一处，只会在
// 真机首帧闪那么一下，CI 与人眼走查都抓不到。本文件当时就是为看住这三份而写的。
//
// 现在三份都没了：applyTheme() 每次换主题把 --bg-deep 与明暗写回 localStorage，
// 脚本只读那两个值。脚本因此完全不知道有哪些主题，也就无从漂移。剩下要看住的是：
//   1. 两个 HTML 的脚本仍然逐字一致（复制粘贴的东西迟早会分叉）；
//   2. 唯一保留的那个硬编码兜底色值，等于默认主题真实的 --bg-deep；
//   3. localStorage 的 key 与字段名与 settings.ts 一致（key 一漂，脚本永远读不到）。
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SETTINGS } from "./lib/settings";

const HTML = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const DEMO_HTML = readFileSync(resolve(__dirname, "../demo.html"), "utf8");
const TOKENS_CSS = readFileSync(resolve(__dirname, "./theme-tokens.css"), "utf8");
const SETTINGS = readFileSync(resolve(__dirname, "./lib/settings.ts"), "utf8");

/** 内联脚本里的兜底色值（`var FALLBACK_BG = "…"`）。 */
function fallbackBg(html: string): string {
  const m = /var\s+FALLBACK_BG\s*=\s*"([^"]+)"/.exec(html);
  if (!m) throw new Error("内联脚本里没找到 var FALLBACK_BG");
  return m[1].trim().toLowerCase();
}

/** theme-tokens.css 里默认主题（无属性 :root，且不是清单块）的 --bg-deep。 */
function defaultBgDeep(): string {
  const head = /^:root\s*\{/gm;
  for (let m = head.exec(TOKENS_CSS); m; m = head.exec(TOKENS_CSS)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth > 0 && i < TOKENS_CSS.length) {
      if (TOKENS_CSS[i] === "{") depth++;
      else if (TOKENS_CSS[i] === "}") depth--;
      i++;
    }
    const body = TOKENS_CSS.slice(start, i - 1);
    const bg = /^\s*--bg-deep\s*:\s*([^;]+);/m.exec(body);
    if (bg) return bg[1].split("/*")[0].trim().toLowerCase(); // 清单块没有 --bg-deep，自然跳过
  }
  throw new Error("theme-tokens.css 里没找到默认主题（无属性 :root）的 --bg-deep");
}

test("首帧兜底色值等于默认主题在 theme-tokens.css 里的 --bg-deep", () => {
  // 唯一保留的硬编码。对不上就是首次访问闪一下：脚本刷 A 色，CSS 到位后变 B 色。
  expect(fallbackBg(HTML), "index.html 的 FALLBACK_BG 与默认主题漂移了").toBe(defaultBgDeep());
});

test("默认 theme-color meta 等于兜底色值", () => {
  // 脚本会用缓存值重写它，但首帧之前生效的是这个静态值。
  const meta = /<meta name="theme-color" content="([^"]+)"/.exec(HTML)![1].toLowerCase();
  expect(meta).toBe(fallbackBg(HTML));
});

test("默认主题就是 settings.ts 的 DEFAULT_SETTINGS.theme", () => {
  // 兜底色取自「无属性 :root」那套；那套必须正是 TS 侧的默认，否则首帧
  // （还没写 data-theme）与 applyTheme 之后是两套配色。
  expect(DEFAULT_SETTINGS.theme).toBe("cream-dark");
  expect(TOKENS_CSS).toContain("/* theme: cream-dark (default) */");
});

test("内联脚本不再手抄主题列表 / 浅色集合 / 每套色值", () => {
  // 这三份手抄是本次改造消灭的东西；回潮的话这里立刻翻车。
  for (const [name, html] of [["index.html", HTML], ["demo.html", DEMO_HTML]] as const) {
    expect(html, `${name} 又出现了 --boot-bg 声明`).not.toContain("--boot-bg");
    expect(html, `${name} 又手抄了 THEMES 列表`).not.toMatch(/var\s+THEMES\s*=/);
    expect(html, `${name} 又手抄了 LIGHT 集合`).not.toMatch(/var\s+LIGHT\s*=/);
  }
});

test("脚本里只有一个硬编码色值", () => {
  // 兜底色是唯一允许的那个。多出来的十六进制色值意味着有人又在这里写死了配色。
  const script = themeScript(HTML);
  expect(script.match(/#[0-9a-fA-F]{3,8}\b/g)).toEqual([fallbackBg(HTML)]);
});

test("内联脚本用的 localStorage key 与 settings.ts 一致", () => {
  // key 一漂，脚本永远读不到用户存的主题，每次首帧都是兜底色。
  const key = /localStorage\.getItem\("([^"]+)"\)/.exec(HTML)![1];
  expect(key).toBe(/^const KEY = "([^"]+)";/m.exec(SETTINGS)![1]);
});

test("脚本读的三个字段名都在 Settings 接口里", () => {
  // theme/scheme/bootBg 任一改名，脚本会静默读到 undefined 而回落兜底色——
  // 不报错，只是每次首帧都闪。
  for (const field of ["theme", "scheme", "bootBg"]) {
    expect(HTML, `脚本没读 s.${field}`).toContain(`s.${field}`);
    expect(SETTINGS, `Settings 接口里没有 ${field}`).toMatch(new RegExp(`^\\s{2}${field}[?]?:`, "m"));
  }
});

test("scheme 缺失时兜 dark，theme 为 system 时不写 data-theme", () => {
  // "system" 是指针不是配色，写进 data-theme 会得到一个没有令牌块的选择器；
  // 解析它需要知道具体主题名，那正是这段脚本要避免持有的知识。
  const script = themeScript(HTML);
  expect(script).toMatch(/scheme\s*\|\|\s*"dark"/);
  expect(script).toMatch(/pref\s*!==\s*"system"/);
});

test("applyTheme 会撤掉内联脚本写的 background", () => {
  // 内联样式优先级高于样式表：不撤的话首帧那个色会焊死，之后换主题背景纹丝不动。
  const themeTs = readFileSync(resolve(__dirname, "./lib/theme.ts"), "utf8");
  expect(HTML).toMatch(/root\.style\.background\s*=/);
  expect(themeTs).toContain('style.removeProperty("background")');
});

test("解析器自身有效性自检", () => {
  // 正则失配会让上面几条静默通过，锚一下已知内容。
  expect(fallbackBg(HTML)).toMatch(/^#[0-9a-f]{6}$/);
  expect(defaultBgDeep()).toMatch(/^#[0-9a-f]{6}$/);
  expect(themeScript(HTML).length).toBeGreaterThan(200);
});

// ── demo.html：与 index.html 的内联脚本必须逐字一致 ──

/** 抽出内联防闪烁脚本的主体（从兜底色声明到该 IIFE 结束）。 */
function themeScript(html: string): string {
  const start = html.indexOf("var FALLBACK_BG");
  expect(start, "内联脚本里没找到 var FALLBACK_BG").toBeGreaterThan(-1);
  const end = html.indexOf("</script>", start);
  expect(end, "内联脚本没有闭合的 </script>").toBeGreaterThan(start);
  return html.slice(start, end).replace(/\s+/g, " ").trim();
}

test("demo.html 的主题防闪烁脚本与 index.html 逐字一致", () => {
  // 两处漂移是静默的：只在展台页首帧闪那么一下，CI 与人眼走查都抓不到。
  // 现在脚本不含主题知识，能漂的只剩兜底色与字段名——照样一改就分叉。
  expect(themeScript(DEMO_HTML)).toBe(themeScript(HTML));
});

test("demo.html 的兜底 theme-color 与 index.html 一致", () => {
  const meta = (html: string) => /<meta name="theme-color" content="([^"]+)"/.exec(html)![1].toLowerCase();
  expect(meta(DEMO_HTML)).toBe(meta(HTML));
});

test("demo.html 有分流脚本，且 index.html 没有", () => {
  // 两边都有的话，手机落到 app 入口后会再 replace 到自己、白白多一次导航。
  expect(DEMO_HTML).toContain('location.replace("/app")');
  expect(DEMO_HTML).toMatch(/pointer:\s*coarse/);
  expect(HTML).not.toContain("location.replace");
});

test("分流判据是「窄屏 && 触控」，不是 ||", () => {
  // || 会把触屏笔电与 iPad 横屏（宽屏但 pointer: coarse）踢到手机版，
  // 于是看不到展台页的二维码和安装 CTA——那正是展台页存在的理由。
  expect(DEMO_HTML).toMatch(/innerWidth\s*<\s*900\s*&&\s*matchMedia/);
  expect(DEMO_HTML).not.toMatch(/innerWidth\s*<\s*900\s*\|\|/);
});

test("分流与 iframe 都指向无扩展名的 /app，不是 /app.html", () => {
  // Cloudflare Pages 会剥掉 .html 扩展名：请求 /app.html 得到 308 → /app。
  // 功能上能跑通，但每个访客（尤其手机——那是主要受众）白付一次跳转往返。
  // 线上实测得来的，本地 `serve dist` 不会剥扩展名，所以复现不出。
  // 判据只看**代码**里的引用，不看注释——注释里正需要提到 /app.html 才能
  // 解释清楚为什么不用它（`dist/app.html` 确实是改名产物的真实文件名）。
  const showcase = readFileSync(resolve(__dirname, "./components/Showcase.svelte"), "utf8");
  expect(DEMO_HTML).toContain('location.replace("/app")');
  expect(DEMO_HTML).not.toContain('location.replace("/app.html")');
  expect(showcase).toContain('src="/app"');
  expect(showcase).not.toContain('"/app.html"');
});

test("demo.html 不引 manifest 与 apple-touch-icon（演示站不做 PWA）", () => {
  expect(DEMO_HTML).not.toContain("manifest.webmanifest");
  expect(DEMO_HTML).not.toContain("apple-touch-icon");
});

test("demo.html 的入口指向 demo-main.ts", () => {
  expect(DEMO_HTML).toContain("/src/demo-main.ts");
  expect(DEMO_HTML).not.toContain("/src/main.ts");
});
