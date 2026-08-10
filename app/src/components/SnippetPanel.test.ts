import { test, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import SnippetPanel from "./SnippetPanel.svelte";

// The panel only touches the snippet slice of Connection, so a stub with those
// five members is enough (same shape trick as SettingsPanel.test.ts's bare conn).
function fakeConn(items: any[] = []) {
  return {
    onSnippets: (cb: (s: any[]) => void) => { cb(items); return () => {}; },
    listSnippets: vi.fn(),
    addSnippet: vi.fn(),
    updateSnippet: vi.fn(),
    removeSnippet: vi.fn(),
  } as any;
}
const one = [{ id: "s1", group: "项目", label: "build", command: "npm run build", autoEnter: true }];

test("默认态不显示删除按钮，显示管理与自定义按钮", () => {
  const { queryByLabelText, getByText } = render(SnippetPanel, {
    props: { conn: fakeConn(one), onInsert: () => {} },
  });
  expect(queryByLabelText("删除")).toBeNull();
  expect(getByText("管理")).toBeTruthy();
  expect(getByText("＋ 自定义")).toBeTruthy();
});

test("进入管理态后出现删除按钮，且新增按钮消失", async () => {
  const { getByText, getByLabelText, queryByText } = render(SnippetPanel, {
    props: { conn: fakeConn(one), onInsert: () => {} },
  });
  await fireEvent.click(getByText("管理"));
  expect(getByLabelText("删除")).toBeTruthy();
  expect(queryByText("＋ 自定义")).toBeNull();
  expect(getByText("完成")).toBeTruthy();
});

test("管理态点击指令打开编辑弹窗而不是插入", async () => {
  const onInsert = vi.fn();
  const { getByText } = render(SnippetPanel, { props: { conn: fakeConn(one), onInsert } });
  await fireEvent.click(getByText("管理"));
  await fireEvent.click(getByText("build"));
  expect(onInsert).not.toHaveBeenCalled();
  expect(getByText("编辑指令")).toBeTruthy();
});

test("默认态点击指令插入到终端", async () => {
  const onInsert = vi.fn();
  const { getByText } = render(SnippetPanel, { props: { conn: fakeConn(one), onInsert } });
  await fireEvent.click(getByText("build"));
  expect(onInsert).toHaveBeenCalledWith("npm run build\r");
});

test("退出管理态回到使用态", async () => {
  const { getByText, queryByLabelText } = render(SnippetPanel, {
    props: { conn: fakeConn(one), onInsert: () => {} },
  });
  await fireEvent.click(getByText("管理"));
  await fireEvent.click(getByText("完成"));
  expect(queryByLabelText("删除")).toBeNull();
  expect(getByText("＋ 自定义")).toBeTruthy();
});

test("编辑保存走 updateSnippet 而不是 addSnippet", async () => {
  const conn = fakeConn(one);
  const { getByText, getByPlaceholderText } = render(SnippetPanel, {
    props: { conn, onInsert: () => {} },
  });
  await fireEvent.click(getByText("管理"));
  await fireEvent.click(getByText("build"));
  await fireEvent.input(getByPlaceholderText("显示名，如 build"), { target: { value: "build2" } });
  await fireEvent.click(getByText("保存"));
  expect(conn.addSnippet).not.toHaveBeenCalled();
  expect(conn.updateSnippet).toHaveBeenCalledWith("s1", {
    group: "项目", label: "build2", command: "npm run build", autoEnter: true,
  });
});

// 14 期需求 5：假空态。listSnippets 是 push 型，回调到达前 groups 恒为空，
// 与「确实没有片段」共用一个条件，于是加载中就先给出一句肯定的错话。
test("加载中不显示「还没有自定义指令」空态", () => {
  const conn = { onSnippets: vi.fn(() => () => {}), listSnippets: vi.fn() } as any;
  const { container } = render(SnippetPanel, { props: { conn, onInsert: () => {} } });
  expect(container.querySelector(".sp-empty")).toBeNull();
  expect(container.querySelector(".sk")).not.toBeUndefined();
});

test("确实加载完且为空时才显示空态", async () => {
  let cb: ((s: any[]) => void) | null = null;
  const conn = {
    onSnippets: vi.fn((f: (s: any[]) => void) => { cb = f; return () => {}; }),
    listSnippets: vi.fn(),
  } as any;
  const { container, findByText } = render(SnippetPanel, { props: { conn, onInsert: () => {} } });
  cb!([]);
  await findByText("还没有自定义指令，点右上角 ＋ 添加");
  expect(container.querySelector(".sp-empty")).toBeTruthy();
});
