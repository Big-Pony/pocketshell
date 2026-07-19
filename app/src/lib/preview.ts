// Pure preview helpers: file-type classification, the agent HTTP origin for
// the token /preview route, URL assembly, and markdown local-image path math.
export type PreviewKind = "image" | "markdown" | "html" | "code";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);

function ext(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

export function previewKind(path: string): PreviewKind {
  const e = ext(path);
  if (IMAGE_EXT.has(e)) return "image";
  if (e === "md" || e === "markdown") return "markdown";
  if (e === "html" || e === "htm") return "html";
  return "code";
}

// Derive the preview HTTP origin from the agent's WebSocket URL, so the
// /preview route always hits the SAME agent that minted the token — whatever
// host/port it runs on (dev :8722, an alt port, or prod same-origin wss).
export function previewOrigin(agentWsUrl: string): string {
  try {
    const u = new URL(agentWsUrl);
    const scheme = u.protocol === "wss:" ? "https:" : "http:";
    return `${scheme}//${u.host}`;
  } catch {
    return agentWsUrl;
  }
}

export function previewUrl(origin: string, token: string, relpath: string): string {
  const enc = relpath.split("/").map(encodeURIComponent).join("/");
  return `${origin}/preview/${token}/${enc}`;
}

export function relFromBase(base: string, abs: string): string {
  const b = base.endsWith("/") ? base : base + "/";
  return abs.startsWith(b) ? abs.slice(b.length) : abs;
}

// Normalise nothing (agent resolves + guards); we only strip the leading "./"
// and keep "../" so the agent can resolve within base. Remote/data URIs opt out.
export function resolveMdImageSrc(mdFileDir: string, src: string): { relToDir: string } | null {
  if (/^[a-z]+:/i.test(src) || src.startsWith("//") || src.startsWith("data:")) return null;
  if (src.startsWith("/")) return null; // absolute URL-path: leave to browser
  return { relToDir: src.replace(/^\.\//, "") };
}
