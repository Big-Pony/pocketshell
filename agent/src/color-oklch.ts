// agent/src/color-oklch.ts
// sRGB ↔ OKLCH plus the three operations the theme derivation needs on top of it:
// interpolation, a chroma floor and a contrast floor.
//
// Why OKLCH and not HSL: the derivation's real work is "same hue, different
// lightness" (four elevation layers, three text levels). HSL's L is not
// perceptual — the same +5% is invisible on near-black and a jump in mid-tones —
// and pushing a saturated colour brighter in HSL washes it towards white. OKLCH
// keeps the hue and spaces the steps evenly.
//
// Why in JS and not CSS's oklch(): xterm's ITheme only takes literal colour
// values, so the terminal's ANSI palette could never come from a CSS function.
// Doing the maths here means the UI tokens and the terminal colours come out of
// one code path.
//
// Every function is pure: same input → same output, no globals, no clock, no
// randomness. That is what lets the generated `theme-tokens.css` be checked in
// and diffed.

export interface RGB { r: number; g: number; b: number }
export interface OKLCH { L: number; C: number; h: number }

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** `#2d2e2d` or `2d2e2d` → channels in 0..1. */
export function hex2rgb(hex: string): RGB {
  const s = hex.trim().replace(/^#/, "");
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
  };
}

/** Channels in 0..1 → lowercase `#rrggbb`. Out-of-gamut values are clamped. */
export function rgb2hex(c: RGB): string {
  const ch = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}`;
}

/** sRGB transfer function, gamma → linear. */
const srgb2linear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/** sRGB transfer function, linear → gamma. */
const linear2srgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgb2oklch(c: RGB): OKLCH {
  const r = srgb2linear(c.r), g = srgb2linear(c.g), b = srgb2linear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

export function oklch2rgb(c: OKLCH): RGB {
  const hr = (c.h * Math.PI) / 180;
  const a = c.C * Math.cos(hr);
  const b2 = c.C * Math.sin(hr);
  const l = (c.L + 0.3963377774 * a + 0.2158037573 * b2) ** 3;
  const m = (c.L - 0.1055613458 * a - 0.0638541728 * b2) ** 3;
  const s = (c.L - 0.0894841775 * a - 1.291485548 * b2) ** 3;
  return {
    r: linear2srgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linear2srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linear2srgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

export const hex2oklch = (hex: string): OKLCH => rgb2oklch(hex2rgb(hex));
export const oklch2hex = (c: OKLCH): string => rgb2hex(oklch2rgb(c));

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relLuminance(hex: string): number {
  const c = hex2rgb(hex);
  return 0.2126 * srgb2linear(c.r) + 0.7152 * srgb2linear(c.g) + 0.0722 * srgb2linear(c.b);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black vs white). Symmetric. */
export function contrast(a: string, b: string): number {
  const la = relLuminance(a), lb = relLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Shortest angular distance between two hues, 0..180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Below this chroma a colour is neutral grey, and its hue angle is noise.
 *  CSS Color 4 calls such a hue "powerless" and excludes it from interpolation. */
const POWERLESS_CHROMA = 0.01;

/**
 * Interpolate `from` towards `to` by `t` in OKLCH, taking the short way around
 * the hue circle. Used for `--dim`/`--dimmer` (foreground blended towards the
 * background, which adapts to either scheme without a light/dark branch) and for
 * the tinted surfaces like `--red-dark`.
 *
 * A near-grey endpoint contributes no hue. Its stored angle is an artefact of
 * rounding — `#2d2e2d` reports 145° — and blending towards it would rotate a red
 * into a green while the eye only expects it to desaturate. Skipping the powerless
 * endpoint's hue keeps the chromatic side's identity and lets chroma alone carry
 * the fade.
 */
export function towards(from: string, to: string, t: number): string {
  // Endpoints are returned verbatim. The powerless-hue rule below is a
  // best-effort choice for the interior of the range; at t=0 and t=1 there is
  // nothing to choose and callers are entitled to get their input back.
  if (t <= 0) return rgb2hex(hex2rgb(from));
  if (t >= 1) return rgb2hex(hex2rgb(to));
  const a = hex2oklch(from), b = hex2oklch(to);
  const aGrey = a.C < POWERLESS_CHROMA, bGrey = b.C < POWERLESS_CHROMA;
  let h: number;
  if (aGrey && bGrey) {
    h = a.h; // both neutral: the angle is irrelevant to the result
  } else if (bGrey) {
    h = a.h;
  } else if (aGrey) {
    h = b.h;
  } else {
    let dh = b.h - a.h;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    h = a.h + dh * t;
  }
  return oklch2hex({ L: a.L + (b.L - a.L) * t, C: a.C + (b.C - a.C) * t, h });
}

/**
 * Raise a colour's chroma to `floor` if it is below, keeping L and hue. Nord's
 * grey-green status colour has to still read as a "running" light.
 *
 * Setting C exactly to the floor is not enough: rounding back to 8-bit sRGB can
 * land a hair under it (blackout's `#dd9999` at C=0.09 quantises to 0.0895), so
 * the result is measured and nudged until the floor actually holds. Bounded at
 * ten steps — a hue that cannot reach the floor inside sRGB returns the closest
 * it got rather than looping.
 */
export function minChroma(hex: string, floor: number): string {
  const c = hex2oklch(hex);
  if (c.C >= floor) return hex;
  let best = oklch2hex({ ...c, C: floor });
  let bestC = hex2oklch(best).C;
  for (let i = 1; i <= 10 && bestC < floor; i++) {
    const cand = oklch2hex({ ...c, C: floor + 0.002 * i });
    const candC = hex2oklch(cand).C;
    if (candC <= bestC) break; // clamped at the gamut boundary: no further gain
    best = cand;
    bestC = candC;
  }
  return best;
}

const STEP = 0.02;   // L increment per search step
const MAX_STEPS = 50;

/**
 * Nudge `c` along the L axis until it reaches `target` contrast against `bg`,
 * lightening on a dark background and darkening on a light one, keeping hue and
 * chroma. **Returns `c` unchanged (byte-for-byte) when it already passes** —
 * that is what keeps the seven themes distinguishable instead of being dragged
 * towards a common "safe" colour.
 *
 * When the target is unreachable in that direction (e.g. asking for 21:1 on mid
 * grey) it returns the best candidate it found rather than throwing or spinning.
 */
export function ensureContrast(c: string, bg: string, target: number): string {
  if (contrast(c, bg) >= target) return c;
  const o = hex2oklch(c);
  const dir = relLuminance(bg) > 0.4 ? -1 : 1;
  let best = c;
  let bestRatio = contrast(c, bg);
  for (let i = 1; i <= MAX_STEPS; i++) {
    const L = clamp01(o.L + dir * STEP * i);
    const cand = oklch2hex({ ...o, L });
    const ratio = contrast(cand, bg);
    if (ratio > bestRatio) { best = cand; bestRatio = ratio; }
    if (ratio >= target) return cand;
    if (L <= 0 || L >= 1) break;
  }
  return best;
}

/** `#ff4d00`, 0.12 → `rgba(255, 77, 0, 0.12)`. The token set uses a handful of
 *  fixed-alpha variants (`--accent-soft`, `--ok-line`, …) built this way. */
export function alpha(hex: string, a: number): string {
  const c = hex2rgb(hex);
  const ch = (v: number) => Math.round(clamp01(v) * 255);
  return `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${a})`;
}
