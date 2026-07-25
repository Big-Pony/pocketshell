// app/src/lib/theme.ts
// Applies the user's theme preference to <html data-theme="…">. All six themes
// share one token system in app.css; this module only decides which token set
// is active. It also writes <html data-scheme="dark|light"> so components can
// key structural (non-colour) overrides off the light/dark class rather than
// one specific theme id — see the rules at the top of app.css.

import { loadSettings, type ThemePref } from "./settings";

/** Every theme except "system", which is a pointer rather than a palette. */
export type ResolvedTheme = Exclude<ThemePref, "system">;

export type Scheme = "dark" | "light";

/**
 * Which themes are light. Everything not listed is dark, so a new dark theme
 * only needs its app.css block; a new *light* theme must be added here or it
 * will inherit dark-only structural overrides.
 */
const LIGHT_THEMES: ReadonlySet<string> = new Set<ResolvedTheme>(["light", "vermilion"]);

export function schemeOf(theme: ResolvedTheme): Scheme {
  return LIGHT_THEMES.has(theme) ? "light" : "dark";
}

/**
 * Swatches for the theme picker, in menu order.
 *
 * These five hex values are the ONLY hardcoded colours allowed outside app.css,
 * and only because the picker has to show what each theme looks like while a
 * different one is active — reading the live tokens would paint all six rows
 * identically. Order matches app.css: 机身 / 面板 / 主色 / 运行灯 / 文字.
 * Keep in sync with the matching --bg/--panel/--accent/--ok/--text tokens.
 */
export interface ThemeSwatch {
  id: ResolvedTheme;
  scheme: Scheme;
  colors: [string, string, string, string, string];
}

export const THEME_SWATCHES: readonly ThemeSwatch[] = [
  { id: "dark",      scheme: "dark",  colors: ["#131416", "#1b1d20", "#ff4d00", "#35d158", "#e4e5e1"] },
  { id: "osc",       scheme: "dark",  colors: ["#0f1417", "#151b1f", "#14cfd6", "#52d96a", "#dde6e9"] },
  { id: "blackout",  scheme: "dark",  colors: ["#000000", "#0b0b0c", "#e9e9e6", "#35d158", "#e9e9e6"] },
  { id: "prussian",  scheme: "dark",  colors: ["#0e131c", "#141a26", "#3d8bfd", "#35d158", "#dfe4ec"] },
  { id: "light",     scheme: "light", colors: ["#f7f6f3", "#ffffff", "#e04000", "#1a9e5c", "#1a1a18"] },
  { id: "vermilion", scheme: "light", colors: ["#f8f5ee", "#fffdf8", "#bf3d14", "#1f8a52", "#211d18"] },
];

/** "system" follows the OS between the two base themes; the rest are literal. */
export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

/** Set <html data-theme> + <html data-scheme>. Pure DOM side effect, no state. */
export function applyTheme(pref: ThemePref): ResolvedTheme {
  const resolved = resolveTheme(pref, window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.scheme = schemeOf(resolved);
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
