import { test, expect } from "bun:test";
import { renderManifest } from "./gen-embedded";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("renderManifest emits type:file imports + ASSETS map for every dist file", () => {
  const dist = join(mkdtempSync(join(tmpdir(), "ps-dist-")), "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html>");
  writeFileSync(join(dist, "assets", "app-abc.js"), "console.log(1)");
  const out = renderManifest(dist, "/repo/agent/src");
  expect(out).toContain('with { type: "file" }');
  expect(out).toContain('"/index.html"');
  expect(out).toContain('"/assets/app-abc.js"');
  expect(out).toContain("export const ASSETS");
  rmSync(dist, { recursive: true, force: true });
});
