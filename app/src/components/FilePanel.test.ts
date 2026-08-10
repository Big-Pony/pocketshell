import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import FilePanel from "./FilePanel.svelte";

beforeEach(() => {
  localStorage.setItem("pocketshell.projectRoot", "/repo-a");
});

function conn() {
  return {
    rpc: vi.fn(async (m: string) => {
      if (m === "git.branches") return { current: "main", branches: ["main"] };
      if (m === "git.log") return { commits: [] };
      // fs.tree 的真实响应形状是 { path, nodes }（见 FileTree.svelte:115），
      // 不是 { entries }——给错形状会让 FileTree 在 nodes 上炸掉。
      if (m === "fs.tree") return { path: "/repo-a", nodes: [] };
      return { files: [] };
    }),
  } as any;
}

const baseProps = () => ({
  conn: conn(),
  onOpenFile: () => {},
  onOpenDiff: () => {},
  onCd: () => {},
  getFocusedPwd: async () => ({ pwd: "/repo-a" }),
  rootTick: 0,
  onToast: () => {},
});

// Git 子 tab 的按钮里除了 "Git" 还有分支名 span，textContent 会是 "Gitmain"，
// 所以按结构取而不是按文本取。
const gitTab = (c: HTMLElement) => c.querySelectorAll(".subtabs button")[1] as HTMLElement;

// 14 期需求 2 根因 B：FilePanel 自己收了 rootTick 却没往下透传，
// App 的广播在 GitPanel 这里落到空地址。
describe("FilePanel 透传 rootTick", () => {
  it("切到 Git 子 tab 后，rootTick 变化会让 GitPanel 按新根重拉", async () => {
    const c = conn();
    const props = { ...baseProps(), conn: c };
    const { container, rerender } = render(FilePanel, { props });

    // 切到 Git 子 tab（默认是「目录」）
    await fireEvent.click(gitTab(container));
    await vi.waitFor(() => {
      expect(c.rpc.mock.calls.some((x: any[]) => x[0] === "git.log")).toBe(true);
    });

    c.rpc.mockClear();
    localStorage.setItem("pocketshell.projectRoot", "/repo-b");
    await rerender({ ...props, rootTick: 1 });

    await vi.waitFor(() => {
      const logCall = c.rpc.mock.calls.find((x: any[]) => x[0] === "git.log");
      expect(logCall, "rootTick 变化应触发 GitPanel 重拉").toBeTruthy();
      expect(logCall![1].cwd).toBe("/repo-b");
    });
  });
});

// 14 期需求 2 附带修复：App 传 {treeTick}、FilePanel 收 refreshTick，
// 名字对不上导致「新建文件后目录树自动刷新」从未生效。
// 这条断言锁住 FilePanel → FileTree 的透传链本身是通的，
// App 侧的传参名由 Step 3 的手工核对保证（App.svelte 整体渲染开销过大，不进单测）。
describe("FilePanel 透传 refreshTick", () => {
  it("refreshTick 变化会让 FileTree 重新读目录", async () => {
    const c = conn();
    const props = { ...baseProps(), conn: c, refreshTick: 0 };
    const { rerender } = render(FilePanel, { props });
    await vi.waitFor(() => {
      expect(c.rpc.mock.calls.some((x: any[]) => x[0] === "fs.tree")).toBe(true);
    });

    c.rpc.mockClear();
    await rerender({ ...props, refreshTick: 1 });
    await vi.waitFor(() => {
      expect(
        c.rpc.mock.calls.some((x: any[]) => x[0] === "fs.tree"),
        "refreshTick 变化应触发目录重读",
      ).toBe(true);
    });
  });
});
