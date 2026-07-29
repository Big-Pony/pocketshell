import { describe, it, expect } from "vitest";
import { readTermFont, cleanCapture } from "./term-clone";

// prepareRowsClone / ownerClassOf are gone with the DOM-clone approach: under
// the WebGL renderer there are no row elements to clone and no per-instance
// owner class to carry. Copy mode now renders tmux's plain-text capture.

describe("readTermFont", () => {
  it("pulls the four font metrics off a computed-style-like source", () => {
    const cs = {
      getPropertyValue: (p: string) =>
        ({
          "font-family": '"JetBrains Mono", monospace',
          "font-size": "14px",
          "line-height": "18px",
          "letter-spacing": "0px",
        })[p] ?? "",
    };
    expect(readTermFont(cs)).toEqual({
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: "14px",
      lineHeight: "18px",
      letterSpacing: "0px",
    });
  });

  it("returns empty strings rather than undefined when metrics are missing", () => {
    expect(readTermFont({ getPropertyValue: () => "" })).toEqual({
      fontFamily: "", fontSize: "", lineHeight: "", letterSpacing: "",
    });
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
