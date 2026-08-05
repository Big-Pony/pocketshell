// agent/src/color-oklch.test.ts
// Task 1 of the Ghostty theme system: the colour maths the derivation rests on.
// Every case here is a property the derivation relies on, not a spot check of an
// arbitrary constant — the roundtrip precision bounds how far a derived token can
// drift from its source palette, and `ensureContrast`'s "already fine → return the
// input byte-for-byte" is what keeps the seven themes from being flattened into
// one another.
import { test, expect, describe } from "bun:test";
import {
  hex2rgb, rgb2hex, rgb2oklch, oklch2rgb, hex2oklch, oklch2hex,
  contrast, relLuminance, towards, ensureContrast, minChroma, alpha, hueDistance,
} from "./color-oklch";

/** background/foreground of the seven shipped palettes — the real inputs. */
const SAMPLES = [
  "#2d2e2d", "#ddd9cd", // cream-dark
  "#f5f3e9", "#403d36", // cream-light
  "#282828", "#ebdbb2", // gruvbox-dark
  "#1a1b26", "#c0caf5", // tokyonight
  "#2e3440", "#d8dee9", // nord
  "#1e1e2e", "#cdd6f4", // mocha
  "#000000", "#c1c1c1", // blackout
];

describe("hex2rgb / rgb2hex", () => {
  test("roundtrips byte-for-byte, normalising case", () => {
    for (const hex of [...SAMPLES, "#FF4D00", "#ffffff", "#000000"]) {
      expect(rgb2hex(hex2rgb(hex))).toBe(hex.toLowerCase());
    }
  });

  test("accepts a bare hex without the leading #", () => {
    expect(hex2rgb("2d2e2d")).toEqual(hex2rgb("#2d2e2d"));
  });

  test("rgb2hex clamps out-of-gamut channels instead of emitting garbage", () => {
    expect(rgb2hex({ r: -0.5, g: 0.5, b: 1.8 })).toBe("#0080ff");
  });

  test("channels are 0..1", () => {
    expect(hex2rgb("#ffffff")).toEqual({ r: 1, g: 1, b: 1 });
    expect(hex2rgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe("rgb2oklch / oklch2rgb", () => {
  test("roundtrips the 14 real palette colours to within 1/255 per channel", () => {
    for (const hex of SAMPLES) {
      const rgb = hex2rgb(hex);
      const back = oklch2rgb(rgb2oklch(rgb));
      for (const ch of ["r", "g", "b"] as const) {
        expect(Math.abs(back[ch] - rgb[ch]), `${hex} channel ${ch}`).toBeLessThanOrEqual(1 / 255);
      }
    }
  });

  test("hex-level roundtrip is exact for the 14 real palette colours", () => {
    for (const hex of SAMPLES) expect(oklch2hex(hex2oklch(hex))).toBe(hex);
  });

  test("known values: black, white, pure red", () => {
    const black = hex2oklch("#000000");
    expect(black.L).toBeCloseTo(0, 3);
    const white = hex2oklch("#ffffff");
    expect(white.L).toBeCloseTo(1, 3);
    const red = hex2oklch("#ff0000");
    expect(red.L).toBeCloseTo(0.628, 2);
    expect(red.C).toBeCloseTo(0.258, 2);
    expect(red.h).toBeCloseTo(29.2, 1);
  });
});

describe("relLuminance / contrast", () => {
  test("white on black is 21, a colour on itself is 1", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 4);
    for (const hex of SAMPLES) expect(contrast(hex, hex)).toBeCloseTo(1, 10);
  });

  test("is symmetric", () => {
    expect(contrast("#2d2e2d", "#ddd9cd")).toBe(contrast("#ddd9cd", "#2d2e2d"));
  });

  test("relLuminance is 0 for black and 1 for white and monotonic in between", () => {
    expect(relLuminance("#000000")).toBeCloseTo(0, 10);
    expect(relLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(relLuminance("#808080")).toBeGreaterThan(0);
    expect(relLuminance("#808080")).toBeLessThan(1);
  });
});

describe("towards", () => {
  test("t=0 returns from, t=1 returns to (within 1/255)", () => {
    const from = "#ddd9cd", to = "#2d2e2d";
    expect(towards(from, to, 0)).toBe(from);
    expect(towards(from, to, 1)).toBe(to);
  });

  test("t=0.5 lands between the two lightnesses", () => {
    const from = "#ddd9cd", to = "#2d2e2d";
    const mid = hex2oklch(towards(from, to, 0.5));
    expect(mid.L).toBeGreaterThan(hex2oklch(to).L);
    expect(mid.L).toBeLessThan(hex2oklch(from).L);
  });

  test("a near-grey endpoint does not rotate the other end's hue", () => {
    // #2d2e2d is visually neutral but reports h≈145 (green) from rounding. Fading
    // a red towards it must desaturate the red, not turn it green — this is what
    // produced a green --red-dark on cream-dark before the powerless-hue rule.
    // Tolerance is a few degrees, not zero: the result is nearly neutral, so
    // 8-bit rounding moves its reported angle. What matters is that it is still
    // in the red family rather than 120° away.
    const faded = hex2oklch(towards("#f4a199", "#2d2e2d", 0.85));
    expect(hueDistance(faded.h, hex2oklch("#f4a199").h)).toBeLessThan(6);
  });

  test("interpolating between two neutrals still produces a neutral", () => {
    const out = hex2oklch(towards("#2d2e2d", "#c1c1c1", 0.5));
    expect(out.C).toBeLessThan(0.02);
  });

  test("takes the short way around the hue circle", () => {
    // 350° → 10° must pass through 0°, not sweep down through 180°.
    const mid = hex2oklch(towards(oklch2hex({ L: 0.6, C: 0.15, h: 350 }), oklch2hex({ L: 0.6, C: 0.15, h: 10 }), 0.5));
    expect(hueDistance(mid.h, 0)).toBeLessThan(5);
  });
});

describe("hueDistance", () => {
  test("wraps at 360 and never exceeds 180", () => {
    expect(hueDistance(10, 350)).toBeCloseTo(20, 6);
    expect(hueDistance(0, 180)).toBeCloseTo(180, 6);
    expect(hueDistance(90, 90)).toBe(0);
  });
});

describe("ensureContrast", () => {
  test("returns the input byte-for-byte when already at target", () => {
    // The point of the whole function: correction only when needed, so themes
    // that were already legible keep their exact identity colour.
    const already = "#7aa2f7";
    expect(contrast(already, "#1a1b26")).toBeGreaterThanOrEqual(4.5);
    const out = ensureContrast(already, "#1a1b26", 4.5);
    expect(out).toBe(already);
  });

  test("lightens on a dark background until the target is met", () => {
    const c = "#486e6f", bg = "#000000";
    const out = ensureContrast(c, bg, 7);
    expect(contrast(out, bg)).toBeGreaterThanOrEqual(7);
    expect(hex2oklch(out).L).toBeGreaterThan(hex2oklch(c).L);
  });

  test("darkens on a light background until the target is met", () => {
    const c = "#e2bc67", bg = "#f5f3e9";
    const out = ensureContrast(c, bg, 4.5);
    expect(contrast(out, bg)).toBeGreaterThanOrEqual(4.5);
    expect(hex2oklch(out).L).toBeLessThan(hex2oklch(c).L);
  });

  test("keeps hue and chroma", () => {
    const c = "#486e6f";
    const before = hex2oklch(c);
    const after = hex2oklch(ensureContrast(c, "#000000", 7));
    expect(Math.abs(after.C - before.C)).toBeLessThan(0.005);
    expect(hueDistance(after.h, before.h)).toBeLessThan(1);
  });

  test("an unreachable target returns the best found instead of looping or throwing", () => {
    const out = ensureContrast("#888888", "#808080", 21);
    expect(typeof out).toBe("string");
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    // best effort still beats the input
    expect(contrast(out, "#808080")).toBeGreaterThanOrEqual(contrast("#888888", "#808080"));
  });

  test("is deterministic", () => {
    expect(ensureContrast("#486e6f", "#000000", 7)).toBe(ensureContrast("#486e6f", "#000000", 7));
  });
});

describe("minChroma", () => {
  test("raises a washed-out colour to the floor, keeping hue", () => {
    const c = "#a3be8c"; // nord's grey-green
    const before = hex2oklch(c);
    const out = minChroma(c, 0.2);
    const after = hex2oklch(out);
    expect(after.C).toBeGreaterThanOrEqual(0.2 - 1e-3);
    expect(hueDistance(after.h, before.h)).toBeLessThan(2);
  });

  test("returns a saturated colour byte-for-byte", () => {
    const c = "#ff4d00";
    expect(hex2oklch(c).C).toBeGreaterThan(0.09);
    expect(minChroma(c, 0.09)).toBe(c);
  });

  test("the floor holds after quantising back to 8-bit sRGB", () => {
    // Naively writing C = floor is not enough: rounding to #rrggbb can land just
    // under it. blackout's #dd9999 is the case that caught this.
    for (const c of ["#dd9999", "#a3be8c", "#888888", "#c1c1c1"]) {
      expect(hex2oklch(minChroma(c, 0.09)).C, c).toBeGreaterThanOrEqual(0.09);
    }
  });

  test("an achromatic colour cannot gain a hue out of nowhere — but does not loop", () => {
    // Pure grey has an undefined hue; whatever comes back must still be a colour.
    expect(minChroma("#808080", 0.3)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("alpha", () => {
  test("renders rgba() with integer channels", () => {
    expect(alpha("#ff4d00", 0.12)).toBe("rgba(255, 77, 0, 0.12)");
    expect(alpha("#000000", 1)).toBe("rgba(0, 0, 0, 1)");
  });
});
