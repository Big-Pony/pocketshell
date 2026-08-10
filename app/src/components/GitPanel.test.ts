import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/svelte";
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
      expect(container.querySelectorAll("span.br").length).toBe(5);
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
      expect(container.querySelectorAll("span.br").length).toBe(5);
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
      expect(container.querySelectorAll("span.br").length).toBe(7);
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

  // 展开按钮与分支 chip 同款（同一排、同边框圆角），只靠文字颜色区分。
  // 它带 .br 但必须是 <button> 而非 <span>——数分支的地方一律用 span.br，
  // 否则按钮会被当成一个分支混进去。
  it("展开按钮与分支 chip 同款，但不算作一个分支", async () => {
    const { container } = render(GitPanel, {
      props: {
        conn: branchConn("main", ["main", "a", "b", "c", "d", "e", "f"]),
        onOpenDiff: () => {},
      },
    });
    const btn = await screen.findByText("展开 2 个");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.classList.contains("br"), "应复用分支 chip 的外观").toBe(true);
    // 和 chip 同处一个 .brs 容器里，才能跟着一起换行
    expect(btn.closest(".brs"), "应与 chip 同排").toBeTruthy();
    expect(container.querySelectorAll("span.br").length, "按钮不该被算成分支").toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Git 审查增强：三个入口（工作区 / 分支相对基线 / 单个 commit）。
// 入口只负责把 scope 交给 GitReview，range 一档**不传 base**——基线由后端
// inferBaseline 推断，入口条上的名字只是显示文案。
// ---------------------------------------------------------------------------
const BRANCHES = { current: "feat/x", branches: ["feat/x", "main"] };
const LOG = { commits: [{ hash: "a3f91c2aaa", msg: "refactor: x", author: "Claude", when: "12 分钟前", files: [] }] };
const STATUS = { files: [{ path: "src/auth.ts", status: "M" }, { path: "b.ts", status: "?" }] };
const REVIEW = {
  scope: { kind: "worktree", stage: "all" }, title: "", subtitle: "",
  files: [{ path: "src/auth.ts", status: "M", add: 4, del: 2, hunks: [] }],
  totals: { files: 2, add: 142, del: 37 }, counts: { all: 2, staged: 0, unstaged: 2 },
};

function connStub(extra: Record<string, any> = {}) {
  return {
    rpc: vi.fn(async (m: string) => {
      if (m === "git.branches") return BRANCHES;
      if (m === "git.log") return LOG;
      if (m === "git.status") return STATUS;
      if (m === "git.review") return REVIEW;
      return {};
    }),
    ...extra,
  } as any;
}

describe("GitPanel 审查入口", () => {
  beforeEach(() => {
    localStorage.setItem("pocketshell.projectRoot", "/proj");
  });

  it("变更区顶部有「审查全部改动」入口，带文件数", async () => {
    const { getByText } = render(GitPanel, { props: { conn: connStub(), onOpenDiff: () => {} } });
    await waitFor(() => expect(getByText(/审查全部改动/)).toBeTruthy());
    await waitFor(() => expect(getByText(/2 个文件/)).toBeTruthy());
  });

  it("点入口打开全屏审查页，发出 worktree/all 的 rpc", async () => {
    const conn = connStub();
    const { getByText, container } = render(GitPanel, { props: { conn, onOpenDiff: () => {} } });
    await waitFor(() => expect(getByText(/审查全部改动/)).toBeTruthy());
    await fireEvent.click(getByText(/审查全部改动/));
    await waitFor(() => expect(container.querySelector(".rv")).toBeTruthy());
    const call = conn.rpc.mock.calls.find((c: any[]) => c[0] === "git.review");
    expect(call[1].scope).toEqual({ kind: "worktree", stage: "all" });
  });

  it("分支区有「本分支相对 main」入口，点开发 range scope 且不带 base", async () => {
    const conn = connStub();
    const { getByText } = render(GitPanel, { props: { conn, onOpenDiff: () => {} } });
    await waitFor(() => expect(getByText(/本分支相对/)).toBeTruthy());
    await fireEvent.click(getByText(/本分支相对/));
    await waitFor(() => {
      const call = conn.rpc.mock.calls.find((c: any[]) => c[0] === "git.review");
      expect(call[1].scope).toEqual({ kind: "range" });
    });
  });

  it("入口条上的基线名取本地猜测，仅作显示", async () => {
    const { getByText } = render(GitPanel, { props: { conn: connStub(), onOpenDiff: () => {} } });
    await waitFor(() => expect(getByText("本分支相对 main")).toBeTruthy());
  });

  it("点历史里的 commit 打开该提交的审查页", async () => {
    const conn = connStub();
    const { getByText } = render(GitPanel, { props: { conn, onOpenDiff: () => {} } });
    await waitFor(() => expect(getByText(/refactor: x/)).toBeTruthy());
    await fireEvent.click(getByText(/refactor: x/));
    await waitFor(() => {
      const call = conn.rpc.mock.calls.find((c: any[]) => c[0] === "git.review");
      expect(call[1].scope).toEqual({ kind: "commit", hash: "a3f91c2aaa" });
    });
  });

  it("单文件点击仍走 onOpenDiff（旧习惯不打断）", async () => {
    const onOpenDiff = vi.fn();
    const { getByText } = render(GitPanel, { props: { conn: connStub(), onOpenDiff } });
    await waitFor(() => expect(getByText("src/auth.ts")).toBeTruthy());
    await fireEvent.click(getByText("src/auth.ts"));
    expect(onOpenDiff).toHaveBeenCalledWith("/proj/src/auth.ts");
  });

  it("审查页返回后回到面板", async () => {
    const { getByText, container } = render(GitPanel, { props: { conn: connStub(), onOpenDiff: () => {} } });
    await waitFor(() => expect(getByText(/审查全部改动/)).toBeTruthy());
    await fireEvent.click(getByText(/审查全部改动/));
    await waitFor(() => expect(container.querySelector(".rv")).toBeTruthy());
    await fireEvent.click(container.querySelector(".rv-back")!);
    await waitFor(() => expect(container.querySelector(".rv")).toBeNull());
  });

  it("进过一次审查页后，入口条回填 +X −Y", async () => {
    const { getByText, container } = render(GitPanel, { props: { conn: connStub(), onOpenDiff: () => {} } });
    await waitFor(() => expect(getByText(/审查全部改动/)).toBeTruthy());
    await fireEvent.click(getByText(/审查全部改动/));
    await waitFor(() => expect(container.querySelector(".rv")).toBeTruthy());
    await fireEvent.click(container.querySelector(".rv-back")!);
    await waitFor(() => expect(getByText(/\+142/)).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// 14 期需求 2：Git 面板 cwd 跟随聚焦终端。
// 项目根书签在 localStorage，响应式靠 App 的 rootTick 计数器广播。
// 三条断言分别锁住三个曾经的根因：根被冻结成 const / 未接 rootTick / effect 无依赖。
// ---------------------------------------------------------------------------
describe("GitPanel 跟随项目根", () => {
  function cwdConn() {
    return {
      rpc: vi.fn(async (m: string) => {
        if (m === "git.branches") return { current: "main", branches: ["main"] };
        if (m === "git.log") return { commits: [] };
        return { files: [] };
      }),
    } as any;
  }

  it("rootTick 变化时按新的项目根重新拉取", async () => {
    localStorage.setItem("pocketshell.projectRoot", "/repo-a");
    const conn = cwdConn();
    const { rerender } = render(GitPanel, {
      props: { conn, onOpenDiff: () => {}, rootTick: 0 },
    });
    await vi.waitFor(() => expect(conn.rpc).toHaveBeenCalledTimes(3));
    expect(conn.rpc.mock.calls[0][1].cwd).toBe("/repo-a");

    conn.rpc.mockClear();
    localStorage.setItem("pocketshell.projectRoot", "/repo-b");
    await rerender({ conn, onOpenDiff: () => {}, rootTick: 1 });

    await vi.waitFor(() => expect(conn.rpc).toHaveBeenCalledTimes(3));
    for (const call of conn.rpc.mock.calls) {
      expect(call[1].cwd, "切根后三个 RPC 都该用新根").toBe("/repo-b");
    }
  });

  // 这一条锁的是比「不自动刷新」更隐蔽的缺陷：根被冻结成 const 时，
  // 手点 ⟳ 刷的也是旧目录——按钮看起来正常响应，数据却是错的。
  it("切根后点 ⟳ 刷新用的是新根，不是挂载时那个", async () => {
    localStorage.setItem("pocketshell.projectRoot", "/repo-a");
    const conn = cwdConn();
    const { rerender } = render(GitPanel, {
      props: { conn, onOpenDiff: () => {}, rootTick: 0 },
    });
    await vi.waitFor(() => expect(conn.rpc).toHaveBeenCalledTimes(3));

    localStorage.setItem("pocketshell.projectRoot", "/repo-b");
    await rerender({ conn, onOpenDiff: () => {}, rootTick: 1 });
    await vi.waitFor(() => expect(conn.rpc).toHaveBeenCalledTimes(6));

    conn.rpc.mockClear();
    (await screen.findByLabelText("刷新")).click();
    await vi.waitFor(() => expect(conn.rpc).toHaveBeenCalledTimes(3));
    expect(conn.rpc.mock.calls[0][1].cwd).toBe("/repo-b");
  });

  // rootTick 不变时不得重复拉取：effect 会因为任何 $state 变化而重跑，
  // 少了 lastTick 比对就会在每次 branches/commits 赋值后再打一轮 RPC，无限循环。
  it("rootTick 不变时不重复拉取", async () => {
    localStorage.setItem("pocketshell.projectRoot", "/repo-a");
    const conn = cwdConn();
    const { rerender } = render(GitPanel, {
      props: { conn, onOpenDiff: () => {}, rootTick: 3 },
    });
    await vi.waitFor(() => expect(conn.rpc).toHaveBeenCalledTimes(3));
    await rerender({ conn, onOpenDiff: () => {}, rootTick: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.rpc).toHaveBeenCalledTimes(3);
  });
});
