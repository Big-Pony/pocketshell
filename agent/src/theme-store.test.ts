// agent/src/theme-store.test.ts
// Task 9 of the Ghostty theme system: the on-disk repository of user themes.
//
// The interesting cases here are all failure cases. A themes directory is the
// one place in the agent where the *file name* reaches a CSS selector and the
// *file content* reaches a stylesheet, so both are treated as hostile input;
// and because the whole directory is rendered into one response, a single bad
// file must not be able to take the rest of the user's themes down with it.
import { test, expect, describe } from "bun:test";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
  utimesSync, statSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openThemeStore, isValidThemeName, slugThemeId, themeBaseOf, MAX_CUSTOM_THEMES,
  BUILTIN_THEME_IDS, type ThemeSkip,
} from "./theme-store";
import { derive } from "./theme-derive";

/** A parseable Ghostty theme. `extra` lets a test change the byte length. */
function themeText(bg = "1d2021", fg = "ebdbb2", extra = ""): string {
  const palette = Array.from({ length: 16 }, (_, i) => `palette = ${i}=${i.toString(16).repeat(6)}`);
  return [`# a theme${extra}`, `background = ${bg}`, `foreground = ${fg}`, ...palette].join("\n") + "\n";
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "ps-theme-"));
}

/** A root with a populated `themes/` subdir — the shape config.ts wires up. */
function withThemes(files: Record<string, string>): { root: string; dir: string } {
  const root = tmpRoot();
  const dir = join(root, "themes");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { root, dir };
}

// ------------------------------------------------------------------- list()

describe("list", () => {
  test("missing directory yields an empty list instead of throwing", () => {
    const root = tmpRoot();
    const store = openThemeStore(join(root, "themes"));
    const r = store.list();
    expect(r.themes).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.skipped).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("enumerates *.ghostty sorted by file name, ignoring everything else", () => {
    const { root, dir } = withThemes({
      "zulu.ghostty": themeText(),
      "alpha.ghostty": themeText(),
      "mike.ghostty": themeText(),
      "notes.txt": "not a theme",
      "README": "hello",
      ".alpha.ghostty.tmp": themeText(),
    });
    const store = openThemeStore(dir);
    const r = store.list();
    expect(r.themes.map((t) => t.id)).toEqual(["alpha", "mike", "zulu"]);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("entries carry a ParsedTheme the deriver accepts", () => {
    const { root, dir } = withThemes({ "solo.ghostty": themeText("2d2e2d", "d5d0c0") });
    const t = openThemeStore(dir).list().themes[0];
    expect(t.id).toBe("solo");
    expect(t.theme.background).toBe("#2d2e2d");
    expect(t.theme.palette.length).toBe(16);
    expect(derive(t.theme)["--bg"]).toBe("#2d2e2d");
    rmSync(root, { recursive: true, force: true });
  });

  test("one unparseable file is skipped and recorded; the others survive", () => {
    const { root, dir } = withThemes({
      "good-a.ghostty": themeText(),
      "broken.ghostty": "background = zzz\nforeground = ffffff\n",
      "good-b.ghostty": themeText(),
    });
    const skips: string[] = [];
    const store = openThemeStore(dir, { onSkip: (s) => skips.push(s.file) });
    const r = store.list();
    // The whole point: a bad file costs the user that theme, not all of them.
    expect(r.themes.map((t) => t.id)).toEqual(["good-a", "good-b"]);
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0].file).toBe("broken.ghostty");
    expect(r.skipped[0].reason).toBe("parse");
    expect(r.skipped[0].message).toContain("broken");
    expect(skips).toEqual(["broken.ghostty"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a truncated file (missing palette) is skipped, not fatal", () => {
    const { root, dir } = withThemes({
      "half.ghostty": "background = 000000\nforeground = ffffff\npalette = 0=111111\n",
      "whole.ghostty": themeText(),
    });
    const r = openThemeStore(dir).list();
    expect(r.themes.map((t) => t.id)).toEqual(["whole"]);
    expect(r.skipped[0].reason).toBe("parse");
    rmSync(root, { recursive: true, force: true });
  });

  test("an unreadable file reports reason 'read', not 'parse'", () => {
    // A dangling symlink: readFileSync gets ENOENT while readdir still lists the
    // entry. Deterministic everywhere and, unlike chmod 000, still a failure when
    // the suite runs as root on CI.
    const { root, dir } = withThemes({ "fine.ghostty": themeText() });
    symlinkSync(join(dir, "nowhere.ghostty"), join(dir, "dangling.ghostty"));
    const skips: ThemeSkip[] = [];
    const r = openThemeStore(dir, { onSkip: (s) => skips.push(s) }).list();
    expect(r.themes.map((t) => t.id)).toEqual(["fine"]);
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0].file).toBe("dangling.ghostty");
    // The distinction Task 10 shows the user: fix this in the shell, not in an
    // editor. Folding it into "parse" would send them to the wrong place.
    expect(r.skipped[0].reason).toBe("read");
    expect(skips.map((s) => s.reason)).toEqual(["read"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a directory named *.ghostty reports 'read' and does not take the listing down", () => {
    const { root, dir } = withThemes({ "fine.ghostty": themeText() });
    mkdirSync(join(dir, "oops.ghostty"));
    const r = openThemeStore(dir).list();
    expect(r.themes.map((t) => t.id)).toEqual(["fine"]);
    expect(r.skipped.map((s) => [s.file, s.reason])).toEqual([["oops.ghostty", "read"]]);
    rmSync(root, { recursive: true, force: true });
  });

  test("read failures and parse failures are reported apart in one listing", () => {
    const { root, dir } = withThemes({
      "a-broken.ghostty": "background = zzz\nforeground = ffffff\n",
      "c-fine.ghostty": themeText(),
    });
    symlinkSync(join(dir, "nowhere.ghostty"), join(dir, "b-dangling.ghostty"));
    const r = openThemeStore(dir).list();
    expect(r.themes.map((t) => t.id)).toEqual(["c-fine"]);
    expect(r.skipped.map((s) => [s.file, s.reason])).toEqual([
      ["a-broken.ghostty", "parse"],
      ["b-dangling.ghostty", "read"],
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a file whose NAME would break out of the CSS selector is skipped", () => {
    // `:root[data-theme="custom:<id>"]` — a quote or brace in the id escapes the
    // declaration. cp(1) will happily create such a file, so list() must filter
    // by the same rule save() enforces.
    const { root, dir } = withThemes({
      'ev"il.ghostty': themeText(),
      "a,b.ghostty": themeText(),
      "fine.ghostty": themeText(),
    });
    const r = openThemeStore(dir).list();
    expect(r.themes.map((t) => t.id)).toEqual(["fine"]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["name", "name"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("caps at 50 themes and reports the real total rather than dropping silently", () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 55; i++) files[`t${String(i).padStart(2, "0")}.ghostty`] = themeText();
    const { root, dir } = withThemes(files);
    const r = openThemeStore(dir).list();
    expect(MAX_CUSTOM_THEMES).toBe(50);
    expect(r.themes.length).toBe(50);
    expect(r.themes[0].id).toBe("t01");
    expect(r.themes[49].id).toBe("t50");
    expect(r.total).toBe(55);
    expect(r.truncated).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("the cap is injectable so the limit path is testable cheaply", () => {
    const { root, dir } = withThemes({
      "a.ghostty": themeText(), "b.ghostty": themeText(), "c.ghostty": themeText(),
    });
    const r = openThemeStore(dir, { max: 2 }).list();
    expect(r.themes.map((t) => t.id)).toEqual(["a", "b"]);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a path that is a file, not a directory, yields an empty list", () => {
    const root = tmpRoot();
    const notADir = join(root, "themes");
    writeFileSync(notADir, "surprise");
    expect(openThemeStore(notADir).list().themes).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------- name validity

describe("isValidThemeName", () => {
  test("accepts the shapes real Ghostty theme files use", () => {
    for (const ok of ["gruvbox-dark", "Tokyo Night", "cream_light", "3024 Day", "a", "v1.2"]) {
      expect(isValidThemeName(ok)).toBe(true);
    }
  });

  test("accepts non-Latin names — a theme file is not required to be English", () => {
    for (const ok of ["我的主题", "Café Noir", "テーマ", "Тема 1"]) {
      expect(isValidThemeName(ok), ok).toBe(true);
    }
  });

  test("rejects space-like characters that are not a plain ASCII space", () => {
    // U+00A0 and U+3000 are indistinguishable from a space in a file listing;
    // letting them through makes "why are there two Tokyo Nights" unanswerable.
    for (const bad of ["a\u00A0b", "a\u3000b", "a\u2028b", "a\tb"]) {
      expect(isValidThemeName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("rejects path traversal", () => {
    for (const bad of ["../evil", "a/b", "..", "../../etc/passwd", "a\\b", "/abs", ".hidden", "."]) {
      expect(isValidThemeName(bad)).toBe(false);
    }
  });

  test("rejects CSS-selector injection", () => {
    for (const bad of ['a"b', "a'b", "a{b}", "x;y", "a,b", "a<b", "a*b", "a)b", "a/*b"]) {
      expect(isValidThemeName(bad)).toBe(false);
    }
  });

  test("rejects control characters, newlines and NUL", () => {
    for (const bad of ["a\0b", "a\nb", "a\rb", "a\tb"]) {
      expect(isValidThemeName(bad)).toBe(false);
    }
  });

  test("rejects empty, whitespace-padded and over-long names", () => {
    expect(isValidThemeName("")).toBe(false);
    expect(isValidThemeName("   ")).toBe(false);
    expect(isValidThemeName(" pad")).toBe(false);
    expect(isValidThemeName("pad ")).toBe(false);
    expect(isValidThemeName("x".repeat(65))).toBe(false);
    expect(isValidThemeName("x".repeat(64))).toBe(true);
  });
});

// ------------------------------------------------------------ slugThemeId

describe("slugThemeId", () => {
  test("turns the names the upstream theme repo actually uses into ids", () => {
    // The reason this function exists: most of mbadolato/iTerm2-Color-Schemes
    // is named like this, and the id ends up in a CSS custom property name.
    expect(slugThemeId("Tokyo Night")).toBe("tokyo-night");
    expect(slugThemeId("3024 Day")).toBe("3024-day");
    expect(slugThemeId("Solarized Dark Higher Contrast")).toBe("solarized-dark-higher-contrast");
    expect(slugThemeId("gruvbox.2")).toBe("gruvbox-2");
    expect(slugThemeId("My_Theme")).toBe("my-theme");
    expect(slugThemeId("already-kebab")).toBe("already-kebab");
  });

  test("collapses runs of separators and trims the ends", () => {
    expect(slugThemeId("a  b")).toBe("a-b");
    expect(slugThemeId("a - _ . b")).toBe("a-b");
    expect(slugThemeId("-lead")).toBe("lead");
    expect(slugThemeId("trail-")).toBe("trail");
    expect(slugThemeId("__x__")).toBe("x");
  });

  test("folds accents to their ASCII base rather than hashing them away", () => {
    // `Café` has an unambiguous ASCII home; throwing that away for a hash would
    // make a perfectly readable id unreadable.
    expect(slugThemeId("Café Noir")).toBe("cafe-noir");
    expect(slugThemeId("Über Dark")).toBe("uber-dark");
  });

  test("a name with no ASCII content gets a stable hashed id, never an empty one", () => {
    // 我的主题 has no Latin transliteration this code could justify inventing,
    // and an empty id would be a broken selector. The *display* name is still
    // the file name, so the user sees 我的主题 in the menu either way.
    const zh = slugThemeId("我的主题");
    expect(zh).toMatch(/^theme-[0-9a-f]{8}$/);
    expect(slugThemeId("我的主题")).toBe(zh);            // stable across calls
    expect(slugThemeId("另一个主题")).not.toBe(zh);       // and distinct per name
    expect(slugThemeId("テーマ")).toMatch(/^theme-[0-9a-f]{8}$/);
  });

  test("a name of nothing but separators also falls back rather than yielding ''", () => {
    expect(slugThemeId("...")).toMatch(/^theme-[0-9a-f]{8}$/);
    expect(slugThemeId("___")).toMatch(/^theme-[0-9a-f]{8}$/);
  });

  test("never emits a leading or trailing dash, even at the length limit", () => {
    // A 64-char cut can land right on a separator; `--sw-custom-x--bg` is legal
    // but ugly and a trailing dash would collide with the suffix joint.
    const long = `${"a".repeat(63)} tail`;
    const s = slugThemeId(long);
    expect(s.length).toBeLessThanOrEqual(64);
    expect(s.startsWith("-")).toBe(false);
    expect(s.endsWith("-")).toBe(false);
  });

  test("every output is a legal CSS ident tail — the property this whole change rests on", () => {
    const names = [
      "Tokyo Night", "3024 Day", "gruvbox.2", "我的主题", "...", "Café", "A B  C",
      "x".repeat(64), "9lives", "-x-",
    ];
    for (const n of names) expect(slugThemeId(n), n).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe("themeBaseOf", () => {
  test("strips one .ghostty suffix and leaves everything else alone", () => {
    expect(themeBaseOf("Tokyo Night.ghostty")).toBe("Tokyo Night");
    expect(themeBaseOf("Tokyo Night")).toBe("Tokyo Night");
    expect(themeBaseOf("a.ghostty.ghostty")).toBe("a.ghostty");
  });
});

test("BUILTIN_THEME_IDS matches what app/themes/ actually ships", () => {
  // The agent cannot import from app/ at run time, so the built-in id list is
  // copied here. This is the guard against that copy going stale: add a
  // built-in theme and forget this list, and a user's file with the same name
  // would shadow it in the menu instead of being reported as a collision.
  const dir = join(import.meta.dir, "../../app/themes");
  const shipped = readdirSync(dir)
    .filter((f) => f.endsWith(".ghostty"))
    .map((f) => f.slice(0, -".ghostty".length))
    .sort();
  expect([...BUILTIN_THEME_IDS].sort()).toEqual(shipped);
});

// -------------------------------------------------------------- collisions

describe("id collisions", () => {
  test("two files that slug to one id keep the first by file name", () => {
    // `cp "Tokyo Night" …` next to an existing `tokyo-night.ghostty`. One of
    // them has to lose; which one must not depend on readdir order, and the
    // loser must be reported rather than silently vanish.
    const { root, dir } = withThemes({
      "Tokyo Night.ghostty": themeText("101010"),
      "tokyo-night.ghostty": themeText("202020"),
      "tokyo_night.ghostty": themeText("303030"),
    });
    const r = openThemeStore(dir).list();
    expect(r.themes.map((t) => [t.name, t.id])).toEqual([["Tokyo Night", "tokyo-night"]]);
    expect(r.skipped.map((s) => [s.file, s.reason])).toEqual([
      ["tokyo-night.ghostty", "dup"],
      ["tokyo_night.ghostty", "dup"],
    ]);
    // The message has to name the winner, or "duplicate" is unactionable.
    expect(r.skipped[0].message).toContain("Tokyo Night");
    rmSync(root, { recursive: true, force: true });
  });

  test("the winner is stable across repeated listings", () => {
    const { root, dir } = withThemes({
      "Zed Theme.ghostty": themeText(),
      "zed-theme.ghostty": themeText(),
    });
    const store = openThemeStore(dir);
    for (let i = 0; i < 3; i++) expect(store.list().themes[0].name).toBe("Zed Theme");
    rmSync(root, { recursive: true, force: true });
  });

  test("a custom theme cannot take a built-in's id — the built-in wins", () => {
    // `cp ~/.config/ghostty/themes/nord ~/.pocketshell/themes/nord.ghostty`.
    // The built-in tokens live in the bundled stylesheet and would win the
    // cascade regardless; an explicit skip is the honest version of that.
    const { root, dir } = withThemes({
      "nord.ghostty": themeText(),
      "Cream Dark.ghostty": themeText(),
      "mine.ghostty": themeText(),
    });
    const r = openThemeStore(dir).list();
    expect(r.themes.map((t) => t.id)).toEqual(["mine"]);
    expect(r.skipped.map((s) => [s.file, s.reason])).toEqual([
      ["Cream Dark.ghostty", "builtin"],
      ["nord.ghostty", "builtin"],
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test("collisions are settled before the cap, so the cap cannot change the winner", () => {
    const { root, dir } = withThemes({
      "A Theme.ghostty": themeText(),
      "a-theme.ghostty": themeText(),
      "b.ghostty": themeText(),
    });
    // With max=1 the loser is still a `dup` (not simply "cut off"), and `b`
    // is what truncation drops.
    const r = openThemeStore(dir, { max: 1 }).list();
    expect(r.themes.map((t) => t.name)).toEqual(["A Theme"]);
    expect(r.truncated).toBe(true);
    expect(r.skipped.map((s) => s.reason)).toEqual(["dup"]);
    rmSync(root, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------- slugged list

describe("list with slugged names", () => {
  test("a name with spaces becomes a theme, with the file name kept for display", () => {
    // The bug this change fixes: this file used to be reported as an unusable
    // name and the user was told to rename an official theme.
    const { root, dir } = withThemes({
      "Tokyo Night.ghostty": themeText("1a1b26", "c0caf5"),
      "3024 Day.ghostty": themeText("f7f7f7", "4a4543"),
    });
    const r = openThemeStore(dir).list();
    expect(r.themes.map((t) => [t.name, t.id])).toEqual([
      ["3024 Day", "3024-day"],
      ["Tokyo Night", "tokyo-night"],
    ]);
    expect(r.skipped).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a non-Latin file name yields a hashed id and keeps the name for display", () => {
    const { root, dir } = withThemes({ "我的主题.ghostty": themeText() });
    const r = openThemeStore(dir).list();
    expect(r.themes).toHaveLength(1);
    expect(r.themes[0].name).toBe("我的主题");
    expect(r.themes[0].id).toMatch(/^theme-[0-9a-f]{8}$/);
    rmSync(root, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------- save()

describe("save", () => {
  test("creates the directory on first save and the theme becomes listable", () => {
    const root = tmpRoot();
    const dir = join(root, "themes");
    const store = openThemeStore(dir);
    const r = store.save("mine", themeText("101010", "f0f0f0"));
    expect(r).toEqual({ ok: true, id: "mine", name: "mine", overwritten: false });
    expect(existsSync(join(dir, "mine.ghostty"))).toBe(true);
    expect(store.list().themes.map((t) => t.id)).toEqual(["mine"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a colliding name overwrites and says so", () => {
    const { root, dir } = withThemes({ "mine.ghostty": themeText("101010", "f0f0f0") });
    const store = openThemeStore(dir);
    const r = store.save("mine", themeText("222222", "eeeeee"));
    expect(r).toEqual({ ok: true, id: "mine", name: "mine", overwritten: true });
    expect(readFileSync(join(dir, "mine.ghostty"), "utf8")).toContain("background = 222222");
    expect(store.list().themes[0].theme.background).toBe("#222222");
    rmSync(root, { recursive: true, force: true });
  });

  test("a trailing .ghostty in the name is not doubled", () => {
    const root = tmpRoot();
    const dir = join(root, "themes");
    const store = openThemeStore(dir);
    expect(store.save("mine.ghostty", themeText())).toMatchObject({ ok: true, id: "mine" });
    expect(readdirSync(dir)).toEqual(["mine.ghostty"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("unparseable text is rejected and nothing is written", () => {
    const root = tmpRoot();
    const dir = join(root, "themes");
    const store = openThemeStore(dir);
    const r = store.save("junk", "hello world");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse");
      expect(r.message).toContain("background");
    }
    expect(existsSync(join(dir, "junk.ghostty"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("existing themes are untouched when a save is rejected", () => {
    const { root, dir } = withThemes({ "keep.ghostty": themeText("101010", "f0f0f0") });
    const store = openThemeStore(dir);
    expect(store.save("keep", "garbage").ok).toBe(false);
    expect(store.list().themes[0].theme.background).toBe("#101010");
    rmSync(root, { recursive: true, force: true });
  });

  test("path-traversal names are refused and write nothing outside the dir", () => {
    const root = tmpRoot();
    const dir = join(root, "themes");
    mkdirSync(dir, { recursive: true });
    const store = openThemeStore(dir);
    for (const bad of ["../escape", "..", "sub/child", "a\\b", "/etc/ps", "a\0b"]) {
      const r = store.save(bad, themeText());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("name");
    }
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(root)).toEqual(["themes"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("CSS-injection names are refused", () => {
    const root = tmpRoot();
    const dir = join(root, "themes");
    mkdirSync(dir, { recursive: true });
    const store = openThemeStore(dir);
    for (const bad of ['x"] {color:red} [a="', "a'b", "a{}b", "a;b", "a,b", "a\nb"]) {
      const r = store.save(bad, themeText());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("name");
    }
    expect(readdirSync(dir)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("at the cap a new theme is refused but an existing one can still be replaced", () => {
    const { root, dir } = withThemes({ "a.ghostty": themeText(), "b.ghostty": themeText() });
    const store = openThemeStore(dir, { max: 2 });
    const add = store.save("c", themeText());
    expect(add.ok).toBe(false);
    if (!add.ok) expect(add.reason).toBe("limit");
    expect(existsSync(join(dir, "c.ghostty"))).toBe(false);
    expect(store.save("a", themeText("333333", "cccccc"))).toMatchObject({ ok: true, overwritten: true });
    rmSync(root, { recursive: true, force: true });
  });

  test("a spaced name is accepted; the file keeps the name, the id is slugged", () => {
    // Import and `cp` must leave the directory in the same state for the same
    // theme, so the file is named as typed and only the id is derived.
    const root = tmpRoot();
    const dir = join(root, "themes");
    const store = openThemeStore(dir);
    expect(store.save("Tokyo Night", themeText()))
      .toEqual({ ok: true, id: "tokyo-night", name: "Tokyo Night", overwritten: false });
    expect(readdirSync(dir)).toEqual(["Tokyo Night.ghostty"]);
    expect(store.list().themes.map((t) => [t.name, t.id])).toEqual([["Tokyo Night", "tokyo-night"]]);
    rmSync(root, { recursive: true, force: true });
  });

  test("saving a name whose id another file already owns is refused, not silently lost", () => {
    // Writing it would create a file that then loses the collision and never
    // appears — a save that reports success and does nothing visible.
    const { root, dir } = withThemes({ "Tokyo Night.ghostty": themeText() });
    const store = openThemeStore(dir);
    const r = store.save("tokyo_night", themeText());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("dup");
      expect(r.message).toContain("Tokyo Night"); // names the winner
    }
    expect(readdirSync(dir)).toEqual(["Tokyo Night.ghostty"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("overwriting the same file is still allowed even though its id is taken", () => {
    // The collision check must not fire on the theme's own file.
    const { root, dir } = withThemes({ "Tokyo Night.ghostty": themeText("101010") });
    const store = openThemeStore(dir);
    expect(store.save("Tokyo Night", themeText("222222")))
      .toEqual({ ok: true, id: "tokyo-night", name: "Tokyo Night", overwritten: true });
    expect(store.list().themes[0].theme.background).toBe("#222222");
    rmSync(root, { recursive: true, force: true });
  });

  test("a name that slugs onto a built-in id is refused", () => {
    const root = tmpRoot();
    const dir = join(root, "themes");
    const store = openThemeStore(dir);
    for (const name of ["nord", "Nord", "Cream Dark", "cream_dark"]) {
      const r = store.save(name, themeText());
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.reason).toBe("builtin");
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("a non-Latin name saves under that name with a hashed id", () => {
    const root = tmpRoot();
    const dir = join(root, "themes");
    const store = openThemeStore(dir);
    const r = store.save("我的主题", themeText());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe("我的主题");
      expect(r.id).toMatch(/^theme-[0-9a-f]{8}$/);
    }
    expect(readdirSync(dir)).toEqual(["我的主题.ghostty"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("leaves no temp file behind", () => {
    const root = tmpRoot();
    const dir = join(root, "themes");
    const store = openThemeStore(dir);
    store.save("mine", themeText());
    expect(readdirSync(dir)).toEqual(["mine.ghostty"]);
    rmSync(root, { recursive: true, force: true });
  });
});

// ----------------------------------------------------------------- remove()

describe("remove", () => {
  test("true when it existed, false when it did not", () => {
    const { root, dir } = withThemes({ "gone.ghostty": themeText() });
    const store = openThemeStore(dir);
    expect(store.remove("gone")).toBe(true);
    expect(existsSync(join(dir, "gone.ghostty"))).toBe(false);
    expect(store.remove("gone")).toBe(false);
    expect(store.remove("never-existed")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("refuses traversal names without touching anything outside", () => {
    const root = tmpRoot();
    const dir = join(root, "themes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "secret.ghostty"), themeText());
    const store = openThemeStore(dir);
    expect(store.remove("../secret")).toBe(false);
    expect(store.remove("/etc/hosts")).toBe(false);
    expect(existsSync(join(root, "secret.ghostty"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("missing directory is not an error", () => {
    const root = tmpRoot();
    expect(openThemeStore(join(root, "themes")).remove("x")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("the key is the FILE name, not the id — the id is lossy and cannot name a file", () => {
    // `Tokyo Night` and `tokyo_night` share the id `tokyo-night`; deleting by
    // id would mean "delete whichever one wins the collision today".
    const { root, dir } = withThemes({ "Tokyo Night.ghostty": themeText() });
    const store = openThemeStore(dir);
    expect(store.remove("tokyo-night")).toBe(false);      // the id: no such file
    expect(existsSync(join(dir, "Tokyo Night.ghostty"))).toBe(true);
    expect(store.remove("Tokyo Night")).toBe(true);       // the file name: gone
    expect(existsSync(join(dir, "Tokyo Night.ghostty"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("removing the collision winner promotes the loser on the next listing", () => {
    // Which is why `dup` is a skip and not a deletion: the file is still there,
    // and it becomes the theme as soon as the conflict is resolved.
    const { root, dir } = withThemes({
      "Tokyo Night.ghostty": themeText("101010"),
      "tokyo_night.ghostty": themeText("202020"),
    });
    const store = openThemeStore(dir);
    expect(store.list().themes.map((t) => t.name)).toEqual(["Tokyo Night"]);
    expect(store.remove("Tokyo Night")).toBe(true);
    const after = store.list();
    expect(after.themes.map((t) => [t.name, t.id])).toEqual([["tokyo_night", "tokyo-night"]]);
    expect(after.skipped).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a non-Latin name round-trips through save and remove", () => {
    const root = tmpRoot();
    const dir = join(root, "themes");
    const store = openThemeStore(dir);
    store.save("我的主题", themeText());
    expect(store.remove("我的主题")).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ stamp()

describe("stamp", () => {
  test("is stable when nothing changes and empty when the directory is missing", () => {
    const root = tmpRoot();
    const store = openThemeStore(join(root, "themes"));
    expect(store.stamp()).toBe("");
    expect(store.stamp()).toBe(store.stamp());
    rmSync(root, { recursive: true, force: true });
  });

  test("changes on add, on in-place edit, and on remove", () => {
    const { root, dir } = withThemes({ "a.ghostty": themeText() });
    const store = openThemeStore(dir);
    const one = store.stamp();
    expect(one).not.toBe("");
    expect(store.stamp()).toBe(one); // idempotent read

    writeFileSync(join(dir, "b.ghostty"), themeText());
    const two = store.stamp();
    expect(two).not.toBe(one);

    // Edited in place: mtime alone can collide inside one millisecond, so the
    // size rides along (same reasoning as registry-watch.ts).
    writeFileSync(join(dir, "a.ghostty"), themeText("000000", "ffffff", " with a longer comment"));
    const three = store.stamp();
    expect(three).not.toBe(two);

    rmSync(join(dir, "b.ghostty"));
    const four = store.stamp();
    expect(four).not.toBe(three);
    expect(four).not.toBe(one);
    rmSync(root, { recursive: true, force: true });
  });

  test("size is part of the token, so a same-mtime rewrite still registers", () => {
    // Real filesystems can hand two writes the same millisecond. Rather than
    // race one, pin the mtime by hand and change only the length — if the stamp
    // were mtime-only this would look like "nothing happened" and the served
    // CSS would go stale until the next unrelated edit.
    const { root, dir } = withThemes({ "a.ghostty": themeText() });
    const store = openThemeStore(dir);
    const file = join(dir, "a.ghostty");
    const pinned = new Date(1_700_000_000_000);
    utimesSync(file, pinned, pinned);
    const before = store.stamp();

    writeFileSync(file, themeText("000000", "ffffff", " a much longer trailing comment"));
    utimesSync(file, pinned, pinned);
    expect(statSync(file).mtimeMs).toBe(pinned.getTime());
    expect(store.stamp()).not.toBe(before);
    rmSync(root, { recursive: true, force: true });
  });

  test("ignores non-theme files so unrelated writes do not trigger a reload", () => {
    const { root, dir } = withThemes({ "a.ghostty": themeText() });
    const store = openThemeStore(dir);
    const before = store.stamp();
    writeFileSync(join(dir, "scratch.txt"), "noise");
    expect(store.stamp()).toBe(before);
    rmSync(root, { recursive: true, force: true });
  });

  test("save and remove both move the stamp", () => {
    const root = tmpRoot();
    const dir = join(root, "themes");
    const store = openThemeStore(dir);
    const empty = store.stamp();
    store.save("mine", themeText());
    const saved = store.stamp();
    expect(saved).not.toBe(empty);
    store.remove("mine");
    expect(store.stamp()).not.toBe(saved);
    rmSync(root, { recursive: true, force: true });
  });
});
