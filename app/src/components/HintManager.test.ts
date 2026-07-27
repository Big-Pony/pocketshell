import { test, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import HintManager from "./HintManager.svelte";

// 面板只碰 Connection 的 hints 切片，stub 这几个成员就够（同 SnippetPanel.test.ts）。
function fakeConn(items: { id: string; text: string }[] = []) {
  return {
    listHints: vi.fn(async () => ({ items })),
    addHints: vi.fn(),
    updateHint: vi.fn(),
    removeHint: vi.fn(),
    clearHints: vi.fn(),
    onHintsChanged: () => () => {},
    onError: () => () => {},
  } as any;
}

test("空库时显示空态提示", async () => {
  const { findByText } = render(HintManager, { props: { conn: fakeConn() } });
  expect(await findByText(/还没有自定义联想/)).toBeTruthy();
});

test("列出已有条目，并可删除", async () => {
  const conn = fakeConn([{ id: "h1", text: "git graph" }]);
  const { findByText, getByLabelText } = render(HintManager, { props: { conn } });
  await findByText("git graph");
  await fireEvent.click(getByLabelText("删除"));
  expect(conn.removeHint).toHaveBeenCalledWith("h1");
});

test("输入框提交走 addHints", async () => {
  const conn = fakeConn();
  const { getByPlaceholderText, getByText } = render(HintManager, { props: { conn } });
  const input = getByPlaceholderText(/添加一条/) as HTMLInputElement;
  await fireEvent.input(input, { target: { value: "  my-cmd  " } });
  await fireEvent.click(getByText("添加"));
  expect(conn.addHints).toHaveBeenCalledWith(["my-cmd"]); // 前后空白被 trim
});

test("点编辑切到保存修改态，提交走 updateHint", async () => {
  const conn = fakeConn([{ id: "h1", text: "old" }]);
  const { findByLabelText, getByText } = render(HintManager, { props: { conn } });
  await fireEvent.click(await findByLabelText("编辑"));
  const save = getByText("保存修改");
  await fireEvent.click(save);
  expect(conn.updateHint).toHaveBeenCalledWith("h1", "old");
  expect(conn.addHints).not.toHaveBeenCalled();
});

test("取消编辑回到添加态", async () => {
  const conn = fakeConn([{ id: "h1", text: "old" }]);
  const { findByLabelText, getByText, queryByText } = render(HintManager, { props: { conn } });
  await fireEvent.click(await findByLabelText("编辑"));
  await fireEvent.click(getByText("取消"));
  expect(queryByText("保存修改")).toBeNull();
  expect(getByText("添加")).toBeTruthy();
});

test("导入解析失败时提示、不发请求", async () => {
  const conn = fakeConn();
  const { getByPlaceholderText, getByText, findByText } = render(HintManager, { props: { conn } });
  await fireEvent.input(getByPlaceholderText(/粘贴 AI 返回的 JSON/), { target: { value: "   " } });
  await fireEvent.click(getByText("导入"));
  expect(await findByText(/没解析出任何条目/)).toBeTruthy();
  expect(conn.addHints).not.toHaveBeenCalled();
});

test("导入过滤掉内置条目，并在反馈里分项计数", async () => {
  // "git status" 是内置的；"my-cmd" 会真的入库
  const conn = fakeConn();
  conn.listHints = vi.fn(async () => ({ items: conn.addHints.mock.calls.length
    ? [{ id: "h1", text: "my-cmd" }] : [] }));
  const { getByPlaceholderText, getByText, findByText } = render(HintManager, { props: { conn } });
  await fireEvent.input(getByPlaceholderText(/粘贴 AI 返回的 JSON/), {
    target: { value: '["git status", "my-cmd"]' },
  });
  await fireEvent.click(getByText("导入"));
  await waitFor(() => expect(conn.addHints).toHaveBeenCalledWith(["my-cmd"]));
  expect(await findByText(/导入 1 条.*1 条已内置/)).toBeTruthy();
});

test("全部清空需确认，确认后走 clearHints", async () => {
  const conn = fakeConn([{ id: "h1", text: "a" }]);
  const spy = vi.spyOn(window, "confirm").mockReturnValue(true);
  const { getByText } = render(HintManager, { props: { conn } });
  await fireEvent.click(getByText("全部清空"));
  expect(conn.clearHints).toHaveBeenCalled();
  spy.mockRestore();
});

test("取消确认时不清空", async () => {
  const conn = fakeConn([{ id: "h1", text: "a" }]);
  const spy = vi.spyOn(window, "confirm").mockReturnValue(false);
  const { getByText } = render(HintManager, { props: { conn } });
  await fireEvent.click(getByText("全部清空"));
  expect(conn.clearHints).not.toHaveBeenCalled();
  spy.mockRestore();
});
