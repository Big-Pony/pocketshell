import { test, expect } from "vitest";
import { render } from "@testing-library/svelte";
import TaskPanel from "./TaskPanel.svelte";
import type { LocalSession } from "../lib/session-view";

const noop = () => {};
const sess = (over: Partial<LocalSession>): LocalSession => ({
  name: "x", state: "run", cols: 80, rows: 24, lastLine: "", createdAt: 0, attached: true, ...over,
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
