import { describe, it, expect } from "vitest";
import {
  termFontFromOptions,
  cleanCapture,
  COPY_PAGE_ROWS,
  pageRange,
  prependPage,
  keepScrollAnchored,
} from "./term-clone";

// prepareRowsClone / ownerClassOf are gone with the DOM-clone approach: under
// the WebGL renderer there are no row elements to clone and no per-instance
// owner class to carry. Copy mode now renders tmux's plain-text capture.

describe("termFontFromOptions", () => {
  // The bug this replaced readTermFont(getComputedStyle(term.element)) over:
  // xterm's font size is set through its JS options and NEVER written to CSS,
  // so the computed style handed back the page's inherited 16px while the
  // terminal was actually rendering at 14px. The overlay came up visibly bigger
  // than the terminal it covered. term.options is the only honest source.
  it("takes the metrics from xterm's options, so 14px terminal → 14px overlay", () => {
    expect(termFontFromOptions({ fontSize: 14, fontFamily: '"JetBrains Mono", monospace' })).toEqual({
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: "14px",
      lineHeight: "14px", // multiplier 1 (xterm's default) × 14px
      letterSpacing: "0px",
    });
  });

  it("converts xterm's UNITLESS lineHeight multiplier into CSS pixels", () => {
    // xterm's lineHeight is a multiplier, not a length. Copying "1.2" straight
    // into CSS happens to work, but 1.2 with a px-less value is a different
    // inheritance rule; resolving it here keeps the overlay pinned to xterm's
    // real row pitch.
    expect(termFontFromOptions({ fontSize: 20, lineHeight: 1.2 }).lineHeight).toBe("24px");
  });

  it("carries letterSpacing across as whole pixels (xterm's unit)", () => {
    expect(termFontFromOptions({ fontSize: 14, letterSpacing: 2 }).letterSpacing).toBe("2px");
  });

  it("falls back to xterm's own defaults when options are absent", () => {
    // xterm defaults: fontSize 15, lineHeight 1, letterSpacing 0.
    expect(termFontFromOptions({})).toEqual({
      fontFamily: "",
      fontSize: "15px",
      lineHeight: "15px",
      letterSpacing: "0px",
    });
  });

  it("ignores non-finite metrics rather than emitting NaNpx", () => {
    const f = termFontFromOptions({ fontSize: Number.NaN, lineHeight: Number.POSITIVE_INFINITY });
    expect(f.fontSize).toBe("15px");
    expect(f.lineHeight).toBe("15px");
  });

  it("tolerates a missing terminal (copy mode can open before xterm exists)", () => {
    expect(termFontFromOptions(undefined).fontSize).toBe("15px");
  });
});

describe("cleanCapture", () => {
  // capture-pane pads to the pane width and always runs to the bottom of the
  // screen — invisible on screen, very visible in a paste.
  it("strips the trailing padding spaces tmux adds to every row", () => {
    expect(cleanCapture("a.txt      \nb.txt   ")).toBe("a.txt\nb.txt");
  });

  it("drops the slab of blank rows at the bottom of the pane", () => {
    expect(cleanCapture("out\n\n   \n\n")).toBe("out");
  });

  it("keeps interior blank lines — they are part of the output's shape", () => {
    expect(cleanCapture("head\n\ntail")).toBe("head\n\ntail");
  });

  it("keeps leading indentation (code, tree output)", () => {
    expect(cleanCapture("  indented  \n    more  ")).toBe("  indented\n    more");
  });

  it("returns an empty string for an all-blank capture", () => {
    expect(cleanCapture("\n  \n\n")).toBe("");
  });
});

describe("pageRange", () => {
  // Copy mode walks UPWARD in fixed pages: page 0 is the newest COPY_PAGE_ROWS
  // rows (so the overlay opens on what the user just ran), and each further page
  // is the block immediately above it. Both ends of the range are "rows above
  // the cursor", inclusive, matching the agent's back/endBack.
  it("page 0 is the newest page, ending at the cursor row", () => {
    expect(pageRange(0)).toEqual({ back: COPY_PAGE_ROWS, endBack: 1 });
  });

  it("page 1 sits immediately above page 0 — no overlap, no gap", () => {
    const p0 = pageRange(0);
    const p1 = pageRange(1);
    expect(p1.endBack).toBe(p0.back + 1);
    expect(p1.back - p1.endBack).toBe(p0.back - p0.endBack); // same span
  });

  it("every page covers exactly COPY_PAGE_ROWS rows", () => {
    for (const n of [0, 1, 2, 7]) {
      const { back, endBack } = pageRange(n);
      expect(back - endBack + 1).toBe(COPY_PAGE_ROWS);
    }
  });

  it("pages tile the history contiguously as n grows", () => {
    for (let n = 1; n < 6; n++) {
      expect(pageRange(n).endBack).toBe(pageRange(n - 1).back + 1);
    }
  });
});

describe("prependPage", () => {
  // Older text goes ABOVE what is already shown; the join must not invent or
  // swallow a newline, or the seam drifts by a row every page.
  it("puts the older page above the existing text with a single newline", () => {
    expect(prependPage("old", "new")).toBe("old\nnew");
  });

  it("returns the older page alone when nothing is loaded yet", () => {
    expect(prependPage("old", "")).toBe("old");
  });

  it("leaves the existing text untouched when the older page is empty", () => {
    expect(prependPage("", "new")).toBe("new");
  });

  it("preserves blank lines inside either side", () => {
    expect(prependPage("a\n\nb", "c\n\nd")).toBe("a\n\nb\nc\n\nd");
  });
});

describe("keepScrollAnchored", () => {
  // The standard infinite-scroll compensation. Content is added ABOVE the
  // viewport, so scrollHeight grows and the same pixels move down by the
  // difference; scrollTop must move with them or the view jumps to older text.
  it("shifts scrollTop by exactly the height the prepended page added", () => {
    expect(keepScrollAnchored({ before: 1000, after: 3000, scrollTop: 0 })).toBe(2000);
  });

  it("keeps a mid-list position steady too, not just the top", () => {
    expect(keepScrollAnchored({ before: 1000, after: 3000, scrollTop: 120 })).toBe(2120);
  });

  it("does nothing when the height did not change (empty page)", () => {
    expect(keepScrollAnchored({ before: 1000, after: 1000, scrollTop: 40 })).toBe(40);
  });

  it("never returns a negative scrollTop if the content somehow shrank", () => {
    expect(keepScrollAnchored({ before: 3000, after: 1000, scrollTop: 10 })).toBe(0);
  });
});
