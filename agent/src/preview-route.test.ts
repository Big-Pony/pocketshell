import { test, expect } from "bun:test";
import { PreviewTokens } from "./preview-service";
import { buildPreviewResponse } from "./server-preview";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fx() {
  const dir = mkdtempSync(join(tmpdir(), "pvr-"));
  writeFileSync(join(dir, "a.png"), "PNGDATA");
  return dir;
}

function fxVideo() {
  const dir = mkdtempSync(join(tmpdir(), "pvv-"));
  // 1000 字节可预测内容：第 i 字节是 (i % 10) 的 ASCII 数字
  const buf = Buffer.from(Array.from({ length: 1000 }, (_, i) => 48 + (i % 10)));
  writeFileSync(join(dir, "v.mp4"), buf);
  return dir;
}

test("valid token serves file with hardening headers", async () => {
  const dir = fx();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  const res = buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/a.png`), 0);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cache-control")).toBe("no-store");
  // VULN-003: no CORS header at all. It used to be `*`, which let any origin
  // read a preview once it learned a token. Nothing in the app needs it —
  // <img>/<video>/<iframe> loads are not CORS reads, and the app is same-origin
  // with the agent. Asserting null (not "absent-ish") so re-adding it fails.
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  // Defence-in-depth headers: CSP sandbox neutralises a top-level HTML load,
  // nosniff stops MIME sniffing octet-stream into an executable document.
  expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await res.text()).toBe("PNGDATA");
});

test("bad token → 403", () => {
  const pt = new PreviewTokens();
  const res = buildPreviewResponse(pt, new URL("http://x/preview/nope/a.png"), 0);
  expect(res.status).toBe(403);
});

test("malformed percent-escape → 400 (not 500)", () => {
  const dir = fx();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  const res = buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/%ZZ`), 0);
  expect(res.status).toBe(400);
});

test("traversal → 403", () => {
  const dir = fx();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  const res = buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/..%2f..%2fetc%2fpasswd`), 0);
  expect(res.status).toBe(403);
});

test("视频扩展名给出正确 content-type", async () => {
  const dir = fxVideo();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  const res = buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/v.mp4`), 0);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("video/mp4");
});

test("无 Range 时返回 200 且带 accept-ranges", async () => {
  const dir = fxVideo();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  const res = buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/v.mp4`), 0, null);
  expect(res.status).toBe(200);
  expect(res.headers.get("accept-ranges")).toBe("bytes");
  expect(res.headers.get("content-length")).toBe("1000");
});

test("Range 请求返回 206 + content-range + 正确切片", async () => {
  const dir = fxVideo();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  const res = buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/v.mp4`), 0, "bytes=10-19");
  expect(res.status).toBe(206);
  expect(res.headers.get("content-range")).toBe("bytes 10-19/1000");
  expect(res.headers.get("content-length")).toBe("10");
  expect(await res.text()).toBe("0123456789"); // 第 10..19 字节
});

test("206 响应同样带全部安全头", async () => {
  const dir = fxVideo();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  const res = buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/v.mp4`), 0, "bytes=0-9");
  expect(res.status).toBe(206);
  expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("access-control-allow-origin")).toBeNull(); // VULN-003
});

test("越界 Range 返回 416 且带 content-range", async () => {
  const dir = fxVideo();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  const res = buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/v.mp4`), 0, "bytes=5000-6000");
  expect(res.status).toBe(416);
  expect(res.headers.get("content-range")).toBe("bytes */1000");
});

test("畸形 Range 当作无 Range，返回完整 200", async () => {
  const dir = fxVideo();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  const res = buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/v.mp4`), 0, "garbage");
  expect(res.status).toBe(200);
  expect((await res.text()).length).toBe(1000);
});

test("Range 请求仍受 token 与穿越保护约束", () => {
  const dir = fxVideo();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  expect(buildPreviewResponse(pt, new URL(`http://x/preview/badtoken/v.mp4`), 0, "bytes=0-9").status).toBe(403);
  expect(buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/../etc/passwd`), 0, "bytes=0-9").status).toBe(403);
});

// 回归防护：改用 statSync + Bun.file() 后，目录曾一度给出 200 + 读 body
// 时抛 "Directories cannot be read like files"。main 上 readFileSync(dir)
// 抛 EISDIR 被兜成 404，这条测试确保那个行为不再丢失。
test("请求目录返回 404，且 body 可安全读取", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pvd-"));
  mkdirSync(join(dir, "sub"));
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  const res = buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/sub`), 0);
  expect(res.status).toBe(404);
  await res.text(); // 不得抛异常
});
