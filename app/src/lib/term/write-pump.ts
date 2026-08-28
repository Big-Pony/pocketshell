// 写泵看门狗（2026-08-28）—— xterm WriteBuffer 楔形卡死的检测与自愈。
//
// 故障实录（2026-08-28 桌面 Chrome，生产构建，复现后活取）：
//
//   字节到达 onOutput 并被计数（wroteBytes>0）、终端 active 且 DOM 可见，
//   但 buffer 停在 claude「信任提示→主界面」转换的中途再不更新（screen 对拍
//   missingLines 随新输出增长）、renderFrames=0、requestAnimationFrame 零调用、
//   RenderDebouncer 句柄干净（render-kick 报 kicked:false）、主线程活着
//   （心跳照打、eval 正常）、全程无 JS 异常。关掉重开 = 新 Terminal 实例 = 自愈。
//
// 读 xterm 6.1 源码后确认的两条卡死路径，签名逐字段吻合：
//
//   路径 A（同步抛异常）：WriteBuffer._innerWrite 跑在 TimeoutTimer 的
//     setTimeout 回调里。parse 或某个 write 回调同步抛出 → 泵的定时器链断裂，
//     _writeBuffer 滞留在非空状态。此后 write() 走 `if (!this._writeBuffer.length)`
//     分支失败，只 push 不再调度 —— 字节永远积在队列里，无人解析，无人报错。
//   路径 B（异步 handler 不 settle）：parse 里某 handler 返回 Promise 时泵停在
//     `o.then(...)` 上等它。stock xterm 与本 app 都不注册异步 handler，可能性低，
//     但 parseStack.paused 恒 true 是它的指纹，探针顺带采上。
//
// 自愈动作分两级，永远 try 包裹、读不到结构就 no-op（与 render-kick 同纪律）：
//
//   1) 重臂调度：调一次 `_scheduleInnerWrite()`。对「定时器链断裂」直接痊愈
//      —— 它 cancelAndSet 一个新定时器，泵重新转起来，滞留字节被解析。
//   2) 解析器解毒：仅当 parser 处于「improper continuation」死刑态（state===1）
//      或 InputHandler parseStack 暂停时，先 `parser.reset()` 清干净序列状态，
//      再把两个 parseStack 归零，然后重臂调度。代价是丢弃半截转义序列（几个
//      字符可能落成文本），换来整台终端复活 —— 比「冻结到用户手动重开」好得多。
//
// 这不修渲染层卡死（RenderDebouncer/rAF 那条线归 render-kick.ts 管）。两边签名
// 不同：render-kick 那条 buffer 照常更新只是不画；这条 buffer 本身停更。
// 探针字段进了心跳的 render 采样（wbPending/wbStuck/wbOffset/parserState），
// 真机再发作时日志能直接区分两条路径。

/** 泵状态快照。字段缺席（undefined）= 上游结构变了读不到，与 0/false 严格区分。 */
export interface PumpSnapshot {
  /** `_pendingData`：已收下但还没解析完的字节数。 */
  pending?: number;
  /** `_writeBuffer.length - _bufferOffset`：滞留未解析的帧数。 */
  stuck?: number;
  /** `_bufferOffset`：解析推进位置。泵活着时它单调前进；泵死了它冻结。 */
  offset?: number;
  /** `_inputHandler._parseStack.paused`：异步 handler 暂停中（路径 B 指纹）。 */
  parsePaused?: boolean;
  /** `_inputHandler._parser._parseStack.state`：1 = improper continuation 死刑态。 */
  parserState?: number;
}

export interface PumpKickResult {
  /** true = 已重臂调度（泵应当恢复；下一轮看门狗用 offset 是否前进来验证）。 */
  kicked: boolean;
  /** true = 上游结构读不到（xterm 改私有字段名了），什么都没做。 */
  unreadable?: boolean;
  /** true = 顺手解了解析器的死刑/暂停态（见文件头第 2 级）。 */
  parserReset?: boolean;
}

interface WriteBufferLike {
  _pendingData?: unknown;
  _writeBuffer?: { length?: unknown };
  _bufferOffset?: unknown;
  _scheduleInnerWrite?: () => void;
}

interface ParserLike {
  _parseStack?: { state?: unknown; handlers?: unknown };
  reset?: () => void;
}

interface InputHandlerLike {
  _parseStack?: { paused?: unknown };
  _parser?: ParserLike;
}

interface TermLike {
  _core?: {
    _writeBuffer?: WriteBufferLike;
    _inputHandler?: InputHandlerLike;
  };
}

const asNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** 读泵状态。永不抛。 */
export function snapshotWritePump(term: unknown): PumpSnapshot {
  const out: PumpSnapshot = {};
  try {
    const core = (term as TermLike)?._core;
    const wb = core?._writeBuffer;
    const pending = asNum(wb?._pendingData);
    const len = asNum(wb?._writeBuffer?.length);
    const offset = asNum(wb?._bufferOffset);
    if (pending !== undefined) out.pending = pending;
    if (offset !== undefined) out.offset = offset;
    if (len !== undefined && offset !== undefined) out.stuck = Math.max(0, len - offset);
    const ih = core?._inputHandler;
    if (typeof ih?._parseStack?.paused === "boolean") out.parsePaused = ih._parseStack.paused;
    const ps = asNum(ih?._parser?._parseStack?.state);
    if (ps !== undefined) out.parserState = ps;
  } catch { /* 读不到就是读不到，字段缺席即可 */ }
  return out;
}

/**
 * 重臂写泵；解析器处于死刑/暂停态时顺手解毒。永不抛。
 *
 * 注意：泵没卡时调用也无害 —— `_scheduleInnerWrite` 是 cancelAndSet，只是把
 * 既有的待决定时器换成一个新鲜的，队列里的数据一字节不少。
 */
export function kickWritePump(term: unknown): PumpKickResult {
  try {
    const core = (term as TermLike)?._core;
    const wb = core?._writeBuffer;
    const ih = core?._inputHandler;
    if (!wb || typeof wb._scheduleInnerWrite !== "function") {
      return { kicked: false, unreadable: true };
    }
    let parserReset = false;
    const poisoned = ih?._parser?._parseStack?.state === 1 || ih?._parseStack?.paused === true;
    if (poisoned && ih?._parser && typeof ih._parser.reset === "function") {
      try {
        // reset() 清序列状态机，但会把 parseStack.state 标成 2（「下块从
        // chunkPos+1 续传」）——那是给正常跨块续传用的，对死刑态是错的：
        // chunkPos 指向的是旧块里的位置，新块从那里续会错位。归零，让下一块
        // 从头按全新序列解析。
        ih._parser.reset();
        const stack = ih._parser._parseStack;
        if (stack) { stack.state = 0; stack.handlers = []; }
        if (ih._parseStack) ih._parseStack.paused = false;
        parserReset = true;
      } catch { /* 解毒失败不拦着重臂：泵先转起来，真不行下一轮日志会讲 */ }
    }
    try {
      wb._scheduleInnerWrite();
    } catch {
      return { kicked: false, unreadable: true, parserReset };
    }
    return { kicked: true, parserReset };
  } catch {
    return { kicked: false, unreadable: true };
  }
}
