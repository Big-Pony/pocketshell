import { test, expect } from "bun:test";
import { PreviewTokens } from "./preview-service";
import { buildPreviewResponse } from "./server-preview";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fx() {
  const dir = mkdtempSync(join(tmpdir(), "pvr-"));
  writeFileSync(join(dir, "a.png"), "PNGDATA");
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
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(await res.text()).toBe("PNGDATA");
});

test("bad token → 403", () => {
  const pt = new PreviewTokens();
  const res = buildPreviewResponse(pt, new URL("http://x/preview/nope/a.png"), 0);
  expect(res.status).toBe(403);
});

test("traversal → 403", () => {
  const dir = fx();
  const pt = new PreviewTokens();
  const tok = pt.mint(dir, "devA", 0);
  const res = buildPreviewResponse(pt, new URL(`http://x/preview/${tok}/..%2f..%2fetc%2fpasswd`), 0);
  expect(res.status).toBe(403);
});
