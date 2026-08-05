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
  MANIFEST_BUILTIN, MANIFEST_CUSTOM, parseThemeList, parseCustomThemeList,
  schemeFromCss, swatchFromCss, isCustomTheme, type CssReader, type Scheme,
} from "./theme-css";

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
  }));
}

/**
 * @deprecated Task 10 的过渡垫片，届时随 SettingsPanel 改造一并删除。
 *
 * 旧的 `THEME_SWATCHES` 是一张手写的「主题 → 5 个色值」表；现在色值全部来自
 * CSS，所以这里改成由 `listThemes()` 填充的**活绑定**：`applyTheme()` 每次刷新
 * 它。之所以不做成函数，是因为 `SettingsPanel.svelte` 还在 `{#each}` 里直接迭代
 * 这个名字，而那个文件属于 Task 10；改成函数就得动它。
 *
 * 值在 `initTheme()`（main.ts，mount 之前）跑完后才有内容——那时 CSS 已就位。
 */
export let THEME_SWATCHES: ThemeEntry[] = [];

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
  THEME_SWATCHES = listThemes(read); // 过渡垫片，见其声明处
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
