// Forensic probe for the blank-glyph bug (docs/bug/终端显示异常2).
//
// The failure only reproduces on a real phone coming back from the background,
// and the previous fix attempt was wrong precisely because it was reasoned from
// code alone and never observed. This captures the atlas's actual state at the
// moment of recovery so the NEXT recurrence produces evidence instead of another
// hypothesis.
//
// It reaches into xterm internals on purpose — there is no public API for any of
// this. Everything is optional-chained and wrapped, so a shape change upstream
// degrades to a partial report instead of breaking the terminal.

export interface AtlasSnapshot {
  /** Number of pages in the shared glyph atlas. */
  pages?: number;
  /** Per-page `version`; xterm re-uploads a page only when this changes. */
  pageVersions?: number[];
  /** Per-page GPU texture `version`, as this renderer last uploaded it. */
  textureVersions?: number[];
  /**
   * True when a page's canvas reads back as fully transparent.
   *
   * ON ITS OWN THIS PROVES NOTHING — a page that has never rasterised a glyph is
   * also blank, and that is the normal state moments after a terminal opens.
   * Read it together with `pageGlyphs` / `pagesUsed` (truth table below).
   */
  pagesBlank?: boolean[];
  /**
   * How many glyphs the atlas believes it has rasterised into each page.
   *
   * This is the field that disambiguates `pagesBlank`. `AtlasPage.clear()`
   * resets the packing cursor and bumps `version`, but the failure we are
   * hunting is NOT a clear() call — it is the browser silently dropping a
   * detached canvas's backing store, which touches neither the glyph list nor
   * the version. So:
   *
   *   glyphs=0  blank=Y  → page never used. NORMAL. Not evidence of anything.
   *   glyphs>0  blank=Y  → the atlas thinks it holds glyphs but the pixels are
   *                        gone. THIS IS THE BUG — and if pageVer==texVer at
   *                        the same time, xterm will never re-upload it.
   *   glyphs>0  blank=n  → healthy.
   *
   * -1 means the field could not be read (upstream shape change), which must
   * stay distinguishable from a real 0.
   */
  pageGlyphs?: number[];
  /**
   * Whether the page's packing cursor has moved off the origin — an independent
   * second opinion on "was this page ever written to", read from different state
   * than `pageGlyphs`. It is exactly the condition `clearTexture()` itself uses
   * to decide a page is untouched, so a disagreement between the two is itself
   * worth seeing in the log.
   */
  pagesUsed?: boolean[];
  /** Monotonic counter the shared-atlas fix uses to sync sibling renderers. */
  pageLayoutVersion?: number;
  /** Whether a WebGL addon is driving this terminal at all. */
  hasRenderer: boolean;
  error?: string;
}

/**
 * Read the glyph atlas state behind a WebglAddon. Never throws.
 *
 * `sampleBlankness` decodes each page canvas, which is comparatively expensive
 * (a 512×512 readback per page), so callers should only enable it on an event
 * that is already rare — not per frame.
 */
export function snapshotAtlas(addon: unknown, sampleBlankness = false): AtlasSnapshot {
  try {
    const renderer = (addon as { _renderer?: Record<string, unknown> } | undefined)?._renderer;
    if (!renderer) return { hasRenderer: false };

    const atlas = renderer._charAtlas as
      | {
          pages?: Array<{
            version?: number;
            canvas?: HTMLCanvasElement;
            glyphs?: readonly unknown[];
            currentRow?: { x?: number; y?: number };
          }>;
          pageLayoutVersion?: number;
        }
      | undefined;
    const glyphRenderer = renderer._glyphRenderer as
      | { value?: { _atlasTextures?: Array<{ version?: number }> } }
      | undefined;

    const pages = atlas?.pages ?? [];
    const snap: AtlasSnapshot = {
      hasRenderer: true,
      pages: pages.length,
      pageVersions: pages.map((p) => p?.version ?? -1),
      textureVersions: (glyphRenderer?.value?._atlasTextures ?? [])
        .slice(0, pages.length)
        .map((t) => t?.version ?? -1),
      pageGlyphs: pages.map((p) => (Array.isArray(p?.glyphs) ? p.glyphs.length : -1)),
      // Mirrors clearTexture()'s own "is this page untouched" check: the packing
      // cursor sits at the origin until the first glyph is written.
      pagesUsed: pages.map((p) => {
        const r = p?.currentRow;
        return !!r && ((r.x ?? 0) !== 0 || (r.y ?? 0) !== 0);
      }),
      pageLayoutVersion: atlas?.pageLayoutVersion,
    };

    if (sampleBlankness) {
      snap.pagesBlank = pages.map((p) => isCanvasBlank(p?.canvas));
    }
    return snap;
  } catch (e) {
    return { hasRenderer: false, error: String(e) };
  }
}

/**
 * Whether a canvas reads back fully transparent.
 *
 * Returns false (i.e. "not proven blank") on any failure — a tainted or
 * unreadable canvas must not be reported as evidence of the bug.
 */
function isCanvasBlank(canvas: HTMLCanvasElement | undefined): boolean {
  if (!canvas || !canvas.width || !canvas.height) return false;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    // Sample a grid rather than every pixel: a populated atlas page has glyphs
    // spread across it, so a coarse grid finds ink quickly, and a blank page
    // costs at most the full grid.
    const step = 16;
    for (let y = 0; y < canvas.height; y += step) {
      const row = ctx.getImageData(0, y, canvas.width, 1).data;
      for (let x = 3; x < row.length; x += 4) {
        if (row[x] !== 0) return false; // found a non-transparent pixel
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Format a snapshot as one console line. */
export function formatSnapshot(tag: string, s: AtlasSnapshot): string {
  if (s.error) return `[atlas:${tag}] probe failed: ${s.error}`;
  if (!s.hasRenderer) return `[atlas:${tag}] no webgl renderer (DOM renderer)`;
  const yn = (a: boolean[]) => a.map((b) => (b ? "Y" : "n")).join("");
  const blank = s.pagesBlank ? ` blank=[${yn(s.pagesBlank)}]` : "";
  const glyphs = s.pageGlyphs ? ` glyphs=[${s.pageGlyphs.join(",")}]` : "";
  const used = s.pagesUsed ? ` used=[${yn(s.pagesUsed)}]` : "";
  return (
    `[atlas:${tag}] pages=${s.pages} plv=${s.pageLayoutVersion}` +
    ` pageVer=[${s.pageVersions?.join(",")}] texVer=[${s.textureVersions?.join(",")}]` +
    `${blank}${glyphs}${used}`
  );
}
