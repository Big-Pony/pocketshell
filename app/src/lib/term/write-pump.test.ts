import { test, expect, vi } from "vitest";
import { snapshotWritePump, kickWritePump } from "./write-pump";

// 写泵看门狗的单元测试。与 render-kick.test.ts 同款做法：私有结构全用替身注入，
// 断言「读得到什么、动不动手、永不抛」三条契约。

const fakeTerm = (over: {
  pending?: number; len?: number; offset?: number;
  paused?: boolean; parserState?: number;
  schedule?: () => void; reset?: () => void;
}) => ({
  _core: {
    _writeBuffer: {
      _pendingData: over.pending ?? 0,
      _writeBuffer: { length: over.len ?? 0 },
      _bufferOffset: over.offset ?? 0,
      _scheduleInnerWrite: over.schedule ?? (() => {}),
    },
    _inputHandler: {
      _parseStack: { paused: over.paused ?? false },
      _parser: {
        _parseStack: { state: over.parserState ?? 0, handlers: [] },
        reset: over.reset ?? (() => {}),
      },
    },
  },
});

test("快照读出 pending/stuck/offset/paused/parserState", () => {
  const s = snapshotWritePump(fakeTerm({ pending: 120, len: 5, offset: 2, paused: false, parserState: 0 }));
  expect(s).toEqual({ pending: 120, stuck: 3, offset: 2, parsePaused: false, parserState: 0 });
});

test("结构读不到时字段缺席而不是 0（与真 0 区分）", () => {
  expect(snapshotWritePump({})).toEqual({});
  expect(snapshotWritePump(null)).toEqual({});
  expect(snapshotWritePump({ _core: {} })).toEqual({});
});

test("stuck 恒非负（offset 越过 length 的瞬时不报负数）", () => {
  const s = snapshotWritePump(fakeTerm({ len: 1, offset: 3 }));
  expect(s.stuck).toBe(0);
});

test("kick 重臂调度：泵链断了也能续上", () => {
  const schedule = vi.fn();
  const r = kickWritePump(fakeTerm({ schedule }));
  expect(r).toEqual({ kicked: true, parserReset: false });
  expect(schedule).toHaveBeenCalledTimes(1);
});

test("解析器死刑态（state=1）触发解毒：reset + 双 stack 归零", () => {
  const schedule = vi.fn();
  const reset = vi.fn();
  const term = fakeTerm({ schedule, reset, parserState: 1 });
  const r = kickWritePump(term);
  expect(r).toEqual({ kicked: true, parserReset: true });
  expect(reset).toHaveBeenCalledTimes(1);
  expect(term._core._inputHandler._parser._parseStack.state).toBe(0);
  expect(term._core._inputHandler._parser._parseStack.handlers).toEqual([]);
});

test("parseStack.paused=true 也触发解毒并解除暂停", () => {
  const term = fakeTerm({ paused: true });
  const r = kickWritePump(term);
  expect(r.parserReset).toBe(true);
  expect(term._core._inputHandler._parseStack.paused).toBe(false);
});

test("健康解析器（state=0 且未暂停）不动 parser", () => {
  const reset = vi.fn();
  const r = kickWritePump(fakeTerm({ reset }));
  expect(r.kicked).toBe(true);
  expect(r.parserReset).toBe(false);
  expect(reset).not.toHaveBeenCalled();
});

test("结构读不到：不动手、报 unreadable、不抛", () => {
  expect(kickWritePump({})).toEqual({ kicked: false, unreadable: true });
  expect(kickWritePump(null)).toEqual({ kicked: false, unreadable: true });
  expect(kickWritePump({ _core: { _writeBuffer: {} } })).toEqual({ kicked: false, unreadable: true });
});

test("调度本身抛异常也不外溢", () => {
  const schedule = vi.fn(() => { throw new Error("boom"); });
  const r = kickWritePump(fakeTerm({ schedule }));
  expect(r.kicked).toBe(false);
  expect(r.unreadable).toBe(true);
});

test("解毒抛异常不拦着重臂调度", () => {
  const schedule = vi.fn();
  const reset = vi.fn(() => { throw new Error("reset boom"); });
  const r = kickWritePump(fakeTerm({ schedule, reset, parserState: 1 }));
  expect(r.kicked).toBe(true);
  expect(r.parserReset).toBe(false);
  expect(schedule).toHaveBeenCalledTimes(1);
});
