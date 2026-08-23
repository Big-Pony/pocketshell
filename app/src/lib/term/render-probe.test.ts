import { describe, expect, it } from "vitest";
import { formatRenderSnapshot, snapshotRender, subscribeRender } from "./render-probe";

const mk = (rs: unknown, element?: unknown) => ({ _core: { _renderService: rs }, element });

describe("snapshotRender", () => {
  it("读出暂停状态与渲染器指针（故障形态：可见却仍暂停）", () => {
    const s = snapshotRender(mk(
      { _isPaused: true, _needsFullRefresh: true, _renderer: { value: {} } },
      { offsetParent: {} },
    ));
    expect(s).toEqual({ paused: true, needsFullRefresh: true, rendererSet: true, domVisible: true });
  });

  it("健康形态：没暂停、渲染器在、无欠账", () => {
    const s = snapshotRender(mk(
      { _isPaused: false, _needsFullRefresh: false, _renderer: { value: {} } },
      { offsetParent: {} },
    ));
    expect(s).toEqual({ paused: false, needsFullRefresh: false, rendererSet: true, domVisible: true });
  });

  it("渲染器被摘掉：rendererSet=false（_renderRows 整个 no-op）", () => {
    expect(snapshotRender(mk({ _renderer: { value: undefined } })).rendererSet).toBe(false);
  });

  it("隐藏的 tab：domVisible=false（display:none ⇒ offsetParent 为 null）", () => {
    expect(snapshotRender(mk({}, { offsetParent: null })).domVisible).toBe(false);
  });

  it("读不到的字段不出现在快照里 —— 与 false 区分开", () => {
    // 上游改了字段名的情形：不能把「读不到」报成「没暂停」
    const s = snapshotRender(mk({ somethingElse: 1 }));
    expect(s.paused).toBeUndefined();
    expect(s.rendererSet).toBeUndefined();
  });

  it("结构完全对不上也不抛", () => {
    expect(() => snapshotRender(undefined)).not.toThrow();
    expect(() => snapshotRender({})).not.toThrow();
    expect(() => snapshotRender({ _core: null })).not.toThrow();
    expect(snapshotRender(null)).toEqual({});
  });

  it("getter 抛异常也不炸（上游可能把字段做成访问器）", () => {
    const hostile = { _core: { _renderService: { get _isPaused(): boolean { throw new Error("boom"); } } } };
    expect(() => snapshotRender(hostile)).not.toThrow();
  });

  it("摘要行把「读不到」显式写成 ?，不伪装成 false", () => {
    expect(formatRenderSnapshot("s1", {})).toContain("paused=?");
    expect(formatRenderSnapshot("s1", { paused: false })).toContain("paused=false");
  });
});

// 【2026-08-23】订阅必须走 RenderService 内部的 onRender，不能用公开的
// term.onRender —— 后者转发被 _isNextRenderRedrawOnly 门控的
// onRenderedViewportChange，普通流式输出（redraw-only）一次都不 fire。
// 线上因此连着几十条 renderFrames=0，屏幕却在滚动。
describe("subscribeRender", () => {
  const mkTerm = () => {
    const cbs: ((e: { start: number; end: number }) => void)[] = [];
    let disposed = false;
    return {
      term: {
        // 公开 API 存在但**永远不 fire**（模拟 redraw-only 门控）
        onRender: () => ({ dispose() {} }),
        _core: {
          _renderService: {
            onRender: (cb: (e: { start: number; end: number }) => void) => {
              cbs.push(cb);
              return { dispose() { disposed = true; } };
            },
          },
        },
      },
      fire: (start: number, end: number) => cbs.forEach((c) => c({ start, end })),
      isDisposed: () => disposed,
    };
  };

  it("订阅的是 RenderService 的 onRender，收得到每一帧", () => {
    const h = mkTerm();
    let frames = 0, rows = 0;
    const un = subscribeRender(h.term, (r) => { frames++; rows += r; });
    h.fire(0, 26);
    h.fire(5, 5);
    expect(frames).toBe(2);
    expect(rows).toBe(27 + 1);   // 区间是闭区间
    un?.();
    expect(h.isDisposed()).toBe(true);
  });

  it("取消订阅后不再计数", () => {
    const h = mkTerm();
    let frames = 0;
    const un = subscribeRender(h.term, () => { frames++; });
    un?.();
    // dispose 之后宿主不该再回调；这里直接验证 dispose 被调用过
    expect(h.isDisposed()).toBe(true);
    expect(frames).toBe(0);
  });

  it("拿不到 RenderService 时返回 undefined，且不抛", () => {
    expect(subscribeRender({}, () => {})).toBeUndefined();
    expect(subscribeRender(undefined, () => {})).toBeUndefined();
    expect(() => subscribeRender({ _core: { _renderService: {} } }, () => {})).not.toThrow();
  });

  it("事件对象畸形也不炸", () => {
    const cbs: ((e: unknown) => void)[] = [];
    const term = { _core: { _renderService: { onRender: (cb: (e: unknown) => void) => { cbs.push(cb); return { dispose() {} }; } } } };
    let rows = -1;
    subscribeRender(term, (r) => { rows = r; });
    expect(() => cbs[0]({})).not.toThrow();
    expect(rows).toBeGreaterThanOrEqual(0);
  });
});
