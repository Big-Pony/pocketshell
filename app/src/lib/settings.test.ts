// app/src/lib/settings.test.ts
import { test, expect } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "./settings";

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
  expect(loadSettings(memStore())).toEqual(DEFAULT_SETTINGS);
});

test("saveSettings persists and loadSettings reads back", () => {
  const store = memStore();
  saveSettings({ layout: "win", fontSize: 14, vibrate: false, theme: "light" }, store);
  expect(loadSettings(store)).toEqual({ layout: "win", fontSize: 14, vibrate: false, theme: "light" });
});

test("loadSettings fills missing keys with defaults", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ vibrate: false }));
  const s = loadSettings(store);
  expect(s.vibrate).toBe(false);
  expect(s.layout).toBe("mac"); // default
  expect(s.fontSize).toBe(10);  // default
  expect(s.theme).toBe("dark"); // default
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
