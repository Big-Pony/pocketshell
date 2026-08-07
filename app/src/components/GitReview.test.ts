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
