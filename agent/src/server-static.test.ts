import { test, expect } from "bun:test";
import { startServer } from "./server";
import type { SecureChannel } from "./secure-channel";

const M2 = new Uint8Array([2]);
function passthroughResponder(): SecureChannel {
  let state: SecureChannel["state"] = "handshaking";
  return {
    get state() { return state; },
    start() { return null; },
    receive(frame) { if (state === "handshaking") { state = "transport"; return { status: "handshake", reply: M2, established: true }; } return { status: "message", plaintext: frame }; },
    send(pt) { return pt; },
  };
}

async function withServer(assets: Record<string, string>, fn: (base: string) => Promise<void>) {
  const srv = startServer({ port: 0, assets, channelFactory: passthroughResponder });
  try { await fn(`http://127.0.0.1:${srv.port}`); } finally { srv.stop(); }
}

test("serves index.html at / with no-cache, and hashed asset immutable", async () => {
  const dir = await import("node:os").then((o) => o.tmpdir());
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(dir, "ps-assets-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>ps</title>");
  writeFileSync(join(root, "assets", "app-x.js"), "export const x=1");
  const assets = { "/index.html": join(root, "index.html"), "/assets/app-x.js": join(root, "assets", "app-x.js") };

  await withServer(assets, async (base) => {
    const idx = await fetch(`${base}/`);
    expect(idx.status).toBe(200);
    expect(idx.headers.get("cache-control")).toBe("no-cache");
    expect(await idx.text()).toContain("<!doctype html>");

    const js = await fetch(`${base}/assets/app-x.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const spa = await fetch(`${base}/deep/link`, { headers: { accept: "text/html" } });
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("<!doctype html>");

    const miss = await fetch(`${base}/nope.js`, { headers: { accept: "*/*" } });
    expect(miss.status).toBe(404);
  });
});

test("ETag: 200 carries ETag, If-None-Match replay returns 304 with same validators", async () => {
  const dir = await import("node:os").then((o) => o.tmpdir());
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(dir, "ps-etag-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>ps</title>");
  const assets = { "/index.html": join(root, "index.html") };

  await withServer(assets, async (base) => {
    const first = await fetch(`${base}/`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);

    const second = await fetch(`${base}/`, { headers: { "if-none-match": etag! } });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("no-cache");
    expect(await second.text()).toBe("");

    const stale = await fetch(`${base}/`, { headers: { "if-none-match": '"deadbeef"' } });
    expect(stale.status).toBe(200);
  });
});

test("precompressed variant: br served with original content-type, identity without accept-encoding", async () => {
  const dir = await import("node:os").then((o) => o.tmpdir());
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { brotliCompressSync } = await import("node:zlib");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(dir, "ps-br-"));
  const body = "export const x = 1;\n".repeat(100);
  const compressed = brotliCompressSync(body);
  writeFileSync(join(root, "app.js"), body);
  writeFileSync(join(root, "app.js.br"), compressed);
  const assets = { "/app.js": join(root, "app.js"), "/app.js.br": join(root, "app.js.br") };

  await withServer(assets, async (base) => {
    const br = await fetch(`${base}/app.js`, { headers: { "accept-encoding": "br" } });
    expect(br.status).toBe(200);
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("content-type")).toContain("text/javascript");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    // Content-Length is the on-wire (compressed) size; fetch transparently
    // decompresses, so text() must round-trip to the original body.
    expect(Number(br.headers.get("content-length"))).toBe(compressed.length);
    expect(await br.text()).toBe(body);

    const plain = await fetch(`${base}/app.js`, { headers: { "accept-encoding": "" } });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("vary")).toBe("Accept-Encoding");
    expect(await plain.text()).toBe(body);

    // Variant ETags differ (each hashed from its own bytes); 304 works per variant.
    const brEtag = br.headers.get("etag")!;
    expect(brEtag).toBeTruthy();
    expect(brEtag).not.toBe(plain.headers.get("etag"));
    const revalidate = await fetch(`${base}/app.js`, {
      headers: { "accept-encoding": "br", "if-none-match": brEtag },
    });
    expect(revalidate.status).toBe(304);
    expect(revalidate.headers.get("etag")).toBe(brEtag);
  });
});
