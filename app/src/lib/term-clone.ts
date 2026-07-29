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

// The font metrics the overlay copies off the live terminal so its text keeps
// xterm's metrics (monospace alignment). CSS-ready strings.
export interface TermFont {
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  letterSpacing: string;
}

// The subset of xterm's ITerminalOptions this needs. Declared structurally so
// the function stays pure and testable without an xterm instance.
export interface TermFontOptions {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  letterSpacing?: number;
}

// xterm's own defaults (OptionsService): the overlay must land on these when an
// option is unset, not on whatever the page happens to inherit.
const XTERM_DEFAULT_FONT_SIZE = 15;
const XTERM_DEFAULT_LINE_HEIGHT = 1;

// Derive the overlay's CSS font metrics from xterm's OPTIONS.
//
// This used to read getComputedStyle(term.element), which was wrong in a way
// that showed: xterm sets its font size through JS options and never writes it
// to CSS, so the computed style reported the page's inherited size (~16px)
// while the terminal rendered at its real one (14px by default, user-adjustable
// in settings). Copy mode's text therefore came up noticeably larger than the
// terminal it covered.
//
// Note the unit mismatch this has to bridge: xterm's `lineHeight` is a UNITLESS
// MULTIPLIER of the font size and its `letterSpacing` is in whole pixels,
// whereas CSS wants lengths. Both are resolved here.
export function termFontFromOptions(opts: TermFontOptions | undefined): TermFont {
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const size = num(opts?.fontSize, XTERM_DEFAULT_FONT_SIZE);
  const mult = num(opts?.lineHeight, XTERM_DEFAULT_LINE_HEIGHT);
  return {
    fontFamily: opts?.fontFamily ?? "",
    fontSize: `${size}px`,
    lineHeight: `${size * mult}px`,
    letterSpacing: `${num(opts?.letterSpacing, 0)}px`,
  };
}

// Tidy a raw tmux capture for display + copying.
//
// capture-pane pads every row to the pane width and always runs to the bottom of
// the visible screen, so a raw capture ends in a slab of blank lines and each
// line carries trailing spaces. Both are invisible on screen but very visible
// once pasted, so they are stripped here rather than in the component.
// Interior blank lines are preserved — they are part of the output's shape.
//
// `keepTrailingBlanks` is for copy mode's OLDER pages. That slab of blank rows
// only exists on a capture that runs to the bottom of the screen; a page taken
// from the middle of the scrollback ends wherever the range ends, so its
// trailing blank lines are real content sitting above the next page. Dropping
// them there would silently close up gaps between commands.
export function cleanCapture(text: string, keepTrailingBlanks = false): string {
  const trimmed = text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n");
  return keepTrailingBlanks ? trimmed : trimmed.replace(/\n+$/, "");
}

// ---- copy mode pagination ----------------------------------------------
//
// Copy mode used to fetch the entire scrollback (~2000 rows) in one rpc and drop
// it into the <pre>. Two problems, both reported from a real phone: the browser
// parked at the TOP, so the user had to scroll the whole way down to reach the
// output they had just run, and they waited for every row to cross the wire
// before seeing anything.
//
// So it pages, upward. Page 0 is the newest COPY_PAGE_ROWS rows and the overlay
// jumps straight to the bottom of it; scrolling to the top loads the block
// immediately above, which is prepended.
//
// Why upward-on-scroll rather than quietly backfilling the rest: loading is
// driven by the user scrolling to the top, and scrolling and selecting are
// mutually exclusive gestures. A background fetch would be free to mutate the
// DOM while a long-press selection was in progress and collapse it.
export const COPY_PAGE_ROWS = 200;

// The agent's capture window for page `n`, in its "rows above the cursor"
// coordinates (see TermCaptureResult): both ends inclusive, so page 0 is
// [COPY_PAGE_ROWS .. 1] and each later page is the adjacent block above.
export function pageRange(n: number): { back: number; endBack: number } {
  const endBack = n * COPY_PAGE_ROWS + 1;
  return { back: endBack + COPY_PAGE_ROWS - 1, endBack };
}

// Join an older page onto the front of what is already displayed. Kept separate
// (and tested) because an off-by-one newline here shifts the seam by a row on
// every single page.
export function prependPage(older: string, current: string): string {
  if (!older) return current;
  if (!current) return older;
  return `${older}\n${current}`;
}

// Where scrollTop must move to after content is prepended, so the rows the user
// is looking at stay under their finger. Content added ABOVE the viewport pushes
// everything down by the height it added; without this the view snaps to the
// freshly loaded older text, which is exactly what the user did not ask for.
export function keepScrollAnchored(m: { before: number; after: number; scrollTop: number }): number {
  return Math.max(0, m.scrollTop + (m.after - m.before));
}
