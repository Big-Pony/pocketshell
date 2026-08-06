import { test, expect } from "vitest";
import { snapshotScroll, formatScrollSnapshot } from "./scroll-probe";

// 一个刚好够用的假终端：字段名与 xterm 的真实结构逐字对应。滚动账本挂在
// _core._viewport._scrollableElement.getScrollDimensions() 上——这是 xterm 6
// 里滚动状态的真实来源（DOM 的 .xterm-scrollable-element.scrollHeight 是常量，
// 见下面「reads the virtualised scroll ledger」那条测试钉的教训）。
function fakeTerm(over: {
  scroll?: { scrollHeight: number; scrollTop: number; height: number } | null;
} = {}) {
  const scroll = over.scroll === undefined
    ? { scrollHeight: 8500, scrollTop: 8092, height: 408 }
    : over.scroll;
  return {
    rows: 24,
    cols: 80,
    buffer: { active: { type: "normal", length: 500, baseY: 476, viewportY: 476 } },
    _core: {
      _renderService: { dimensions: { css: { cell: { height: 17 }, canvas: { height: 408 } } } },
      _viewport: scroll ? { _scrollableElement: { getScrollDimensions: () => scroll } } : undefined,
    },
  };
}

test("captures the numbers that tell a healthy terminal from a stuck one", () => {
  const s = snapshotScroll(fakeTerm());
  expect(s.bufferType).toBe("normal");
  expect(s.bufferLength).toBe(500);
  expect(s.baseY).toBe(476);
  expect(s.ydisp).toBe(476);
  expect(s.rows).toBe(24);
  expect(s.cols).toBe(80);
  expect(s.cellHeight).toBe(17);
  expect(s.canvasHeight).toBe(408);
  expect(s.scrollHeight).toBe(8500);
  expect(s.scrollTop).toBe(8092);
  expect(s.clientHeight).toBe(408);
});

// 这正是头号怀疑的形态：缓冲区有几百行，但滚动容器认为无处可滚。快照必须让
// 这两件事在同一行日志里同时可见，否则读日志的人无法把它与「缓冲区真空了」区分开。
test("records a collapsed scrollHeight alongside a non-empty buffer", () => {
  const s = snapshotScroll(fakeTerm({ scroll: { scrollHeight: 0, scrollTop: 0, height: 408 } }));
  expect(s.bufferLength).toBe(500);
  expect(s.scrollHeight).toBe(0);
});

// 读不到的值必须是 -1，不能是 0：真实的 0（塌陷）与「读不到」（上游结构变了）
// 是完全不同的结论，混在一起会把日志读成错误的方向。
test("uses -1 for anything unreadable so it stays distinct from a real zero", () => {
  const s = snapshotScroll({});
  expect(s.bufferLength).toBe(-1);
  expect(s.cellHeight).toBe(-1);
  expect(s.scrollHeight).toBe(-1);
  expect(s.bufferType).toBe("unknown");
});

// 诊断绝不能影响终端本身——xterm 内部结构变了、或传入畸形对象时，
// 只能得到一份残缺报告，不能抛。
test("never throws on junk input", () => {
  for (const junk of [undefined, null, 42, "str", { buffer: null }]) {
    expect(() => snapshotScroll(junk)).not.toThrow();
  }
});

test("formats one single line", () => {
  const line = formatScrollSnapshot("sess-1", snapshotScroll(fakeTerm({ scroll: { scrollHeight: 0, scrollTop: 0, height: 408 } })));
  expect(line.includes("\n")).toBe(false);
  expect(line).toContain("sess-1");
  expect(line).toContain("scrollH=0");
});

// 这个探针曾经读 .xterm-scrollable-element 的 DOM scrollHeight/scrollTop —— 那三个
// 值在 xterm 6 里是恒定常量（滚动被虚拟化进了 Scrollable，DOM 上不发生滚动），
// 于是健康终端也会打出 scrollHeight === clientHeight && scrollTop === 0，
// 也就是「无处可滚」的形态。埋点打出假阳性比不埋更糟，所以这里钉死：数据必须
// 来自 getScrollDimensions()，读不到就诚实地报 -1，不许回落到任何 DOM 值。
test("reads the virtualised scroll ledger, never DOM scroll properties", () => {
  const t = fakeTerm();
  delete (t as any)._core._viewport;   // 账本读不到
  const s = snapshotScroll(t);
  expect(s.scrollHeight).toBe(-1);
  expect(s.scrollTop).toBe(-1);
  expect(s.clientHeight).toBe(-1);
});
