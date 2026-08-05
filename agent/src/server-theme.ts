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
//     --ps-custom-themes: "mine,other";     ← the manifest the app reads (ids)
//     --ps-name-custom-mine: "My Theme";    ← display name, per theme
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
 * Ids that survive into a CSS *custom property* name.
 *
 * This used to be a **user-facing rule**: the id was the file name verbatim, so
 * `3024 Day.ghostty` was refused with "rename the file" — the swatch and scheme
 * markers are idents, `--sw-custom-3024 Day-bg` ends at the space, and a
 * malformed declaration is dropped silently by every browser. That rule failed
 * the main use case, since most of `mbadolato/iTerm2-Color-Schemes` is named
 * that way, so ids are now slugged (`theme-store.slugThemeId`) and every id
 * reaching this module is `[a-z0-9-]+` by construction.
 *
 * It is kept as an **internal assertion**, not deleted: if the slug ever grows a
 * bug, the failure mode without this check is a stylesheet with a truncated
 * declaration — invisible, and it corrupts the *whole* manifest rule rather than
 * one theme. A tripped assertion instead costs that one theme and reports
 * `reason: "internal"`, which the panel shows as a bug in PocketShell rather
 * than as something the user did wrong.
 *
 * The `custom-` prefix that `tokenIdOf` adds keeps the ident legal even for an
 * id starting with a digit (`3024-day`), so a leading digit is fine here.
 */
const IDENT_SAFE = /^[a-z0-9][a-z0-9-]*$/;

export function isCssIdentSafe(id: string): boolean {
  return IDENT_SAFE.test(id);
}

/**
 * A display name that is safe inside a double-quoted CSS string value.
 *
 * Same treatment `encodeSkips` gives a file name and for the same reason: the
 * name comes from a file the user created with `cp`, and a quote or a brace in
 * it would end the declaration. Degrading a character to `_` costs a slightly
 * wrong label; not degrading it costs the entire manifest rule.
 */
const cssString = (s: string): string => s.replace(/[",;{}()\n\r\\]/g, "_");

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
    // Unreachable unless slugThemeId is broken — see isCssIdentSafe.
    skipped.push({
      file: t.file,
      reason: "internal",
      message: `slug "${t.id}" for "${t.name}" is not a legal CSS ident — this is a PocketShell bug`,
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
    // The display name, because the id is a slug of it (`Tokyo Night` →
    // `tokyo-night`) and showing the slug in the menu would be renaming the
    // user's theme behind their back.
    manifest.push(`  --ps-name-${tid}: "${cssString(entry.name)}";`);
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
  | { ok: true; id: string; name: string; overwritten: boolean }
  | { ok: false; reason: "name" | "dup" | "builtin" | "parse" | "limit" | "write"; message: string };

/**
 * Validate and store one imported theme.
 *
 * Shared by the HTTP route and the RPC so the two cannot disagree about what is
 * acceptable, and so `reason` — which the settings panel turns into a different
 * message each — comes out of one place.
 *
 * Thin on purpose: `ThemeStore.save` owns every rule (unsafe names, slug
 * collisions with another theme or with a built-in, unparseable text, the cap),
 * so pasting "Tokyo Night" into the import box and copying `Tokyo Night.ghostty`
 * into the directory land in exactly the same place. This layer used to add its
 * own CSS-ident check, which is what made the import box refuse the very names
 * the upstream theme repository uses.
 */
export function importTheme(store: ThemeStore, body: ThemeImportBody): ThemeImportResult {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!name) return { ok: false, reason: "name", message: "missing theme name" };
  if (!text.trim()) return { ok: false, reason: "parse", message: "missing theme text" };
  return store.save(name, text);
}
