// app/src/lib/settings.ts
// Local (per-device) settings persisted to localStorage. These NEVER go
// to the backend — identity keys, agent addresses, keyboard layout,
// font size, and vibration preference are all device-local by design.

import { CUSTOM_PREFIX, isSafeThemeId } from "./theme-css";

const KEY = "ps.settings";

/**
 * 内置主题 id，与 `app/themes/<id>.ghostty` 及生成物 `src/theme-tokens.css` 的
 * `:root[data-theme="…"]` 块一一对应（清单令牌 `--ps-themes` 是那份的真相）。
 * 加一套内置主题 = 丢一个 `.ghostty` 文件 + 重跑 `bun run gen:themes` + 在这里
 * 补一行（本清单只是 TS 侧的白名单，用于校验 localStorage 里的脏数据）。
 *
 * `"system"` 是指针不是配色，apply 时解析成具体一套。
 * `custom:<name>` 是用户放进 agent keyDir 的 `.ghostty`——**前端不可能预先知道
 * 有哪些**，故按前缀放行，具体存不存在由 CSS 说了算（不存在就没令牌，回落默认）。
 */
export type BuiltinTheme =
  | "cream-dark"    // 奶油深（默认，深）
  | "cream-light"   // 奶油浅（浅）
  | "gruvbox-dark"  // Gruvbox（深）
  | "tokyonight"    // Tokyo Night（深）
  | "nord"          // Nord（深）
  | "mocha"         // Catppuccin Mocha（深）
  | "blackout";     // Black Metal 改编（深，OLED 纯黑）

export type ThemePref = BuiltinTheme | "system" | `custom:${string}`;
export type Language = "zh" | "en";
export type VibrateLevel = "off" | "light" | "medium" | "strong";

export interface Settings {
  layout: "mac" | "win";
  fontSize: number;
  vibrate: VibrateLevel;
  theme: ThemePref;
  language: Language;
  groupTabsByType: boolean;   // 需求 4：终端 tab 靠左、文件 tab 靠右
  /**
   * 首帧用的缓存值，由 `applyTheme()` 写入，**只被 index.html / demo.html 的内联
   * 防闪烁脚本读**（那段脚本跑在任何 CSS 之前，没法自己算出当前主题的颜色）。
   * 缺失时脚本用硬编码的默认主题兜底，所以它们是可选的、坏了也只是闪一下。
   */
  bootBg?: string;            // 当前主题的 --bg-deep 字面值
  scheme?: string;            // 当前主题的明暗（"dark" | "light"）
}

export const DEFAULT_SETTINGS: Settings = {
  layout: "mac",
  fontSize: 10,
  vibrate: "medium",
  theme: "cream-dark",
  language: "zh",
  groupTabsByType: false,     // 默认关闭，维持现状
};

/** 菜单序：内置 7 套在前，"system" 收尾。自定义主题由 CSS 清单动态追加。 */
export const THEMES: ThemePref[] = [
  "cream-dark", "cream-light", "gruvbox-dark", "tokyonight", "nord", "mocha", "blackout", "system",
];
const LANGS: Language[] = ["zh", "en"];
const VIBES: VibrateLevel[] = ["off", "light", "medium", "strong"];

/**
 * 主题白名单。内置 7 套 + "system" 逐个比对；`custom:*` 只能按前缀放行——
 * 有哪些自定义主题只有 agent 知道，前端拿到 CSS 才清楚，这里拦不了「不存在」，
 * 只拦「不安全」：含引号/换行/空白等字符的 id 拼进 `[data-theme="…"]` 会静默
 * 失配（不报错，只是主题不生效），必须在入口挡掉。
 *
 * 旧主题 id（dark/light/osc/prussian/vermilion）**不做迁移映射**（计划「已知取舍」）：
 * 不在白名单里 → 回落新默认，这是 loadSettings 的既有行为。
 */
function coerceTheme(v: unknown): ThemePref {
  if (typeof v !== "string") return DEFAULT_SETTINGS.theme;
  if ((THEMES as string[]).includes(v)) return v as ThemePref;
  if (v.startsWith(CUSTOM_PREFIX) && isSafeThemeId(v)) return v as ThemePref;
  return DEFAULT_SETTINGS.theme;
}

/** 首帧缓存值是要直接写进 `style.background` 的，只收干净的短字符串。 */
function coerceBootValue(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 && s.length <= 32 && /^[#a-zA-Z0-9(),.%\s/-]+$/.test(s) ? s : undefined;
}

// Legacy boolean -> level; invalid/absent -> default.
function coerceVibrate(v: unknown): VibrateLevel {
  if (v === true) return "medium";
  if (v === false) return "off";
  return typeof v === "string" && (VIBES as string[]).includes(v) ? (v as VibrateLevel) : DEFAULT_SETTINGS.vibrate;
}

// First-run language: follow the browser (zh* -> zh, everything else -> en).
// Once the user picks a language in Settings it is persisted and wins.
export function detectLanguage(): Language {
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function loadSettings(store: Storage = localStorage): Settings {
  const raw = store.getItem(KEY);
  if (!raw) return { ...DEFAULT_SETTINGS, language: detectLanguage() };
  try {
    const parsed = JSON.parse(raw);
    const s: Settings = {
      layout: parsed.layout === "win" ? "win" : "mac",
      fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : DEFAULT_SETTINGS.fontSize,
      vibrate: coerceVibrate(parsed.vibrate),
      theme: coerceTheme(parsed.theme),
      language: LANGS.includes(parsed.language) ? parsed.language : detectLanguage(),
      groupTabsByType: parsed.groupTabsByType === true,
    };
    // 只在真有值时挂上，缺省保持 undefined —— 这样 `toEqual(DEFAULT_SETTINGS)`
    // 之类的断言不会被两个可选字段搅乱。
    const bootBg = coerceBootValue(parsed.bootBg);
    if (bootBg) s.bootBg = bootBg;
    const scheme = parsed.scheme === "light" || parsed.scheme === "dark" ? parsed.scheme : undefined;
    if (scheme) s.scheme = scheme;
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS, language: detectLanguage() };
  }
}

export function saveSettings(s: Settings, store: Storage = localStorage): void {
  store.setItem(KEY, JSON.stringify(s));
}
