import { test, expect } from "bun:test";
import { PreviewTokens, contentTypeFor } from "./preview-service";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pv-"));
  writeFileSync(join(dir, "a.png"), "x");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "b.css"), "y");
  return dir;
}

test("mint + resolve serves files inside base", () => {
  const dir = fixture();
  const pt = new PreviewTokens({ gen: (() => { let n = 0; return () => `t${n++}`; })() });
  const tok = pt.mint(dir, "devA", 1000);
  expect(tok).toBe("t0");
  expect(pt.resolve(tok, "a.png", 1000)).toBe(join(dir, "a.png"));
  expect(pt.resolve(tok, "sub/b.css", 1000)).toBe(join(dir, "sub", "b.css"));
});

test("resolve rejects path traversal out of base", () => {
  const dir = fixture();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  expect(pt.resolve(tok, "../etc/passwd", 0)).toBeNull();
  expect(pt.resolve(tok, "sub/../../x", 0)).toBeNull();
});

test("unknown token resolves null", () => {
  const pt = new PreviewTokens();
  expect(pt.resolve("nope", "a.png", 0)).toBeNull();
});

test("idle expiry (sliding) then null", () => {
  const dir = fixture();
  const pt = new PreviewTokens({ idleMs: 100 });
  const tok = pt.mint(dir, "devA", 0);
  expect(pt.resolve(tok, "a.png", 90)).toBe(join(dir, "a.png")); // refreshes lastUsed=90
  expect(pt.resolve(tok, "a.png", 180)).toBe(join(dir, "a.png")); // within 90+100
  expect(pt.resolve(tok, "a.png", 400)).toBeNull();               // idle > 100
});

test("revokeDevice drops that device's tokens only", () => {
  const dir = fixture();
  const pt = new PreviewTokens();
  const a = pt.mint(dir, "devA", 0);
  const b = pt.mint(dir, "devB", 0);
  pt.revokeDevice("devA");
  expect(pt.resolve(a, "a.png", 0)).toBeNull();
  expect(pt.resolve(b, "a.png", 0)).toBe(join(dir, "a.png"));
});

test("contentTypeFor maps common types + octet fallback", () => {
  expect(contentTypeFor("/x/a.png")).toBe("image/png");
  expect(contentTypeFor("/x/a.svg")).toBe("image/svg+xml");
  expect(contentTypeFor("/x/a.js")).toBe("text/javascript; charset=utf-8");
  expect(contentTypeFor("/x/a.unknownext")).toBe("application/octet-stream");
});
