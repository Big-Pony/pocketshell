// Helpers for the terminal "copy mode" overlay (TermCopyOverlay).
//
// History, because the shape of this file is otherwise puzzling: copy mode used
// to clone xterm's rendered `.xterm-rows` DOM into a listener-free overlay so a
// mobile long-press could select it natively. That worked only under the DOM
// renderer. Since the terminal moved to the WebGL renderer there are no row
// elements at all — glyphs live in a GPU texture — so `.xterm-rows` is empty and
// the clone produced a blank overlay.
//
// Copy mode now asks the agent for the pane's text (`term.capture` without
// colours, which tmux emits as clean plain text) and renders it into a plain
// <pre>. That is strictly better than reading xterm's buffer: it is not capped
// by xterm's scrollback and `-J` restores tmux-folded long lines instead of the
// hard-wrapped copies the frontend holds. The trade-off, accepted deliberately,
// is that colours are lost — the clipboard wants text.
//
// What survives from the clone era is the font metrics, which the overlay still
// copies off the live terminal so its text lines up with what the user sees.

// The font-related computed properties the overlay copies from the live
// terminal so the rendered text keeps xterm's metrics (monospace alignment).
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

// Tidy a raw tmux capture for display + copying.
//
// capture-pane pads every row to the pane width and always runs to the bottom of
// the visible screen, so a raw capture ends in a slab of blank lines and each
// line carries trailing spaces. Both are invisible on screen but very visible
// once pasted, so they are stripped here rather than in the component.
// Interior blank lines are preserved — they are part of the output's shape.
export function cleanCapture(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}
