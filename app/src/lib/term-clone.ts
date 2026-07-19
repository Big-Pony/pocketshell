// req 7-5 (copy-mode): helpers for the terminal "copy mode" overlay.
//
// Approach: when the user enters copy mode we clone xterm's already-rendered
// `.xterm-rows` node into a plain overlay. The clone is a "dead" DOM subtree —
// cloneNode does NOT copy event listeners, so it carries none of xterm's touch
// handling that otherwise hijacks a long-press into a scroll. It keeps xterm's
// inline colour spans (colours preserved) and its exact layout (no reflow), and
// with user-select:text a mobile long-press selects it natively, exactly like
// the file preview's <pre>.

// The font-related computed properties the overlay must copy from the live
// terminal so the cloned rows keep xterm's metrics (monospace alignment).
export interface TermFont {
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  letterSpacing: string;
}

// Read the font metrics off a computed-style-like object (CSSStyleDeclaration or
// a plain lookup in tests). Pure: no DOM access of its own.
export function readTermFont(cs: { getPropertyValue(prop: string): string }): TermFont {
  return {
    fontFamily: cs.getPropertyValue("font-family"),
    fontSize: cs.getPropertyValue("font-size"),
    lineHeight: cs.getPropertyValue("line-height"),
    letterSpacing: cs.getPropertyValue("letter-spacing"),
  };
}

// xterm scopes its colour CSS under a per-instance owner class
// (`xterm-dom-renderer-owner-N`). A clone placed outside the live `.xterm`
// loses those colours unless its container carries the same owner class.
export function ownerClassOf(classes: Iterable<string>): string | undefined {
  for (const c of classes) if (c.includes("xterm-dom-renderer-owner")) return c;
  return undefined;
}

// Deep-clone the rows node for the overlay and force it selectable. Returns a
// detached clone (the caller appends it). Strips aria-hidden so the copied text
// is exposed to selection/AT rather than hidden. cloneNode(true) intentionally
// drops xterm's listeners — that's the whole point.
export function prepareRowsClone(rows: HTMLElement): HTMLElement {
  const clone = rows.cloneNode(true) as HTMLElement;
  clone.removeAttribute("aria-hidden");
  clone.style.userSelect = "text";
  clone.style.webkitUserSelect = "text";
  return clone;
}
