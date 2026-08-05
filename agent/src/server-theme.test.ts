// agent/src/server-theme.test.ts
// Task 10: the two routes that make a user's own .ghostty files reach the app.
//
// The stylesheet is the interesting one, and the reason it is a stylesheet at
// all is a first-frame guarantee (design §4.3): a blocking <link> means a custom
// theme is painted in the same frame as a built-in, with no cache logic. The
// cost of that choice is that the app can only see what is *in the CSS* —
// <link> exposes no response headers — which is why the manifest carries the
// skip list and the file count, and why every failure mode below has to end in
// something the settings panel can render rather than in a missing theme.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openThemeStore, type ThemeListing, type ThemeStore } from "./theme-store";
import { loadConfig } from "./config";
import { startServer } from "./server";
import { encode, decodeServer } from "./protocol";
import type { SecureChannel } from "./secure-channel";
import { parseGhostty, derive } from "./theme-derive";
import {
  buildThemeCss, buildThemeCssResponse, importTheme, isCssIdentSafe, encodeSkips, tokenIdOf,
} from "./server-theme";

function themeText(bg = "1d2021", fg = "ebdbb2"): string {
  const palette = Array.from({ length: 16 }, (_, i) => `palette = ${i}=${i.toString(16).repeat(6)}`);
  return ["# a theme", `background = ${bg}`, `foreground = ${fg}`, ...palette].join("\n") + "\n";
}

/** A themes dir with the given files, plus the store over it. */
function withThemes(files: Record<string, string>): { root: string; store: ThemeStore } {
  const root = mkdtempSync(join(tmpdir(), "ps-theme-http-"));
  const dir = join(root, "themes");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { root, store: openThemeStore(dir) };
}

const listingOf = (files: Record<string, string>): { root: string; listing: ThemeListing } => {
  const { root, store } = withThemes(files);
  return { root, listing: store.list() };
};

// WS test scaffolding, same shape as server.test.ts's (a marker handshake and a
// socket that just records what was sent — no crypto, since none of it is what
// these tests are about).
const M1 = new Uint8Array([1]);
const M2 = new Uint8Array([2]);
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

function passthroughResponder(): SecureChannel {
  let state: SecureChannel["state"] = "handshaking";
  return {
    get state() { return state; },
    start() { return null; },
    receive(frame) {
      if (state === "handshaking") { state = "transport"; return { status: "handshake", reply: M2, established: true }; }
      return { status: "message", plaintext: frame };
    },
    send(pt) { return pt; },
  };
}

type FakeWs = { sent: Uint8Array[]; send(d: Uint8Array | string): void; close(): void };
function fakeWs(): FakeWs {
  const sent: Uint8Array[] = [];
  return { sent, send(d) { sent.push(typeof d === "string" ? utf8(d) : d); }, close() {} };
}

/** Value of one declaration in the rendered CSS. */
function decl(css: string, token: string): string | null {
  const m = css.match(new RegExp(`^\\s*${token}\\s*:\\s*([^;]+);`, "m"));
  return m ? m[1].trim() : null;
}

// ------------------------------------------------------------- buildThemeCss

describe("buildThemeCss", () => {
  test("no themes at all still yields an empty manifest, not nothing", () => {
    // 200-with-empty-manifest rather than 404 is what lets the app treat "no
    // custom themes" and "request failed" the same way: read the token, get "".
    const { root, listing } = listingOf({});
    const built = buildThemeCss(listing, null);
    expect(decl(built.css, "--ps-custom-themes")).toBe('""');
    expect(built.names).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("lists every theme in the manifest but only expands the selected one", () => {
    // Design §4.5: the token set is ~100 declarations; fifty of them on every
    // page load would be a quarter of a megabyte to paint one theme.
    const { root, listing } = listingOf({
      "one.ghostty": themeText("101010", "f0f0f0"),
      "two.ghostty": themeText("202020", "e0e0e0"),
    });
    const built = buildThemeCss(listing, "two");
    expect(decl(built.css, "--ps-custom-themes")).toBe('"one,two"');
    expect(built.css).toContain(':root[data-theme="custom:two"]');
    expect(built.css).not.toContain(':root[data-theme="custom:one"]');
    // The selected block is the full set, not a subset.
    expect(Object.keys(derive(parseGhostty(themeText("202020", "e0e0e0")))).length)
      .toBe([...built.css.matchAll(/^ {2}--[a-z0-9-]+:/gm)].length
        - [...built.css.matchAll(/^ {2}--(?:ps|sw)-[a-z0-9-]+:/gm)].length);
    rmSync(root, { recursive: true, force: true });
  });

  test("an unknown or absent selection is not an error — just the manifest", () => {
    // This is every page load where the user is on a built-in theme, plus the
    // case where they deleted the theme they were using from another device.
    const { root, listing } = listingOf({ "one.ghostty": themeText() });
    for (const sel of [null, "nope"]) {
      const built = buildThemeCss(listing, sel);
      expect(decl(built.css, "--ps-custom-themes")).toBe('"one"');
      expect(built.css).not.toContain("data-theme=");
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("every theme gets a scheme marker and five swatches", () => {
    // The settings panel shows what theme B looks like while theme A is active,
    // so these live in the attribute-less :root and must be there for all of them.
    const { root, listing } = listingOf({
      "dim.ghostty": themeText("101010", "f0f0f0"),
      "bright.ghostty": themeText("fafafa", "202020"),
    });
    const built = buildThemeCss(listing, null);
    expect(decl(built.css, "--ps-scheme-custom-dim")).toBe("dark");
    expect(decl(built.css, "--ps-scheme-custom-bright")).toBe("light");
    for (const s of ["bg", "panel", "accent", "ok", "text"]) {
      expect(decl(built.css, `--sw-custom-dim-${s}`), s).toMatch(/^#[0-9a-f]{6}$/);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("swatch values equal the theme's real tokens", () => {
    // The same cross-check app.css.test.ts runs on the built-ins: a preview
    // strip that drifts from the theme is worse than no preview.
    const text = themeText("123456", "eeeeee");
    const { root, listing } = listingOf({ "mine.ghostty": text });
    const built = buildThemeCss(listing, "mine");
    const t = derive(parseGhostty(text));
    for (const [s, token] of [["bg", "--bg"], ["panel", "--panel"], ["accent", "--accent"],
      ["ok", "--ok"], ["text", "--text"]] as const) {
      expect(decl(built.css, `--sw-custom-mine-${s}`), s).toBe(t[token]);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("token names use custom-<name>, matching the app's tokenIdOf", () => {
    // A colon is not legal in a custom property name: `--ps-scheme-custom:mine`
    // is dropped by the parser and the theme silently gets the wrong light/dark
    // class. The selector keeps the colon (it is inside quotes there).
    expect(tokenIdOf("mine")).toBe("custom-mine");
    const { root, listing } = listingOf({ "mine.ghostty": themeText() });
    const built = buildThemeCss(listing, "mine");
    expect(built.css).toContain("--ps-scheme-custom-mine:");
    expect(built.css).not.toContain("--ps-scheme-custom:mine");
    expect(built.css).toContain(':root[data-theme="custom:mine"]');
    rmSync(root, { recursive: true, force: true });
  });

  test("a broken file costs its own theme and nothing else", () => {
    const { root, listing } = listingOf({
      "good.ghostty": themeText(),
      "junk.ghostty": "this is not a theme",
    });
    const built = buildThemeCss(listing, "good");
    expect(built.names).toEqual(["good"]);
    expect(built.skipped.map((s) => [s.file, s.reason])).toEqual([["junk.ghostty", "parse"]]);
    expect(built.css).toContain(':root[data-theme="custom:good"]');
    rmSync(root, { recursive: true, force: true });
  });

  test("a name that parses on disk but cannot be a CSS ident is skipped, not half-rendered", () => {
    // theme-store allows spaces and dots (they are fine in a file name and in a
    // quoted attribute selector), but `--sw-custom-3024 Day-bg` ends at the
    // space. Rendering it would give a theme with a blank swatch and the wrong
    // scheme — worse than an explicit skip the panel can explain.
    const { root, listing } = listingOf({
      "3024 Day.ghostty": themeText(),
      "gruvbox.2.ghostty": themeText(),
      "fine_one-2.ghostty": themeText(),
    });
    const built = buildThemeCss(listing, null);
    expect(built.names).toEqual(["fine_one-2"]);
    expect(built.skipped.map((s) => s.reason)).toEqual(["name", "name"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("skips ride in the CSS, because <link> gives the app no headers", () => {
    const { root, listing } = listingOf({ "junk.ghostty": "nope" });
    const built = buildThemeCss(listing, null);
    expect(decl(built.css, "--ps-custom-skipped")).toBe('"parse:junk.ghostty"');
    rmSync(root, { recursive: true, force: true });
  });

  test("the file count rides in the CSS too, so truncation is visible", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`t${i}.ghostty`] = themeText();
    const { root } = withThemes(files);
    const capped = openThemeStore(join(root, "themes"), { max: 3 }).list();
    const built = buildThemeCss(capped, null);
    expect(built.truncated).toBe(true);
    expect(built.total).toBe(5);
    expect(decl(built.css, "--ps-custom-total")).toBe("5");
    expect(decl(built.css, "--ps-custom-truncated")).toBe("1");
    expect(built.names).toHaveLength(3);
    rmSync(root, { recursive: true, force: true });
  });

  test("skipped files do not read as truncation", () => {
    // Found in the live walkthrough: one good theme plus two broken files gives
    // total=3, shown=1, and an app inferring truncation from `total > shown`
    // announced "showing the first 1 of 3" — a lie, with the real explanation
    // (two unreadable files) printed directly underneath it. So the flag is
    // stated, not inferred.
    const { root, listing } = listingOf({
      "good.ghostty": themeText(),
      "broken.ghostty": "nope",
      "incomplete.ghostty": "background = 111111\n",
    });
    const built = buildThemeCss(listing, null);
    expect(built.total).toBe(3);
    expect(built.names).toEqual(["good"]);
    expect(built.truncated).toBe(false);
    expect(decl(built.css, "--ps-custom-truncated")).toBe("0");
    rmSync(root, { recursive: true, force: true });
  });

  test("a hostile file name cannot break out of the skip string", () => {
    // `cp` will create any name the filesystem accepts. The name is the useful
    // part of the message, so it is kept — sanitised, not dropped.
    expect(encodeSkips([{ file: 'ev"il;}.ghostty', reason: "parse", message: "x" }]))
      .toBe("parse:ev_il__.ghostty");
    expect(encodeSkips([{ file: "a\nb", reason: "read", message: "x" }])).toBe("read:a_b");
  });

  test("theme content cannot inject CSS rules either", () => {
    // renderCss already truncates at the first `;{}` — this is the end-to-end
    // check that nothing in this module reintroduces the hole.
    const evil = themeText().replace("background = 1d2021", "background = 1d2021\ncursor-color = 000000");
    const { root, listing } = listingOf({ "x.ghostty": evil });
    const built = buildThemeCss(listing, "x");
    // One manifest rule + one theme rule, and nothing else.
    expect(built.css.match(/\{/g)).toHaveLength(2);
    expect(built.css.match(/\}/g)).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("isCssIdentSafe", () => {
  test("accepts what a token name can hold", () => {
    for (const ok of ["mine", "My_Theme", "gruvbox-dark", "v2", "a"]) {
      expect(isCssIdentSafe(ok), ok).toBe(true);
    }
  });

  test("rejects what would silently truncate the token name", () => {
    for (const bad of ["", "3024 Day", "gruvbox.2", "a:b", "-lead", "_lead", "a/b", "a\\b", 'a"b']) {
      expect(isCssIdentSafe(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

// --------------------------------------------------------- the GET route

describe("GET /theme/custom.css", () => {
  test("serves CSS with no-cache and an ETag", () => {
    const { root, store } = withThemes({ "mine.ghostty": themeText() });
    const r = buildThemeCssResponse(store, new URL("http://x/theme/custom.css"), null);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("etag")).toMatch(/^"[0-9a-f]{16}"$/);
    rmSync(root, { recursive: true, force: true });
  });

  test("200 with an empty manifest when there is no themes directory at all", async () => {
    // The overwhelmingly common case — most installs never create one — so it
    // must not be an error path.
    const root = mkdtempSync(join(tmpdir(), "ps-theme-none-"));
    const store = openThemeStore(join(root, "themes"));
    const r = buildThemeCssResponse(store, new URL("http://x/theme/custom.css"), null);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('--ps-custom-themes: "";');
    rmSync(root, { recursive: true, force: true });
  });

  test("a matching If-None-Match gets 304 with no body but the same headers", () => {
    const { root, store } = withThemes({ "mine.ghostty": themeText() });
    const first = buildThemeCssResponse(store, new URL("http://x/theme/custom.css"), null);
    const etag = first.headers.get("etag")!;
    const second = buildThemeCssResponse(store, new URL("http://x/theme/custom.css"), etag);
    expect(second.status).toBe(304);
    expect(second.body).toBeNull();
    expect(second.headers.get("etag")).toBe(etag);
    rmSync(root, { recursive: true, force: true });
  });

  test("editing a theme changes the ETag, so a reload actually shows the edit", () => {
    // The whole reason for no-cache + ETag: the source is a file the user edits
    // in an editor and expects a refresh to pick up.
    const { root, store } = withThemes({ "mine.ghostty": themeText("101010") });
    const before = buildThemeCssResponse(store, new URL("http://x/theme/custom.css"), null).headers.get("etag");
    writeFileSync(join(root, "themes", "mine.ghostty"), themeText("202020"));
    const after = buildThemeCssResponse(store, new URL("http://x/theme/custom.css"), null).headers.get("etag");
    expect(after).not.toBe(before);
    rmSync(root, { recursive: true, force: true });
  });

  test("?t= selects which theme gets its full token set", async () => {
    const { root, store } = withThemes({
      "one.ghostty": themeText("101010"), "two.ghostty": themeText("202020"),
    });
    const body = await buildThemeCssResponse(store, new URL("http://x/theme/custom.css?t=two"), null).text();
    expect(body).toContain(':root[data-theme="custom:two"]');
    expect(body).not.toContain(':root[data-theme="custom:one"]');
    rmSync(root, { recursive: true, force: true });
  });

  test("?t= tolerates the full custom: id as well as the bare name", async () => {
    const { root, store } = withThemes({ "one.ghostty": themeText() });
    const body = await buildThemeCssResponse(store, new URL("http://x/theme/custom.css?t=custom:one"), null).text();
    expect(body).toContain(':root[data-theme="custom:one"]');
    rmSync(root, { recursive: true, force: true });
  });

  test("X-Theme-Truncated names the real total, on the 304 as well", () => {
    // A client that skipped the body still has to know it is seeing a subset.
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`t${i}.ghostty`] = themeText();
    const { root } = withThemes(files);
    const store = openThemeStore(join(root, "themes"), { max: 2 });
    const first = buildThemeCssResponse(store, new URL("http://x/theme/custom.css"), null);
    expect(first.headers.get("X-Theme-Truncated")).toBe("4");
    const again = buildThemeCssResponse(store, new URL("http://x/theme/custom.css"), first.headers.get("etag"));
    expect(again.status).toBe(304);
    expect(again.headers.get("X-Theme-Truncated")).toBe("4");
    rmSync(root, { recursive: true, force: true });
  });

  test("no truncation header when nothing was truncated", () => {
    const { root, store } = withThemes({ "mine.ghostty": themeText() });
    const r = buildThemeCssResponse(store, new URL("http://x/theme/custom.css"), null);
    expect(r.headers.get("X-Theme-Truncated")).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------ importTheme

describe("importTheme", () => {
  const store = (): { root: string; s: ThemeStore } => {
    const root = mkdtempSync(join(tmpdir(), "ps-theme-imp-"));
    return { root, s: openThemeStore(join(root, "themes")) };
  };

  test("stores a valid theme and reports whether it replaced one", () => {
    const { root, s } = store();
    expect(importTheme(s, { name: "mine", text: themeText() }))
      .toEqual({ ok: true, id: "mine", overwritten: false });
    expect(importTheme(s, { name: "mine", text: themeText("222222") }))
      .toEqual({ ok: true, id: "mine", overwritten: true });
    expect(s.list().themes.map((t) => t.id)).toEqual(["mine"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("each rejection carries a distinct reason — the UI shows four messages", () => {
    const { root, s } = store();
    expect(importTheme(s, {})).toMatchObject({ ok: false, reason: "name" });
    expect(importTheme(s, { name: "  " })).toMatchObject({ ok: false, reason: "name" });
    expect(importTheme(s, { name: "ok", text: "  " })).toMatchObject({ ok: false, reason: "parse" });
    expect(importTheme(s, { name: "ok", text: "not a theme" })).toMatchObject({ ok: false, reason: "parse" });
    expect(importTheme(s, { name: "../evil", text: themeText() })).toMatchObject({ ok: false, reason: "name" });
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects names the stylesheet could not render, not just unsafe ones", () => {
    // theme-store would accept "3024 Day" as a file; this layer refuses it
    // because the token name would truncate at the space. Refusing at import
    // beats saving a theme that shows up broken.
    const { root, s } = store();
    expect(importTheme(s, { name: "3024 Day", text: themeText() })).toMatchObject({ ok: false, reason: "name" });
    expect(s.list().themes).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a trailing .ghostty in the name is not doubled", () => {
    const { root, s } = store();
    expect(importTheme(s, { name: "mine.ghostty", text: themeText() })).toMatchObject({ ok: true, id: "mine" });
    rmSync(root, { recursive: true, force: true });
  });

  test("non-string fields are refused rather than stringified", () => {
    // String(undefined) === "undefined" would create a theme called "undefined".
    const { root, s } = store();
    expect(importTheme(s, { name: 42, text: themeText() })).toMatchObject({ ok: false, reason: "name" });
    expect(importTheme(s, { name: "ok", text: { a: 1 } })).toMatchObject({ ok: false, reason: "parse" });
    rmSync(root, { recursive: true, force: true });
  });

  test("refuses a new theme once the directory is full, but still allows replacing one", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-theme-full-"));
    const s = openThemeStore(join(root, "themes"), { max: 2 });
    expect(importTheme(s, { name: "a", text: themeText() }).ok).toBe(true);
    expect(importTheme(s, { name: "b", text: themeText() }).ok).toBe(true);
    expect(importTheme(s, { name: "c", text: themeText() })).toMatchObject({ ok: false, reason: "limit" });
    // A full directory must not become unfixable from the UI.
    expect(importTheme(s, { name: "a", text: themeText("333333") }).ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("an imported theme is immediately in the stylesheet", () => {
    const { root, s } = store();
    importTheme(s, { name: "fresh", text: themeText() });
    const built = buildThemeCss(s.list(), "fresh");
    expect(built.names).toEqual(["fresh"]);
    expect(built.css).toContain(':root[data-theme="custom:fresh"]');
    rmSync(root, { recursive: true, force: true });
  });
});

// ------------------------------------------------------ wired into the server

describe("routes on a live server", () => {
  function start(themes: Record<string, string> = {}) {
    const keyDir = mkdtempSync(join(tmpdir(), "ps-theme-srv-"));
    if (Object.keys(themes).length) {
      mkdirSync(join(keyDir, "themes"), { recursive: true });
      for (const [n, t] of Object.entries(themes)) writeFileSync(join(keyDir, "themes", n), t);
    }
    const config = loadConfig({ POCKETSHELL_KEY_DIR: keyDir, POCKETSHELL_PORT: "0" });
    const srv = startServer({ port: 0, config, assets: {} });
    return { srv, keyDir, config, base: `http://127.0.0.1:${srv.port}` };
  }
  const stop = (s: { srv: { stop(): void }; keyDir: string }) => {
    s.srv.stop();
    rmSync(s.keyDir, { recursive: true, force: true });
  };

  test("GET /theme/custom.css is reachable without any credential", async () => {
    // Deliberate: the app pulls it with a <link>, which can carry neither the
    // bearer token nor the Noise session. It is a colour palette, not a secret.
    const s = start({ "mine.ghostty": themeText() });
    const res = await fetch(`${s.base}/theme/custom.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await res.text()).toContain('--ps-custom-themes: "mine";');
    stop(s);
  });

  test("GET /theme/custom.css is 200 on an install with no themes directory", async () => {
    const s = start();
    const res = await fetch(`${s.base}/theme/custom.css`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('--ps-custom-themes: "";');
    stop(s);
  });

  test("a second request with the ETag gets 304", async () => {
    const s = start({ "mine.ghostty": themeText() });
    const first = await fetch(`${s.base}/theme/custom.css`);
    const res = await fetch(`${s.base}/theme/custom.css`, {
      headers: { "if-none-match": first.headers.get("etag")! },
    });
    expect(res.status).toBe(304);
    stop(s);
  });

  test("POST /theme/import needs the bearer token", async () => {
    // Same guard as /internal/notify: loopback is not an identity (net-addr.ts),
    // so the token is the actual credential and the loopback check narrows it.
    const s = start();
    const body = JSON.stringify({ name: "mine", text: themeText() });
    const noAuth = await fetch(`${s.base}/theme/import`, { method: "POST", body });
    expect(noAuth.status).toBe(401);
    const badAuth = await fetch(`${s.base}/theme/import`, {
      method: "POST", body, headers: { authorization: "Bearer wrong" },
    });
    expect(badAuth.status).toBe(401);
    stop(s);
  });

  test("POST /theme/import with the token stores a theme that then serves", async () => {
    const s = start();
    const res = await fetch(`${s.base}/theme/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.config.notifyToken}` },
      body: JSON.stringify({ name: "mine", text: themeText() }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "mine", overwritten: false });
    expect(await (await fetch(`${s.base}/theme/custom.css`)).text()).toContain('--ps-custom-themes: "mine";');
    stop(s);
  });

  test("a rejected import answers 400 with the structured reason", async () => {
    // The four reasons are four different messages in the settings panel, so
    // the wire has to carry which one it was, not just "failed".
    const s = start();
    const res = await fetch(`${s.base}/theme/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.config.notifyToken}` },
      body: JSON.stringify({ name: "mine", text: "not a theme" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, reason: "parse" });
    stop(s);
  });

  test("an unknown /theme/* path is still a 404, not a stylesheet", async () => {
    const s = start();
    expect((await fetch(`${s.base}/theme/whatever`)).status).toBe(404);
    stop(s);
  });
});

// ---------------------------------------------- the RPC path (what phones use)

describe("theme.import / theme.remove over the authed WS", () => {
  // A phone is neither on loopback nor holding the notify token, so the HTTP
  // import above is a local-script path only. The settings panel goes through
  // the RPC envelope, where the device's Noise key is already the credential —
  // no new protocol message type, no new auth mechanism.
  function rpc(srv: ReturnType<typeof startServer>, ws: FakeWs, id: string, method: string, params: unknown) {
    ws.sent.length = 0;
    srv.__test.message(ws as never, utf8(encode({ type: "rpc", id, method, params })));
    return decodeServer(Buffer.from(ws.sent[0]!).toString("utf8"));
  }

  function start() {
    const keyDir = mkdtempSync(join(tmpdir(), "ps-theme-rpc-"));
    const config = loadConfig({ POCKETSHELL_KEY_DIR: keyDir, POCKETSHELL_PORT: "0" });
    const srv = startServer({ port: 0, config, assets: {}, channelFactory: passthroughResponder });
    const ws = fakeWs();
    srv.__test.open(ws as never);
    srv.__test.message(ws as never, M1); // handshake
    return { srv, ws, keyDir, config };
  }
  const stop = (s: { srv: { stop(): void }; keyDir: string }) => {
    s.srv.stop();
    rmSync(s.keyDir, { recursive: true, force: true });
  };

  test("theme.import stores a theme and it shows up in the stylesheet", async () => {
    const s = start();
    const reply = rpc(s.srv, s.ws, "t1", "theme.import", { name: "phone", text: themeText() });
    expect(reply).toMatchObject({ type: "response", ok: true, id: "t1" });
    expect((reply as { result: unknown }).result).toEqual({ ok: true, id: "phone", overwritten: false });
    const css = await (await fetch(`http://127.0.0.1:${s.srv.port}/theme/custom.css`)).text();
    expect(css).toContain('--ps-custom-themes: "phone";');
    stop(s);
  });

  test("theme.import reports the reason instead of failing the RPC", () => {
    // A rejected import is a normal outcome the UI explains, not a transport
    // error — an rpc_error would surface as "something went wrong".
    const s = start();
    const reply = rpc(s.srv, s.ws, "t2", "theme.import", { name: "x", text: "junk" });
    expect(reply).toMatchObject({ type: "response", ok: true });
    expect((reply as { result: { reason: string } }).result).toMatchObject({ ok: false, reason: "parse" });
    stop(s);
  });

  test("theme.remove deletes it, and says so when there was nothing to delete", () => {
    const s = start();
    rpc(s.srv, s.ws, "t3", "theme.import", { name: "gone", text: themeText() });
    expect((rpc(s.srv, s.ws, "t4", "theme.remove", { name: "gone" }) as { result: unknown }).result)
      .toEqual({ removed: true });
    expect((rpc(s.srv, s.ws, "t5", "theme.remove", { name: "gone" }) as { result: unknown }).result)
      .toEqual({ removed: false });
    stop(s);
  });

  test("theme.remove cannot escape the themes directory", () => {
    // The store refuses any name it would not have written; this is the check
    // that the RPC does not get a shortcut around it.
    const s = start();
    for (const name of ["../../etc/passwd", "..", "a/b"]) {
      expect((rpc(s.srv, s.ws, "t6", "theme.remove", { name }) as { result: unknown }).result)
        .toEqual({ removed: false });
    }
    stop(s);
  });
});
