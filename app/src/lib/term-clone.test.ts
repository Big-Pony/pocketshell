import { describe, it, expect } from "vitest";
import { readTermFont, prepareRowsClone, ownerClassOf } from "./term-clone";

describe("ownerClassOf", () => {
  it("finds the xterm owner class among others", () => {
    expect(ownerClassOf(["terminal", "xterm", "xterm-dom-renderer-owner-1"])).toBe(
      "xterm-dom-renderer-owner-1",
    );
  });
  it("returns undefined when absent", () => {
    expect(ownerClassOf(["foo", "bar"])).toBeUndefined();
  });
});

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
});

describe("prepareRowsClone", () => {
  function rows(): HTMLElement {
    const el = document.createElement("div");
    el.className = "xterm-rows";
    el.setAttribute("aria-hidden", "true");
    const line = document.createElement("div");
    line.innerHTML = '<span style="color:#0f0">line ok</span>';
    el.appendChild(line);
    return el;
  }

  it("returns a detached deep clone, not the original", () => {
    const src = rows();
    const clone = prepareRowsClone(src);
    expect(clone).not.toBe(src);
    expect(clone.parentNode).toBeNull();
    expect(clone.querySelectorAll("span").length).toBe(1);
  });

  it("preserves text content and inline colour spans", () => {
    const clone = prepareRowsClone(rows());
    expect(clone.textContent).toBe("line ok");
    expect(clone.querySelector("span")?.getAttribute("style")).toContain("color");
  });

  it("forces the clone selectable and unhides it", () => {
    const clone = prepareRowsClone(rows());
    expect(clone.style.userSelect).toBe("text");
    expect(clone.getAttribute("aria-hidden")).toBeNull();
  });
});
