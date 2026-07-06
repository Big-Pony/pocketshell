// Pure routing for same-port frontend serving. server.ts turns a StaticResult
// into a Response via Bun.file(ASSETS[assetKey]) (Bun sets Content-Type from
// the file extension automatically). Keys are url paths, e.g. "/assets/x.js".
export interface StaticResult {
  status: 200 | 404;
  assetKey?: string;
  headers: Record<string, string>;
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

export function resolveStatic(pathname: string, accept: string, assetKeys: Set<string>): StaticResult {
  const key = pathname === "/" ? "/index.html" : pathname;
  if (assetKeys.has(key)) {
    const immutable = key.startsWith("/assets/"); // vite emits content-hashed names here
    return { status: 200, assetKey: key, headers: { "Cache-Control": immutable ? IMMUTABLE : NO_CACHE } };
  }
  // SPA fallback: navigation requests (Accept: text/html) get the shell so
  // client-side routing works; asset misses stay 404.
  if (accept.includes("text/html") && assetKeys.has("/index.html")) {
    return { status: 200, assetKey: "/index.html", headers: { "Cache-Control": NO_CACHE } };
  }
  return { status: 404, headers: {} };
}
