// Pure HTTP handler for `GET /theme/custom.css`. Kept out of server.ts for the
// same reason server-preview.ts is: the interesting decisions (what goes in the
// stylesheet, which names are safe to put there, what the ETag covers) are worth
// unit-testing without standing up a server.
//
// Why a stylesheet and not a WS message (design §4.3): `<link rel="stylesheet">`
// blocks the first paint, so a user's own theme is on screen in the same frame
// as the built-ins — no flash, no cache layer, and no change to protocol.ts.
//
// Shape of the response (design §4.4/§4.5):
//
//   :root {
//     --ps-custom-themes: "mine,other";     ← the manifest the app reads
//     --ps-scheme-custom-mine: dark;        ← light/dark marker, per theme
//     --sw-custom-mine-bg: #101010;         ← five preview swatches, per theme
//     …
//   }
//   :root[data-theme="custom:mine"] { …the full token set… }
//
// Only the *selected* theme gets its full tokens. Fifty themes' worth of tokens
// would be ~250 KB on every page load to paint one of them; the swatches are
// ~100 bytes each and are needed for every theme at once (the settings panel
// shows what theme B looks like while theme A is active).
import { isLightBackground, derive, renderCss } from "./theme-derive";
import type { ThemeListing, ThemeSkip, ThemeStore } from "./theme-store";
import { contentEtag, isNotModified } from "./static-serve";

/** Same five colours, in the same order, as the built-in generator emits
 *  (`app/scripts/gen-themes.ts`): 机身 / 面板 / 主色 / 运行灯 / 文字. */
const SWATCH: ReadonlyArray<[suffix: string, token: string]> = [
  ["bg", "--bg"], ["panel", "--panel"], ["accent", "--accent"],
  ["ok", "--ok"], ["text", "--text"],
];

/**
 * Names that survive into a CSS *custom property* name.
 *
 * Stricter than `theme-store.isValidThemeName`, and it has to be. That one
 * guards a path segment and an attribute-selector value, where `3024 Day` and
 * `gruvbox.2` are both fine (`[data-theme="custom:3024 Day"]` is quoted). But
 * the swatch and scheme markers are *idents* — `--sw-custom-3024 Day-bg` ends
 * at the space and `--ps-scheme-custom-gruvbox.2` ends at the dot, and a
 * malformed declaration is dropped silently by every browser. The theme would
 * appear in the menu with a blank swatch and the wrong light/dark class.
 *
 * So a name that cannot be an ident does not go in the stylesheet at all; it
 * comes back as a skip instead, which the settings panel already knows how to
 * show. The user gets "renaming this file will fix it" rather than a theme that
 * half-works.
 *
 * This matches `app/src/lib/theme-css.ts`'s `tokenIdOf` — both sides turn
 * `custom:<name>` into `custom-<name>` — minus the characters that side's
 * `CUSTOM_NAME` lets through but CSS does not.
 */
const IDENT_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isCssIdentSafe(name: string): boolean {
  return IDENT_SAFE.test(name);
}

/** `mine` → `custom-mine`, the fragment used inside token names. Mirrors
 *  `tokenIdOf()` on the app side, which maps the id `custom:mine` the same way
 *  (a colon is not legal in a custom property name). */
export const tokenIdOf = (name: string): string => `custom-${name}`;

/**
 * Pack the skip list into one CSS string value: `reason:file` entries, comma
 * separated.
 *
 * The file name is the whole point of the message ("which of my files is
 * broken?"), and it is hostile input — `cp` will happily create
 * `a,b";}.ghostty`. Anything that would end the string, the declaration or the
 * rule is replaced with `_`, so a bad name degrades to a slightly-wrong label
 * rather than to a broken stylesheet. The detailed `message` is deliberately
 * left out: it is prose, sometimes multi-line, and the app shows a translated
 * per-reason string anyway (§Task 11 i18n).
 */
export function encodeSkips(skips: ThemeSkip[]): string {
  return skips
    .map((s) => `${s.reason}:${s.file.replace(/[",;{}():\n\r\\]/g, "_")}`)
    .join(",");
}

export interface ThemeCss {
  css: string;
  /** Themes actually rendered into the manifest, in order. */
  names: string[];
  /** Everything the store rejected plus everything this module rejected. */
  skipped: ThemeSkip[];
  /** Candidate files on disk, before the cap. */
  total: number;
  truncated: boolean;
}

/**
 * Render the listing as one stylesheet.
 *
 * `selected` is the *bare* name (the app strips `custom:` before asking). An
 * unknown or absent selection is not an error — it is what every page load
 * looks like when the user is on a built-in theme — and yields the manifest
 * alone.
 */
export function buildThemeCss(listing: ThemeListing, selected: string | null): ThemeCss {
  const skipped = [...listing.skipped];
  const usable = listing.themes.filter((t) => {
    if (isCssIdentSafe(t.id)) return true;
    skipped.push({
      file: t.file,
      reason: "name",
      message: `"${t.id}" cannot be used in a CSS token name (letters, digits, - and _ only); rename the file`,
    });
    return false;
  });

  const parts: string[] = [
    "/* PocketShell custom themes — generated per request from <keyDir>/themes/*.ghostty.",
    "   Derived by agent/src/theme-derive.ts, the same code that generates the",
    "   built-in src/theme-tokens.css, so an imported theme and a built-in one",
    "   cannot come out different colours. */",
    "",
  ];

  const manifest: string[] = [`  --ps-custom-themes: "${usable.map((t) => t.id).join(",")}";`];
  // The counters and the skip list ride in the stylesheet, not only in the
  // response headers. The app fetches this file with `<link>`, which exposes no
  // headers at all — `X-Theme-Truncated` is there for curl and for a future
  // fetch()-based caller, but the settings panel can only see what is in the CSS.
  // Without these two, "I copied 60 themes in and ten are missing" and "I copied
  // a broken file in and it doesn't show up" are both silent.
  manifest.push(`  --ps-custom-total: ${listing.total};`);
  // Truncation is its own flag rather than something the app infers from
  // `total > shown`. Those two differ whenever a file was *skipped*, and the
  // resulting message ("showing the first 1 of 3") would be a plain lie about a
  // directory holding one good theme and two broken files — with the real
  // explanation sitting right underneath it in the skip list.
  manifest.push(`  --ps-custom-truncated: ${listing.truncated ? 1 : 0};`);
  manifest.push(`  --ps-custom-skipped: "${encodeSkips(skipped)}";`);
  const blocks: string[] = [];

  for (const entry of usable) {
    const tokens = derive(entry.theme);
    const tid = tokenIdOf(entry.id);
    manifest.push("");
    manifest.push(`  --ps-scheme-${tid}: ${isLightBackground(entry.theme.background) ? "light" : "dark"};`);
    for (const [suffix, token] of SWATCH) manifest.push(`  --sw-${tid}-${suffix}: ${tokens[token]};`);
    if (entry.id === selected) {
      blocks.push(`/* selected: ${entry.id} */`);
      blocks.push(renderCss(tokens, `:root[data-theme="custom:${entry.id}"]`));
    }
  }

  parts.push(`:root {\n${manifest.join("\n")}\n}\n`);
  parts.push(...blocks);

  return {
    css: parts.join("\n"),
    names: usable.map((t) => t.id),
    skipped,
    total: listing.total,
    truncated: listing.truncated,
  };
}

/**
 * The route.
 *
 * Always 200 with a manifest, never 404, even with no themes and no directory:
 * the app hangs a plain `<link>` in its `<head>` and the empty manifest is what
 * tells it "no custom themes" as opposed to "the request failed". A 404 would
 * make the two indistinguishable without extra client code.
 *
 * `no-cache` rather than a max-age: the directory is a directory, the user can
 * edit a theme in an editor and expect a reload to show it. The ETag then makes
 * the common case (nothing changed) a 304 with no body.
 */
export function buildThemeCssResponse(
  store: ThemeStore,
  url: URL,
  ifNoneMatch: string | null,
): Response {
  const raw = url.searchParams.get("t");
  // The app sends the bare name, but tolerate the full id in case a URL is ever
  // hand-typed or copied out of the settings panel.
  const selected = raw ? (raw.startsWith("custom:") ? raw.slice("custom:".length) : raw) : null;

  const built = buildThemeCss(store.list(), selected);
  const bytes = new TextEncoder().encode(built.css);
  const etag = contentEtag(bytes);

  const headers: Record<string, string> = {
    "content-type": "text/css; charset=utf-8",
    "cache-control": "no-cache",
    ETag: etag,
  };
  // Not silently dropped (design §4.5): the settings panel turns this into a
  // visible "showing 50 of N" note. Sent on the 304 too — a client that skipped
  // the body still needs to know.
  if (built.truncated) headers["X-Theme-Truncated"] = String(built.total);

  if (isNotModified(ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  return new Response(bytes, { headers });
}

// --------------------------------------------------------------------- import

/** What the caller sends. Both transports (HTTP POST and the `theme.import`
 *  RPC) parse an untyped body into this. */
export interface ThemeImportBody {
  name?: unknown;
  text?: unknown;
}

export type ThemeImportResult =
  | { ok: true; id: string; overwritten: boolean }
  | { ok: false; reason: "name" | "parse" | "limit" | "write"; message: string };

/**
 * Validate and store one imported theme.
 *
 * Shared by the HTTP route and the RPC so the two cannot disagree about what is
 * acceptable, and so `reason` — which the settings panel turns into four
 * different messages — comes out of one place. `ThemeStore.save` already
 * refuses unsafe names, unparseable text and an over-full directory; this adds
 * the CSS-ident check (see `isCssIdentSafe`) so a name that would be accepted on
 * disk but silently mangled in a token name is refused up front rather than
 * saved into a theme that half-works.
 */
export function importTheme(store: ThemeStore, body: ThemeImportBody): ThemeImportResult {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!name) return { ok: false, reason: "name", message: "missing theme name" };
  if (!text.trim()) return { ok: false, reason: "parse", message: "missing theme text" };

  const bare = name.endsWith(".ghostty") ? name.slice(0, -".ghostty".length) : name;
  if (!isCssIdentSafe(bare)) {
    return {
      ok: false,
      reason: "name",
      message: `invalid theme name "${bare}": use letters, digits, dash and underscore only`,
    };
  }
  return store.save(bare, text);
}
