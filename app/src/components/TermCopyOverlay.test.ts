import { test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import TermCopyOverlay from "./TermCopyOverlay.svelte";
import { COPY_PAGE_ROWS } from "../lib/term-clone";

// btoa, not Buffer: the app tsconfig has no node types, and these fixtures are
// ASCII so the latin1 round-trip is exact.
const b64 = (s: string) => btoa(s);
const tick = () => new Promise((r) => setTimeout(r, 0));
// Loading a page settles across a requestAnimationFrame (the scroll-position
// compensation has to wait for layout), so a bare macrotask tick can land
// mid-flight. Drain both a few times instead of racing it.
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await tick();
  }
};

// One page of text, or an error. atTop defaults to true so a single-page stub
// behaves like a session with nothing older.
function stubConn(data: string | Error, atTop = true) {
  return {
    rpc: vi.fn().mockImplementation(async () =>
      data instanceof Error ? Promise.reject(data) : { data: b64(data), atTop },
    ),
  } as any;
}

// A paged session: pages[0] is the newest, pages[n] older. atTop on the last.
function stubPages(pages: string[]) {
  let n = 0;
  return {
    rpc: vi.fn().mockImplementation(async () => {
      const i = n++;
      return { data: b64(pages[i] ?? ""), atTop: i >= pages.length - 1 };
    }),
  } as any;
}

const props = (conn: any, extra: Record<string, unknown> = {}) => ({
  props: { conn, sessionId: "s1", term: undefined, onClose: () => {}, onCopy: () => {}, ...extra },
});

// The regression this component test exists for: copy mode used to clone
// xterm's `.xterm-rows`, which the WebGL renderer never populates, so the
// overlay silently came up blank. Text must come from term.capture instead.
test("renders the pane text fetched from term.capture, not from the DOM", async () => {
  const conn = stubConn("a.txt\nb.txt");
  render(TermCopyOverlay, props(conn));
  await tick();
  expect(screen.getByText(/a\.txt/)).toBeTruthy();
});

test("requests PLAIN text — no colours flag, so nothing pastes SGR escapes", async () => {
  const conn = stubConn("x");
  render(TermCopyOverlay, props(conn));
  await tick();
  const params = conn.rpc.mock.calls[0][1];
  expect(params.colors).toBeUndefined();
});

test("strips tmux's trailing row padding so a paste has no phantom whitespace", async () => {
  const conn = stubConn("out   \n\n   \n");
  const { container } = render(TermCopyOverlay, props(conn));
  await tick();
  expect(container.querySelector("pre")!.textContent).toBe("out");
});

test("shows the empty hint when the pane has nothing (and on an rpc failure)", async () => {
  const conn = stubConn(new Error("offline"));
  render(TermCopyOverlay, props(conn));
  await tick();
  expect(screen.getByText("无可复制内容")).toBeTruthy();
});

test("copy with no selection falls back to the whole capture rather than nothing", async () => {
  const conn = stubConn("line1\nline2");
  const onCopy = vi.fn();
  render(TermCopyOverlay, props(conn, { onCopy }));
  await tick();
  (screen.getByText("复制选中") as HTMLButtonElement).click();
  expect(onCopy).toHaveBeenCalledWith("line1\nline2");
});

// ---- paging (problems 3+4: opened at the top, and waited for ~2000 rows) ----

// The whole point: the user opens copy mode to grab what just ran, so the first
// request must be the NEWEST page only, not the entire scrollback.
test("first fetch asks for only the newest page, not the whole scrollback", async () => {
  const conn = stubConn("x");
  render(TermCopyOverlay, props(conn));
  await tick();
  expect(conn.rpc).toHaveBeenCalledWith("term.capture", {
    session: "s1",
    back: COPY_PAGE_ROWS,
    endBack: 1,
  });
});

test("does not fetch a second page on its own — loading is user-driven", async () => {
  const conn = stubPages(["newest", "older"]);
  render(TermCopyOverlay, props(conn));
  await tick();
  await tick();
  expect(conn.rpc).toHaveBeenCalledTimes(1);
});

test("scrolling to the top loads the page above and PREPENDS it", async () => {
  const conn = stubPages(["newest", "older"]);
  const { container } = render(TermCopyOverlay, props(conn));
  await tick();
  const box = container.querySelector(".cm-content") as HTMLElement;
  box.dispatchEvent(new Event("scroll"));
  await settle();
  expect(conn.rpc).toHaveBeenCalledTimes(2);
  expect(conn.rpc.mock.calls[1][1]).toEqual({
    session: "s1",
    back: COPY_PAGE_ROWS * 2,
    endBack: COPY_PAGE_ROWS + 1,
  });
  expect(container.querySelector("pre")!.textContent).toBe("older\nnewest");
});

// Guard against a scroll gesture firing a burst of identical requests.
test("concurrent scroll events do not stack up duplicate requests", async () => {
  const conn = stubPages(["newest", "older", "oldest"]);
  const { container } = render(TermCopyOverlay, props(conn));
  await tick();
  const box = container.querySelector(".cm-content") as HTMLElement;
  box.dispatchEvent(new Event("scroll"));
  box.dispatchEvent(new Event("scroll"));
  box.dispatchEvent(new Event("scroll"));
  await settle();
  expect(conn.rpc).toHaveBeenCalledTimes(2);
});

test("stops requesting once the agent reports the start of history", async () => {
  const conn = stubPages(["newest", "older"]); // second page carries atTop
  const { container } = render(TermCopyOverlay, props(conn));
  await tick();
  const box = container.querySelector(".cm-content") as HTMLElement;
  box.dispatchEvent(new Event("scroll"));
  await settle();
  box.dispatchEvent(new Event("scroll"));
  await settle();
  expect(conn.rpc).toHaveBeenCalledTimes(2);
  expect(screen.getByText("已到最早")).toBeTruthy();
});

// atTop has to come from the agent: tmux's -J joins wrapped rows, so a short
// page is NOT evidence of the end, and overshooting the top makes tmux clamp
// and re-serve the oldest row rather than report anything.
test("a SHORT page is not treated as the end unless the agent says so", async () => {
  const conn = {
    rpc: vi.fn()
      .mockResolvedValueOnce({ data: b64("a\nb"), atTop: false }) // short, more above
      .mockResolvedValueOnce({ data: b64("older"), atTop: false }),
  } as any;
  const { container } = render(TermCopyOverlay, props(conn));
  await tick();
  const box = container.querySelector(".cm-content") as HTMLElement;
  box.dispatchEvent(new Event("scroll"));
  await settle();
  expect(conn.rpc).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("已到最早")).toBeNull();
});

// Older pages come from the MIDDLE of the scrollback, where trailing blank rows
// are real gaps between commands rather than tmux's bottom-of-screen padding.
test("keeps blank rows at the foot of an older page (they are real gaps)", async () => {
  const conn = stubPages(["newest", "older\n\n"]);
  const { container } = render(TermCopyOverlay, props(conn));
  await tick();
  const box = container.querySelector(".cm-content") as HTMLElement;
  box.dispatchEvent(new Event("scroll"));
  await settle();
  expect(container.querySelector("pre")!.textContent).toBe("older\n\n\nnewest");
});

test("an rpc failure while paging leaves the loaded text alone and lets the user retry", async () => {
  const conn = {
    rpc: vi.fn()
      .mockResolvedValueOnce({ data: b64("newest"), atTop: false })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ data: b64("older"), atTop: true }),
  } as any;
  const { container } = render(TermCopyOverlay, props(conn));
  await tick();
  const box = container.querySelector(".cm-content") as HTMLElement;
  box.dispatchEvent(new Event("scroll"));
  await settle();
  expect(container.querySelector("pre")!.textContent).toBe("newest"); // survived
  box.dispatchEvent(new Event("scroll"));
  await settle();
  expect(container.querySelector("pre")!.textContent).toBe("older\nnewest");
});

// Honesty requirement: with paging, the <pre> holds only what has been loaded,
// so "select all" must not imply the whole session came along.
test("labels the select-all button as covering only what is loaded", async () => {
  const conn = stubConn("x", false);
  render(TermCopyOverlay, props(conn));
  await tick();
  expect(screen.getByText("全选已载")).toBeTruthy();
});

test("tells the user how much is loaded and that more is above", async () => {
  const conn = stubConn("a\nb\nc", false);
  render(TermCopyOverlay, props(conn));
  await tick();
  expect(screen.getByText(/已载入 3 行/)).toBeTruthy();
  expect(screen.getByText("向上滚动载入更早内容")).toBeTruthy();
});
