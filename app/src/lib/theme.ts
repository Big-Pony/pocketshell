// app/src/lib/theme.ts
// Applies the user's theme preference to <html data-theme="…">. The two
// themes ("dark" = 深色 IDE, "light" = 浅色极简) share one token system in
// app.css; this module only decides which token set is active.

import { loadSettings, type ThemePref } from "./settings";

export type ResolvedTheme = "dark" | "light";

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

/** Set <html data-theme> per preference. Pure DOM side effect, no state. */
export function applyTheme(pref: ThemePref): ResolvedTheme {
  const resolved = resolveTheme(pref, window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = resolved;
  return resolved;
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
