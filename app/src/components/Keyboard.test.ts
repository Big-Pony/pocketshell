import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import Keyboard from "./Keyboard.svelte";

function openOps(onText = vi.fn(), onCommand = vi.fn(), extra = {}) {
  const r = render(Keyboard, { props: { onText, onCommand, ...extra } });
  return { onText, onCommand, r };
}

test("ops sub-tab: Del key sends the forward-delete sequence via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.pointerDown(screen.getByText("Del"));
  expect(onText).toHaveBeenCalledWith("\x1b[3~");
});

test("ops sub-tab: Tab key sends the tab byte via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.pointerDown(screen.getByText("Tab"));
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
  await fireEvent.pointerDown(screen.getByText("PgUp"));
  await fireEvent.pointerDown(screen.getByText("PgDn"));
  expect(onText).toHaveBeenCalledWith("\x1b[5~");
  expect(onText).toHaveBeenCalledWith("\x1b[6~");
});

test("ops sub-tab: D-pad up sends the arrow-up escape via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.pointerDown(screen.getByText("↑"));
  expect(onText).toHaveBeenCalledWith("\x1b[A");
});

test("ops sub-tab: Home button sends escape sequence via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.pointerDown(screen.getByText("Home"));
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
  await fireEvent.pointerDown(screen.getByText("Esc"));
  expect(onText).toHaveBeenCalledWith("\x1b");
});

test("ops sub-tab: center Enter button sends carriage return", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.pointerDown(screen.getByText("⏎"));
  expect(onText).toHaveBeenCalledWith("\r");
});
