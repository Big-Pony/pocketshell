// app/src/lib/settings.ts
// Local (per-device) settings persisted to localStorage. These NEVER go
// to the backend — identity keys, agent addresses, keyboard layout,
// font size, and vibration preference are all device-local by design.

const KEY = "ps.settings";

/**
 * Theme ids match the `:root[data-theme="…"]` blocks in app.css one-for-one
 * (plus "system", which resolves to dark/light at apply time). Adding one here
 * means adding a token block there — and mirroring the list into index.html's
 * inline FOUC guard, which cannot import from this module.
 */
export type ThemePref =
  | "dark"        // 石墨橙（默认，深）
  | "light"       // 暖白仪表（浅）
  | "osc"         // 示波青（深）
  | "blackout"    // 纯黑银（深）
  | "prussian"    // 普鲁士蓝（深）
  | "vermilion"   // 朱砂宣纸（浅）
  | "system";
export type Language = "zh" | "en";
export type VibrateLevel = "off" | "light" | "medium" | "strong";

export interface Settings {
  layout: "mac" | "win";
  fontSize: number;
  vibrate: VibrateLevel;
  theme: ThemePref;
  language: Language;
  groupTabsByType: boolean;   // 需求 4：终端 tab 靠左、文件 tab 靠右
}

export const DEFAULT_SETTINGS: Settings = {
  layout: "mac",
  fontSize: 10,
  vibrate: "medium",
  theme: "dark",
  language: "zh",
  groupTabsByType: false,     // 默认关闭，维持现状
};

export const THEMES: ThemePref[] = ["dark", "light", "osc", "blackout", "prussian", "vermilion", "system"];
const LANGS: Language[] = ["zh", "en"];
const VIBES: VibrateLevel[] = ["off", "light", "medium", "strong"];

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
    return {
      layout: parsed.layout === "win" ? "win" : "mac",
      fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : DEFAULT_SETTINGS.fontSize,
      vibrate: coerceVibrate(parsed.vibrate),
      theme: THEMES.includes(parsed.theme) ? parsed.theme : DEFAULT_SETTINGS.theme,
      language: LANGS.includes(parsed.language) ? parsed.language : detectLanguage(),
      groupTabsByType: parsed.groupTabsByType === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS, language: detectLanguage() };
  }
}

export function saveSettings(s: Settings, store: Storage = localStorage): void {
  store.setItem(KEY, JSON.stringify(s));
}
