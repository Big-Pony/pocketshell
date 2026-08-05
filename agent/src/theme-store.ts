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
 * Names must be safe as BOTH a path segment and a CSS attribute-selector value,
 * so this is an allowlist rather than a blocklist — a blocklist over two
 * different grammars is a bet nobody should take.
 *
 * Allowed: ASCII letters/digits, space, dot, dash, underscore; must start with a
 * letter or digit. That covers how Ghostty themes are actually named
 * ("Tokyo Night", "gruvbox-dark", "3024 Day") while excluding `/` and `\`
 * (traversal), a leading dot (hidden files, and `.`/`..`), quotes, braces,
 * semicolons, commas, angle brackets and every control character including NUL
 * and newline (selector and declaration escapes).
 */
const NAME_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,${MAX_NAME_LEN - 1}}$`);

export function isValidThemeName(name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  if (name !== name.trim()) return false; // trailing space: legal path, confusing id
  if (name.includes("..")) return false;  // belt and braces; `/` is already out
  return true;
}

/** Strip an optional `.ghostty` suffix so `save("foo.ghostty")` and
 *  `save("foo")` mean the same thing (people paste file names). */
export function themeIdOf(fileName: string): string {
  return fileName.endsWith(EXT) ? fileName.slice(0, -EXT.length) : fileName;
}

export interface ThemeEntry {
  /** Base name without extension. Used verbatim as the `custom:<id>` theme id. */
  id: string;
  /** File name as it sits on disk, for error messages. */
  file: string;
  theme: ParsedTheme;
}

/** Why a file in the directory did not become a theme. Surfaced rather than
 *  swallowed: "my theme doesn't show up" is unanswerable without it. */
export interface ThemeSkip {
  file: string;
  reason: "name" | "parse" | "read";
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
  | { ok: true; id: string; overwritten: boolean }
  | { ok: false; reason: "name" | "parse" | "limit" | "write"; message: string };

export interface ThemeStore {
  list(): ThemeListing;
  save(name: string, text: string): SaveResult;
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
    const id = e.slice(0, -EXT.length);
    if (!isValidThemeName(id)) {
      skipped.push({
        file: e,
        reason: "name",
        message: `unusable theme name "${id}" (letters, digits, space, . - _ only; must not start with a dot)`,
      });
      continue;
    }
    files.push(e);
  }
  return { files, skipped };
}

export function openThemeStore(dir: string, opts: ThemeStoreOpts = {}): ThemeStore {
  const max = opts.max ?? MAX_CUSTOM_THEMES;
  const onSkip = opts.onSkip ?? (() => {});

  const pathOf = (id: string) => join(dir, `${id}${EXT}`);

  return {
    list() {
      const { files, skipped } = scan(dir);
      const total = files.length;
      const truncated = total > max;
      const themes: ThemeEntry[] = [];
      // Parse only up to the cap: `total` is honest about how many files are
      // there, but reading 600 of them to then throw 550 away would be work
      // done purely to be tidy.
      for (const file of files.slice(0, max)) {
        const id = file.slice(0, -EXT.length);
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
          themes.push({ id, file, theme: parseGhostty(text, id) });
        } catch (e) {
          skipped.push({ file, reason: "parse", message: String((e as Error)?.message ?? e) });
        }
      }
      for (const s of skipped) onSkip(s);
      return { themes, total, truncated, skipped };
    },

    save(name, text) {
      const id = themeIdOf(name.trim());
      if (!isValidThemeName(id)) {
        return {
          ok: false,
          reason: "name",
          message: `invalid theme name "${name}": use letters, digits, space, dot, dash or underscore`,
        };
      }
      // Validate before writing, never after: an unparseable file on disk is a
      // theme the user thinks they saved and a skip record they never read.
      try {
        parseGhostty(text, id);
      } catch (e) {
        return { ok: false, reason: "parse", message: String((e as Error)?.message ?? e) };
      }

      const { files } = scan(dir);
      const overwritten = files.includes(`${id}${EXT}`);
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

      const target = pathOf(id);
      const tmp = join(dir, `.${id}${EXT}.tmp`);
      try {
        mkdirSync(dir, { recursive: true });
        // tmp+rename so a half-written file is never visible to a concurrent
        // stylesheet request (and never lands in the listing as a parse skip).
        writeFileSync(tmp, text, { mode: 0o600 });
        renameSync(tmp, target);
      } catch (e) {
        try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
        return { ok: false, reason: "write", message: String((e as Error)?.message ?? e) };
      }
      return { ok: true, id, overwritten };
    },

    remove(name) {
      const id = themeIdOf(name.trim());
      if (!isValidThemeName(id)) return false; // never let a name we would not write be a name we delete
      try {
        unlinkSync(pathOf(id));
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
