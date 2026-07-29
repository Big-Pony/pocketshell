import { test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import TermCopyOverlay from "./TermCopyOverlay.svelte";

// btoa, not Buffer: the app tsconfig has no node types, and these fixtures are
// ASCII so the latin1 round-trip is exact.
const b64 = (s: string) => btoa(s);
const tick = () => new Promise((r) => setTimeout(r, 0));

function stubConn(data: string | Error) {
  return {
    rpc: vi.fn().mockImplementation(async () =>
      data instanceof Error ? Promise.reject(data) : { data: b64(data) },
    ),
  } as any;
}

// The regression this component test exists for: copy mode used to clone
// xterm's `.xterm-rows`, which the WebGL renderer never populates, so the
// overlay silently came up blank. Text must come from term.capture instead.
test("renders the pane text fetched from term.capture, not from the DOM", async () => {
  const conn = stubConn("a.txt\nb.txt");
  render(TermCopyOverlay, { props: { conn, sessionId: "s1", term: undefined, onClose: () => {}, onCopy: () => {} } });
  await tick();
  expect(screen.getByText(/a\.txt/)).toBeTruthy();
  expect(conn.rpc).toHaveBeenCalledWith("term.capture", { session: "s1" });
});

test("requests PLAIN text — no colours flag, so nothing pastes SGR escapes", async () => {
  const conn = stubConn("x");
  render(TermCopyOverlay, { props: { conn, sessionId: "s1", term: undefined, onClose: () => {}, onCopy: () => {} } });
  await tick();
  const params = conn.rpc.mock.calls[0][1];
  expect(params.colors).toBeUndefined();
});

test("strips tmux's trailing row padding so a paste has no phantom whitespace", async () => {
  const conn = stubConn("out   \n\n   \n");
  const { container } = render(TermCopyOverlay, { props: { conn, sessionId: "s1", term: undefined, onClose: () => {}, onCopy: () => {} } });
  await tick();
  expect(container.querySelector("pre")!.textContent).toBe("out");
});

test("shows the empty hint when the pane has nothing (and on an rpc failure)", async () => {
  const conn = stubConn(new Error("offline"));
  render(TermCopyOverlay, { props: { conn, sessionId: "s1", term: undefined, onClose: () => {}, onCopy: () => {} } });
  await tick();
  expect(screen.getByText("无可复制内容")).toBeTruthy();
});

test("copy with no selection falls back to the whole capture rather than nothing", async () => {
  const conn = stubConn("line1\nline2");
  const onCopy = vi.fn();
  render(TermCopyOverlay, { props: { conn, sessionId: "s1", term: undefined, onClose: () => {}, onCopy } });
  await tick();
  (screen.getByText("复制选中") as HTMLButtonElement).click();
  expect(onCopy).toHaveBeenCalledWith("line1\nline2");
});
