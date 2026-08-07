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

// ---------------------------------------------------------------------------
// 13 期需求 3：分支折叠。分支多的仓库全量平铺会糊成一大片 chip。
// 测试断言用中文——vitest-setup.ts 固定 locale 为 zh。
// ---------------------------------------------------------------------------
describe("GitPanel 分支折叠", () => {
  function branchConn(current: string, branches: string[]) {
    return makeConn(vi.fn(async (m: string) => {
      if (m === "git.branches") return { current, branches };
      if (m === "git.log") return { commits: [] };
      return { files: [] };
    }));
  }

  it("超过 5 个分支时只渲染 5 个 chip，并给出展开按钮", async () => {
    const { container } = render(GitPanel, {
      props: {
        conn: branchConn("main", ["main", "a", "b", "c", "d", "e", "f"]),
        onOpenDiff: () => {},
      },
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".br").length).toBe(5);
    });
    expect(screen.getByText("展开 2 个")).toBeTruthy();
  });

  it("当前分支置顶", async () => {
    const { container } = render(GitPanel, {
      props: {
        conn: branchConn("dev", ["a", "b", "c", "d", "dev", "e"]),
        onOpenDiff: () => {},
      },
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".br").length).toBe(5);
    });
    expect(container.querySelector(".br")!.textContent!.trim()).toBe("dev");
  });

  it("点展开后全部分支可见，按钮变成收起", async () => {
    const { container } = render(GitPanel, {
      props: {
        conn: branchConn("main", ["main", "a", "b", "c", "d", "e", "f"]),
        onOpenDiff: () => {},
      },
    });
    const btn = await screen.findByText("展开 2 个");
    btn.click();
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".br").length).toBe(7);
    });
    expect(screen.getByText("收起")).toBeTruthy();
  });

  it("分支数不超过上限时不渲染展开按钮（不留死按钮）", async () => {
    render(GitPanel, {
      props: {
        conn: branchConn("main", ["main", "a", "b"]),
        onOpenDiff: () => {},
      },
    });
    await vi.waitFor(() => expect(screen.getByText("main")).toBeTruthy());
    expect(screen.queryByText(/展开/)).toBeNull();
    expect(screen.queryByText("收起")).toBeNull();
  });
});
