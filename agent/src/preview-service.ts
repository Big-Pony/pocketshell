// Token-scoped preview file access. A token authorizes reads under one base
// directory subtree; delivered over the Noise WS, consumed by the HTTP
// /preview route. Pure/injectable so the table logic is unit-testable.
import { randomBytes } from "node:crypto";
import { resolve, join, sep, extname } from "node:path";

interface Entry { base: string; dev: string; lastUsed: number }

const DEFAULT_IDLE_MS = 30 * 60 * 1000; // sliding idle expiry backstop

export class PreviewTokens {
  private map = new Map<string, Entry>();
  private idleMs: number;
  private gen: () => string;
  constructor(opts: { idleMs?: number; gen?: () => string } = {}) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.gen = opts.gen ?? (() => randomBytes(24).toString("base64url"));
  }

  mint(base: string, dev: string, now: number): string {
    const token = this.gen();
    this.map.set(token, { base: resolve(base), dev, lastUsed: now });
    return token;
  }

  resolve(token: string, relpath: string, now: number): string | null {
    const e = this.map.get(token);
    if (!e) return null;
    if (now - e.lastUsed > this.idleMs) { this.map.delete(token); return null; }
    const abs = resolve(join(e.base, relpath));
    if (abs !== e.base && !abs.startsWith(e.base + sep)) return null; // traversal guard
    e.lastUsed = now;
    return abs;
  }

  revokeDevice(dev: string): void {
    for (const [t, e] of this.map) if (e.dev === dev) this.map.delete(t);
  }

  sweep(now: number): void {
    for (const [t, e] of this.map) if (now - e.lastUsed > this.idleMs) this.map.delete(t);
  }
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".bmp": "image/bmp", ".ico": "image/x-icon", ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".wasm": "application/wasm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".map": "application/json",
};

export function contentTypeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// HTTP Range 解析（RFC 7233 单区间）。视频拖进度条必须有它——浏览器会对
// video 源发 Range 请求，不认 206 就没法 seek。
//
// 返回值三态，调用方据此分流：
//   null            → 无 Range / 畸形 / 多区间 → 走完整 200 响应
//   "unsatisfiable" → 区间越界 → 416
//   {start, end}    → 闭区间，含端点的字节下标 → 206
//
// 多区间（bytes=0-100,200-300）刻意不支持：浏览器的媒体请求从不用它，
// 支持它要引入 multipart/byteranges 编码，收益为零。
export function parseRange(
  header: string | null,
  fileSize: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;                      // 单位不对 / 多区间 / 完全畸形
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;   // "bytes=-" 无意义

  if (rawStart === "") {
    // 后缀形式 bytes=-N：末尾 N 字节。N 超过文件大小就是整个文件。
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    if (fileSize === 0) return "unsatisfiable";
    return { start: Math.max(0, fileSize - suffix), end: fileSize - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start)) return null;
  if (fileSize === 0 || start >= fileSize) return "unsatisfiable";
  // end 缺省即到末尾；超出末尾则截断（浏览器常发 bytes=0- 或超大 end）
  const end = rawEnd === "" ? fileSize - 1 : Math.min(Number(rawEnd), fileSize - 1);
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  return { start, end };
}
