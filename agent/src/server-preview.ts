// Pure HTTP handler for /preview/<token>/<relpath>. Kept out of server.ts so
// the routing/hardening decisions are unit-testable without spinning a server.
import { statSync } from "node:fs";
import { PreviewTokens, contentTypeFor, parseRange } from "./preview-service";

// Hardening headers applied to EVERY success response (200 and 206 alike).
// Defence-in-depth: the route is same-origin as the app and can serve
// executable HTML. `sandbox allow-scripts` forces even a top-level load into
// an opaque origin (cannot read the app's identity keys), and nosniff stops
// MIME-sniffing octet-stream bodies into HTML. The iframe's own sandbox attr
// is the first layer; this makes it not the ONLY layer.
const HARDENING = {
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "content-security-policy": "sandbox allow-scripts",
  "x-content-type-options": "nosniff",
} as const;

export function buildPreviewResponse(
  pt: PreviewTokens,
  url: URL,
  now: number,
  rangeHeader?: string | null,
): Response {
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

  let size: number;
  try { size = statSync(abs).size; }
  catch { return new Response("not found", { status: 404 }); }

  const ct = contentTypeFor(abs);
  // Bun.file() is lazy: the body streams from disk instead of being read into
  // memory. Matters for video (hundreds of MB) and fixes the pre-existing
  // whole-file-in-RAM behaviour for large images too.
  const file = Bun.file(abs);
  const range = parseRange(rangeHeader ?? null, size);

  if (range === "unsatisfiable") {
    return new Response("range not satisfiable", {
      status: 416,
      headers: { ...HARDENING, "content-range": `bytes */${size}` },
    });
  }

  if (range) {
    const { start, end } = range;
    return new Response(file.slice(start, end + 1), {   // slice end is exclusive
      status: 206,
      headers: {
        ...HARDENING,
        "content-type": ct,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": String(end - start + 1),
      },
    });
  }

  // accept-ranges advertises seek support so the browser knows it MAY send a
  // Range request for this resource (video controls depend on seeing it).
  return new Response(file, {
    status: 200,
    headers: {
      ...HARDENING,
      "content-type": ct,
      "accept-ranges": "bytes",
      "content-length": String(size),
    },
  });
}
