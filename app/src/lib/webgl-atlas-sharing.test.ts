import { describe, it, expect } from "vitest";

// Regression guard for the shared-WebGL-atlas corruption (docs/bug/终端显示异常2).
//
// Upstream bug (xtermjs/xterm.js#6038, #6014): terminals whose render config
// matches share ONE TextureAtlas. When the atlas merges pages it rewrites every
// glyph's texture coordinates in place, and signalled that through a
// consume-once `_requestClearModel` flag stored ON THE ATLAS. Only the first
// renderer to draw that frame consumed it; every sibling terminal kept stale
// coordinates and rendered its unchanged rows blank — which is exactly the
// "all tabs go blank at once" report.
//
// The fix (0.20.0-beta.288+) replaces that flag with a monotonic
// `pageLayoutVersion` on the atlas plus a `_lastSeenPageLayoutVersion` tracked
// PER GlyphRenderer, so every sharing renderer notices the change independently.
//
// This test asserts the fix is present in the installed package rather than
// simulating GL: jsdom has no WebGL at all, so a behavioural test is impossible
// here (the real pixel-level proof lives in upstream's Chromium suite). If a
// dependency bump silently drops us back onto a build without the per-renderer
// tracking, this fails loudly instead of the bug quietly returning on phones.
describe("webgl shared atlas invalidation (upstream #6038 regression guard)", () => {
  // Resolved from the vitest cwd (the app/ package root) rather than
  // import.meta.url: under vite the latter is an http-scheme URL, not file:.
  const src = "node_modules/@xterm/addon-webgl/lib/addon-webgl.js";

  // `node:fs` has no types here (the project ships no @types/node, and adding it
  // just for this guard would widen the dependency surface), so the import is
  // funnelled through one narrowly-typed helper instead of being sprinkled with
  // ts-expect-error at each call site.
  const readText = async (path: string): Promise<string> => {
    // @ts-expect-error -- no @types/node in this project; vitest runs in node.
    const fs = (await import("node:fs")) as {
      readFileSync(p: string, enc: string): string;
    };
    return fs.readFileSync(path, "utf8");
  };

  it("ships the per-renderer pageLayoutVersion fix, not the consume-once flag", async () => {
    const code = await readText(src);

    // The fix's public surface on TextureAtlas.
    expect(code).toContain("pageLayoutVersion");

    // The old consume-once signal must be gone: its presence means we are back
    // on a build where one terminal's render starves its siblings.
    expect(code).not.toContain("_requestClearModel");
  });

  it("tracks the atlas version per renderer, not per atlas", async () => {
    const map = JSON.parse(await readText(`${src}.map`));
    const i = map.sources.findIndex((s: string) => s.endsWith("GlyphRenderer.ts"));
    expect(i).toBeGreaterThanOrEqual(0);
    const glyphRenderer: string = map.sourcesContent[i];

    // Per-renderer state is what makes siblings independent.
    expect(glyphRenderer).toContain("_lastSeenPageLayoutVersion");
    // ...and it must be compared against the atlas inside beginFrame.
    expect(glyphRenderer).toMatch(/pageLayoutVersion\s*!==\s*this\._lastSeenPageLayoutVersion/);
  });
});
