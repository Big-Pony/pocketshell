// app/src/lib/settings.ts
// Local (per-device) settings persisted to localStorage. These NEVER go
// to the backend — identity keys, agent addresses, keyboard layout,
// font size, and vibration preference are all device-local by design.

const KEY = "ps.settings";

export type ThemePref = "dark" | "light" | "system";
export type Language = "zh" | "en";

export interface Settings {
  layout: "mac" | "win";
  fontSize: number;
  vibrate: boolean;
  theme: ThemePref;
  language: Language;
}

export const DEFAULT_SETTINGS: Settings = {
  layout: "mac",
  fontSize: 10,
  vibrate: true,
  theme: "dark",
  language: "zh",
};

const THEMES: ThemePref[] = ["dark", "light", "system"];
const LANGS: Language[] = ["zh", "en"];

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
      vibrate: typeof parsed.vibrate === "boolean" ? parsed.vibrate : DEFAULT_SETTINGS.vibrate,
      theme: THEMES.includes(parsed.theme) ? parsed.theme : DEFAULT_SETTINGS.theme,
      language: LANGS.includes(parsed.language) ? parsed.language : detectLanguage(),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, language: detectLanguage() };
  }
}

export function saveSettings(s: Settings, store: Storage = localStorage): void {
  store.setItem(KEY, JSON.stringify(s));
}
