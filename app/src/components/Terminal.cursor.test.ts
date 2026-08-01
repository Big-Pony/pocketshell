import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/svelte";
import Terminal from "./Terminal.svelte";

// Regression guard: the input cursor must stay visible on the phone.
//
// This pane is display-only (`disableStdin: true`) and the mobile-IME fix makes
// xterm's hidden helper textarea readOnly / tabindex=-1 / blurred, so that
// textarea NEVER takes focus. xterm derives `isFocused` from exactly that
// element (CoreBrowserService listens to its focus/blur), so `isFocused` is
// permanently false here and the renderer always draws
// `options.cursorInactiveStyle` — never `cursorStyle`.
//
// xterm's default inactive style is "outline": a hairline box one device pixel
// wide. It was already being used before, but xterm 6.0 added DECSCUSR
// (`CSI Ps SP q`) support, so cursor style now resolves as
// `decPrivateModes.cursorStyle ?? options.cursorStyle`. TUIs like Claude Code
// emit that sequence; 5.5.0 ignored it, 6.x honours it — and combined with the
// permanently-inactive path the cursor became effectively invisible on a phone
// screen. Pinning the INACTIVE style is what actually controls this pane.
//
// Asserting on the constructor options (not pixels) is deliberate: jsdom has no
// layout or WebGL, so the drawn cursor cannot be measured here. Whether the
// block reads clearly against each theme's --term-accent is a real-device call.
function stubConn() {
  return {
    onOutput: () => () => {},
    onInput: () => () => {},
    attach: () => {},
    resize: () => {},
    rpc: vi.fn().mockResolvedValue({ data: "", currentCommand: "", alternateOn: false, isShell: true }),
  } as any;
}

let origMatchMedia: any;
beforeAll(() => {
  origMatchMedia = window.matchMedia;
  const mql = { matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} };
  window.matchMedia = vi.fn().mockReturnValue(mql);
});
afterAll(() => {
  window.matchMedia = origMatchMedia;
});

test("renders a visible cursor while the pane is permanently unfocused", async () => {
  // onReady hands back the live xterm instance — the same object the renderer
  // reads its options from, so this asserts the real terminal, not a copy.
  let term: any;
  render(Terminal, {
    props: { conn: stubConn(), sessionId: "s1", active: true, onReady: (_id: string, t: any) => (term = t) },
  });
  await new Promise((r) => setTimeout(r, 0));

  expect(term).toBeDefined();
  const opts = term.options;

  // Both options are required, and neither is sufficient alone:
  //
  // 1. Without showCursorImmediately, xterm waits for the first focus or
  //    keystroke before setting isCursorInitialized — and this pane gets
  //    neither — so the cursor never enters the render model at all. Verified
  //    in a real browser: with only the style set, the renderer's cursor model
  //    stayed undefined and no cursor was drawn.
  expect(opts.showCursorImmediately).toBe(true);
  // 2. The style that this pane actually renders, because isFocused is never
  //    true. Left at xterm's "outline" default it is a one-device-pixel
  //    hairline, effectively invisible on a phone.
  expect(opts.cursorInactiveStyle).toBe("block");

  // Guard the premise: if xterm ever lets this pane take focus, the reasoning
  // above stops holding and this test needs revisiting.
  expect(opts.disableStdin).toBe(true);
});
