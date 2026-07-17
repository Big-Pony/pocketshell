// app/src/lib/settings.test.ts
import { test, expect } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, detectLanguage, type Settings } from "./settings";

function memStore(): Storage {
  const data = new Map<string, string>();
  return {
    getItem(k: string) { return data.get(k) ?? null; },
    setItem(k: string, v: string) { data.set(k, v); },
    removeItem(k: string) { data.delete(k); },
    get length() { return data.size; },
    key(_i: number) { return null; },
    clear() { data.clear(); },
  };
}

test("loadSettings returns defaults when nothing stored", () => {
  // language follows the browser on first run (jsdom is en-US -> en)
  expect(loadSettings(memStore())).toEqual({ ...DEFAULT_SETTINGS, language: detectLanguage() });
});

test("saveSettings persists and loadSettings reads back", () => {
  const store = memStore();
  saveSettings({ layout: "win", fontSize: 14, vibrate: false, theme: "light", language: "en" }, store);
  expect(loadSettings(store)).toEqual({ layout: "win", fontSize: 14, vibrate: false, theme: "light", language: "en" });
});

test("loadSettings fills missing keys with defaults", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ vibrate: false }));
  const s = loadSettings(store);
  expect(s.vibrate).toBe(false);
  expect(s.layout).toBe("mac"); // default
  expect(s.fontSize).toBe(10);  // default
  expect(s.theme).toBe("dark"); // default
  expect(s.language).toBe(detectLanguage()); // missing -> browser detection
});

test("default theme is dark", () => {
  expect(DEFAULT_SETTINGS.theme).toBe("dark");
});

test("loadSettings rejects unknown theme values", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ theme: "neon" }));
  expect(loadSettings(store).theme).toBe("dark");
});

test("loadSettings accepts system theme", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ theme: "system" }));
  expect(loadSettings(store).theme).toBe("system");
});

test("default fontSize is 10", () => {
  expect(DEFAULT_SETTINGS.fontSize).toBe(10);
});

test("loadSettings falls back to 10 when stored fontSize is not a number", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ fontSize: "big" }));
  expect(loadSettings(store).fontSize).toBe(10);
});

test("loadSettings keeps a valid stored language", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ language: "zh" }));
  expect(loadSettings(store).language).toBe("zh");
});

test("loadSettings rejects unknown language values and re-detects", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ language: "fr" }));
  expect(loadSettings(store).language).toBe(detectLanguage());
});

test("detectLanguage follows navigator.language (zh* -> zh, else en)", () => {
  const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, "language");
  const set = (v: string) => Object.defineProperty(Navigator.prototype, "language", { value: v, configurable: true });
  try {
    set("zh-CN");
    expect(detectLanguage()).toBe("zh");
    set("zh-TW");
    expect(detectLanguage()).toBe("zh");
    set("en-US");
    expect(detectLanguage()).toBe("en");
    set("fr-FR");
    expect(detectLanguage()).toBe("en");
  } finally {
    if (desc) Object.defineProperty(Navigator.prototype, "language", desc);
  }
});
