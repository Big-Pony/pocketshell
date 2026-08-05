// agent/src/theme-store.ts
// The user's own themes: plain `.ghostty` files under `<keyDir>/themes/`.
//
// Why a directory of files and not a table in pocketshell.db (which is where
// snippets and hints live): the whole point of this feature is that a user with
// Ghostty installed can `cp ~/.config/ghostty/themes/foo ~/.pocketshell/themes/`
// and be done. A database would make the primary path an import UI. The
// directory also survives OTA (keyDir is not in the binary) and travels with the
// machine, which is what `<link rel="stylesheet">` needs in order to make the
// no-flash-on-first-frame story work (design §4.3).
//
// Shape follows snippet-store.ts: a factory returning an object, no globals, and
// the awkward parts (the cap, the skip reporter) injected so tests do not have
// to create fifty files or capture stdout.
//
// Everything here treats the directory as hostile input. A file NAME reaches a
// CSS selector (`:root[data-theme="custom:<id>"]`) and a file's CONTENT reaches
// a stylesheet, and `cp` will cheerfully create `ev"il.ghostty`. Two rules fall
// out: names are validated on the way in AND on the way out, and one bad file
// costs the user that theme rather than all of them — the alternative is that a
// stray editor backup makes every custom theme vanish with no explanation.
import {
  readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { parseGhostty, type ParsedTheme } from "./theme-derive";

/** Pure defence against accidents, not performance: 50 is far more themes than
 *  anyone picks between, and it stops someone who cloned a 600-theme repo into
 *  the directory from turning every stylesheet request into 600 file reads. */
export const MAX_CUSTOM_THEMES = 50;

const EXT = ".ghostty";
const MAX_NAME_LEN = 64;

/**
 * Built-in theme ids, i.e. the base names of `app/themes/*.ghostty`.
 *
 * The agent has to know them because a slugged custom name can land on one of
 * them (`cp nord ~/.pocketshell/themes/nord.ghostty`), and the settings panel
 * would then show two rows the user cannot tell apart. Duplicated here rather
 * than imported: nothing from `app/` is on the agent's runtime path. The drift
 * guard is a test that reads the directory (`theme-store.test.ts`).
 */
export const BUILTIN_THEME_IDS: readonly string[] = Object.freeze([
  "blackout", "cream-dark", "cream-light", "gruvbox-dark", "mocha", "nord", "tokyonight",
]);
const BUILTIN = new Set(BUILTIN_THEME_IDS);

/**
 * Names must be safe as a path segment and as a quoted CSS string, so this is
 * an allowlist rather than a blocklist — a blocklist over two different
 * grammars is a bet nobody should take.
 *
 * Allowed: Unicode letters and digits (so `我的主题.ghostty` and `Café.ghostty`
 * are themes, not errors), combining marks, plus space, dot, dash and
 * underscore; must start with a letter or digit. That covers how Ghostty themes
 * are actually named ("Tokyo Night", "gruvbox-dark", "3024 Day") while
 * excluding `/` and `\` (traversal), a leading dot (hidden files, and `.`/`..`),
 * quotes, braces, semicolons, commas, angle brackets, every control character
 * including NUL and newline, and every space-like character that is not a plain
 * ASCII space (U+00A0 and friends are confusables in a file name).
 *
 * Note what this rule no longer has to do: it does *not* have to keep the name
 * usable as a CSS ident. `slugThemeId` handles that, so the file can be called
 * whatever the upstream theme is called and the id is derived.
 */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._-]*$/u;

export function isValidThemeName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LEN) return false;
  if (!NAME_RE.test(name)) return false;
  if (name !== name.trim()) return false; // trailing space: legal path, confusing id
  if (name.includes("..")) return false;  // belt and braces; `/` is already out
  return true;
}

/** Strip an optional `.ghostty` suffix so `save("foo.ghostty")` and
 *  `save("foo")` mean the same thing (people paste file names). */
export function themeBaseOf(fileName: string): string {
  return fileName.endsWith(EXT) ? fileName.slice(0, -EXT.length) : fileName;
}

/** 32-bit FNV-1a, hex. Only used to give a name with no ASCII content a stable,
 *  distinct id; nothing security-relevant hangs off it. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * File name → theme **id**: the string that ends up in a CSS custom property
 * name (`--sw-custom-<id>-bg`) and in `[data-theme="custom:<id>"]`.
 *
 * The display name and the id used to be the same string, which meant the 602
 * themes in `mbadolato/iTerm2-Color-Schemes` — most of them named like
 * "Tokyo Night" and "3024 Day" — were unusable: `--sw-custom-3024 Day-bg` ends
 * at the space and the whole declaration is dropped silently. Telling the user
 * to rename an official theme file is a worse answer than deriving an id.
 *
 * Rules, in order:
 *  1. NFKD-normalise and drop combining marks, so `Café` → `Cafe`. Accented
 *     Latin has an unambiguous ASCII home and the alternative (a hash) throws
 *     away a perfectly readable name.
 *  2. Lowercase; every run of anything outside `[a-z0-9]` becomes one `-`;
 *     leading/trailing `-` go. So `Tokyo Night` → `tokyo-night`,
 *     `3024 Day` → `3024-day`, `gruvbox.2` → `gruvbox-2`, `My_Theme` → `my-theme`.
 *  3. Truncated to the same 64 as the name, then re-trimmed (a cut can leave a
 *     trailing dash).
 *  4. Empty result → `theme-<hash of the original name>`. This is where scripts
 *     that are not Latin land: `我的主题` has no ASCII home, and a hash is at
 *     least stable across restarts and distinct per name — the user still sees
 *     `我的主题` in the menu, because the *display name* is the file name and
 *     only the id is slugged.
 *
 * Mirrored by `slugThemeId` in `app/src/lib/theme-css.ts`; the two are pinned
 * together by a cross-package test.
 */
export function slugThemeId(name: string): string {
  const folded = name.normalize("NFKD").replace(/\p{M}+/gu, "");
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LEN)
    .replace(/-+$/, "");
  return slug || `theme-${fnv1a(name)}`;
}

export interface ThemeEntry {
  /** Slugged base name. Used as the `custom:<id>` theme id and in token names. */
  id: string;
  /** Base name as the user wrote it — what the settings panel shows. */
  name: string;
  /** File name as it sits on disk, for error messages. */
  file: string;
  theme: ParsedTheme;
}

/**
 * Why a file in the directory did not become a theme. Surfaced rather than
 * swallowed: "my theme doesn't show up" is unanswerable without it.
 *
 *  - `name`    — the file name is not usable at all (traversal, quotes, …).
 *  - `dup`     — its id collides with another custom theme's; first by file
 *                name won.
 *  - `builtin` — its id collides with a built-in theme's.
 *  - `parse`   — not a complete Ghostty theme.
 *  - `read`    — could not be read (permissions, dangling symlink, a directory).
 *  - `internal`— a slug that is somehow not a legal CSS ident. Never expected;
 *                emitted by `server-theme.ts` as a last-line assertion so a bug
 *                in the slug costs one theme rather than a broken stylesheet.
 */
export interface ThemeSkip {
  file: string;
  reason: "name" | "dup" | "builtin" | "parse" | "read" | "internal";
  message: string;
}

export interface ThemeListing {
  /** Parsed themes, sorted by file name, at most `max` of them. */
  themes: ThemeEntry[];
  /** Candidate theme files found (before the cap). */
  total: number;
  /** True when `total > max` — the caller should tell the user, not hide it. */
  truncated: boolean;
  skipped: ThemeSkip[];
}

export type SaveResult =
  /** `id` is the slug the theme is addressed by; `name` is the file it went to
   *  (they differ whenever the name needed slugging, which the UI reports). */
  | { ok: true; id: string; name: string; overwritten: boolean }
  | { ok: false; reason: "name" | "dup" | "builtin" | "parse" | "limit" | "write"; message: string };

export interface ThemeStore {
  list(): ThemeListing;
  save(name: string, text: string): SaveResult;
  /** Delete by **file/display name**, not by slug — see the note on `remove`. */
  remove(name: string): boolean;
  /**
   * Cheap change token for the directory. Callers cache rendered CSS against it
   * and re-read only when it moves.
   *
   * Polling a stamp, not fs.watch — same reason registry-watch.ts gives: on
   * macOS a directory watch missed an atomic tmp+rename outright, and `save()`
   * here is exactly a tmp+rename. A handful of stat() calls costs nothing.
   * mtime alone would miss a same-millisecond rewrite, so size rides along.
   */
  stamp(): string;
}

export interface ThemeStoreOpts {
  /** Override the cap. Tests use it to exercise the limit with three files. */
  max?: number;
  /** Called once per unusable file. Default: nothing — the listing already
   *  carries `skipped`, and the agent should not spam the log on every request. */
  onSkip?: (skip: ThemeSkip) => void;
}

/** Theme files in the directory, sorted, with invalid names split off.
 *  A missing directory (or a path that is not a directory) is not an error —
 *  most installs never create one. */
function scan(dir: string): { files: string[]; skipped: ThemeSkip[] } {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { files: [], skipped: [] };
  }
  const files: string[] = [];
  const skipped: ThemeSkip[] = [];
  for (const e of entries.slice().sort()) {
    if (!e.endsWith(EXT)) continue;
    const name = e.slice(0, -EXT.length);
    if (!isValidThemeName(name)) {
      skipped.push({
        file: e,
        reason: "name",
        message: `unusable theme name "${name}" (letters, digits, space, . - _ only; must not start with a dot)`,
      });
      continue;
    }
    files.push(e);
  }
  return { files, skipped };
}

/**
 * Resolve slug collisions across a sorted file list.
 *
 * Two different files can slug to one id — `Tokyo Night.ghostty` and
 * `tokyo-night.ghostty` both give `tokyo-night` — and a slug can also land on a
 * built-in (`nord.ghostty` in the keyDir). Both are decided the same way:
 * *whoever is first wins*, deterministically. The list is sorted by file name,
 * so the winner does not change between two requests, and the loser becomes a
 * skip the panel can explain rather than a theme that silently replaces
 * another one in the menu.
 *
 * Built-ins beat every custom theme: a user's `nord.ghostty` cannot shadow the
 * shipped `nord`, because the shipped tokens are in the bundled stylesheet and
 * would win the cascade anyway — the honest outcome is a skip that says so.
 */
function resolveIds(
  files: string[],
): { keep: Array<{ file: string; name: string; id: string }>; skipped: ThemeSkip[] } {
  const keep: Array<{ file: string; name: string; id: string }> = [];
  const skipped: ThemeSkip[] = [];
  const taken = new Map<string, string>(); // id → the file that claimed it
  for (const file of files) {
    const name = file.slice(0, -EXT.length);
    const id = slugThemeId(name);
    if (BUILTIN.has(id)) {
      skipped.push({
        file,
        reason: "builtin",
        message: `"${name}" resolves to the built-in theme id "${id}"; rename the file to keep both`,
      });
      continue;
    }
    const owner = taken.get(id);
    if (owner !== undefined) {
      skipped.push({
        file,
        reason: "dup",
        message: `"${name}" and "${themeBaseOf(owner)}" both resolve to "${id}"; keeping "${themeBaseOf(owner)}"`,
      });
      continue;
    }
    taken.set(id, file);
    keep.push({ file, name, id });
  }
  return { keep, skipped };
}

export function openThemeStore(dir: string, opts: ThemeStoreOpts = {}): ThemeStore {
  const max = opts.max ?? MAX_CUSTOM_THEMES;
  const onSkip = opts.onSkip ?? (() => {});

  const pathOf = (id: string) => join(dir, `${id}${EXT}`);

  return {
    list() {
      const { files, skipped } = scan(dir);
      const total = files.length;
      // Collisions are settled before the cap, and on names alone — it is
      // string work over a sorted list, no extra IO, and doing it after the cap
      // would make which file wins depend on where the cap happened to fall.
      const { keep, skipped: clashes } = resolveIds(files);
      skipped.push(...clashes);
      const truncated = keep.length > max;
      const themes: ThemeEntry[] = [];
      // Parse only up to the cap: `total` is honest about how many files are
      // there, but reading 600 of them to then throw 550 away would be work
      // done purely to be tidy.
      for (const { file, name, id } of keep.slice(0, max)) {
        // Read and parse are separate try blocks on purpose. Both end in "this
        // file did not become a theme", but the user's next move differs: a read
        // failure (permissions, a dangling symlink, a directory wearing a
        // .ghostty name, a delete that raced us) is fixed in the shell, while a
        // parse failure is fixed by editing the theme. Task 10 shows the reason
        // in the UI, so folding them into one catch would make the label a lie.
        let text: string;
        try {
          text = readFileSync(join(dir, file), "utf8");
        } catch (e) {
          skipped.push({ file, reason: "read", message: String((e as Error)?.message ?? e) });
          continue;
        }
        try {
          themes.push({ id, name, file, theme: parseGhostty(text, name) });
        } catch (e) {
          skipped.push({ file, reason: "parse", message: String((e as Error)?.message ?? e) });
        }
      }
      for (const s of skipped) onSkip(s);
      return { themes, total, truncated, skipped };
    },

    save(name, text) {
      // The file keeps the name the user typed; only the id is slugged. Import
      // "Tokyo Night" and the file is `Tokyo Night.ghostty`, exactly as if it
      // had been copied in — the two paths must not produce different directory
      // contents for the same theme.
      const base = themeBaseOf(name.trim());
      if (!isValidThemeName(base)) {
        return {
          ok: false,
          reason: "name",
          message: `invalid theme name "${name}": use letters, digits, space, dot, dash or underscore`,
        };
      }
      const id = slugThemeId(base);
      if (BUILTIN.has(id)) {
        return {
          ok: false,
          reason: "builtin",
          message: `"${base}" resolves to the built-in theme id "${id}"; pick another name`,
        };
      }
      // Validate before writing, never after: an unparseable file on disk is a
      // theme the user thinks they saved and a skip record they never read.
      try {
        parseGhostty(text, base);
      } catch (e) {
        return { ok: false, reason: "parse", message: String((e as Error)?.message ?? e) };
      }

      const { files } = scan(dir);
      const target = `${base}${EXT}`;
      const overwritten = files.includes(target);
      // A *different* file that already owns this id: writing would create a
      // second file that then loses the collision and never appears. Refusing
      // up front, with the winner named, beats a save that silently does
      // nothing visible.
      if (!overwritten) {
        const clash = files.find((f) => slugThemeId(f.slice(0, -EXT.length)) === id);
        if (clash) {
          return {
            ok: false,
            reason: "dup",
            message: `"${themeBaseOf(clash)}" already uses the id "${id}"; delete it or pick another name`,
          };
        }
      }
      // The cap bounds how many themes exist, so replacing one is always fine
      // even at the limit — otherwise a full directory would be unfixable from
      // the UI.
      if (!overwritten && files.length >= max) {
        return {
          ok: false,
          reason: "limit",
          message: `theme limit reached (${max}); remove one before adding another`,
        };
      }

      const tmp = join(dir, `.${base}${EXT}.tmp`);
      try {
        mkdirSync(dir, { recursive: true });
        // tmp+rename so a half-written file is never visible to a concurrent
        // stylesheet request (and never lands in the listing as a parse skip).
        writeFileSync(tmp, text, { mode: 0o600 });
        renameSync(tmp, pathOf(base));
      } catch (e) {
        try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
        return { ok: false, reason: "write", message: String((e as Error)?.message ?? e) };
      }
      return { ok: true, id, name: base, overwritten };
    },

    /**
     * Delete by **file name**, not by slug.
     *
     * The slug is lossy — `Tokyo Night` and `tokyo_night` share one — so it
     * cannot name a file, and resolving it back would mean "delete whichever
     * file happens to win the collision today". The file name is what the panel
     * displays and what `ThemeEntry.name` carries, so the caller always has it.
     */
    remove(name) {
      const base = themeBaseOf(name.trim());
      if (!isValidThemeName(base)) return false; // never let a name we would not write be a name we delete
      try {
        unlinkSync(pathOf(base));
        return true;
      } catch {
        return false; // missing file, missing dir, or not ours to delete
      }
    },

    stamp() {
      const { files } = scan(dir);
      const parts: string[] = [];
      for (const f of files) {
        try {
          const st = statSync(join(dir, f));
          parts.push(`${f}:${st.mtimeMs}:${st.size}`);
        } catch {
          // Vanished between readdir and stat: its absence is itself a change,
          // and the next stamp will agree.
        }
      }
      return parts.join("|");
    },
  };
}
