// 渲染去抖器解卡（2026-08-28）。
//
// 根因（2026-08-27 真机实锤，teachppt 一例）：iOS 把 PWA 切后台时会**丢弃**
// 已排定的 requestAnimationFrame 回调——不是延迟投递，是永远不投递。而 xterm
// 的 RenderDebouncer 里唯一清除 `_animationFrame` 的语句在回调体内：
//
//   refresh() {
//     ...
//     if (this._animationFrame !== undefined) return;   // ← 卡死后每次都从这里返回
//     this._animationFrame = requestAnimationFrame(() => this._innerRefresh());
//   }
//   _innerRefresh() { this._animationFrame = undefined; ... }  // ← 回调不跑就永远到不了
//
// 后台时挂起的那个回调被丢弃后，句柄永远是陈旧的非 undefined 值，该终端实例
// 此后的**所有**渲染请求在第一行就 early-return。同时 xterm 的解析与渲染完全
// 解耦，字节照常进 buffer，于是故障签名是四个字段同时成立：
//
//   screen 缺=0（buffer 与 tmux 一致）、paused=false、rendererSet=true、
//   renderFrames=0（onRender 一次都不 fire，哪怕 15s 里写入了 11KB）
//
// 用户侧表现为「终端冻结，关掉重开才看到内容」——重开 = 新 Terminal 实例 =
// 新 debouncer。切 tab 同样触发（隐藏 tab 恢复可见时）。
//
// 解卡就是把 _innerRefresh 本会做的事替它做掉：cancel 陈旧句柄、清字段、请求
// 一次全量重画（走 refreshRows 重新排定一个新鲜的 rAF）。cancel 一个真实待决
// 的句柄也无害——紧接着的全量重画会覆盖它要画的内容。对 paused（隐藏）的终端，
// refreshRows 只是记下 needsFullRefresh，等 IntersectionObserver 报可见时照常
// 补画，所以对隐藏 tab 解卡同样安全。
//
// 与 render-probe 同一纪律：**深入私有字段，全程可选链 + try 包裹**，上游结构
// 变了就退化成 no-op，绝不能让一次自愈把终端搞挂。
//
// 注意这不修 WebGL 上下文丢失（那是 webgl-renderer.ts 的 onContextLoss 的
// 事）：这里渲染器活着、rAF 排程死了；两者签名不同（前者 hasRenderer=false 或
// 图集异常，后者四字段签名如上）。这条红线写在两边的文件头里，别再混为一谈。

/** 解卡只需要一个能取消动画帧句柄的宿主；测试里注入替身。 */
export interface KickHost {
  cancelAnimationFrame(handle: number): void;
}

export interface KickResult {
  /** true = 发现陈旧句柄并已解卡（cancel + 清 + 全量重画）。false = 没卡（或没读到）。 */
  kicked: boolean;
  /** true = 上游结构读不到（xterm 改私有字段名了），什么都没做。 */
  unreadable?: boolean;
}

interface DebouncerLike {
  _animationFrame?: number | undefined;
}

interface RenderServiceLike {
  _renderDebouncer?: DebouncerLike;
  refreshRows?(start: number, end: number): void;
}

interface TermLike {
  rows?: number;
  _core?: { _renderService?: RenderServiceLike };
}

/**
 * 若渲染去抖器持有（可能已被浏览器丢弃的）动画帧句柄，替 `_innerRefresh`
 * 把它清掉并请求全量重画。永不抛。
 */
export function kickRenderDebouncer(term: unknown, host?: KickHost): KickResult {
  try {
    const t = term as TermLike;
    const rs = t?._core?._renderService;
    const deb = rs?._renderDebouncer;
    if (!rs || !deb || typeof rs.refreshRows !== "function") {
      return { kicked: false, unreadable: true };
    }
    // 注意不能拿 "_animationFrame" in deb 判结构：TS 编译的类字段在首次赋值前
    // 不是自有属性（真实 debouncer 首帧之前就没有这个 key），in 检查会把
    // 「崭新未卡」误判成「结构读不到」。
    const stale = deb._animationFrame;
    if (typeof stale !== "number") {
      // 没有待决句柄 = 没卡。别多画这一帧。
      return { kicked: false };
    }
    deb._animationFrame = undefined;
    try {
      (host ?? (globalThis as { cancelAnimationFrame?: KickHost["cancelAnimationFrame"] }))
        .cancelAnimationFrame?.(stale);
    } catch { /* 取消一个陈旧句柄失败不需要处理；字段已清，重画会重新排程 */ }
    // 全量重画（0..rows-1）。paused 的终端在这一步只记账不画，见文件头。
    // 单独包一层：就算这次重画请求本身抛了，句柄也已清、卡已解——下一次写入
    // 会经 refresh() 重新排程，这里不该把「已解卡」误报成「结构读不到」。
    try {
      rs.refreshRows(0, Math.max(0, (t.rows ?? 24) - 1));
    } catch { /* 解卡已成立，重画让后续写入自然补上 */ }
    return { kicked: true };
  } catch {
    return { kicked: false, unreadable: true };
  }
}
