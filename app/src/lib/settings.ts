// app/src/lib/settings.ts
// Local (per-device) settings persisted to localStorage. These NEVER go
// to the backend — identity keys, agent addresses, keyboard layout,
// font size, and vibration preference are all device-local by design.

const KEY = "ps.settings";

export interface Settings {
  layout: "mac" | "win";
  fontSize: number;
  vibrate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  layout: "mac",
  fontSize: 14,
  vibrate: true,
};

export function loadSettings(store: Storage = localStorage): Settings {
  const raw = store.getItem(KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw);
    return {
      layout: parsed.layout === "win" ? "win" : "mac",
      fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : DEFAULT_SETTINGS.fontSize,
      vibrate: typeof parsed.vibrate === "boolean" ? parsed.vibrate : DEFAULT_SETTINGS.vibrate,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings, store: Storage = localStorage): void {
  store.setItem(KEY, JSON.stringify(s));
}
