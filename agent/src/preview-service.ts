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
