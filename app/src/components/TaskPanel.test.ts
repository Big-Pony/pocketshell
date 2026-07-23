import { test, expect } from "vitest";
import { render } from "@testing-library/svelte";
import TaskPanel from "./TaskPanel.svelte";
import type { LocalSession } from "../lib/session-view";

const noop = () => {};
const sess = (over: Partial<LocalSession>): LocalSession => ({
  name: "x", kind: "tmux", state: "run", cols: 80, rows: 24, lastLine: "", createdAt: 0, attached: true, ...over,
});

function renderPanel(sessions: LocalSession[]) {
  return render(TaskPanel, {
    props: { sessions, onSelect: noop, onRename: noop, onKill: noop, onCopy: noop, onClose: noop },
  });
}

test("un-adopted idle session shows 打开 + 后台运行 + neutral dot", () => {
  const { getByText, container } = renderPanel([
    sess({ name: "work", state: "idle", attached: false, lastLine: "npm run dev" }),
  ]);
  expect(getByText("打开")).toBeInTheDocument();
  expect(getByText("后台运行")).toBeInTheDocument();
  expect(container.querySelector(".dot-idle")).not.toBeNull();
});

test("adopted running session shows 进入", () => {
  const { getByText } = renderPanel([sess({ name: "s1", state: "run", attached: true })]);
  expect(getByText("进入")).toBeInTheDocument();
});

test("keeps the disconnect note but drops the long-press hint", () => {
  const { getByText, queryByText } = renderPanel([]);
  expect(getByText(/断线保护/)).toBeInTheDocument();
  expect(queryByText(/长按会话/)).toBeNull();
});

test("closed session's delete sits INSIDE .row and fires onClose not onSelect", () => {
  let selectN = 0, closeN = 0;
  const { container } = render(TaskPanel, {
    props: {
      sessions: [sess({ name: "old", state: "done", attached: false, closed: true })],
      onSelect: () => selectN++, onRename: noop, onKill: noop, onCopy: noop, onClose: () => closeN++,
    },
  });
  const del = container.querySelector(".row .act-del") as HTMLElement | null;
  expect(del).not.toBeNull();                                   // now inside the row
  expect(container.querySelector(".row-wrap > .act-del")).toBeNull(); // no longer a wrap-level sibling
  del!.click();
  expect(closeN).toBe(1);
  expect(selectN).toBe(0);                                      // stopPropagation blocks row select
});
