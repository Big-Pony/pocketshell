import { test, expect } from "bun:test";
import { resolveStatic, contentEtag, isNotModified } from "./static-serve";

const keys = new Set(["/index.html", "/assets/index-abc.js", "/assets/index-abc.css", "/favicon.svg"]);

test("root serves index.html with no-cache", () => {
  const r = resolveStatic("/", "text/html", keys);
  expect(r).toEqual({ status: 200, assetKey: "/index.html", headers: { "Cache-Control": "no-cache" } });
});

test("hashed assets get immutable long cache", () => {
  const r = resolveStatic("/assets/index-abc.js", "*/*", keys);
  expect(r.status).toBe(200);
  expect(r.assetKey).toBe("/assets/index-abc.js");
  expect(r.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
});

test("non-/assets root file (favicon) is no-cache", () => {
  expect(resolveStatic("/favicon.svg", "*/*", keys).headers["Cache-Control"]).toBe("no-cache");
});

test("unknown navigation request falls back to index.html (SPA)", () => {
  const r = resolveStatic("/some/deep/route", "text/html,application/xhtml+xml", keys);
  expect(r).toEqual({ status: 200, assetKey: "/index.html", headers: { "Cache-Control": "no-cache" } });
});

test("unknown non-navigation request is 404 (no SPA fallback for assets)", () => {
  expect(resolveStatic("/missing.js", "*/*", keys).status).toBe(404);
});

test("empty asset map is always 404", () => {
  expect(resolveStatic("/", "text/html", new Set()).status).toBe(404);
});

const withVariants = new Set([
  "/index.html",
  "/index.html.br",
  "/index.html.gz",
  "/assets/index-abc.js",
  "/assets/index-abc.js.gz",
  "/favicon.svg",
]);

test("br preferred when client accepts br and .br exists", () => {
  const r = resolveStatic("/", "text/html", withVariants, "gzip, deflate, br");
  expect(r.assetKey).toBe("/index.html.br");
  expect(r.contentType).toBe("text/html; charset=utf-8");
  expect(r.headers["Content-Encoding"]).toBe("br");
  expect(r.headers["Vary"]).toBe("Accept-Encoding");
  expect(r.headers["Cache-Control"]).toBe("no-cache");
});

test("gzip chosen when br sibling missing, with original content-type", () => {
  const r = resolveStatic("/assets/index-abc.js", "*/*", withVariants, "gzip, br");
  expect(r.assetKey).toBe("/assets/index-abc.js.gz");
  expect(r.contentType).toBe("text/javascript; charset=utf-8");
  expect(r.headers["Content-Encoding"]).toBe("gzip");
  expect(r.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
});

test("identity variant when client accepts no supported encoding (Vary still set)", () => {
  const r = resolveStatic("/", "text/html", withVariants, "");
  expect(r.assetKey).toBe("/index.html");
  expect(r.contentType).toBeUndefined();
  expect(r.headers["Content-Encoding"]).toBeUndefined();
  expect(r.headers["Vary"]).toBe("Accept-Encoding");
});

test("encoding tokens tolerate parameters and whitespace", () => {
  const r = resolveStatic("/", "text/html", withVariants, "br;q=1.0, gzip;q=0.5");
  expect(r.assetKey).toBe("/index.html.br");
});

test("file without compressed siblings is served as before", () => {
  const r = resolveStatic("/favicon.svg", "*/*", withVariants, "br");
  expect(r).toEqual({ status: 200, assetKey: "/favicon.svg", headers: { "Cache-Control": "no-cache" } });
});

test("SPA fallback honors compressed index.html variant", () => {
  const r = resolveStatic("/deep/route", "text/html", withVariants, "br");
  expect(r.assetKey).toBe("/index.html.br");
  expect(r.headers["Content-Encoding"]).toBe("br");
});

test("contentEtag is a quoted, stable, content-derived token", () => {
  const a = contentEtag(new TextEncoder().encode("hello"));
  expect(a).toMatch(/^"[0-9a-f]{16}"$/);
  expect(contentEtag(new TextEncoder().encode("hello"))).toBe(a);
  expect(contentEtag(new TextEncoder().encode("world"))).not.toBe(a);
  expect(contentEtag(new TextEncoder().encode("hello").buffer as ArrayBuffer)).toBe(a);
});

test("isNotModified matches exact, list, weak and star forms", () => {
  const etag = '"abc123"';
  expect(isNotModified(null, etag)).toBe(false);
  expect(isNotModified('"abc123"', etag)).toBe(true);
  expect(isNotModified('"other", "abc123"', etag)).toBe(true);
  expect(isNotModified('W/"abc123"', etag)).toBe(true);
  expect(isNotModified("*", etag)).toBe(true);
  expect(isNotModified('"other"', etag)).toBe(false);
});
