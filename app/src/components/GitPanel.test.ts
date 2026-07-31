import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import GitPanel from "./GitPanel.svelte";

// 项目根书签存在 localStorage；不设即为 "/"，组件会走 noRoot 分支不渲染面板。
beforeEach(() => {
  localStorage.setItem("pocketshell.projectRoot", "/repo");
});

function makeConn(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as never;
}

describe("GitPanel 刷新按钮", () => {
  it("渲染刷新按钮", async () => {
    const rpc = vi.fn().mockResolvedValue({ current: "main", branches: ["main"], commits: [], files: [] });
    render(GitPanel, { props: { conn: makeConn(rpc), onOpenDiff: () => {} } });
    expect(await screen.findByLabelText("刷新")).toBeTruthy();
  });

  it("点击刷新重新拉取三项 git 数据", async () => {
    const rpc = vi.fn().mockResolvedValue({ current: "main", branches: ["main"], commits: [], files: [] });
    render(GitPanel, { props: { conn: makeConn(rpc), onOpenDiff: () => {} } });
    const btn = await screen.findByLabelText("刷新");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(3)); // 挂载时一轮
    rpc.mockClear();
    btn.click();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(3)); // 刷新又一轮
    const methods = rpc.mock.calls.map((c) => c[0]).sort();
    expect(methods).toEqual(["git.branches", "git.log", "git.status"]);
  });
});
