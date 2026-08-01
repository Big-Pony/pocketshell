import { describe, it, expect } from "vitest";
import { snapshotAtlas, formatSnapshot } from "./atlas-probe";

// The probe reaches into xterm internals, so its own contract is "never throw,
// degrade to a partial report". These tests pin that down — a probe that can
// crash the terminal is worse than no probe.
describe("snapshotAtlas", () => {
  it("reports no renderer when the DOM renderer is in charge", () => {
    expect(snapshotAtlas(undefined).hasRenderer).toBe(false);
    expect(snapshotAtlas({}).hasRenderer).toBe(false);
  });

  it("reads page and texture versions off the renderer", () => {
    const addon = {
      _renderer: {
        _charAtlas: { pages: [{ version: 7 }, { version: 9 }], pageLayoutVersion: 3 },
        _glyphRenderer: { value: { _atlasTextures: [{ version: 7 }, { version: 2 }] } },
      },
    };
    const s = snapshotAtlas(addon);
    expect(s.hasRenderer).toBe(true);
    expect(s.pages).toBe(2);
    expect(s.pageVersions).toEqual([7, 9]);
    // Page 1 differs from its texture → xterm would re-upload it. Page 0 matches,
    // which is the state that hides a silently-emptied canvas.
    expect(s.textureVersions).toEqual([7, 2]);
    expect(s.pageLayoutVersion).toBe(3);
  });

  it("survives an unexpected internal shape instead of throwing", () => {
    const addon = { _renderer: { _charAtlas: { pages: [null, { version: 1 }] } } };
    expect(() => snapshotAtlas(addon as any)).not.toThrow();
    const s = snapshotAtlas(addon as any);
    expect(s.pageVersions).toEqual([-1, 1]);
  });

  // The blankness sample alone is ambiguous: a page that has never rasterised a
  // glyph is ALSO blank, and that is the normal state right after a terminal
  // opens. These two counters are what tell the cases apart — see the comment on
  // pageGlyphs in atlas-probe.ts for the full truth table.
  it("reports per-page glyph counts and packing state", () => {
    const addon = {
      _renderer: {
        _charAtlas: {
          pages: [
            { version: 1, glyphs: [], currentRow: { x: 0, y: 0, height: 0 } },
            { version: 2, glyphs: [{}, {}, {}], currentRow: { x: 40, y: 0, height: 18 } },
          ],
        },
      },
    };
    const s = snapshotAtlas(addon);
    expect(s.pageGlyphs).toEqual([0, 3]);
    // Page 0's packing cursor is still at the origin → nothing was ever written.
    // Page 1's has moved → the page holds rasterised glyphs.
    expect(s.pagesUsed).toEqual([false, true]);
  });

  it("treats a missing glyphs/currentRow shape as unknown rather than as zero", () => {
    const addon = { _renderer: { _charAtlas: { pages: [{ version: 1 }] } } };
    const s = snapshotAtlas(addon);
    // -1 is "could not read", distinct from a real 0 (which means "never used").
    expect(s.pageGlyphs).toEqual([-1]);
    expect(s.pagesUsed).toEqual([false]);
  });

  it("formats a one-line report", () => {
    const line = formatSnapshot("resume", {
      hasRenderer: true, pages: 2, pageVersions: [7, 9], textureVersions: [7, 2],
      pageLayoutVersion: 3, pagesBlank: [true, false], pageGlyphs: [0, 12], pagesUsed: [false, true],
    });
    expect(line).toContain("pages=2");
    expect(line).toContain("blank=[Yn]");
    expect(line).toContain("glyphs=[0,12]");
    expect(line).toContain("used=[nY]");
  });
});
