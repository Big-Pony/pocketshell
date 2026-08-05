// app/src/lib/font.ts
// 把用户选的等宽字体应用到 <html data-font="…">。所有字体共享一套令牌
// （fonts.css 的 --font-mono），本模块只决定哪套生效——与 lib/theme.ts 同构。
//
// 与主题的区别：主题的清单/明暗/预览色从 CSS 读（那里有 derive() 算出来的东西，
// TS 侧无从预知），字体的清单就在这里。字体只有「id + 家族名 + 路径」三个字面量，
// 从 CSS 反解出来只会让加字体变难。
//
// 加一套字体要动的四处见 fonts.css 顶部的注释。

import { loadSettings, saveSettings } from "./settings";

export type FontId =
  | "maple-mono"        // Maple Mono（默认）
  | "jetbrains-mono"    // JetBrains Mono（1.10.0 及以前的默认）
  | "google-sans-code"  // Google Sans Code
  | "monaspace-neon"    // Monaspace Neon
  | "ubuntu-mono";      // Ubuntu Mono

export interface FontEntry {
  id: FontId;
  /**
   * 字体内部家族名，**必须与 woff2 里的 name ID 1 及 fonts.css 的 @font-face
   * 逐字一致**。给 document.fonts.load() 用（它要单个 family，不吃回落链）。
   *
   * Monaspace 是 "MonaspiceNe NFM" 不是 "Monaspace Neon"：上游 Nerd Fonts 为
   * 遵守 Reserved Font Name 条款改的名，改回去既违反 OFL 也加载不到。
   */
  family: string;
  /** Regular 权重的 woff2 路径，供首帧 preload。Bold 保持惰性。 */
  url: string;
}

/** 菜单序。默认排第一。 */
export const FONTS: FontEntry[] = [
  { id: "maple-mono",       family: "Maple Mono NF",             url: "/fonts/maple-mono-regular.woff2" },
  { id: "jetbrains-mono",   family: "JetBrains Mono",            url: "/fonts/JetBrainsMono-Regular.woff2" },
  { id: "google-sans-code", family: "GoogleSansCode NFM",        url: "/fonts/google-sans-code-regular.woff2" },
  { id: "monaspace-neon",   family: "MonaspiceNe NFM",           url: "/fonts/monaspace-neon-regular.woff2" },
  { id: "ubuntu-mono",      family: "UbuntuMono Nerd Font Mono", url: "/fonts/ubuntu-mono-regular.woff2" },
];

/** 在 fonts.css 里渲染为无属性 `:root` 的那套。 */
export const DEFAULT_FONT: FontId = "maple-mono";

function entryOf(id: FontId): FontEntry {
  return FONTS.find((f) => f.id === id) ?? FONTS.find((f) => f.id === DEFAULT_FONT)!;
}

/** 单个家族名。`document.fonts.load()` 要的是这个，不是整条回落链。 */
export function familyOf(id: FontId): string {
  return entryOf(id).family;
}

/**
 * 当前 `--font-mono` 的**计算值**，喂给 xterm。
 *
 * xterm 只吃字面值不认 CSS 变量（与主题里 termTheme() 读 22 个色值同源）。
 * jsdom 不注入样式表，读出来是空串——那时回落到从清单拼一条，否则 xterm 会
 * 拿空串去用它自己的默认字体，而这个 bug 在真机上完全看不出来。
 */
export function termFontFamily(): string {
  if (typeof document !== "undefined" && typeof getComputedStyle === "function") {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
    if (v) return v;
  }
  const id = (document?.documentElement?.dataset?.font as FontId) || DEFAULT_FONT;
  return `"${familyOf(id)}", "SF Mono", ui-monospace, Menlo, monospace`;
}

/**
 * 切到某套字体。写 `<html data-font>`，并把首帧 preload 要用的路径存回设置。
 *
 * 存这一步是防首帧闪烁的全部机制：index.html / demo.html 的内联脚本跑在任何
 * CSS 之前，没法自己知道「当前字体的文件在哪」。与主题的 bootBg 同一套路数——
 * 谁应用了字体谁负责留下这一帧要预取的 URL，脚本只读不算。
 */
export function applyFont(id: FontId): void {
  const e = entryOf(id); // 不认识的 id 在这里被换成默认，不会写进 DOM
  document.documentElement.dataset.font = e.id;
  try {
    const s = loadSettings();
    if (s.bootFontUrl === e.url) return; // 免掉一次无谓的写
    saveSettings({ ...s, bootFontUrl: e.url });
  } catch {
    /* 隐私模式下 localStorage 会抛；首帧退回兜底 URL 即可，不影响换字体本身 */
  }
}

/** 启动时应用已存的偏好（main.ts 在 mount 之前调）。 */
export function initFont(): FontId {
  const id = loadSettings().fontFamily;
  applyFont(id);
  return entryOf(id).id;
}
