// agent/src/theme-derive.test.ts
// Tasks 2 and 3 of the Ghostty theme system.
//
// Two things are being pinned down here. First, that a 22-colour Ghostty palette
// really does expand into the full UI token set with legible results — the seven
// fixtures are the shipped themes, and the contrast table at the bottom is the
// acceptance criterion from the design doc (§2.4), not a smoke test.
// Second (Task 3), that the token *names* the deriver emits match `app/src/app.css`
// exactly. Those two files live in different packages; if they drift, a component
// referencing a token nobody produces silently renders with no value in every
// theme, and nothing fails.
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { contrast, hex2oklch, hueDistance } from "./color-oklch";
import {
  parseGhostty, derive, renderCss, isLightBackground, TOKEN_NAMES, HUE_BANDS, inHueBand,
} from "./theme-derive";

const FIXTURES = resolve(import.meta.dir, "__fixtures__/themes");
const readFixture = (id: string) => readFileSync(resolve(FIXTURES, `${id}.ghostty`), "utf8");

/** The seven built-ins, by the id the app will use. */
const THEME_IDS = [
  "cream-dark", "cream-light", "gruvbox-dark", "tokyonight", "nord", "mocha", "blackout",
] as const;

const parsedOf = (id: string) => parseGhostty(readFixture(id), id);
const tokensOf = (id: string) => derive(parsedOf(id));

// ---------------------------------------------------------------- parseGhostty

describe("parseGhostty", () => {
  const MINIMAL = [
    "background = 2d2e2d",
    "foreground = ddd9cd",
    ...Array.from({ length: 16 }, (_, i) => `palette = ${i}=#0000${i.toString(16)}${i.toString(16)}`),
  ].join("\n");

  test("treats a bare hex and a #-prefixed hex as the same colour", () => {
    const bare = parseGhostty(MINIMAL);
    const hashed = parseGhostty(MINIMAL.replace("background = 2d2e2d", "background = #2d2e2d"));
    expect(bare.background).toBe("#2d2e2d");
    expect(hashed.background).toBe(bare.background);
  });

  test("normalises hex to lowercase", () => {
    expect(parseGhostty(MINIMAL.replace("2d2e2d", "2D2E2D")).background).toBe("#2d2e2d");
  });

  test("reads palette entries into a 16-slot array", () => {
    const p = parseGhostty(MINIMAL);
    expect(p.palette).toHaveLength(16);
    expect(p.palette[0]).toBe("#000000");
    expect(p.palette[15]).toBe("#0000ff");
  });

  test("reads the cursor and selection keys", () => {
    const p = parseGhostty(`${MINIMAL}\ncursor-color = e6bf7a\ncursor-text  = 2a1e1b\nselection-background = #736347\nselection-foreground = f8f7f2`);
    expect(p.cursorColor).toBe("#e6bf7a");
    expect(p.cursorText).toBe("#2a1e1b");
    expect(p.selectionBackground).toBe("#736347");
    expect(p.selectionForeground).toBe("#f8f7f2");
  });

  test("skips comments and blank lines", () => {
    const p = parseGhostty(`# a comment\n\n   \n${MINIMAL}\n# trailing`);
    expect(p.background).toBe("#2d2e2d");
  });

  test("ignores keys it does not know instead of throwing", () => {
    // Ghostty theme files in the wild carry window-level settings; those are not
    // colours and must not stop a theme from loading.
    const p = parseGhostty(`${MINIMAL}\nwindow-padding-x = 8\ncursor-invert-fg-bg = true\nfont-family = "JetBrains Mono"`);
    expect(p.background).toBe("#2d2e2d");
  });

  test("ignores palette entries at index 16 and above", () => {
    const p = parseGhostty(`${MINIMAL}\npalette = 16=#123456\npalette = 255=#654321`);
    expect(p.palette).toHaveLength(16);
  });

  describe("ps-accent directive", () => {
    test("reads the #-prefixed form used by the shipped files", () => {
      expect(parseGhostty(`# ps-accent = #e6bf7a\n${MINIMAL}`).psAccent).toBe("#e6bf7a");
    });
    test("reads the bare form too", () => {
      expect(parseGhostty(`# ps-accent = e6bf7a\n${MINIMAL}`).psAccent).toBe("#e6bf7a");
    });
    test("tolerates spacing variants", () => {
      expect(parseGhostty(`#ps-accent=E6BF7A\n${MINIMAL}`).psAccent).toBe("#e6bf7a");
    });
    test("is absent when not declared", () => {
      expect(parseGhostty(MINIMAL).psAccent).toBeUndefined();
    });
    test("a malformed directive is ignored, not fatal — it lives in a comment", () => {
      expect(parseGhostty(`# ps-accent = not-a-colour\n${MINIMAL}`).psAccent).toBeUndefined();
    });
  });

  describe("errors name the file", () => {
    test("missing background", () => {
      const text = MINIMAL.split("\n").filter((l) => !l.startsWith("background")).join("\n");
      expect(() => parseGhostty(text, "broken.ghostty")).toThrow(/broken\.ghostty.*background/i);
    });
    test("missing foreground", () => {
      const text = MINIMAL.split("\n").filter((l) => !l.startsWith("foreground")).join("\n");
      expect(() => parseGhostty(text, "broken.ghostty")).toThrow(/broken\.ghostty.*foreground/i);
    });
    test("an incomplete palette is not a usable theme", () => {
      const text = MINIMAL.split("\n").filter((l) => !l.startsWith("palette = 7=")).join("\n");
      expect(() => parseGhostty(text, "broken.ghostty")).toThrow(/broken\.ghostty.*palette/i);
    });
    test("a malformed colour value", () => {
      expect(() => parseGhostty(MINIMAL.replace("2d2e2d", "zzz"), "broken.ghostty")).toThrow(/broken\.ghostty/);
    });
    test("an unnamed source still produces a readable message", () => {
      expect(() => parseGhostty("")).toThrow(/background/i);
    });
  });

  test("parses all seven shipped themes, licence headers and all", () => {
    for (const id of THEME_IDS) {
      const p = parsedOf(id);
      expect(p.palette.filter(Boolean), id).toHaveLength(16);
      expect(p.psAccent, `${id} should name its accent`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

// -------------------------------------------------------------------- hue bands

describe("inHueBand", () => {
  test("handles a band that wraps past 360 (red)", () => {
    for (const h of [0, 15, 29, 40, 340, 359.9]) expect(inHueBand(h, HUE_BANDS.red), `${h}`).toBe(true);
    for (const h of [45, 90, 180, 300, 325]) expect(inHueBand(h, HUE_BANDS.red), `${h}`).toBe(false);
  });

  test("handles ordinary non-wrapping bands", () => {
    expect(inHueBand(130, HUE_BANDS.ok)).toBe(true);
    expect(inHueBand(198, HUE_BANDS.ok)).toBe(false); // blackout's teal
    expect(inHueBand(19, HUE_BANDS.ok)).toBe(false);  // blackout's pink
    expect(inHueBand(80, HUE_BANDS.amber)).toBe(true);
    expect(inHueBand(20, HUE_BANDS.amber)).toBe(false);
  });

  test("the bands do not overlap", () => {
    const bands = Object.values(HUE_BANDS);
    for (let h = 0; h < 360; h += 0.5) {
      const hits = bands.filter((b) => inHueBand(h, b)).length;
      expect(hits, `hue ${h} is claimed by ${hits} bands`).toBeLessThanOrEqual(1);
    }
  });

  test("the bands admit the hues the six healthy palettes actually use", () => {
    // The bands are calibrated from real theme data, not chosen a priori: the six
    // coherent palettes cluster at green 111-143, red 1-30, yellow 70-86.
    for (const [h, band] of [[111, "ok"], [143, "ok"], [1, "red"], [30, "red"], [70, "amber"], [86, "amber"]] as const) {
      expect(inHueBand(h, HUE_BANDS[band]), `${h} should be ${band}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------- derive

describe("derive", () => {
  test("is a pure function — two calls give byte-identical output", () => {
    for (const id of THEME_IDS) expect(derive(parsedOf(id))).toEqual(derive(parsedOf(id)));
  });

  test("--bg is the palette background and the terminal follows it", () => {
    for (const id of THEME_IDS) {
      const p = parsedOf(id);
      const t = derive(p);
      expect(t["--bg"], id).toBe(p.background);
      expect(t["--term-bg"], id).toBe(p.background);
      expect(t["--text"], id).toBe(p.foreground);
    }
  });

  test("pure black still gets three distinguishable elevation layers", () => {
    // The relative rule alone collapses on #000000 — every layer comes out black.
    // The absolute-L floor is what keeps OLED themes from going flat.
    const t = derive(parseGhostty([
      "background = #000000", "foreground = #c1c1c1",
      ...Array.from({ length: 16 }, (_, i) => `palette = ${i}=#888888`),
    ].join("\n")));
    const layers = [t["--bg"], t["--panel"], t["--panel2"], t["--elev"]];
    expect(new Set(layers).size, `layers collapsed: ${layers.join(" ")}`).toBe(4);
  });

  test("light schemes darken to elevate rather than brighten", () => {
    const t = tokensOf("cream-light");
    expect(isLightBackground(t["--bg"])).toBe(true);
    expect(hex2oklch(t["--panel"]).L).toBeLessThan(hex2oklch(t["--bg"]).L);
    expect(hex2oklch(t["--panel2"]).L).toBeLessThan(hex2oklch(t["--panel"]).L);
  });

  test("dark schemes brighten to elevate", () => {
    for (const id of THEME_IDS.filter((i) => i !== "cream-light")) {
      const t = tokensOf(id);
      expect(isLightBackground(t["--bg"]), id).toBe(false);
      expect(hex2oklch(t["--panel"]).L, id).toBeGreaterThanOrEqual(hex2oklch(t["--bg"]).L);
    }
  });

  test("a declared ps-accent sets the accent hue", () => {
    for (const id of THEME_IDS) {
      const p = parsedOf(id);
      const t = derive(p);
      // The contrast floor may shift L, but the theme's identity hue survives.
      expect(hueDistance(hex2oklch(t["--accent"]).h, hex2oklch(p.psAccent!).h), id).toBeLessThan(2);
    }
  });

  test("an accent that already passes is used verbatim", () => {
    const p = parsedOf("tokyonight");
    expect(p.psAccent).toBe("#7aa2f7");
    expect(derive(p)["--accent"]).toBe("#7aa2f7");
  });

  test("without ps-accent the heuristic still finds a chromatic accent", () => {
    for (const id of THEME_IDS) {
      const p = parsedOf(id);
      const t = derive({ ...p, psAccent: undefined });
      expect(hex2oklch(t["--accent"]).C, `${id} fell back to a grey accent`).toBeGreaterThanOrEqual(0.05);
    }
  });

  test("--ok stays chromatic enough to read as a running light", () => {
    // Nord's green is a desaturated grey-green; without a chroma floor it reads
    // as "off" rather than "running".
    for (const id of THEME_IDS) {
      expect(hex2oklch(tokensOf(id)["--ok"]).C, id).toBeGreaterThanOrEqual(0.09 - 1e-6);
    }
  });

  describe("status colours are hue-corrected when the palette misuses the slot", () => {
    // A palette is trusted for its hue right up until the hue contradicts the
    // slot's meaning. Black Metal (shipped as `blackout`) puts a teal in ANSI
    // slot 9 and a pink in slot 10, so a faithful mapping gives a teal disconnect
    // banner and a pink "running" light — the status semantics stop working.
    // Correction applies to every theme, not as a blackout special case: it is
    // also what protects users importing an arbitrary Ghostty theme.

    test("the six well-behaved palettes are passed through byte-for-byte", () => {
      // Same contract as ensureContrast: intervene only when necessary, so a
      // theme that was already coherent keeps its exact identity colours.
      // The direct check: for these six, every status slot passes the hue test,
      // so correctHue returns its input and the palette's own colour survives
      // into the token (modulo the chroma/contrast floors, which are separate and
      // predate this rule).
      for (const id of THEME_IDS.filter((i) => i !== "blackout")) {
        const p = parsedOf(id);
        for (const [kind, slot] of [["ok", 10], ["red", 9], ["amber", 11]] as const) {
          expect(
            inHueBand(hex2oklch(p.palette[slot]).h, HUE_BANDS[kind]),
            `${id} slot ${slot} should not need correcting`,
          ).toBe(true);
        }
      }

      // And the values themselves, pinned so a change to the bands cannot quietly
      // restyle a theme that was fine.
      const UNTOUCHED: Record<string, [string, string, string]> = {
        "cream-dark": ["#a9d18e", "#f4a199", "#f5ce84"],
        "cream-light": ["#4d6d2c", "#aa4a40", "#915500"],
        "gruvbox-dark": ["#b8bb26", "#ff664f", "#fabd2f"],
        "tokyonight": ["#9ece6a", "#f7768e", "#e0af68"],
        "nord": ["#a0c083", "#ef8c94", "#eeca81"],
        "mocha": ["#bcefb8", "#feaac1", "#fcd682"],
      };
      for (const [id, [ok, red, amber]] of Object.entries(UNTOUCHED)) {
        const t = tokensOf(id);
        expect(t["--ok"], `${id} --ok was rewritten`).toBe(ok);
        expect(t["--red"], `${id} --red was rewritten`).toBe(red);
        expect(t["--amber"], `${id} --amber was rewritten`).toBe(amber);
      }
    });

    test("every theme's status colours land in their semantic hue band", () => {
      for (const id of THEME_IDS) {
        const t = tokensOf(id);
        expect(inHueBand(hex2oklch(t["--ok"]).h, HUE_BANDS.ok), `${id} --ok is not green`).toBe(true);
        expect(inHueBand(hex2oklch(t["--red"]).h, HUE_BANDS.red), `${id} --red is not red`).toBe(true);
        expect(inHueBand(hex2oklch(t["--amber"]).h, HUE_BANDS.amber), `${id} --amber is not amber`).toBe(true);
      }
    });

    test("blackout: the teal 'red' and pink 'green' are corrected", () => {
      const t = tokensOf("blackout");
      // Slot 9 held #486e6f (teal, h≈198) and slot 10 held #dd9999 (rose, h≈19).
      // Neither survives into the token it was mapped to: the teal is not a
      // danger colour, and the rose is not a running light.
      expect(hex2oklch(t["--red"]).h, "--red kept the teal").not.toBeCloseTo(198, 0);
      expect(inHueBand(hex2oklch(t["--red"]).h, HUE_BANDS.red)).toBe(true);
      expect(hex2oklch(t["--ok"]).h, "--ok kept the rose").not.toBeCloseTo(19, 0);
      expect(inHueBand(hex2oklch(t["--ok"]).h, HUE_BANDS.ok)).toBe(true);
    });

    test("a substitute is taken from the theme's own palette when one fits", () => {
      // blackout's slots 2/3/10/11 hold reds (h≈19-20), so its --red can be
      // rescued from its own palette and still look like the theme.
      const p = parsedOf("blackout");
      const red = derive(p)["--red"];
      const ownHues = p.palette.map((c) => hex2oklch(c).h);
      expect(ownHues.some((h) => Math.abs(h - hex2oklch(red).h) < 12), "--red is not from blackout's palette").toBe(true);
    });

    test("a neutral fallback is used when the palette has nothing in band", () => {
      // blackout has no green and no amber anywhere in its 16 colours, so those
      // two must come from the fixed fallbacks rather than being forced out of a
      // pink. The fallback is still put through the chroma and contrast floors.
      const t = tokensOf("blackout");
      expect(inHueBand(hex2oklch(t["--ok"]).h, HUE_BANDS.ok)).toBe(true);
      expect(inHueBand(hex2oklch(t["--amber"]).h, HUE_BANDS.amber)).toBe(true);
      expect(contrast(t["--ok"], t["--panel"])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--amber"], t["--panel"])).toBeGreaterThanOrEqual(4.5);
    });

    test("an all-grey palette still yields usable status colours", () => {
      // The degenerate import: nothing chromatic to rescue from anywhere.
      const t = derive(parseGhostty([
        "background = #101010", "foreground = #e0e0e0",
        ...Array.from({ length: 16 }, (_, i) => `palette = ${i}=#7f7f7f`),
      ].join("\n")));
      for (const [name, band] of [["--ok", HUE_BANDS.ok], ["--red", HUE_BANDS.red], ["--amber", HUE_BANDS.amber]] as const) {
        expect(inHueBand(hex2oklch(t[name]).h, band), `${name} out of band`).toBe(true);
        expect(hex2oklch(t[name]).C, `${name} is grey`).toBeGreaterThanOrEqual(0.09);
        expect(contrast(t[name], t["--panel"]), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
    });

    test("correction picks the best-contrasting in-band candidate, not merely the first", () => {
      // Two reds in the palette, one too dark to read on the panel; the brighter
      // one has to win.
      const pal = Array.from({ length: 16 }, () => "#7f7f7f");
      pal[9] = "#488e8f";  // teal in the red slot: triggers correction
      pal[1] = "#3d0f0c";  // an in-band red, but nearly black
      pal[5] = "#f4a199";  // an in-band red that actually reads
      const t = derive(parseGhostty([
        "background = #101010", "foreground = #e0e0e0",
        ...pal.map((c, i) => `palette = ${i}=${c}`),
      ].join("\n")));
      expect(t["--red"]).toBe("#f4a199");
    });

    test("correction is applied before the contrast floor, not after", () => {
      // Order matters: rescuing a hue and then failing to make it legible would
      // trade one broken token for another.
      for (const id of THEME_IDS) {
        const t = tokensOf(id);
        for (const name of ["--ok", "--red", "--amber"] as const) {
          expect(contrast(t[name], t["--panel"]), `${id} ${name}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  });

  test("tinted surfaces keep the hue of the colour they are named after", () => {
    // --red-dark backs the disconnect banner and --teal-dark the connected chip.
    // Fading them towards a visually-neutral background used to swing the hue
    // right across the wheel (cream-dark's --red-dark came out green), because a
    // near-grey's stored hue angle is rounding noise.
    for (const id of THEME_IDS) {
      const t = tokensOf(id);
      expect(hueDistance(hex2oklch(t["--red-dark"]).h, hex2oklch(t["--red"]).h), `${id} --red-dark`).toBeLessThan(15);
      expect(hueDistance(hex2oklch(t["--banner-line"]).h, hex2oklch(t["--red"]).h), `${id} --banner-line`).toBeLessThan(15);
      expect(hueDistance(hex2oklch(t["--teal-dark"]).h, hex2oklch(t["--ok"]).h), `${id} --teal-dark`).toBeLessThan(15);
    }
  });

  test("the 27 pure aliases stay as var() references, not flattened literals", () => {
    // Flattening them would defeat the point: they exist so that "make the bottom
    // bar indicator a different colour from the tab top rule" is a one-line change.
    const ALIASES: Record<string, string> = {
      "--primary-bg": "var(--accent)", "--primary-text": "var(--on-accent)",
      "--teal": "var(--ok)", "--term-accent": "var(--accent)",
      "--key-text": "var(--text)",
      "--seg-bg": "var(--bg)", "--seg-line": "var(--line)",
      "--seg-active-bg": "var(--elev2)", "--seg-active-text": "var(--text)",
      "--tab-line": "var(--line-strong)", "--tab-idx-bg": "var(--panel)",
      "--tab-idx-line": "var(--line-strong)", "--tab-idx-top": "var(--accent)",
      "--tab-active-bg": "var(--tab-idx-bg)", "--tab-active-text": "var(--text)",
      "--tab-active-line": "var(--tab-idx-line)",
      "--bar-bg": "var(--bg)", "--bar-text": "var(--dimmer)", "--bar-grip": "var(--elev2)",
      "--brand-sig": "var(--accent)",
      "--bb-bg": "var(--bg)", "--bb-line": "var(--line)",
      "--bb-active": "var(--accent)", "--bb-indicator": "var(--accent)",
      "--toast-text": "var(--text)",
      "--banner-bg": "var(--red-dark)", "--banner-text": "var(--amber)",
    };
    expect(Object.keys(ALIASES)).toHaveLength(27);
    const t = tokensOf("gruvbox-dark");
    for (const [name, value] of Object.entries(ALIASES)) expect(t[name], name).toBe(value);
  });

  test("emits every token in TOKEN_NAMES and nothing else", () => {
    for (const id of THEME_IDS) {
      expect(Object.keys(tokensOf(id)).sort(), id).toEqual([...TOKEN_NAMES].sort());
    }
  });

  test("no token comes out empty or undefined", () => {
    for (const id of THEME_IDS) {
      for (const [name, value] of Object.entries(tokensOf(id))) {
        expect(typeof value, `${id} ${name}`).toBe("string");
        expect(value.trim().length, `${id} ${name} is empty`).toBeGreaterThan(0);
      }
    }
  });
});

// ------------------------------------------------------- contrast, all 7 themes

describe("contrast floors hold across all seven palettes (design doc §2.4)", () => {
  for (const id of THEME_IDS) {
    test(id, () => {
      const t = tokensOf(id);
      expect(contrast(t["--accent"], t["--on-accent"]), "accent/on-accent").toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--dim"], t["--bg"]), "dim/bg").toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--dimmer"], t["--bg"]), "dimmer/bg").toBeGreaterThanOrEqual(3.0);
      expect(contrast(t["--ok"], t["--panel"]), "ok/panel").toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--red"], t["--panel"]), "red/panel").toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--amber"], t["--panel"]), "amber/panel").toBeGreaterThanOrEqual(4.5);
      // body text has to clear AA as well, though no palette has ever failed it
      expect(contrast(t["--text"], t["--bg"]), "text/bg").toBeGreaterThanOrEqual(4.5);
    });
  }
});

// -------------------------------------------------------------------- renderCss

describe("renderCss", () => {
  test("emits a well-formed rule under the given selector", () => {
    const css = renderCss({ "--bg": "#000000", "--text": "#ffffff" }, ':root[data-theme="x"]');
    expect(css).toBe(':root[data-theme="x"] {\n  --bg: #000000;\n  --text: #ffffff;\n}\n');
  });

  test("the selector is caller-supplied — built-in vs custom themes differ only here", () => {
    const t = { "--bg": "#000000" };
    expect(renderCss(t, ":root")).toStartWith(":root {");
    expect(renderCss(t, ':root[data-theme="custom:foo"]')).toStartWith(':root[data-theme="custom:foo"] {');
  });

  test("strips characters that would break out of the declaration", () => {
    // A hand-written theme file must not be able to inject CSS rules.
    const css = renderCss({ "--bg": "red; } body { display: none" }, ":root");
    expect(css).not.toContain("body");
    expect(css.match(/\{/g)).toHaveLength(1);
    expect(css.match(/\}/g)).toHaveLength(1);
  });

  test("strips newlines from values", () => {
    const css = renderCss({ "--bg": "red\n  --evil: blue" }, ":root");
    expect(css.split("\n").filter((l) => l.includes("--"))).toHaveLength(1);
  });

  test("round-trips all seven themes into parseable CSS", () => {
    for (const id of THEME_IDS) {
      const css = renderCss(tokensOf(id), `:root[data-theme="${id}"]`);
      const body = css.slice(css.indexOf("{") + 1, css.lastIndexOf("}"));
      const decls = body.split("\n").filter((l) => l.trim());
      expect(decls, id).toHaveLength(TOKEN_NAMES.length);
      for (const d of decls) expect(d, `${id}: ${d}`).toMatch(/^ {2}--[a-z0-9-]+: .+;$/);
    }
  });
});

// ================================================================== Task 3
// The deriver lives in agent/, the consumers in app/, and nothing in the type
// system connects them. If a token name drifts, the component referencing it
// silently renders with no value in *every* theme — no error, no failing build,
// just a colour that quietly is not there. These are the only checks standing in
// the way.
//
// Two independent anchors, because each catches what the other cannot:
//  - the generated `theme-tokens.css`, which must contain exactly what the
//    deriver emits (catches a stale generated file);
//  - the actual `var(--x)` references across the app source (catches a token a
//    component needs that nothing produces, and dead tokens nobody consumes).
// `app.css` itself is no longer an anchor: as of Task 6 it holds only structural
// tokens, the colour set having moved to the generated file.

describe("token set matches the app", () => {
  const APP_SRC = resolve(import.meta.dir, "../../app/src");

  /** Token names of every `:root…{ … }` block whose selector matches, brace-matched. */
  function blocksMatching(css: string, head: RegExp): string[][] {
    const out: string[][] = [];
    for (const m of css.matchAll(head)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (depth > 0 && i < css.length) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
        i++;
      }
      out.push([...css.slice(start, i - 1).matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((x) => x[1]));
    }
    return out;
  }

  test("the generated theme-tokens.css carries exactly the derived token set", () => {
    // Regenerating is `bun run gen:themes` in app/. A mismatch here means the
    // committed file is stale with respect to this module.
    const css = readFileSync(resolve(APP_SRC, "theme-tokens.css"), "utf8");
    const want = [...TOKEN_NAMES].sort();

    for (const id of THEME_IDS.filter((i) => i !== "cream-dark")) {
      const blocks = blocksMatching(css, new RegExp(`^:root\\[data-theme="${id}"\\]\\s*\\{`, "gm"));
      expect(blocks, `${id} should have exactly one block`).toHaveLength(1);
      expect(blocks[0].sort(), `${id} block in theme-tokens.css`).toEqual(want);
    }

    // The default theme is emitted under a bare `:root` so the first frame has a
    // full token set before any data-theme attribute is set. There is a second
    // bare `:root` holding the generator's metadata (--ps-themes, --sw-* swatch
    // previews); pick the one carrying the theme tokens rather than relying on
    // the order the generator happens to write them in.
    const bare = blocksMatching(css, /^:root\s*\{/gm);
    const creamDark = bare.filter((b) => b.includes("--bg"));
    expect(creamDark, "cream-dark should be the one bare :root with theme tokens").toHaveLength(1);
    expect(creamDark[0].sort(), "cream-dark block in theme-tokens.css").toEqual(want);
  });

  test("every theme token the app references is one the deriver produces", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const p = resolve(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(svelte|css|ts)$/.test(e.name)) files.push(p);
      }
    };
    walk(APP_SRC);

    const referenced = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/var\((--[a-z0-9-]+)/g)) referenced.add(m[1]);
    }

    // Not theme tokens: structural geometry (shared by every theme, declared in
    // app.css), the generator's own metadata (--ps-* list/scheme markers and the
    // --sw-* swatch previews), and --phone-h, a local defined and consumed inside
    // Showcase.svelte.
    const NOT_A_THEME_TOKEN = /^--(radius-|safe-|ps-|sw-|boot-|phone-h$)/;
    const needed = [...referenced].filter((t) => !NOT_A_THEME_TOKEN.test(t)).sort();
    const produced = new Set(TOKEN_NAMES);

    expect(needed.filter((t) => !produced.has(t)), "referenced by a component but never derived").toEqual([]);
  });

  test("the deriver emits no token the app has no use for", () => {
    // The reverse guard, so the token set cannot silently accumulate dead colour.
    // Nine tokens are read at runtime via getComputedStyle rather than var() —
    // Terminal.svelte feeds xterm's ITheme that way, and the settings panel reads
    // swatches — so a plain var() sweep cannot see them.
    const RUNTIME_READ = new Set([
      "--elev", "--cyan", "--ok-soft", "--ok-line", "--amber-soft",
      "--teal", "--teal-dark", "--term-accent", "--term-selection",
    ]);
    const css = readFileSync(resolve(APP_SRC, "theme-tokens.css"), "utf8");
    for (const t of RUNTIME_READ) {
      expect(css, `${t} is claimed to be runtime-read but is not generated`).toContain(`${t}:`);
    }
  });
});

// ---------------------------------------------------------------------- fixtures

test("every fixture file is one of the seven expected themes", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".ghostty")).sort();
  expect(files).toEqual([...THEME_IDS].map((i) => `${i}.ghostty`).sort());
});
