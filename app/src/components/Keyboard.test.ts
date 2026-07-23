import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import Keyboard from "./Keyboard.svelte";

function openOps(onText = vi.fn(), onCommand = vi.fn(), extra = {}) {
  const r = render(Keyboard, { props: { onText, onCommand, ...extra } });
  return { onText, onCommand, r };
}

// This jsdom version has no native PointerEvent constructor, so
// fireEvent.pointerDown/Move(el, { clientX }) silently drops clientX (it falls
// back to a plain Event, whose constructor ignores unknown init keys). Build
// the event by hand and force clientX on so the swipe-cancel test below can
// actually exercise Keyboard.svelte's clientX-based threshold check.
function pointerEventAt(type: string, clientX: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clientX", { value: clientX });
  return ev;
}

// Phase 3 (需求8): byte-producing keys now defer their first shot by one
// animation frame so a horizontal swipe starting on a key can cancel it
// before anything is sent — see keyDown/keyMove/keyUp in Keyboard.svelte. A
// real tap always generates a pointerup shortly after pointerdown, and that
// pointerup fires the deferred shot immediately (the "released before the
// frame" fast path in keyUp), so these tests now fire both events to model
// an actual tap rather than an indefinite hold.
test("ops sub-tab: Del key sends the forward-delete sequence via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = screen.getByText("Del");
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\x1b[3~");
});

test("ops sub-tab: Tab key sends the tab byte via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = screen.getByText("Tab");
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\x09");
});

test("ops sub-tab: paste / selectText / selectAllCopy buttons dispatch commands", async () => {
  const { onCommand } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.click(screen.getByText("粘贴"));
  await fireEvent.click(screen.getByText("选择文本"));
  await fireEvent.click(screen.getByText("全选复制"));
  expect(onCommand).toHaveBeenCalledWith({ type: "paste" });
  expect(onCommand).toHaveBeenCalledWith({ type: "copyMode" });
  expect(onCommand).toHaveBeenCalledWith({ type: "selectAllCopy" });
});

test("ops sub-tab: PgUp/PgDn buttons send page escape sequences via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const pgUp = screen.getByText("PgUp");
  await fireEvent.pointerDown(pgUp);
  await fireEvent.pointerUp(pgUp);
  const pgDn = screen.getByText("PgDn");
  await fireEvent.pointerDown(pgDn);
  await fireEvent.pointerUp(pgDn);
  expect(onText).toHaveBeenCalledWith("\x1b[5~");
  expect(onText).toHaveBeenCalledWith("\x1b[6~");
});

test("ops sub-tab: D-pad up sends the arrow-up escape via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = screen.getByText("↑");
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\x1b[A");
});

test("ops sub-tab: Home button sends escape sequence via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = screen.getByText("Home");
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\x1b[H");
});

test("normal state shows hint chips and tapping one calls onHint", async () => {
  const onHint = vi.fn();
  render(Keyboard, {
    props: { onText: () => {}, onCommand: () => {}, hints: ["git status", "ls -la"], onHint },
  });
  const chip = screen.getByText("git status");
  await fireEvent.pointerDown(chip);
  expect(onHint).toHaveBeenCalledWith("git status");
});

test("Fn state shows F1–F12 in the function row", async () => {
  render(Keyboard, {
    props: { onText: () => {}, onCommand: () => {}, hints: ["git status"] },
  });
  expect(screen.queryByText("F1")).toBeNull();
  await fireEvent.pointerDown(screen.getByText("Fn"));
  expect(screen.getByText("F1")).toBeInTheDocument();
});

test("Esc always sends the escape sequence", async () => {
  const onText = vi.fn();
  render(Keyboard, {
    props: { onText, onCommand: () => {}, hints: [] },
  });
  const key = screen.getByText("Esc");
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\x1b");
});

test("ops sub-tab: center Enter button sends carriage return", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = screen.getByText("⏎");
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\r");
});

// 需求8 Phase 3: a horizontal drag that starts on a byte key is a panel
// swipe, not a keypress — the deferred first shot must be cancelled so
// nothing is sent, even though the same key eventually gets a pointerup.
test("ops sub-tab: dragging off a key horizontally cancels the deferred send (swipe, not a tap)", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = screen.getByText("Home");
  await fireEvent(key, pointerEventAt("pointerdown", 100));
  // Travel well past KEY_SWIPE_CANCEL_PX (12px) before the deferred frame
  // fires — this is what a real swipe looks like, and must NOT emit a byte.
  await fireEvent(key, pointerEventAt("pointermove", 140));
  await fireEvent(key, pointerEventAt("pointerup", 140));
  expect(onText).not.toHaveBeenCalled();
});
