import { test, expect } from "bun:test";
import { resolveStatic } from "./static-serve";

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
