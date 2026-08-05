import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/svelte";
import Terminal from "./Terminal.svelte";

// 「隐藏的终端把塌陷尺寸发给 PTY，tmux 历史被永久写窄」的回归测试（12 期真机 bug）。
//
// 真机现象：Claude Code 历史输出只占屏幕左侧一小块。取证确认窄排版**已烙进 tmux
// 自己的 scrollback**，且 `capture-pane -J` 也拼不回来——那是 Claude Code 按错误
// winsize **自己打进流里的硬换行**，tmux 只能 reflow 自己折的软折行，所以这份历史
// **不可逆**。因此本测试钉的不是「显示对不对」，而是**坏尺寸绝不许出门**。
//
// 根因（真实 Chromium 实测）：`display:none` 不参与布局，
// `getComputedStyle(el).width` 于是原样吐回声明值 `"100%"`，FitAddon 拿去
// `parseInt` 得到 100，当成 100 像素 → cols 塌成 9~12。等待救不了：等 2 帧 rAF、
// 等 2000ms、等 fonts.ready 全是同一个塌陷值，唯一能改变结果的事件是「元素被显示」。
//
// jsdom 里所有元素的 clientWidth/clientHeight 恒为 0（没有布局引擎），这**恰好**
// 就是隐藏元素在真实浏览器里的形态，所以这条契约在 jsdom 里可测：
// **不可测量时不得发出 conn.resize**。
function stubConn(resize: (id: string, cols: number, rows: number) => void) {
  return {
    onOutput: () => () => {},
    onInput: () => () => {},
    attach: () => {},
    resize,
    rpc: vi.fn().mockResolvedValue({ data: "", currentCommand: "", alternateOn: false, isShell: true }),
  } as any;
}

let origMatchMedia: any;
beforeAll(() => {
  origMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
  });
});
afterAll(() => { window.matchMedia = origMatchMedia; });

const tick = () => new Promise((r) => setTimeout(r, 0));

test("挂载时不可测量，绝不把塌陷尺寸发给 PTY", async () => {
  const sent: Array<{ cols: number; rows: number }> = [];
  render(Terminal, {
    props: {
      conn: stubConn((_id, cols, rows) => sent.push({ cols, rows })),
      sessionId: "s1",
      active: true,
    },
  });
  await tick();

  // 允许一次都不发（测不准就不发，正是要的行为）；但凡发出去的，都必须可信。
  for (const d of sent) {
    expect(d.cols).toBeGreaterThanOrEqual(20);
    expect(d.rows).toBeGreaterThanOrEqual(4);
  }
});

test("隐藏挂载的 tab 不得向 PTY 发任何尺寸", async () => {
  // 这是真机上的实际触发路径：开着 N 个 tab，非活动的那些也在挂载。
  // 它们量不到自己，一旦上报就会把**共享的 tmux 会话**拽窄，连带污染别人的历史。
  const sent: Array<{ cols: number; rows: number }> = [];
  render(Terminal, {
    props: {
      conn: stubConn((_id, cols, rows) => sent.push({ cols, rows })),
      sessionId: "s2",
      active: false,
    },
  });
  await tick();

  expect(sent).toEqual([]);
});

test("反复切换隐藏/显示，发出去的尺寸始终可信", async () => {
  const sent: Array<{ cols: number; rows: number }> = [];
  const conn = stubConn((_id, cols, rows) => sent.push({ cols, rows }));
  const { rerender } = render(Terminal, {
    props: { conn, sessionId: "s3", active: true },
  });
  await tick();

  for (let i = 0; i < 3; i++) {
    await rerender({ conn, sessionId: "s3", active: false });
    await tick();
    await rerender({ conn, sessionId: "s3", active: true });
    await tick();
  }

  for (const d of sent) {
    expect(d.cols).toBeGreaterThanOrEqual(20);
    expect(d.rows).toBeGreaterThanOrEqual(4);
  }
});
