import { test, expect } from "bun:test";
import { PreviewTokens, contentTypeFor, parseRange } from "./preview-service";
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

test("parseRange: 无 Range 头返回 null", () => {
  expect(parseRange(null, 1000)).toBeNull();
  expect(parseRange("", 1000)).toBeNull();
});

test("parseRange: bytes=0- 覆盖整个文件", () => {
  expect(parseRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
});

test("parseRange: bytes=100-200 闭区间", () => {
  expect(parseRange("bytes=100-200", 1000)).toEqual({ start: 100, end: 200 });
});

test("parseRange: bytes=500- 从中间到末尾", () => {
  expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
});

test("parseRange: bytes=-500 是末尾 500 字节", () => {
  expect(parseRange("bytes=-500", 1000)).toEqual({ start: 500, end: 999 });
});

test("parseRange: 后缀长度超过文件大小则从 0 开始", () => {
  expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
});

test("parseRange: end 超出文件末尾则截到末尾", () => {
  expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
});

test("parseRange: start 越界返回 unsatisfiable", () => {
  expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
  expect(parseRange("bytes=2000-3000", 1000)).toBe("unsatisfiable");
});

test("parseRange: start 大于 end 返回 unsatisfiable", () => {
  expect(parseRange("bytes=500-100", 1000)).toBe("unsatisfiable");
});

test("parseRange: 空文件任何区间都 unsatisfiable", () => {
  expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
});

test("parseRange: 畸形头返回 null（当作无 Range 处理）", () => {
  expect(parseRange("items=0-100", 1000)).toBeNull();   // 单位不是 bytes
  expect(parseRange("bytes=abc-def", 1000)).toBeNull();
  expect(parseRange("bytes=", 1000)).toBeNull();
  expect(parseRange("bytes=-", 1000)).toBeNull();
  expect(parseRange("garbage", 1000)).toBeNull();
});

test("parseRange: 多区间不支持，返回 null 走完整响应", () => {
  expect(parseRange("bytes=0-100,200-300", 1000)).toBeNull();
});
