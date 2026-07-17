// app/src/lib/i18n/index.ts
// i18n bootstrap for the app. Dictionaries are statically imported (no async
// loader) so init() can run synchronously before mount — no flash of raw keys.
//
// Locale resolution order:
//   1. persisted `ps.settings.language` (user explicitly switched in Settings)
//   2. browser language (zh* -> zh, everything else -> en), handled by
//      loadSettings()'s detectLanguage() fallback
import { init, addMessages, locale, t } from "svelte-i18n";
import { get } from "svelte/store";
import { loadSettings, type Language } from "../settings";
import zh from "./zh";
import en from "./en";

addMessages("zh", zh);
addMessages("en", en);

// Call once from main.ts before mount. Tests pin zh in vitest-setup.ts instead.
export function setupI18n(): void {
  const lang = loadSettings().language;
  init({ fallbackLocale: "zh", initialLocale: lang });
  applyLanguage(lang);
}

// Switch locale at runtime (Settings panel) + keep <html lang> in sync.
export function applyLanguage(lang: Language): void {
  locale.set(lang);
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
}

// One-shot, non-reactive translate for plain TS (event handlers, lib modules,
// error strings). In templates and $derived prefer the reactive `$t(...)`.
export function tr(key: string, values?: Record<string, unknown>): string {
  return get(t)(key, values ? { values } : undefined);
}
