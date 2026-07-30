import { test, expect } from "bun:test";
import { displayName, brandManifest, brandHtml, normalizeInstanceName } from "./instance-brand";

// —— normalizeInstanceName：空/空白一律归一成 undefined（= 不品牌化）——
test("normalizeInstanceName trims and maps blank to undefined", () => {
  expect(normalizeInstanceName("开发")).toBe("开发");
  expect(normalizeInstanceName("  开发  ")).toBe("开发");
  expect(normalizeInstanceName("")).toBeUndefined();
  expect(normalizeInstanceName("   ")).toBeUndefined();
  expect(normalizeInstanceName(undefined)).toBeUndefined();
});

test("normalizeInstanceName caps absurdly long names at 32 chars", () => {
  expect(normalizeInstanceName("x".repeat(100))).toBe("x".repeat(32));
});

// —— displayName ——
test("displayName prefixes the instance name with a middot separator", () => {
  expect(displayName("开发", "PocketShell")).toBe("开发 · PocketShell");
});

test("displayName without an instance name returns the base unchanged", () => {
  expect(displayName(undefined, "PocketShell")).toBe("PocketShell");
  expect(displayName("", "PocketShell")).toBe("PocketShell");
});

// —— brandManifest ——
const MANIFEST = JSON.stringify({
  name: "PocketShell",
  short_name: "PocketShell",
  description: "Mobile remote dev terminal",
  id: "/",
  start_url: "/",
  icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }],
});

test("brandManifest sets name to prefixed form and short_name to the bare instance name", () => {
  const out = JSON.parse(brandManifest(MANIFEST, { name: "开发" }));
  expect(out.name).toBe("开发 · PocketShell");
  expect(out.short_name).toBe("开发");
});

test("brandManifest leaves icons and every other field untouched", () => {
  const out = JSON.parse(brandManifest(MANIFEST, { name: "开发" }));
  const orig = JSON.parse(MANIFEST);
  expect(out.icons).toEqual(orig.icons);
  expect(out.description).toBe(orig.description);
  expect(out.id).toBe(orig.id);
  expect(out.start_url).toBe(orig.start_url);
});

test("brandManifest without a name returns the input byte-for-byte", () => {
  expect(brandManifest(MANIFEST, {})).toBe(MANIFEST);
  expect(brandManifest(MANIFEST, { name: "" })).toBe(MANIFEST);
});

test("brandManifest falls back to the raw input on malformed JSON", () => {
  expect(brandManifest("{not json", { name: "开发" })).toBe("{not json");
});

// —— brandHtml ——
const HTML = [
  "<!doctype html>",
  "<html lang=\"en\">",
  "  <head>",
  "    <title>PocketShell</title>",
  "    <link rel=\"manifest\" href=\"/manifest.webmanifest\" />",
  "    <meta name=\"apple-mobile-web-app-title\" content=\"PocketShell\" />",
  "    <link rel=\"apple-touch-icon\" href=\"/icons/apple-touch-icon.png\" />",
  "  </head>",
  "</html>",
].join("\n");

test("brandHtml rewrites the title to the prefixed form", () => {
  expect(brandHtml(HTML, { name: "开发" })).toContain("<title>开发 · PocketShell</title>");
});

test("brandHtml rewrites apple-mobile-web-app-title to the bare instance name", () => {
  expect(brandHtml(HTML, { name: "开发" })).toContain('content="开发"');
});

test("brandHtml leaves the apple-touch-icon href alone", () => {
  expect(brandHtml(HTML, { name: "开发" })).toContain('href="/icons/apple-touch-icon.png"');
});

test("brandHtml without a name returns the input byte-for-byte", () => {
  expect(brandHtml(HTML, {})).toBe(HTML);
  expect(brandHtml(HTML, { name: "" })).toBe(HTML);
});

test("brandHtml escapes HTML-special characters in the instance name", () => {
  const out = brandHtml(HTML, { name: '<img src=x onerror="alert(1)">' });
  expect(out).not.toContain("<img src=x");
  expect(out).toContain("&lt;img");
  expect(out).toContain("&quot;");
});

test("brandHtml returns the input unchanged when the tags are absent", () => {
  const bare = "<html><head></head></html>";
  expect(brandHtml(bare, { name: "开发" })).toBe(bare);
});
