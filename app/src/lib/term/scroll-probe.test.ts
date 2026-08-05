import { test, expect } from "vitest";
import { snapshotScroll, formatScrollSnapshot } from "./scroll-probe";

// 一个刚好够用的假终端：字段名与 xterm 的真实结构逐字对应。
function fakeTerm(over: Record<string, unknown> = {}) {
  return {
    rows: 24,
    cols: 80,
    buffer: { active: { type: "normal", length: 500, baseY: 476, viewportY: 476 } },
    _core: {
      _renderService: { dimensions: { css: { cell: { height: 17 }, canvas: { height: 408 } } } },
    },
    ...over,
  };
}

function fakeHost(scroll: { scrollHeight: number; scrollTop: number; clientHeight: number } | null) {
  return {
    querySelector: () => scroll,
  };
}

test("captures the numbers that tell a healthy terminal from a stuck one", () => {
  const s = snapshotScroll(
    fakeTerm(),
    fakeHost({ scrollHeight: 8500, scrollTop: 8092, clientHeight: 408 }),
  );
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
  const s = snapshotScroll(
    fakeTerm(),
    fakeHost({ scrollHeight: 0, scrollTop: 0, clientHeight: 408 }),
  );
  expect(s.bufferLength).toBe(500);
  expect(s.scrollHeight).toBe(0);
});

// 读不到的值必须是 -1，不能是 0：真实的 0（塌陷）与「读不到」（上游结构变了）
// 是完全不同的结论，混在一起会把日志读成错误的方向。
test("uses -1 for anything unreadable so it stays distinct from a real zero", () => {
  const s = snapshotScroll({}, fakeHost(null));
  expect(s.bufferLength).toBe(-1);
  expect(s.cellHeight).toBe(-1);
  expect(s.scrollHeight).toBe(-1);
  expect(s.bufferType).toBe("unknown");
});

// 诊断绝不能影响终端本身——xterm 内部结构变了、或 host 是个畸形对象时，
// 只能得到一份残缺报告，不能抛。
test("never throws on junk input", () => {
  for (const junk of [undefined, null, 42, "str", { buffer: null }]) {
    expect(() => snapshotScroll(junk, junk)).not.toThrow();
  }
});

test("formats one single line", () => {
  const line = formatScrollSnapshot("sess-1", snapshotScroll(fakeTerm(), fakeHost({ scrollHeight: 0, scrollTop: 0, clientHeight: 408 })));
  expect(line.includes("\n")).toBe(false);
  expect(line).toContain("sess-1");
  expect(line).toContain("scrollH=0");
});
