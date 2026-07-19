// Pure HTTP handler for /preview/<token>/<relpath>. Kept out of server.ts so
// the routing/hardening decisions are unit-testable without spinning a server.
import { readFileSync } from "node:fs";
import { PreviewTokens, contentTypeFor } from "./preview-service";

export function buildPreviewResponse(pt: PreviewTokens, url: URL, now: number): Response {
  // /preview/<token>/<relpath...>
  const rest = url.pathname.slice("/preview/".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return new Response("bad request", { status: 400 });
  const token = rest.slice(0, slash);
  let relpath: string;
  try { relpath = decodeURIComponent(rest.slice(slash + 1)); }
  catch { return new Response("bad request", { status: 400 }); } // malformed %-escape
  const abs = pt.resolve(token, relpath, now);
  if (!abs) return new Response("forbidden", { status: 403 });
  let bytes: Uint8Array;
  try { bytes = readFileSync(abs); }
  catch { return new Response("not found", { status: 404 }); }
  // Copy into a fresh ArrayBuffer-backed view: readFileSync may hand back a
  // pooled Buffer (nonzero byteOffset) and the DOM BodyInit type rejects the
  // ArrayBufferLike generic. The copy is cheap for preview-sized files.
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": contentTypeFor(abs),
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      // Defence-in-depth: the route is same-origin as the app and can serve
      // executable HTML. `sandbox allow-scripts` forces even a top-level load
      // into an opaque origin (cannot read the app's identity keys), and
      // nosniff stops MIME-sniffing octet-stream bodies into HTML. The iframe's
      // own sandbox attr is the first layer; this makes it not the ONLY layer.
      "content-security-policy": "sandbox allow-scripts",
      "x-content-type-options": "nosniff",
    },
  });
}
