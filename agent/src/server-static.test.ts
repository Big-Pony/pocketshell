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
