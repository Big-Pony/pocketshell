// 渲染服务状态探针（2026-08-22）。
//
// 为什么需要它：全链路埋点上线后拿到的第一组真实故障数据是
//
//   screen 缺=0        ← xterm buffer 里内容一个字不少
//   render 重画帧=0    ← onRender 一次都没 fire
//   hasRenderer=true   ← WebGL addon 还在，图集也健康
//
// 三者同时成立，说明字节进了 buffer 但**没有被画出来**。读 xterm 源码，
// `_onRender.fire` 位于 `RenderService._renderRows` 内，有两道闸：
//
//   refreshRows(): if (this._isPaused) return void (this._needsFullRefresh = true)
//   _renderRows(): this._renderer.value && ( … renderRows() … _onRender.fire() )
//
// 所以「没画」只有两种可能：渲染服务被暂停了，或者渲染器指针是空的。这两者
// 的修法完全不同（前者查可见性/IntersectionObserver，后者查我们自己的
// webgl-renderer suspend/resume），而现有埋点分不出来 —— `hasRenderer` 查的是
// **WebGL addon 对象**，不是 xterm 内部的 `_renderer.value`，两者不是一回事。
//
// `_isPaused` 由 xterm 自己的 IntersectionObserver 驱动（`!isIntersecting` ⇒
// 暂停）。而非活跃 tab 在我们这里是 `display:none`，那种元素**永远不与视口
// 相交**，所以暂停一定会发生；问题只在于切回来时有没有正确恢复。这个探针就是
// 去证实/证伪这一点的。
//
// 与 atlas-probe 同样的原则：**全部深入私有字段，全部可选链 + try 包裹**，
// 上游结构变了就退化成部分快照，绝不能让一个诊断把终端搞挂。

export interface RenderSnapshot {
  /**
   * xterm `RenderService._isPaused`。true = 渲染服务认为自己不可见，
   * `refreshRows` 直接 return，什么都不画。
   *
   * 读不到时不出现在快照里（与 false 区分：false 是「确实没暂停」）。
   */
  paused?: boolean;
  /**
   * `RenderService._renderer.value` 是否存在。false = 渲染器指针为空，
   * `_renderRows` 整个是 no-op（既不画，也不 fire onRender）。
   */
  rendererSet?: boolean;
  /** `_needsFullRefresh`：暂停期间攒下的「欠一次全量重画」标记。 */
  needsFullRefresh?: boolean;
  /**
   * 终端根元素当前是否真的可见（`offsetParent`）。与 `paused` 对照：
   * **可见却仍然 paused**，就是 IntersectionObserver 没能把暂停解除掉——
   * 那正是「切回来一片空白/不更新」的直接证据。
   */
  domVisible?: boolean;
}

interface RenderServiceLike {
  _isPaused?: unknown;
  _needsFullRefresh?: unknown;
  _renderer?: { value?: unknown };
}
interface TermLike {
  element?: { offsetParent?: unknown } | null;
  _core?: { _renderService?: RenderServiceLike };
}

/**
 * 读一次渲染服务状态。永不抛：任何一个字段读不到就不放进快照。
 */
export function snapshotRender(term: unknown): RenderSnapshot {
  const out: RenderSnapshot = {};
  try {
    const t = term as TermLike;
    const rs = t?._core?._renderService;
    if (rs) {
      if (typeof rs._isPaused === "boolean") out.paused = rs._isPaused;
      if (typeof rs._needsFullRefresh === "boolean") out.needsFullRefresh = rs._needsFullRefresh;
      // MutableDisposable：渲染器活着时 `.value` 是渲染器实例，被摘掉时是 undefined。
      if (rs._renderer && "value" in rs._renderer) out.rendererSet = !!rs._renderer.value;
    }
    const el = t?.element;
    // offsetParent 为 null ⇔ 元素或其祖先 display:none（position:fixed 除外，
    // 终端容器不是 fixed）。这是判断「DOM 上到底可不可见」最省事且不触发
    // 重排的方式。
    if (el && "offsetParent" in el) out.domVisible = el.offsetParent !== null;
  } catch { /* 诊断绝不能影响任何东西 */ }
  return out;
}

/** 控制台用的一行摘要。 */
export const formatRenderSnapshot = (tag: string, s: RenderSnapshot): string =>
  `[render:${tag}] paused=${s.paused ?? "?"} rendererSet=${s.rendererSet ?? "?"} needsFullRefresh=${s.needsFullRefresh ?? "?"} domVisible=${s.domVisible ?? "?"}`;

/**
 * 订阅**真正的**每帧渲染事件，返回取消订阅的函数（拿不到时返回 undefined）。
 *
 * 【2026-08-23 修正，重要】不要用公开的 `term.onRender`。它看着正合适，实际
 * 转发的是 RenderService 的 `onRenderedViewportChange`：
 *
 *   // Terminal.open() 里
 *   this._register(this._renderService.onRenderedViewportChange(e => this._onRender.fire(e)))
 *
 *   // RenderService._renderRows() 里
 *   this._isNextRenderRedrawOnly || this._onRenderedViewportChange.fire({start,end}),
 *   this._onRender.fire({start,end}),          // ← 这个才是无条件的
 *   this._isNextRenderRedrawOnly = true
 *
 * `_isNextRenderRedrawOnly` 每帧后都被重置为 true，只有 `refreshRows(…, s=false)`
 * 会清掉它。**普通的流式输出走的正是 redraw-only 路径**，所以公开的 onRender
 * 一次都不 fire —— 屏幕明明在滚动，计数却恒为 0。
 *
 * 这个坑真实发生过：第一版埋点用了公开 API，线上连着几十条 `renderFrames=0`，
 * 差点被读成「渲染器停摆」而去改 suspend/resume。识别它的方法很简单——同一条
 * 采样里 `wroteBytes` 上万、`bufDelta` 几十行，屏幕显然在更新，那 0 就只能是
 * 埋点自己的问题。
 *
 * 所以直接订阅 `_core._renderService.onRender`。私有字段，照例全程防御。
 */
export function subscribeRender(term: unknown, onFrame: (rows: number) => void): (() => void) | undefined {
  try {
    const rs = (term as TermLike)?._core?._renderService as
      | { onRender?: (cb: (e: { start: number; end: number }) => void) => { dispose(): void } }
      | undefined;
    const sub = rs?.onRender?.((e) => {
      onFrame(Math.max(0, (e?.end ?? 0) - (e?.start ?? 0) + 1));
    });
    return sub ? () => { try { sub.dispose(); } catch { /* teardown 尽力而为 */ } } : undefined;
  } catch {
    return undefined;
  }
}
