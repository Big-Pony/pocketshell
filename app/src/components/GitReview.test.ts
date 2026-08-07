import { render, waitFor, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import GitReview from "./GitReview.svelte";
import type { ReviewResult } from "../lib/net/protocol";

const RESULT: ReviewResult = {
  scope: { kind: "worktree", stage: "all" },
  title: "", subtitle: "",
  files: [
    { path: "src/auth.ts", status: "M", add: 4, del: 2, staged: "partial",
      hunks: [{ header: "@@ -12,3 +12,4 @@", lines: [
        { kind: "ctx", text: "const t = readToken()" },
        { kind: "del", text: "if (!t) return null" },
        { kind: "add", text: "if (!t) throw new AuthError()" },
      ] }] },
    { path: "src/big.ts", status: "M", add: 300, del: 40,
      hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [{ kind: "add", text: "x" }] }] },
    { path: "bun.lockb", status: "?", add: 3120, del: 0, oversize: true },
    { path: "src/gone.ts", status: "D", add: 0, del: 0 },
    { path: "newdir/", status: "?", add: 0, del: 0, isDir: true },
  ],
  totals: { files: 5, add: 3424, del: 42 },
  truncated: true,
  counts: { all: 5, staged: 1, unstaged: 4 },
};

function connStub(result: ReviewResult = RESULT, delayMs = 0) {
  const rpc = vi.fn(async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return result;
  });
  return { rpc } as any;
}

const props = (over: Record<string, any> = {}) => ({
  conn: connStub(), cwd: "/proj",
  scope: { kind: "worktree", stage: "all" } as const,
  onClose: () => {}, ...over,
});

describe("GitReview 长流渲染", () => {
  it("按服务端顺序渲染全部文件头", async () => {
    const { container } = render(GitReview, { props: props() });
    await waitFor(() => {
      const paths = [...container.querySelectorAll(".fp")].map((e) => e.textContent);
      expect(paths).toEqual(["src/auth.ts", "src/big.ts", "bun.lockb", "src/gone.ts", "newdir/"]);
    });
  });

  it("小改动默认展开，渲染出 diff 行", async () => {
    const { container } = render(GitReview, { props: props() });
    await waitFor(() => {
      const body = container.querySelector('[data-path="src/auth.ts"]');
      expect(body!.querySelectorAll(".ln").length).toBe(3);
      expect(body!.querySelector(".ln.add")!.textContent).toContain("throw new AuthError()");
    });
  });

  it("P3: 大改动默认折叠，且不生成任何 .ln 节点", async () => {
    const { container } = render(GitReview, { props: props() });
    await waitFor(() => {
      const body = container.querySelector('[data-path="src/big.ts"]');
      expect(body!.querySelectorAll(".ln").length).toBe(0);
    });
  });

  it("点文件头展开折叠的文件", async () => {
    const { container } = render(GitReview, { props: props() });
    await waitFor(() => expect(container.querySelector('[data-head="src/big.ts"]')).toBeTruthy());
    await fireEvent.click(container.querySelector('[data-head="src/big.ts"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-path="src/big.ts"]')!.querySelectorAll(".ln").length).toBe(1);
    });
  });

  it("oversize 显示终止文案，且点击不展开出内容", async () => {
    const { container, getByText } = render(GitReview, { props: props() });
    await waitFor(() => expect(getByText("内容过大，无法预览")).toBeTruthy());
    await fireEvent.click(container.querySelector('[data-head="bun.lockb"]')!);
    expect(container.querySelector('[data-path="bun.lockb"]')!.querySelectorAll(".ln").length).toBe(0);
  });

  it("删除的文件与新建目录各有自己的说明", async () => {
    const { getByText } = render(GitReview, { props: props() });
    await waitFor(() => {
      expect(getByText("整个文件已删除")).toBeTruthy();
      expect(getByText("新建目录")).toBeTruthy();
    });
  });

  it("暂存标签只在有 staged 字段时出现", async () => {
    const { container } = render(GitReview, { props: props() });
    await waitFor(() => {
      expect(container.querySelectorAll(".badge").length).toBe(1);
      expect(container.querySelector(".badge")!.textContent).toContain("部分暂存");
    });
  });

  it("底部有完成信号与截断提示", async () => {
    const { getByText } = render(GitReview, { props: props() });
    await waitFor(() => {
      expect(getByText(/到底了，共 5 个文件/)).toBeTruthy();
      expect(getByText("部分文件因改动过大未加载")).toBeTruthy();
    });
  });

  it("空改动显示空态而非空白页", async () => {
    const empty: ReviewResult = { ...RESULT, files: [], totals: { files: 0, add: 0, del: 0 }, truncated: undefined };
    const { getByText } = render(GitReview, { props: props({ conn: connStub(empty) }) });
    await waitFor(() => expect(getByText("没有改动")).toBeTruthy());
  });

  it("回调把 totals 交给上层供入口条回填", async () => {
    const onTotals = vi.fn();
    render(GitReview, { props: props({ onTotals }) });
    await waitFor(() => expect(onTotals).toHaveBeenCalledWith({ files: 5, add: 3424, del: 42 }));
  });
});

describe("GitReview 三档与加载态", () => {
  it("工作区范围显示三档并带计数", async () => {
    const { container, getByText } = render(GitReview, { props: props() });
    await waitFor(() => {
      expect(container.querySelectorAll(".seg").length).toBe(3);
      expect(getByText(/已暂存/).textContent).toContain("1");
    });
  });

  it("commit 范围不显示三档", async () => {
    const r: ReviewResult = { ...RESULT, scope: { kind: "commit", hash: "a1" }, counts: undefined };
    const { container } = render(GitReview, {
      props: props({ conn: connStub(r), scope: { kind: "commit", hash: "a1" } }),
    });
    await waitFor(() => expect(container.querySelector(".rv-body")).toBeTruthy());
    expect(container.querySelectorAll(".seg").length).toBe(0);
  });

  // scope 不带 base（前端不猜基线，交给后端 inferBaseline），基线行显示的
  // 名字必须来自响应体的 baseline.base，而不是请求里的任何东西。
  it("range 范围显示基线行且标注自动推断（基线名取自响应）", async () => {
    const r: ReviewResult = {
      ...RESULT, scope: { kind: "range" },
      counts: undefined, baseline: { base: "main", inferred: true },
    };
    const { getByText } = render(GitReview, {
      props: props({ conn: connStub(r), scope: { kind: "range" } }),
    });
    await waitFor(() => {
      expect(getByText("main")).toBeTruthy();
      expect(getByText(/自动推断/)).toBeTruthy();
    });
  });

  it("切档发出带新 stage 的 rpc", async () => {
    const conn = connStub();
    const { container } = render(GitReview, { props: props({ conn }) });
    await waitFor(() => expect(container.querySelectorAll(".seg").length).toBe(3));
    await fireEvent.click(container.querySelectorAll(".seg")[1]);
    await waitFor(() => {
      const last = conn.rpc.mock.calls.at(-1);
      expect(last[1].scope).toEqual({ kind: "worktree", stage: "staged" });
    });
  });

  it("P4: 切回已拉过的档不再发 rpc", async () => {
    const conn = connStub();
    const { container } = render(GitReview, { props: props({ conn }) });
    await waitFor(() => expect(container.querySelectorAll(".seg").length).toBe(3));
    await fireEvent.click(container.querySelectorAll(".seg")[1]);   // -> staged
    await waitFor(() => expect(conn.rpc).toHaveBeenCalledTimes(2));
    await fireEvent.click(container.querySelectorAll(".seg")[0]);   // -> all（已缓存）
    await new Promise((r) => setTimeout(r, 30));
    expect(conn.rpc).toHaveBeenCalledTimes(2);                      // 没有第三次
  });

  it("首次加载显示骨架屏，顶栏同时已渲染", async () => {
    const { container } = render(GitReview, { props: props({ conn: connStub(RESULT, 50) }) });
    expect(container.querySelector(".rv-back")).toBeTruthy();       // 顶栏立刻在
    expect(container.querySelectorAll(".sk-file").length).toBeGreaterThan(0);
    await waitFor(() => expect(container.querySelectorAll(".sk-file").length).toBe(0));
  });

  it("切档未命中缓存时三档栏不被卸载，被点档位立即高亮", async () => {
    const { container } = render(GitReview, { props: props({ conn: connStub(RESULT, 50) }) });
    await waitFor(() => expect(container.querySelectorAll(".seg").length).toBe(3));
    await fireEvent.click(container.querySelectorAll(".seg")[2]);   // -> unstaged
    expect(container.querySelectorAll(".seg").length).toBe(3);      // 还在
    expect(container.querySelectorAll(".seg")[2].className).toContain("on");
    expect(container.querySelectorAll(".sk-file").length).toBeGreaterThan(0);
  });

  it("刷新时保留旧内容、按钮 disabled", async () => {
    const { container } = render(GitReview, { props: props({ conn: connStub(RESULT, 50) }) });
    await waitFor(() => expect(container.querySelector('[data-head="src/auth.ts"]')).toBeTruthy());
    await fireEvent.click(container.querySelector(".rv-rf")!);
    expect(container.querySelector('[data-head="src/auth.ts"]')).toBeTruthy();  // 旧内容还在
    expect(container.querySelector(".rv-rf")!.hasAttribute("disabled")).toBe(true);
  });

  it("失败时显示错误 + 重试，顶栏返回仍可用", async () => {
    const conn = { rpc: vi.fn(async () => { throw new Error("rpc_error: boom"); }) } as any;
    const onClose = vi.fn();
    const { container, getByText } = render(GitReview, { props: props({ conn, onClose }) });
    await waitFor(() => expect(getByText("重试")).toBeTruthy());
    expect(container.querySelectorAll(".sk-file").length).toBe(0);   // 骨架屏被替换而非叠加
    await fireEvent.click(container.querySelector(".rv-back")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("重试重新发起 rpc", async () => {
    let fail = true;
    const conn = { rpc: vi.fn(async () => { if (fail) throw new Error("boom"); return RESULT; }) } as any;
    const { getByText, container } = render(GitReview, { props: props({ conn }) });
    await waitFor(() => expect(getByText("重试")).toBeTruthy());
    fail = false;
    await fireEvent.click(getByText("重试"));
    await waitFor(() => expect(container.querySelector('[data-head="src/auth.ts"]')).toBeTruthy());
  });

  it("超过 5 秒显示慢链路提示", async () => {
    vi.useFakeTimers();
    try {
      const conn = { rpc: vi.fn(() => new Promise(() => {})) } as any;  // 永不 resolve
      const { queryByText, getByText } = render(GitReview, { props: props({ conn }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(queryByText("正在读取较大的改动…")).toBeNull();
      await vi.advanceTimersByTimeAsync(5000);
      expect(getByText("正在读取较大的改动…")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
