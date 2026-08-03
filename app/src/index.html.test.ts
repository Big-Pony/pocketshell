// app/src/index.html.test.ts
// index.html 内联防闪烁脚本 <-> lib/settings.ts + lib/theme.ts 的镜像防漂移。
//
// index.html 里那段脚本必须在首帧之前跑完，所以它**不能 import 任何模块**——主题
// 列表、浅色集合、每套主题的 --boot-bg 全是手抄的。漂移是静默的：新增一套主题只
// 改了 settings.ts/theme.ts/app.css，index.html 的 THEMES 里没有它，
// `THEMES.indexOf(s.theme)` 落空 → pref 回落 "dark" → 首帧刷成深色，
// app.css 加载后再跳成真正的主题；漏一条 --boot-bg 则首帧背景闪错色；漏进 LIGHT
// 则首帧 data-scheme 是 dark，浅色主题上会闪一下深色的结构性覆盖。三种都不报错、
// 只在真机首帧闪那么一下——CI 与人眼走查都抓不到。
//
// app.css.test.ts 只管 app.css 与 THEMES/色板的一致，完全不碰 index.html；这里补上。
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { THEMES } from "./lib/settings";
import { schemeOf, THEME_SWATCHES, type ResolvedTheme } from "./lib/theme";

const HTML = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const CSS = readFileSync(resolve(__dirname, "./app.css"), "utf8");

/** 抽出内联脚本里 `var NAME = [...]` 的字符串字面量。 */
function inlineList(name: string): string[] {
  const m = new RegExp(`var\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(HTML);
  if (!m) throw new Error(`index.html 的内联脚本里没找到 var ${name}`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

/** 内联 <style> 里声明了 --boot-bg 的主题 -> 色值；`:root` 无选择器的那条记为 "dark"。 */
function bootBgs(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /:root(?:\[data-theme="([a-z]+)"\])?\s*\{\s*--boot-bg:\s*([^;]+);/g;
  for (let m = re.exec(HTML); m; m = re.exec(HTML)) out.set(m[1] ?? "dark", m[2].trim().toLowerCase());
  return out;
}

/** app.css 里某套主题的 --bg-deep（"dark" 即无选择器的 :root 块）。 */
function cssBgDeep(theme: string): string {
  const head = new RegExp(`^:root${theme === "dark" ? "" : `\\[data-theme="${theme}"\\]`}\\s*\\{`, "m").exec(CSS);
  if (!head) throw new Error(`app.css 里没找到主题 ${theme} 的块`);
  let depth = 1;
  let i = head.index + head[0].length;
  const start = i;
  while (depth > 0 && i < CSS.length) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") depth--;
    i++;
  }
  const body = CSS.slice(start, i - 1);
  const m = /^\s*--bg-deep\s*:\s*([^;]+);/m.exec(body);
  if (!m) throw new Error(`主题 ${theme} 没有 --bg-deep`);
  return m[1].split("/*")[0].trim().toLowerCase();
}

const PALETTES = THEMES.filter((t): t is ResolvedTheme => t !== "system");
const BOOT = bootBgs();

test("内联 THEMES 与 settings.ts 的 THEMES 完全一致（含顺序）", () => {
  // 顺序也比：这是设置面板的菜单序，两处对不上说明有人只改了一边。
  expect(inlineList("THEMES"), "index.html 的 THEMES 与 lib/settings.ts 漂移了").toEqual(THEMES);
});

test("内联 LIGHT 与 theme.ts 的浅色集合一致", () => {
  // theme.ts 的 LIGHT_THEMES 未导出，用它的公开出口 schemeOf 反推，避免为测试改源码。
  const light = PALETTES.filter((t) => schemeOf(t) === "light");
  expect([...inlineList("LIGHT")].sort(), "index.html 的 LIGHT 与 lib/theme.ts 的 LIGHT_THEMES 漂移了")
    .toEqual([...light].sort());
});

test("内联 LIGHT 里没有 THEMES 之外的条目", () => {
  const known = new Set<string>(THEMES);
  expect(inlineList("LIGHT").filter((t) => !known.has(t))).toEqual([]);
});

test("每个非 system 主题都有 --boot-bg 声明", () => {
  const missing = PALETTES.filter((t) => !BOOT.has(t));
  expect(missing, "这些主题首帧会拿到默认（石墨橙）背景然后闪一下").toEqual([]);
});

test("没有多余的 --boot-bg（主题删了但声明还在）", () => {
  const known = new Set<string>(PALETTES);
  expect([...BOOT.keys()].filter((t) => !known.has(t))).toEqual([]);
});

test("system 不该有自己的 --boot-bg 块", () => {
  // "system" 是指针不是配色，脚本会把它解析成 dark/light 再写 data-theme。
  expect(BOOT.has("system")).toBe(false);
});

test("每个 --boot-bg 等于该主题在 app.css 里的 --bg-deep", () => {
  // 值对不上就是首帧一个色、CSS 到位后另一个色——最典型的「闪一下」。
  for (const t of PALETTES) {
    expect(BOOT.get(t), `主题 "${t}" 的 --boot-bg 与 app.css 的 --bg-deep 对不上`).toBe(cssBgDeep(t));
  }
});

test("默认 theme-color meta 等于默认主题的 --boot-bg", () => {
  // 脚本会按解析后的主题重写它，但首帧之前生效的是这个静态值。
  const meta = /<meta name="theme-color" content="([^"]+)"/.exec(HTML)![1].toLowerCase();
  expect(meta).toBe(BOOT.get("dark"));
});

test("内联脚本用的 localStorage key 与 settings.ts 一致", () => {
  // key 一漂，脚本永远读不到用户存的主题，每次首帧都是默认深色。
  const key = /localStorage\.getItem\("([^"]+)"\)/.exec(HTML)![1];
  const SETTINGS = readFileSync(resolve(__dirname, "./lib/settings.ts"), "utf8");
  expect(key).toBe(/^const KEY = "([^"]+)";/m.exec(SETTINGS)![1]);
});

test("解析器自身有效性自检", () => {
  // 断言多为集合相等，正则失配返回空数组会假阳性全绿。锚一下已知内容。
  expect(inlineList("THEMES").length).toBeGreaterThan(5);
  expect(inlineList("THEMES")).toContain("system");
  expect(inlineList("LIGHT")).toContain("light");
  expect(BOOT.size).toBe(THEME_SWATCHES.length);
  expect(BOOT.get("blackout")).toBe("#000000");
});
