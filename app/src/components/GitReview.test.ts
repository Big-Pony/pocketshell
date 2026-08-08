import { render, waitFor, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const BRANCHES = { current: "feat/x", branches: ["feat/x", "main", "dev"] };

function connStub(result: ReviewResult = RESULT, delayMs = 0) {
  const rpc = vi.fn(async (m: string) => {
    if (m === "git.branches") return BRANCHES;
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

describe("GitReview 文件头路径的 bidi", () => {
  // 真机走查发现的 bug：`.fp` 只写 `direction: rtl` 时，浏览器会把行尾的
  // 中性字符按 RTL 规则甩到视觉行首，未跟踪目录 `brandnew/` 显示成
  // `/brandnew`。修法是补 `unicode-bidi: plaintext`。
  //
  // jsdom 不实现 bidi 重排，渲染断言测不出这件事，所以这里退而扫描组件
  // 源码——它锁住的是「这条声明不能被顺手删掉」，这正是回潮的实际形态。
  it("`.fp` 同时声明 direction:rtl 与 unicode-bidi:plaintext", () => {
    const src = readFileSync(resolve(__dirname, "./GitReview.svelte"), "utf8");
    const rule = src.match(/\.fp\s*\{[^}]*\}/s);
    expect(rule, "找不到 .fp 规则").toBeTruthy();
    expect(rule![0]).toContain("direction: rtl");
    expect(rule![0]).toContain("unicode-bidi: plaintext");
  });
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

// ---------------------------------------------------------------------------
// 基线手选：spec 要求「自动推断 + 允许从分支列表手选」。推断结果不一定合心意
// （比如 main 与 master 并存），推断失败时更是只能手选。
// ---------------------------------------------------------------------------
const RANGE_RESULT: ReviewResult = {
  ...RESULT,
  scope: { kind: "range" },
  counts: undefined,
  baseline: { base: "main", inferred: true },
};

const rangeProps = (over: Record<string, any> = {}) => ({
  conn: connStub(RANGE_RESULT), cwd: "/proj",
  scope: { kind: "range" } as const,
  onClose: () => {}, ...over,
});

describe("GitReview 返回键（硬件/浏览器 Back）", () => {
  // 真机反馈：在审查页按手机的返回键会直接退出整个 App，而不是回到 Git
  // 面板。修法照抄 FilePreview 全屏那套 psFs 约定——进来压一条 history
  // 记录，Back 弹掉它时 popstate 触发关闭。
  const RANGE: ReviewResult = {
    ...RESULT, scope: { kind: "range" }, counts: undefined,
    baseline: { base: "main", inferred: true },
  };

  it("打开时压入一条 history 记录", async () => {
    const spy = vi.spyOn(history, "pushState");
    render(GitReview, { props: props() });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ psFs: true }, ""));
    spy.mockRestore();
  });

  it("popstate 触发 onClose（返回上一级而不是退出 App）", async () => {
    const onClose = vi.fn();
    render(GitReview, { props: props({ onClose }) });
    await waitFor(() => expect(document.querySelector(".rv-body")).toBeTruthy());
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 同样关闭审查页", async () => {
    const onClose = vi.fn();
    render(GitReview, { props: props({ onClose }) });
    await waitFor(() => expect(document.querySelector(".rv-body")).toBeTruthy());
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("弹层开着时，返回只关弹层、不关审查页", async () => {
    const onClose = vi.fn();
    const { container } = render(GitReview, {
      props: props({ conn: connStub(RANGE), scope: { kind: "range" }, onClose }),
    });
    await waitFor(() => expect(container.querySelector(".bl")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelector(".bpick")).toBeTruthy());

    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(container.querySelector(".bpick")).toBeNull());
    expect(onClose, "第一次返回不该关掉审查页").not.toHaveBeenCalled();

    // 再按一次才关审查页——这就是「返回上一级」
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("弹层开着时 Esc 也只关弹层", async () => {
    const onClose = vi.fn();
    const { container } = render(GitReview, {
      props: props({ conn: connStub(RANGE), scope: { kind: "range" }, onClose }),
    });
    await waitFor(() => expect(container.querySelector(".bl")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelector(".bpick")).toBeTruthy());
    await fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".bpick")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  // 线上反馈的 bug：点遮罩 / 取消 / 选中分支关掉弹层时，审查页也跟着关了。
  //
  // 根因是初版让两层各压一条 history 记录，弹层收尾要调 history.back() 去
  // 消掉自己那条，而那次 back 会发出真实 popstate，被外层当成用户按了返回。
  // 现在改成整个审查页只压一条记录、由 goBack() 按状态分派，弹层不碰
  // history——所以这些「正常关闭」路径压根不会产生 popstate。
  //
  // 下面几条用例断言的就是这件事：关弹层之后 onClose 一次都没被调过，
  // 且审查页仍在 DOM 里。
  it("点遮罩关弹层：只关弹层，审查页留着", async () => {
    const onClose = vi.fn();
    const { container } = render(GitReview, {
      props: props({ conn: connStub(RANGE), scope: { kind: "range" }, onClose }),
    });
    await waitFor(() => expect(container.querySelector(".bl")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelector(".bpick")).toBeTruthy());

    await fireEvent.click(container.querySelector(".bp-mask")!);
    await waitFor(() => expect(container.querySelector(".bpick")).toBeNull());
    expect(onClose, "关弹层不该连带关审查页").not.toHaveBeenCalled();
    expect(container.querySelector(".rv-body"), "审查页仍在").toBeTruthy();
  });

  it("Esc 关弹层：只关弹层，审查页留着", async () => {
    const onClose = vi.fn();
    const { container } = render(GitReview, {
      props: props({ conn: connStub(RANGE), scope: { kind: "range" }, onClose }),
    });
    await waitFor(() => expect(container.querySelector(".bl")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelector(".bpick")).toBeTruthy());

    await fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".bpick")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("选中分支关弹层：只关弹层，审查页留着并重拉", async () => {
    const conn = connStub(RANGE);
    const onClose = vi.fn();
    const { container } = render(GitReview, {
      props: props({ conn, scope: { kind: "range" }, onClose }),
    });
    await waitFor(() => expect(container.querySelector(".bl")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelectorAll(".bp-item").length).toBeGreaterThan(0));

    await fireEvent.click(container.querySelectorAll(".bp-item")[0]);
    await waitFor(() => expect(container.querySelector(".bpick")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector(".rv-body")).toBeTruthy();
  });

  // 这条锁的是「弹层吃掉一次返回后必须补压一条记录」——否则审查页那条
  // 已被消耗，下一次返回会直接退出 App（就是最初报的问题）。
  //
  // jsdom 的 history 栈行为与真实浏览器不同，靠派发 popstate 测不出栈深，
  // 所以直接监视 pushState 的调用次数：打开时 1 次，弹层吃掉返回后应变成 2 次。
  it("弹层吃掉返回后补压 history 记录，审查页仍可被下一次返回关掉", async () => {
    const spy = vi.spyOn(history, "pushState");
    const { container } = render(GitReview, {
      props: props({ conn: connStub(RANGE), scope: { kind: "range" } }),
    });
    await waitFor(() => expect(container.querySelector(".bl")).toBeTruthy());
    const afterOpen = spy.mock.calls.length;

    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelector(".bpick")).toBeTruthy());
    window.dispatchEvent(new PopStateEvent("popstate"));      // 用户按返回
    await waitFor(() => expect(container.querySelector(".bpick")).toBeNull());

    expect(spy.mock.calls.length, "关弹层后应补压一条").toBe(afterOpen + 1);
    expect(spy.mock.calls.at(-1)).toEqual([{ psFs: true }, ""]);
    spy.mockRestore();
  });

  it("关弹层后再按返回，才轮到关审查页", async () => {
    const onClose = vi.fn();
    const { container } = render(GitReview, {
      props: props({ conn: connStub(RANGE), scope: { kind: "range" }, onClose }),
    });
    await waitFor(() => expect(container.querySelector(".bl")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelector(".bpick")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bp-mask")!);
    await waitFor(() => expect(container.querySelector(".bpick")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();

    window.dispatchEvent(new PopStateEvent("popstate"));   // 这次是用户真按的
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("基线按钮带切换图标且触摸目标够大", async () => {
    const { container } = render(GitReview, {
      props: props({ conn: connStub(RANGE), scope: { kind: "range" } }),
    });
    await waitFor(() => expect(container.querySelector(".bl")).toBeTruthy());
    expect(container.querySelector(".bl .bl-ic")).toBeTruthy();
    // jsdom 不算布局，断言样式声明本身（min-height 是可点区域的保证）
    const src = readFileSync(resolve(__dirname, "./GitReview.svelte"), "utf8");
    expect(src.match(/\.bl\s*\{[^}]*\}/s)![0]).toContain("min-height: 32px");
  });
});

describe("GitReview 基线手选", () => {
  it("懒加载：不点基线按钮就不拉分支列表", async () => {
    const conn = connStub(RANGE_RESULT);
    const { getByText } = render(GitReview, { props: rangeProps({ conn }) });
    await waitFor(() => expect(getByText("main")).toBeTruthy());
    expect(conn.rpc.mock.calls.some((c: any[]) => c[0] === "git.branches")).toBe(false);
  });

  it("点基线按钮弹出列表，此时才发出 git.branches", async () => {
    const conn = connStub(RANGE_RESULT);
    const { getByText, container } = render(GitReview, { props: rangeProps({ conn }) });
    await waitFor(() => expect(getByText("main")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelector(".bpick")).toBeTruthy());
    expect(conn.rpc.mock.calls.some((c: any[]) => c[0] === "git.branches")).toBe(true);
  });

  it("列表排除当前分支，其余全列（不套 5 个折叠）", async () => {
    const conn = connStub(RANGE_RESULT);
    const { getByText, container } = render(GitReview, { props: rangeProps({ conn }) });
    await waitFor(() => expect(getByText("main")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelectorAll(".bp-item").length).toBe(2));
    const labels = [...container.querySelectorAll(".bp-item")].map((e) => e.textContent!.trim());
    expect(labels).toEqual(["main", "dev"]);
    expect(labels).not.toContain("feat/x");
  });

  it("当前生效的基线在列表里高亮", async () => {
    const conn = connStub(RANGE_RESULT);
    const { getByText, container } = render(GitReview, { props: rangeProps({ conn }) });
    await waitFor(() => expect(getByText("main")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelectorAll(".bp-item").length).toBe(2));
    const on = [...container.querySelectorAll(".bp-item.on")].map((e) => e.textContent!.trim());
    expect(on).toEqual(["main"]);
  });

  it("选一个分支后发出带该 base 的 git.review，弹层关闭", async () => {
    const conn = connStub(RANGE_RESULT);
    const { getByText, container } = render(GitReview, { props: rangeProps({ conn }) });
    await waitFor(() => expect(getByText("main")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelectorAll(".bp-item").length).toBe(2));
    await fireEvent.click([...container.querySelectorAll(".bp-item")][1]);  // dev
    await waitFor(() => {
      const last = conn.rpc.mock.calls.filter((c: any[]) => c[0] === "git.review").at(-1);
      expect(last[1].scope).toEqual({ kind: "range", base: "dev" });
    });
    expect(container.querySelector(".bpick")).toBeNull();
  });

  it("关闭弹层不触发额外请求", async () => {
    const conn = connStub(RANGE_RESULT);
    const { getByText, container } = render(GitReview, { props: rangeProps({ conn }) });
    await waitFor(() => expect(getByText("main")).toBeTruthy());
    await fireEvent.click(container.querySelector(".bl")!);
    await waitFor(() => expect(container.querySelectorAll(".bp-item").length).toBe(2));
    const before = conn.rpc.mock.calls.length;
    await fireEvent.click(container.querySelector(".bp-cancel")!);
    await waitFor(() => expect(container.querySelector(".bpick")).toBeNull());
    await new Promise((r) => setTimeout(r, 30));
    expect(conn.rpc.mock.calls.length).toBe(before);
  });

  it("no_baseline 错误态给出手选入口，点了弹同一个列表", async () => {
    const conn = {
      rpc: vi.fn(async (m: string) => {
        if (m === "git.branches") return BRANCHES;
        throw new Error("rpc_error: no_baseline");
      }),
    } as any;
    const { getByText, container } = render(GitReview, { props: rangeProps({ conn }) });
    await waitFor(() => expect(getByText("无法确定对比基线，请手动选择")).toBeTruthy());
    await fireEvent.click(getByText("选择基线分支"));
    await waitFor(() => expect(container.querySelector(".bpick")).toBeTruthy());
    expect(container.querySelectorAll(".bp-item").length).toBe(2);
  });

  it("从 no_baseline 里选中分支后重新拉取成功", async () => {
    let firstReview = true;
    const conn = {
      rpc: vi.fn(async (m: string) => {
        if (m === "git.branches") return BRANCHES;
        if (firstReview) { firstReview = false; throw new Error("rpc_error: no_baseline"); }
        return RANGE_RESULT;
      }),
    } as any;
    const { getByText, container } = render(GitReview, { props: rangeProps({ conn }) });
    await waitFor(() => expect(getByText("选择基线分支")).toBeTruthy());
    await fireEvent.click(getByText("选择基线分支"));
    await waitFor(() => expect(container.querySelectorAll(".bp-item").length).toBe(2));
    await fireEvent.click([...container.querySelectorAll(".bp-item")][0]);  // main
    await waitFor(() => expect(container.querySelector('[data-head="src/auth.ts"]')).toBeTruthy());
  });

  it("工作区范围没有基线按钮（三档才是它的维度）", async () => {
    const { container } = render(GitReview, { props: props() });
    await waitFor(() => expect(container.querySelectorAll(".seg").length).toBe(3));
    expect(container.querySelector(".bl")).toBeNull();
  });
});
