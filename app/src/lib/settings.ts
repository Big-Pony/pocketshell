// app/src/lib/settings.ts
// Local (per-device) settings persisted to localStorage. These NEVER go
// to the backend — identity keys, agent addresses, keyboard layout,
// font size, and vibration preference are all device-local by design.

import { CUSTOM_PREFIX, isSafeThemeId } from "./theme-css";
import type { FontId } from "./font";
import type { KbLayoutId } from "./term/keymap";
import type { PreviewWidthId } from "./ui/preview-width";
import { PREVIEW_WIDTHS } from "./ui/preview-width";

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
  /**
   * 全键盘的键位布局。与 `layout`（Mac/Win 键帽标注）是两回事：
   * 那个只换 Cmd/Win 的字，这个换整套键位与键的大小。
   *   classic —— 完整笔记本布局，14 键一行（24×34px），默认
   *   layered —— 10 键一行（36×46px），数字符号在第二层
   *   flick   —— 10 键一行，按住上滑取符号
   */
  kbLayout: KbLayoutId;
  fontSize: number;
  /**
   * 首屏/重灌历史拉多少行。手机屏一次只显示二十几行，而整份 2000 行 scrollback
   * 带 SGR 是 134KB、base64 后 179KB，实测真机上要七秒（服务端只占其中 0.3%，
   * 全花在链路上传）。往上翻超出范围就是到顶，不做分页续拉。
   */
  historyLines: number;
  vibrate: VibrateLevel;
  theme: ThemePref;
  language: Language;
  groupTabsByType: boolean;   // 需求 4：终端 tab 靠左、文件 tab 靠右
  /** 等宽字体 id。与 fonts.css 的 `:root[data-font="…"]` 一一对应。 */
  fontFamily: FontId;
  /**
   * HTML 预览的渲染宽度档位（14 期需求 1）。默认 phone——日常预览的多半是
   * 自己写的移动端页面；桌面档是给"看桌面站长什么样"用的。
   */
  htmlPreviewWidth: PreviewWidthId;
  /**
   * 首帧用的缓存值，由 `applyTheme()` 写入，**只被 index.html / demo.html 的内联
   * 防闪烁脚本读**（那段脚本跑在任何 CSS 之前，没法自己算出当前主题的颜色）。
   * 缺失时脚本用硬编码的默认主题兜底，所以它们是可选的、坏了也只是闪一下。
   */
  bootBg?: string;            // 当前主题的 --bg-deep 字面值
  scheme?: string;            // 当前主题的明暗（"dark" | "light"）
  /** 当前字体 Regular 权重的 woff2 路径，由 `applyFont()` 写入，只被
   *  index.html / demo.html 的内联脚本读，用来插 `<link rel=preload>`。 */
  bootFontUrl?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  layout: "mac",
  kbLayout: "classic",
  fontSize: 10,
  historyLines: 1000,
  vibrate: "medium",
  theme: "cream-dark",
  language: "zh",
  groupTabsByType: false,     // 默认关闭，维持现状
  fontFamily: "maple-mono",
  htmlPreviewWidth: "phone",
};

/**
 * 历史加载行数的档位。给固定档位而不是自由输入 —— 避免用户填个 50000 把自己
 * 卡死（那正是这次要修的病）。设置面板与下面的校验共用这一份，避免两处漂移。
 *
 * 上限 2000：与 tmux history-limit（实测环境全局默认 2000）和 xterm 的
 * scrollback: 2000 对齐，拉更多也没有内容。
 */
export const HISTORY_LINE_CHOICES = [200, 500, 1000, 2000] as const;

function coerceHistoryLines(v: unknown): number {
  return (HISTORY_LINE_CHOICES as readonly number[]).includes(v as number)
    ? (v as number)
    : DEFAULT_SETTINGS.historyLines;
}

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

/**
 * 字体白名单。id 会被拼进 CSS 选择器 `[data-font="…"]`，脏值只会静默失配
 * （不报错，字体就是不生效）——与主题 id 同样的理由，必须在入口挡掉。
 *
 * 清单在这里重复了一份（真相是 lib/font.ts 的 FONTS），是为了不让 settings.ts
 * 运行时依赖 font.ts —— font.ts 已经依赖 settings.ts，反向引会成环。
 * `font.test.ts` 有一条用例锁住两边一致。
 */
const FONT_IDS = [
  "maple-mono", "jetbrains-mono", "google-sans-code", "monaspace-neon", "ubuntu-mono",
];

function coerceFont(v: unknown): FontId {
  return typeof v === "string" && FONT_IDS.includes(v)
    ? (v as FontId)
    : DEFAULT_SETTINGS.fontFamily;
}

/** 菜单序。默认排第一。 */
export const KB_LAYOUTS: KbLayoutId[] = ["classic", "layered", "flick"];

function coerceKbLayout(v: unknown): KbLayoutId {
  return typeof v === "string" && (KB_LAYOUTS as string[]).includes(v)
    ? (v as KbLayoutId)
    : DEFAULT_SETTINGS.kbLayout;
}

function coercePreviewWidth(v: unknown): PreviewWidthId {
  return typeof v === "string" && PREVIEW_WIDTHS.some((w) => w.id === v)
    ? (v as PreviewWidthId)
    : DEFAULT_SETTINGS.htmlPreviewWidth;
}

/** 首帧缓存值是要直接写进 DOM 的，只收干净的短字符串。
 *  上限 64：最长的字体 URL 是 /fonts/google-sans-code-regular.woff2（36 字符），
 *  32 装不下。 */
function coerceBootValue(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 && s.length <= 64 && /^[#a-zA-Z0-9(),.%\s/_-]+$/.test(s) ? s : undefined;
}

/** bootFontUrl 会被内联脚本直接写进 <link href>。只放行本地字体路径——
 *  宽松字符集能过 `//evil.com/x.woff2`（协议相对 URL 不需要冒号），
 *  那会在首帧发一个跨域请求。 */
function coerceBootFontUrl(v: unknown): string | undefined {
  return typeof v === "string" && /^\/fonts\/[\w.-]+\.woff2$/.test(v) ? v : undefined;
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
      historyLines: coerceHistoryLines(parsed.historyLines),
      vibrate: coerceVibrate(parsed.vibrate),
      theme: coerceTheme(parsed.theme),
      language: LANGS.includes(parsed.language) ? parsed.language : detectLanguage(),
      groupTabsByType: parsed.groupTabsByType === true,
      fontFamily: coerceFont(parsed.fontFamily),
      kbLayout: coerceKbLayout(parsed.kbLayout),
      htmlPreviewWidth: coercePreviewWidth(parsed.htmlPreviewWidth),
    };
    // 只在真有值时挂上，缺省保持 undefined —— 这样 `toEqual(DEFAULT_SETTINGS)`
    // 之类的断言不会被两个可选字段搅乱。
    const bootBg = coerceBootValue(parsed.bootBg);
    if (bootBg) s.bootBg = bootBg;
    const scheme = parsed.scheme === "light" || parsed.scheme === "dark" ? parsed.scheme : undefined;
    if (scheme) s.scheme = scheme;
    const bootFontUrl = coerceBootFontUrl(parsed.bootFontUrl);
    if (bootFontUrl) s.bootFontUrl = bootFontUrl;
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS, language: detectLanguage() };
  }
}

export function saveSettings(s: Settings, store: Storage = localStorage): void {
  store.setItem(KEY, JSON.stringify(s));
}
