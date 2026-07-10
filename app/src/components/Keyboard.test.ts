import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import Keyboard from "./Keyboard.svelte";

function openOps(onText = vi.fn(), onCommand = vi.fn(), extra = {}) {
  const r = render(Keyboard, { props: { onText, onCommand, ...extra } });
  return { onText, onCommand, r };
}

test("ops sub-tab: 选区 button dispatches selBegin when idle", async () => {
  const { onCommand } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.click(screen.getByText("选区"));
  expect(onCommand).toHaveBeenCalledWith({ type: "selBegin" });
});

test("ops sub-tab: when selecting, toggle shows 取消 and dispatches selCancel", async () => {
  const { onCommand } = openOps(vi.fn(), vi.fn(), { selecting: true, selCount: 4 });
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  expect(screen.getByText("取消")).toBeInTheDocument();
  await fireEvent.click(screen.getByText("取消"));
  expect(onCommand).toHaveBeenCalledWith({ type: "selCancel" });
});

test("ops sub-tab: paste / copyAfter / selectAllCopy buttons dispatch commands", async () => {
  const { onCommand } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.click(screen.getByText("粘贴"));
  await fireEvent.click(screen.getByText("复制后续"));
  await fireEvent.click(screen.getByText("全选复制"));
  expect(onCommand).toHaveBeenCalledWith({ type: "paste" });
  expect(onCommand).toHaveBeenCalledWith({ type: "copyAfter" });
  expect(onCommand).toHaveBeenCalledWith({ type: "selectAllCopy" });
});

test("ops sub-tab: line up/down buttons dispatch cursor movement commands", async () => {
  const { onCommand } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.click(screen.getByText("上一行"));
  await fireEvent.click(screen.getByText("下一行"));
  expect(onCommand).toHaveBeenCalledWith({ type: "lineUp" });
  expect(onCommand).toHaveBeenCalledWith({ type: "lineDown" });
});

test("ops sub-tab: D-pad up dispatches selMove when selecting", async () => {
  const { onCommand } = openOps(vi.fn(), vi.fn(), { selecting: true });
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.pointerDown(screen.getByText("↑"));
  expect(onCommand).toHaveBeenCalledWith({ type: "selMove", dir: "up" });
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

test("ops sub-tab: circular Enter button sends carriage return", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.pointerDown(screen.getByText("确认"));
  expect(onText).toHaveBeenCalledWith("\r");
});
