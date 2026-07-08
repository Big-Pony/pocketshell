import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/svelte";
import Terminal from "./Terminal.svelte";

function stubConn() {
  return {
    onOutput: () => () => {},
    attach: () => {},
    resize: () => {},
    rpc: vi.fn().mockResolvedValue({ data: "", currentCommand: "", alternateOn: false, isShell: true }),
  } as any;
}

let origMatchMedia: any;
beforeAll(() => {
  // xterm.open() needs matchMedia to read the device pixel ratio in jsdom.
  origMatchMedia = window.matchMedia;
  const mql = { matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} };
  window.matchMedia = vi.fn().mockReturnValue(mql);
});
afterAll(() => {
  window.matchMedia = origMatchMedia;
});

test("hardens the xterm helper textarea against mobile IME", async () => {
  const { container } = render(Terminal, { props: { conn: stubConn(), sessionId: "s1", active: true } });
  // Wait a tick for onMount's async body (font load + term.open).
  await new Promise((r) => setTimeout(r, 0));
  const ta = container.querySelector("textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
  expect(ta).not.toBeNull();
  expect(ta!.readOnly).toBe(true);
  expect(ta!.getAttribute("inputmode")).toBe("none");
  expect(ta!.getAttribute("tabindex")).toBe("-1");
});
