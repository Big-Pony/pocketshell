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
