// agent/src/theme-derive.ts
// A Ghostty theme file gives 22 colours; the UI needs 93. This module is the one
// place that bridges the gap, and it is deliberately the *only* implementation:
// it is called at build time to generate the seven built-in themes into
// `app/src/theme-tokens.css`, and at run time by the agent to serve whatever the
// user dropped into `<keyDir>/themes/`. Two implementations would not fail to
// compile when they drifted — the same file would just render different colours
// depending on which path it came in through, silently.
//
// The gap is smaller than 22 → 93 suggests. Only about a dozen decisions are
// real: four elevation layers (one OKLCH rule), three text levels (one
// interpolation rule), six semantic colours mapped straight off the ANSI palette,
// and the accent pair. The rest are aliases, fixed-alpha variants and geometry
// strings that fall out once those are fixed.
//
// Pure throughout: no clock, no randomness, no I/O. Callers pass text in and get
// a token record out, which is what lets the generated CSS be committed and
// diffed in review.
import {
  hex2oklch, oklch2hex, contrast, relLuminance, towards, ensureContrast,
  minChroma, alpha,
} from "./color-oklch";

export interface ParsedTheme {
  /** Source file name, used only to make errors locatable. */
  name?: string;
  background: string;
  foreground: string;
  cursorColor?: string;
  cursorText?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  /** ANSI 0-15, always exactly 16 entries after a successful parse. */
  palette: string[];
  /** From the `# ps-accent = <hex>` directive. Built-in themes name their own
   *  identity colour; imported ones fall back to the heuristic. */
  psAccent?: string;
}

export type Tokens = Record<string, string>;

const HEX = /^#?([0-9a-fA-F]{6})$/;
const norm = (v: string): string | null => {
  const m = HEX.exec(v.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
};

/** Colour keys a theme file may set, mapped to the field they land in. */
const COLOUR_KEYS: Record<string, keyof ParsedTheme> = {
  background: "background",
  foreground: "foreground",
  "cursor-color": "cursorColor",
  "cursor-text": "cursorText",
  "selection-background": "selectionBackground",
  "selection-foreground": "selectionForeground",
};

/**
 * Parse a Ghostty theme file.
 *
 * Lenient about everything that is not a colour: real theme files carry window
 * padding, font chains, `cursor-invert-fg-bg` and palette entries past 15, none
 * of which this project has anything to say about. Refusing to load a theme over
 * a key we simply do not use would be hostile.
 *
 * Strict about the four things that make a file a theme at all: a background, a
 * foreground, sixteen ANSI colours, and well-formed hex. Those throw, and the
 * message names the file so the agent can tell the user *which* of their themes
 * is broken.
 */
export function parseGhostty(text: string, name?: string): ParsedTheme {
  const where = name ? `${name}: ` : "";
  const out: Partial<ParsedTheme> = { name };
  const palette: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      // Comments are also where our own directives live — Ghostty ignores them,
      // so a file carrying `ps-accent` still loads in Ghostty itself.
      const m = /^#\s*ps-accent\s*=\s*(\S+)/i.exec(line);
      if (m) {
        const hex = norm(m[1]);
        // A malformed directive is not fatal: it is a comment, and the heuristic
        // covers for it.
        if (hex) out.psAccent = hex;
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (key === "palette") {
      const m = /^(\d+)\s*=\s*(\S+)$/.exec(value);
      if (!m) throw new Error(`${where}malformed palette entry: ${line}`);
      const idx = Number(m[1]);
      if (idx > 15) continue; // extended 256-colour slots: recognised, unused
      const hex = norm(m[2]);
      if (!hex) throw new Error(`${where}malformed colour in palette ${idx}: ${m[2]}`);
      palette[idx] = hex;
      continue;
    }

    const field = COLOUR_KEYS[key];
    if (!field) continue; // window-padding-x, font-family, …
    const hex = norm(value);
    if (!hex) throw new Error(`${where}malformed colour for ${key}: ${value}`);
    (out as Record<string, string>)[field] = hex;
  }

  if (!out.background) throw new Error(`${where}missing "background"`);
  if (!out.foreground) throw new Error(`${where}missing "foreground"`);
  const missing = Array.from({ length: 16 }, (_, i) => i).filter((i) => !palette[i]);
  if (missing.length) {
    throw new Error(`${where}incomplete palette, missing ${missing.length} of 16 (indices ${missing.join(", ")})`);
  }

  return { ...(out as ParsedTheme), palette: palette.slice(0, 16) };
}

// ---------------------------------------------------------------- derivation

/** Above this relative luminance the scheme is treated as light: elevation
 *  darkens instead of brightening, and the contrast search runs downhill. */
export const isLightBackground = (hex: string): boolean => relLuminance(hex) > 0.4;

/**
 * The elevation ladder. `step` 1..3 moves away from the background (brighter on
 * dark schemes, darker on light ones); -1 recesses.
 *
 * The absolute floor is what makes OLED themes work. On `#000000` the relative
 * term alone produces three more blacks — the prototype's first version did
 * exactly that and every panel edge vanished. Taking whichever of the two terms
 * lands *further* from the background keeps the layers apart near the ends of the
 * range without exaggerating them in the middle.
 *
 * The floor's *offset* (0.10) matters as much as its step. A pure `0.05 × step`
 * ladder is separable in the sense that no two rungs are equal, but on a real
 * OLED panel `#010101` against `#000000` is not a visible edge — the structure
 * then rests entirely on `--line`, and cards stop reading as cards. The hand-
 * tuned 纯黑银 theme this system replaces sat at L 0.150 / 0.209 / 0.255; the
 * offset reproduces that (0.150 / 0.200 / 0.250) rather than inventing a new
 * look for a case someone had already solved by eye.
 *
 * Themes whose background is merely dark rather than black are unaffected: the
 * relative term already exceeds the floor by step 1 (Tokyo Night's `#1a1b26`
 * sits at L 0.213, above the 0.150 rung), so only true-black palettes take it.
 *
 * The floor applies only to whole raised steps. `step = -1` recesses `--bg-deep`
 * and `step = 0.5` sits a key cap just off the body: feeding either through an
 * offset ladder would *raise* them (a 0.05 rung is above pure black), inverting
 * the one thing the caller asked for. Those keep the relative term alone, which
 * on pure black correctly collapses to black — `--bg-deep === --bg` is the
 * honest answer there, and the old hand-tuned theme said the same.
 */
function layer(bg: string, step: number, light: boolean): string {
  const c = hex2oklch(bg);
  const dir = light ? -1 : 1;
  const relative = c.L + dir * 0.035 * step;
  if (step < 1) return oklch2hex({ ...c, L: Math.min(1, Math.max(0, relative)) });
  // The 0.10 offset is a *dark-side* fix: it exists because pure black has no
  // room below it, and a floor of 0.05×step lands the first panel on #010101.
  // The light side has no matching problem — a near-white background sits at
  // L≈0.96 and the relative term never reaches down to the ceiling — so adding
  // the offset there would not rescue anything, it would just clamp every light
  // panel darker (cream-light's panel went #e9e7dd → #d0cec4 when this was
  // symmetric). Keep the ceiling where it was.
  const absolute = light ? 1 - 0.055 * step : 0.1 + 0.05 * step;
  const L = light ? Math.min(relative, absolute) : Math.max(relative, absolute);
  return oklch2hex({ ...c, L: Math.min(1, Math.max(0, L)) });
}

/**
 * A surface that reads as "`color`, faded into the background": takes the
 * background's lightness and a trace of the colour's chroma, but keeps the
 * colour's hue outright.
 *
 * Not the same as `towards()`, and the difference matters. Plain interpolation
 * blends the hue too, so on a warm-cream background the disconnect banner's
 * red-tinted backdrop drifted 60° into yellow — it was still "a fade towards the
 * background" arithmetically, and no longer red to look at. `--red-dark` and
 * `--teal-dark` are named after their hue; that is the part that must survive.
 */
function tint(color: string, bg: string, t: number): string {
  const c = hex2oklch(color), b = hex2oklch(bg);
  return oklch2hex({ L: c.L + (b.L - c.L) * t, C: c.C + (b.C - c.C) * t, h: c.h });
}

/** An OKLCH hue range, in degrees. `from` may exceed `to`, meaning the band
 *  wraps past 360 — reds straddle the origin. */
export interface HueBand { from: number; to: number }

/**
 * Hue ranges a status colour must fall inside to still convey its meaning.
 *
 * Calibrated from the seven shipped palettes rather than picked a priori. The
 * six internally-coherent ones cluster tightly — greens at 111-143°, reds at
 * 1-30°, yellows at 70-86° — and the bands are those clusters widened to the
 * nearest perceptual landmark on each side:
 *
 *  - `ok` 100-190°: yellow-green through green (pure green 142°) to just short
 *    of teal (#008080 is 195°, excluded — a teal "running" light reads as an
 *    accent colour, not a state). The floor has to sit below 111° to admit
 *    gruvbox's olive `#b8bb26`, which is genuinely that theme's green.
 *  - `red` 330-40°: magenta-leaning red (mocha's `#f7aec2` at 1°) through pure
 *    red (29°) to coral (`#ff7f50` at 40°). The ceiling must clear 30.4° —
 *    gruvbox's `#fb4934` sits there and is unmistakably a red.
 *  - `amber` 50-95°: orange (`#ffa500` at 71°) through amber (`#ffbf00` at 84°)
 *    to gold (95°).
 *
 * The bands are disjoint, so no hue can satisfy two meanings at once. The gaps
 * between them (40-50°, 95-100°, 190-330°) are hues no status colour should be:
 * anything landing there gets substituted.
 *
 * These are a guard against gross misuse — a teal in the red slot — not a fine
 * discriminator. Yellow-green sits genuinely on the `ok`/`amber` seam (pure
 * yellow is 110°, one degree off gruvbox's green), and no threshold can separate
 * those two by hue alone. Erring towards accepting the palette's own choice is
 * the right bias: the failure mode of a slightly-off amber is cosmetic, while the
 * failure mode of an uncorrected teal "danger" is a broken interface.
 */
export const HUE_BANDS: Record<"ok" | "red" | "amber", HueBand> = {
  ok: { from: 100, to: 190 },
  red: { from: 330, to: 40 },
  amber: { from: 50, to: 95 },
};

/** Is `h` inside `band`, accounting for bands that wrap past 360? */
export function inHueBand(h: number, band: HueBand): boolean {
  const x = ((h % 360) + 360) % 360;
  return band.from <= band.to
    ? x >= band.from && x <= band.to
    : x >= band.from || x <= band.to;
}

/**
 * Last-resort status colours, used only when a palette contains nothing in the
 * required hue band. These are PocketShell's own long-standing semantic colours,
 * so a theme that needs rescuing falls back to something the product already
 * looks like rather than to an arbitrary primary. Their hues (147/27/79) sit in
 * the middle of their bands.
 */
const FALLBACK_STATUS: Record<"ok" | "red" | "amber", string> = {
  ok: "#35d158",
  red: "#e5564d",
  amber: "#e8b04b",
};

/**
 * Keep a status colour's hue consistent with the meaning of its slot.
 *
 * The palette is trusted by default — a theme's own red is what makes its
 * disconnect banner look like that theme. But the ANSI slot names are a
 * convention, not a guarantee, and some palettes ignore them: Black Metal (the
 * `blackout` theme) fills slot 9 with a teal and slot 10 with a pink. Mapping
 * those faithfully produced a teal disconnect banner, a teal delete-confirm
 * button and a pink "running" light — the colours were authentic to the theme
 * and useless as status.
 *
 * So: accept the slot colour when its hue agrees with the slot's meaning;
 * otherwise look for a substitute elsewhere in the *same* palette (keeping the
 * theme's own character where possible), preferring whichever reads best against
 * the surface it will sit on; and only if the palette offers nothing in band,
 * fall back to a fixed colour.
 *
 * This runs for every theme rather than as a `blackout` special case — the same
 * rule is what protects a user importing an arbitrary Ghostty theme. Themes whose
 * palettes already agree with their slots come through untouched, byte-for-byte.
 */
function correctHue(
  slot: string, kind: "ok" | "red" | "amber", palette: string[], surface: string,
): string {
  const band = HUE_BANDS[kind];
  if (inHueBand(hex2oklch(slot).h, band)) return slot;

  const candidates = palette.filter((c) => {
    const o = hex2oklch(c);
    return o.C >= 0.05 && inHueBand(o.h, band);
  });
  if (!candidates.length) return FALLBACK_STATUS[kind];
  // Among in-band candidates, the one that will actually be legible wins: a
  // palette often carries both a dark and a bright variant of the same hue.
  return candidates.reduce((best, c) =>
    contrast(c, surface) > contrast(best, surface) ? c : best);
}

/**
 * ANSI slot names, in palette order. These are xterm's `ITheme` keys, which is
 * the point: `--term-ansi-<name>` maps onto `theme.<camelCase(name)>` with no
 * lookup table on the app side, and the name is what a person reading the CSS
 * expects (`--term-ansi-bright-green`, not `--term-ansi-10`).
 */
export const ANSI_NAMES: readonly string[] = Object.freeze([
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright-black", "bright-red", "bright-green", "bright-yellow",
  "bright-blue", "bright-magenta", "bright-cyan", "bright-white",
]);

/**
 * The palette, verbatim, as sixteen tokens.
 *
 * Deliberately untouched by the hue and contrast filters that the *semantic*
 * colours (`--ok`, `--red`, `--amber`) go through. Those tokens answer "which
 * colour means running" and must survive a palette that fills slot 10 with
 * pink; these answer "what does this program's `\e[32m` look like", where the
 * only correct answer is whatever the theme author wrote. Correcting them would
 * make the terminal disagree with the same theme running in Ghostty itself.
 */
function ansiTokens(palette: string[]): Tokens {
  const out: Tokens = {};
  ANSI_NAMES.forEach((name, i) => { out[`--term-ansi-${name}`] = palette[i]; });
  return out;
}

/** Is this hue in the warm half of the circle? Used to keep a heuristic accent
 *  in the same temperature family as the background. */
const isWarm = (h: number): boolean => h < 110 || h > 330;

/**
 * Pick an accent when the file did not name one.
 *
 * Three heuristics were prototyped against the seven palettes and all three
 * missed on at least one theme, which is why built-ins carry `ps-accent`
 * explicitly. This is strategy C, the least-bad of them: prefer the cursor
 * colour if the author actually chose one, otherwise the most chromatic palette
 * entry sharing the background's temperature. Warm backgrounds dominate, and
 * picking "furthest hue from the background" instead sent five of seven themes
 * to the same purple.
 */
function heuristicAccent(p: ParsedTheme): string {
  const { background: bg, foreground: fg, palette } = p;
  const usable = (x?: string): x is string => {
    if (!x) return false;
    return hex2oklch(x).C >= 0.05 && contrast(x, fg) >= 1.25 && contrast(x, bg) >= 2.2;
  };
  // Six of the seven sample themes set cursor-color equal or near-equal to the
  // foreground, so it only counts when the author clearly meant it as an accent.
  if (usable(p.cursorColor)) return p.cursorColor;

  const candidates = [3, 4, 5, 6, 11, 12, 13, 14].map((i) => palette[i]).filter(usable);
  if (!candidates.length) return fg;
  const warmBg = isWarm(hex2oklch(bg).h);
  const sameTemp = candidates.filter((x) => isWarm(hex2oklch(x).h) === warmBg);
  const pool = sameTemp.length ? sameTemp : candidates;
  return pool.reduce((best, x) => (hex2oklch(x).C > hex2oklch(best).C ? x : best));
}

/**
 * The accent and the text that sits on top of it, as a pair — they can only be
 * judged together. Start from whichever of black/white the accent already
 * favours; if the pair is short of 4.5, move the accent's lightness (not the
 * text's, and not its hue or chroma) until it clears.
 *
 * A theme whose accent already passes comes through untouched, which is the
 * whole point: tokyonight's blue is byte-identical before and after.
 */
function accentPair(accent: string): { accent: string; on: string } {
  let on = contrast(accent, "#ffffff") >= contrast(accent, "#000000") ? "#ffffff" : "#000000";
  if (contrast(accent, on) >= 4.5) return { accent, on };

  const c = hex2oklch(accent);
  const dir = on === "#ffffff" ? -1 : 1; // white text → darken the accent
  let best = accent;
  let bestRatio = contrast(accent, on);
  for (let i = 1; i <= 40; i++) {
    const L = Math.min(1, Math.max(0, c.L + dir * 0.02 * i));
    const cand = oklch2hex({ ...c, L });
    const ratio = contrast(cand, on);
    if (ratio > bestRatio) { best = cand; bestRatio = ratio; }
    if (ratio >= 4.5) return { accent: cand, on };
    if (L <= 0 || L >= 1) break;
  }
  // This hue cannot reach 4.5 in that direction; the other text colour may do
  // better on the best candidate we found.
  const alt = on === "#ffffff" ? "#000000" : "#ffffff";
  if (contrast(best, alt) > bestRatio) on = alt;
  return { accent: best, on };
}

/**
 * Expand a parsed palette into the full UI token set.
 *
 * Token *names* are fixed by `app/src/app.css` and must not change — components
 * reference the semantic names, which is what makes a new theme a zero-component
 * change. `theme-derive.test.ts` reads app.css and fails if the two sets drift.
 */
export function derive(p: ParsedTheme): Tokens {
  const bg = p.background;
  const fg = p.foreground;
  const light = isLightBackground(bg);
  const pal = p.palette;

  const bgDeep = layer(bg, -1, light);
  const panel = layer(bg, 1, light);
  const panel2 = layer(bg, 2, light);
  const elev = layer(bg, 3, light);

  // Interpolating the foreground towards the background adapts to either scheme
  // on its own — no light/dark branch needed — and the contrast floor then pulls
  // back whatever went too far.
  const dim = ensureContrast(towards(fg, bg, 0.38), bg, 4.5);
  // 3.0 rather than 4.5: --dimmer is for separators and inactive tabs, decoration
  // rather than information. The hand-written themes it replaces sat at 2.64–3.07,
  // so this tightens the floor rather than relaxing it.
  const dimmer = ensureContrast(towards(fg, bg, 0.58), bg, 3.0);

  const { accent, on: onAccent } = accentPair(p.psAccent ?? heuristicAccent(p));
  const accentText = ensureContrast(accent, bg, 4.5);

  // Status colours come off the bright half of the ANSI palette — those slots
  // exist to be noticed. Three filters run in order, each a no-op when the
  // palette is already sane: hue correction (does this colour still mean what the
  // slot says?), then a chroma floor (Nord's grey-green has to read as a running
  // light, not an off one), then the contrast floor against the surface it sits on.
  // Hue first, because rescuing a colour and then failing to make it legible would
  // just trade one broken token for another.
  const status = (kind: "ok" | "red" | "amber", bright: number, normal: number, floor: number) =>
    ensureContrast(minChroma(correctHue(pal[bright] ?? pal[normal], kind, pal, panel), floor), panel, 4.5);
  const ok = status("ok", 10, 2, 0.09);
  const red = status("red", 9, 1, 0.10);
  const amber = status("amber", 11, 3, 0.10);
  const cyan = ensureContrast(pal[14] ?? pal[6], panel, 4.5);
  const blue = ensureContrast(pal[12] ?? pal[4], panel, 4.5);

  const selection = p.selectionBackground ?? accent;
  // Not every theme file sets selection-foreground. Falling back to whichever
  // of the background/foreground reads better on the selection keeps the pair
  // legible without inventing a colour that is not in the theme.
  const selectionText = p.selectionForeground
    ?? (contrast(fg, selection) >= contrast(bg, selection) ? fg : bg);

  // Syntax colours map straight onto the palette, so the editor and the terminal
  // agree by construction and there is no second colour scheme to maintain.
  const codeBg = panel;
  const syntax = (hex: string, target = 4.5) => ensureContrast(hex, codeBg, target);

  // Scrims are always dark, on both schemes — a light overlay over a light UI
  // reads as fog, not as "the thing behind is disabled". Only the opacity differs.
  const scrim = oklch2hex({ ...hex2oklch(bg), L: 0.08 });

  const onDanger = contrast(red, "#ffffff") >= contrast(red, "#000000") ? "#ffffff" : "#000000";

  return {
    // ---- surfaces
    "--bg": bg,
    "--bg-deep": bgDeep,
    "--panel": panel,
    "--panel2": panel2,
    "--elev": elev,
    "--elev2": elev,
    "--line": alpha(fg, light ? 0.14 : 0.09),
    "--line-soft": alpha(fg, light ? 0.09 : 0.05),
    "--line-strong": alpha(fg, light ? 0.24 : 0.16),

    // ---- text
    "--text": fg,
    "--dim": dim,
    "--dimmer": dimmer,

    // A whisper of the accent across the top of the shell so the body is not
    // dead flat. Light schemes get none: any tint over near-white reads as dirt.
    "--shell-glow": light ? "transparent" : alpha(accent, 0.04),

    // ---- accent
    "--accent": accent,
    "--accent-soft": alpha(accent, light ? 0.09 : 0.12),
    "--accent-text": accentText,
    "--on-accent": onAccent,
    "--primary-bg": "var(--accent)",
    "--primary-text": "var(--on-accent)",

    // ---- status
    "--ok": ok,
    "--amber": amber,
    "--red": red,
    "--cyan": cyan,
    "--blue": blue,
    "--ok-soft": alpha(ok, 0.11),
    "--ok-line": alpha(ok, 0.26),
    "--amber-soft": alpha(amber, 0.12),
    "--red-soft": alpha(red, 0.12),
    "--on-danger": onDanger,
    "--red-dark": tint(red, bg, 0.85),
    "--banner-line": tint(red, bg, 0.7),
    "--teal": "var(--ok)",
    "--teal-dark": tint(ok, bg, 0.85),

    // ---- terminal. Follows the scheme now: the ANSI 16 are token-driven from
    // this same palette, so a light theme's terminal uses the light palette its
    // author designed, not xterm's built-in dark-background defaults.
    //
    // The cursor stays the UI accent rather than the file's `cursor-color`.
    // Design §2.3 measured it: six of the seven palettes set cursor-color equal
    // or near-equal to the foreground, so mapping it faithfully would trade a
    // recognisable accent-coloured caret for a near-white one in almost every
    // theme. `--term-cursor-text` is therefore `--on-accent`, which is the
    // colour the accent pair already guarantees 4.5:1 against — the glyph under
    // a block cursor has to be legible on the cursor, not on the file's caret.
    "--term-bg": bg,
    "--term-text": fg,
    "--term-dim": dimmer,
    "--term-accent": "var(--accent)",
    "--term-cursor-text": "var(--on-accent)",
    // Selection is the author's own pair, opaque, because both halves are used:
    // xterm paints selectionForeground over selectionBackground, and the file
    // was designed with exactly that pairing (4.75–12.95:1 across the seven).
    // A translucent background here would blend towards the terminal bg and
    // leave the designed foreground floating on something it was never checked
    // against. ensureContrast is a no-op for all seven; it guards imports.
    "--term-selection": selection,
    "--term-sel-text": ensureContrast(selectionText, selection, 4.5),
    // ANSI 0-15, verbatim from the palette. Not contrast-corrected on purpose:
    // `ls --color` and a prompt's git branch have to look like the theme the
    // user chose, and every terminal in existence renders ANSI black as the
    // palette's black even when that is nearly the background.
    ...ansiTokens(pal),

    // ---- code preview / editor
    "--code-bg": codeBg,
    "--code-fg": fg,
    "--code-gutter": syntax(dimmer, 3.0),
    "--code-active-line": alpha(fg, light ? 0.05 : 0.04),
    "--code-selection": alpha(selection, 0.26),
    "--code-cursor": accent,
    "--code-keyword": syntax(pal[5]),
    "--code-string": syntax(pal[2]),
    "--code-comment": syntax(pal[8], 3.0), // comments stay quiet on purpose
    "--code-number": syntax(pal[3]),
    "--code-func": syntax(pal[12]),
    "--code-type": syntax(pal[11]),
    "--code-attr": syntax(pal[6]),

    // ---- keyboard
    "--key": panel2,
    "--key-bg-image": "none",
    "--keyhi": elev,
    "--key-line": alpha("#000000", light ? 0.12 : 0.4),
    "--key-text": "var(--text)",
    "--key-shadow": `0 1.5px 0 ${alpha("#000000", light ? 0.08 : 0.42)}`,
    "--key-inset": light ? "none" : `inset 0 1px 0 ${alpha(fg, 0.05)}`,
    "--key-mod-bg": layer(bg, 0.5, light),
    "--key-enter-bg": `linear-gradient(180deg, ${oklch2hex({ ...hex2oklch(accent), L: Math.min(1, hex2oklch(accent).L + 0.04) })}, ${oklch2hex({ ...hex2oklch(accent), L: Math.max(0, hex2oklch(accent).L - 0.04) })})`,
    "--key-enter-text": onAccent,
    "--key-enter-line": alpha(accent, 0.5),
    "--key-enter-shadow": `0 2px 0 ${oklch2hex({ ...hex2oklch(accent), L: Math.max(0, hex2oklch(accent).L - 0.22) })}`,

    // ---- segmented control
    "--seg-bg": "var(--bg)",
    "--seg-line": "var(--line)",
    "--seg-active-bg": "var(--elev2)",
    "--seg-active-text": "var(--text)",
    "--seg-active-ring": "inset 0 0 0 1px var(--line-strong)",
    "--seg-shadow": light ? `0 1px 2px ${alpha("#000000", 0.08)}` : "none",

    // ---- session tabs
    "--tab-bg": "transparent",
    "--tab-line": "var(--line-strong)",
    "--tab-idx-bg": "var(--panel)",
    "--tab-idx-line": "var(--line-strong)",
    "--tab-idx-top": "var(--accent)",
    "--tab-active-bg": "var(--tab-idx-bg)",
    "--tab-active-text": "var(--text)",
    "--tab-active-line": "var(--tab-idx-line)",

    // ---- status bar
    "--bar-bg": "var(--bg)",
    "--bar-text": "var(--dimmer)",
    "--bar-grip": "var(--elev2)",

    // ---- brand
    "--brand-sig": "var(--accent)",

    // ---- bottom bar
    "--bb-bg": "var(--bg)",
    "--bb-line": "var(--line)",
    "--bb-active": "var(--accent)",
    "--bb-indicator": "var(--accent)",

    // ---- overlays
    "--overlay-bg": alpha(scrim, light ? 0.35 : 0.72),
    "--dlg-bg": panel2,
    "--menu-bg": panel2,
    "--pop-shadow": `0 8px 24px ${alpha("#000000", light ? 0.14 : 0.5)}`,
    "--toast-bg": elev,
    "--toast-text": "var(--text)",

    // ---- disconnect banner
    "--banner-bg": "var(--red-dark)",
    "--banner-text": "var(--amber)",
  };
}

/**
 * Every token `derive` produces, in output order. Declared once and used by both
 * the renderer and the app.css cross-check so the two cannot disagree about what
 * "the token set" means.
 */
export const TOKEN_NAMES: readonly string[] = Object.freeze(
  Object.keys(derive({
    background: "#000000",
    foreground: "#ffffff",
    palette: Array.from({ length: 16 }, () => "#808080"),
  })),
);

/**
 * Strip anything that could escape the declaration it is about to be written
 * into. Theme files are user-supplied text; without this, a value containing
 * `; } … {` would let a hand-edited `.ghostty` inject arbitrary rules into the
 * page. Truncating at the first offending character (rather than deleting it)
 * means the injected tail cannot reappear as a valid value.
 */
function safeValue(v: string): string {
  const cut = v.search(/[;{}\n\r]|\/\*|\*\//);
  return (cut < 0 ? v : v.slice(0, cut)).trim();
}

/** Render a token record as one CSS rule. The selector is the caller's: built-in
 *  themes use `:root[data-theme="id"]`, imported ones `:root[data-theme="custom:id"]`,
 *  and the default theme plain `:root` so the first frame has values before any
 *  attribute is set. */
export function renderCss(tokens: Tokens, selector: string): string {
  const lines: string[] = [];
  for (const [name, raw] of Object.entries(tokens)) {
    const value = safeValue(raw);
    if (!value) continue;
    lines.push(`  ${name}: ${value};`);
  }
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}
