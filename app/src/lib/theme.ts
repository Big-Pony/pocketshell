// app/src/lib/theme.ts
// Applies the user's theme preference to <html data-theme="…">. Every theme —
// the seven built-ins in src/theme-tokens.css and any .ghostty the user drops
// into the agent's keyDir — shares one token set; this module only decides
// which one is active. It also writes <html data-scheme="dark|light"> so
// components can key structural (non-colour) overrides off the light/dark
// class rather than one specific theme id — see the rules at the top of app.css.
//
// 2026-08-05：主题清单、明暗集合、预览色三份硬编码从这里搬走了。真相在 CSS：
// `theme-tokens.css` 的清单块（`--ps-themes` / `--ps-scheme-<id>` / `--sw-<id>-*`）
// 加上 agent 供给的 `/theme/custom.css`。本模块负责把它们读出来，纯逻辑在
// `theme-css.ts`（读取函数注入，可单测）。

import { loadSettings, saveSettings, THEMES, type ThemePref } from "./settings";
import {
  MANIFEST_BUILTIN, MANIFEST_CUSTOM, MANIFEST_SKIPPED, parseThemeList, parseCustomThemeList,
  parseSkips, totalFromCss, truncatedFromCss, schemeFromCss, swatchFromCss, isCustomTheme,
  customThemeName, nameFromCss, type CssReader, type Scheme, type ThemeSkip,
} from "./theme-css";

export type { ThemeSkip };

/** Every theme except "system", which is a pointer rather than a palette. */
export type ResolvedTheme = Exclude<ThemePref, "system">;

export type { Scheme };

/** 默认主题：`theme-tokens.css` 里渲染为无属性 `:root` 的那套。 */
export const DEFAULT_THEME: ResolvedTheme = "cream-dark";

/** 真实读取器：读 <html> 上生效的自定义属性。CSS 尚未到位时返回空串。 */
export function cssReader(): CssReader {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return () => "";
  const cs = getComputedStyle(document.documentElement);
  return (prop) => cs.getPropertyValue(prop) ?? "";
}

/**
 * 某套主题是深是浅。查 CSS 的 `--ps-scheme-<id>`（生成器按背景色相对亮度判定），
 * 读不到回落 `"dark"`——jsdom 与 CSS 尚未加载时都会走那条路。
 */
export function schemeOf(theme: ResolvedTheme, read: CssReader = cssReader()): Scheme {
  return schemeFromCss(theme, read);
}

/** 设置面板的色板：机身 / 面板 / 主色 / 运行灯 / 文字。缺失返回 null。 */
export function swatchOf(theme: ResolvedTheme, read: CssReader = cssReader()): string[] | null {
  return swatchFromCss(theme, read);
}

export interface ThemeEntry {
  id: ResolvedTheme;
  scheme: Scheme;
  /** 5 个预览色；CSS 里没有该主题的预览色时为 null（画空色板，不画错色板）。 */
  colors: string[] | null;
  custom: boolean;
  /**
   * 自定义主题的展示名（**原文件名**，如 `Tokyo Night`）；内置主题为 null，
   * 名字走 i18n。id 是文件名 slug 化的产物，拿来当名字显示等于替用户改名。
   */
  name: string | null;
}

/**
 * 菜单里该出现哪些主题（不含 "system"，那是 UI 单独一行）。
 *
 * 内置清单以 `settings.ts` 的 `THEMES` 为准并与 CSS 的 `--ps-themes` 取交集：
 * 生成物里没有的主题不该出现在菜单里（切过去会没令牌），CSS 里多出来的也不认
 * （TS 侧白名单挡在 loadSettings，菜单跟着白名单走）。自定义主题来自
 * `--ps-custom-themes`，agent 未接入时该令牌不存在，自然是空列表。
 */
export function listThemes(read: CssReader = cssReader()): ThemeEntry[] {
  const inCss = new Set(parseThemeList(read(MANIFEST_BUILTIN)));
  const builtin = THEMES.filter((t): t is ResolvedTheme => t !== "system" && !isCustomTheme(t))
    // CSS 读不到清单（jsdom、CSS 还没到）时不做过滤，否则菜单会整个空掉。
    .filter((t) => inCss.size === 0 || inCss.has(t));
  const custom = parseCustomThemeList(read(MANIFEST_CUSTOM)) as ResolvedTheme[];
  return [...builtin, ...custom].map((id) => ({
    id,
    scheme: schemeFromCss(id, read),
    colors: swatchFromCss(id, read),
    custom: isCustomTheme(id),
    name: isCustomTheme(id) ? nameFromCss(id, read) : null,
  }));
}

/** keyDir 里的主题文件情况：装不下的、以及没能成为主题的。 */
export interface CustomThemeInfo {
  /** keyDir 里的 `.ghostty` 文件总数（含超出上限被丢掉的）。0 表示 agent 没供给。 */
  total: number;
  /** 列表里实际有几套。 */
  shown: number;
  /** 触到 50 套上限，UI 要提示「只显示了前 N 套」。**由 agent 明说**，不是从
   *  `total > shown` 推的——有文件被跳过时那两个数本来就不等。 */
  truncated: boolean;
  skipped: ThemeSkip[];
}

/**
 * 自定义主题的「为什么没看到我的文件」信息。
 *
 * 这些只能从 CSS 里读：样式表是 `<link>` 拉的，拿不到响应头（agent 也发了
 * `X-Theme-Truncated`，那是给 curl 和将来的 fetch 调用方的）。
 */
export function customThemeInfo(read: CssReader = cssReader()): CustomThemeInfo {
  return {
    total: totalFromCss(read),
    shown: parseCustomThemeList(read(MANIFEST_CUSTOM)).length,
    truncated: truncatedFromCss(read),
    skipped: parseSkips(read(MANIFEST_SKIPPED)),
  };
}

/**
 * 换掉自定义主题样式表的 href，等它加载完再 resolve。
 *
 * 为什么要等：agent 只把**选中那套**的完整令牌写进 CSS（设计 4.5，否则 50 套
 * 就是四分之一兆字节换一套配色）。所以切到自定义主题必须重新请求一次，而在新
 * CSS 到位之前写 `data-theme` 会有一帧拿不到任何令牌——屏幕上就是闪一下白。
 *
 * 失败也 resolve 不 reject：agent 没接入（demo 站）、离线、或主题被别的设备删了，
 * 这三种都会 404 或超时。那时该做的是回落到内置令牌继续渲染，不是把换主题这个
 * 动作整个失败掉。
 */
function loadCustomCss(name: string | null): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  const link = document.querySelector<HTMLLinkElement>('link[data-ps-theme="custom"]');
  if (!link) return Promise.resolve(); // 页面没挂这个 link（单测/演示构建）
  const href = name ? `/theme/custom.css?t=${encodeURIComponent(name)}` : "/theme/custom.css";
  // 已经是这个 href 就别动：重设相同的 href 也会触发一次重新请求，而换回同一套
  // 主题（比如从设置面板里点两下）本来什么都不用做。
  if (new URL(link.href, location.href).search === new URL(href, location.href).search) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      link.removeEventListener("load", done);
      link.removeEventListener("error", done);
      resolve();
    };
    link.addEventListener("load", done);
    link.addEventListener("error", done);
    link.href = href;
  });
}

/**
 * 切到某套主题，需要时先把自定义样式表换过来。
 *
 * 内置主题走同步的 `applyTheme()` 即可（令牌已经在 `theme-tokens.css` 里）；
 * 自定义主题必须先等 CSS，所以这个是 async。调用方（设置面板）用它。
 */
export async function applyThemeAsync(pref: ThemePref): Promise<ResolvedTheme> {
  const resolved = resolveTheme(pref, window.matchMedia("(prefers-color-scheme: dark)").matches);
  await loadCustomCss(customThemeName(resolved));
  return applyTheme(pref);
}

/** "system" 在浅色时选哪套。与 DEFAULT_THEME 成对，同属 cream 家族。 */
export const SYSTEM_LIGHT: ResolvedTheme = "cream-light";

/** "system" 跟随 OS 在默认深色与默认浅色之间切换；其余是字面量。 */
export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? DEFAULT_THEME : SYSTEM_LIGHT;
  return pref;
}

/**
 * Set <html data-theme> + <html data-scheme>，并把首帧要用的两个值写回
 * localStorage。
 *
 * 回写这一步是防闪烁的全部机制：index.html / demo.html 的内联脚本跑在任何 CSS
 * 之前，没法自己算出「当前主题的 --bg-deep 是什么颜色」。以前的解法是在两个
 * HTML 里各手抄一份「主题 → 色值」表（CLAUDE.md 点名的手工镜像），加一套主题
 * 漏抄一处就静默闪错色。现在改为**用完即存**：谁应用了主题谁负责留下这一帧的
 * 颜色，脚本只读不算，主题有多少套、各自什么颜色它一概不需要知道。
 */
export function applyTheme(pref: ThemePref): ResolvedTheme {
  const resolved = resolveTheme(pref, window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = resolved;
  const read = cssReader();
  const scheme = schemeFromCss(resolved, read);
  document.documentElement.dataset.scheme = scheme;
  // 交接：内联守卫在 <html> 上写了 style.background 兜首帧，而**内联样式优先级
  // 高于样式表**——不撤掉的话，之后换主题背景会纹丝不动。此刻 app.css 已经到位
  // （main.ts 是 module script，跑在样式表之后），撤掉即由 var(--bg-deep) 接管。
  document.documentElement.style.removeProperty("background");
  cacheFirstPaint(read, scheme);
  return resolved;
}

/** 把当前生效的 --bg-deep 与明暗存进设置，供下次首帧用。失败不影响换主题。 */
function cacheFirstPaint(read: CssReader, scheme: Scheme): void {
  try {
    // data-theme 刚写过，getComputedStyle 此时读到的就是新主题的值。
    const bootBg = read("--bg-deep").trim();
    if (!bootBg) return;
    const s = loadSettings();
    if (s.bootBg === bootBg && s.scheme === scheme) return; // 免掉一次无谓的写
    saveSettings({ ...s, bootBg, scheme });
  } catch { /* 隐私模式下 localStorage 可能抛；首帧退回兜底色即可 */ }
}

/**
 * Watch the OS color scheme; fires onChange only while the (live) preference
 * is "system". Takes a getter so callers don't re-register on every change.
 * Returns an unlisten function.
 */
export function watchSystem(getPref: () => ThemePref, onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => { if (getPref() === "system") onChange(); };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

/** Boot-time theme application (called from main.ts before mount). */
export function initTheme(): ThemePref {
  const pref = loadSettings().theme;
  applyTheme(pref);
  return pref;
}

/**
 * Boot-time application that also waits for a custom theme's stylesheet.
 *
 * The `<link>` in the HTML has no `?t=`, so on a cold load it brings back the
 * manifest but not the selected theme's tokens (agent only expands the selected
 * one — design §4.5). A user on a custom theme therefore needs one extra
 * request before mount, and mounting first would paint the whole app in the
 * default palette for that round trip.
 *
 * Costs nothing for the built-in themes: the href is already the one we want,
 * so `loadCustomCss` resolves without touching the network.
 */
export async function initThemeAsync(): Promise<ThemePref> {
  const pref = loadSettings().theme;
  await applyThemeAsync(pref);
  return pref;
}
