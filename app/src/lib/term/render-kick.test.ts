import { describe, expect, it } from "vitest";
import { kickRenderDebouncer } from "./render-kick";

// 复刻 RenderDebouncer 的卡死形态：_animationFrame 是一个浏览器已经丢弃、
// 永远不会投递的句柄。真实结构里它是 number，测试里随便给个数。
function plant(handle: number | undefined, rows = 27) {
  const cancelled: number[] = [];
  const refreshRowsCalls: Array<[number, number]> = [];
  const deb: { _animationFrame?: number } = {};
  if (handle !== undefined) deb._animationFrame = handle;
  const term = {
    rows,
    _core: {
      _renderService: {
        _renderDebouncer: deb,
        refreshRows: (s: number, e: number) => refreshRowsCalls.push([s, e]),
      },
    },
  };
  const host = { cancelAnimationFrame: (h: number) => cancelled.push(h) };
  return { term, host, deb, cancelled, refreshRowsCalls };
}

describe("kickRenderDebouncer", () => {
  it("陈旧句柄 → cancel + 清字段 + 请求全量重画（0..rows-1）", () => {
    const p = plant(4128, 27);
    const r = kickRenderDebouncer(p.term, p.host);
    expect(r).toEqual({ kicked: true });
    expect(p.cancelled).toEqual([4128]);        // 替 _innerRefresh 丢弃陈旧句柄
    expect(p.deb._animationFrame).toBeUndefined(); // 字段已清，refresh() 不再 early-return
    expect(p.refreshRowsCalls).toEqual([[0, 26]]); // 全量重画走全新 rAF
  });

  it("没有待决句柄 = 没卡 → 不画任何东西", () => {
    const p = plant(undefined);
    const r = kickRenderDebouncer(p.term, p.host);
    expect(r).toEqual({ kicked: false });
    expect(p.cancelled).toEqual([]);
    expect(p.refreshRowsCalls).toEqual([]);
  });

  it("上游结构读不到（私有字段改名）→ no-op 且永不抛", () => {
    expect(kickRenderDebouncer(undefined, {} as never)).toEqual({ kicked: false, unreadable: true });
    expect(kickRenderDebouncer({}, {} as never)).toEqual({ kicked: false, unreadable: true });
    expect(kickRenderDebouncer({ _core: {} }, {} as never)).toEqual({ kicked: false, unreadable: true });
  });

  it("refreshRows 抛异常也只吞掉——字段已清，下一次写入会自然重排程", () => {
    const deb: { _animationFrame?: number } = { _animationFrame: 7 };
    const term = {
      rows: 10,
      _core: { _renderService: { _renderDebouncer: deb, refreshRows: () => { throw new Error("boom"); } } },
    };
    expect(kickRenderDebouncer(term, { cancelAnimationFrame: () => {} })).toEqual({ kicked: true });
    expect(deb._animationFrame).toBeUndefined();
  });

  it("cancelAnimationFrame 缺席（异常宿主）也能完成解卡", () => {
    const deb: { _animationFrame?: number } = { _animationFrame: 3 };
    const calls: Array<[number, number]> = [];
    const term = {
      rows: 24,
      _core: { _renderService: { _renderDebouncer: deb, refreshRows: (s: number, e: number) => calls.push([s, e]) } },
    };
    // host 不给 cancelAnimationFrame：字段照清、重画照请求。
    expect(kickRenderDebouncer(term, {} as never)).toEqual({ kicked: true });
    expect(deb._animationFrame).toBeUndefined();
    expect(calls).toEqual([[0, 23]]);
  });
});
