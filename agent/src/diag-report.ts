// Client-side diagnostics, sanitised and written to the agent's stdout.
//
// Why this exists (docs/bug/终端显示异常2): the blank-glyph failure only happens
// on a real phone returning from the background, which is exactly the situation
// where no computer is at hand to open devtools. The agent runs on the user's
// own machine and launchd already redirects its stdout to
// ~/Library/Logs/pocketshell/agent.out.log, so letting the app post one line per
// foreground event turns "偶现，抓不到" into "复现后去日志里翻".
//
// Everything here is defensive on purpose. The payload comes from a client, and
// the log it lands in is something a user may well paste into a public issue:
//   - WHITELIST, never passthrough. Only the handful of atlas counters that
//     answer the question are kept; terminal contents, paths and anything else
//     the client sends are dropped, not redacted.
//   - One line, always. Newlines are stripped so a report cannot forge another.
//   - Bounded. Lengths and array sizes are capped so a stuck client cannot fill
//     the disk.
//   - Never throws. It is called from the rpc dispatch; a diagnostic that can
//     break the session is worse than no diagnostic.
export const DIAG_PREFIX = "[pocketshell:diag]";

/**
 * 诊断埋点总开关（2026-08-23）。**默认关闭。**
 *
 * 为什么要有它：这套埋点是为排查「终端内容中间丢失」配的取证工具，对已经在正常
 * 使用的人没有价值，却要付出真实代价——每个活跃会话在流式输出时每 15s 一轮采样
 * （三条 rpc + agent 侧两次 `tmux capture-pane` 的 spawn），并往 agent 日志持续写行。
 * 让所有人默认承担这个开销去帮一个未复现的 bug 采数据，不是一个合理的默认。
 *
 * 判定顺序（第一个命中的生效）：
 *   1. 环境变量 `POCKETSHELL_DIAG` —— "1"/"true"/"on" 开，其余值（含空字符串）关；
 *   2. `agent.json` 的 `diag` 字段（布尔）；
 *   3. 默认 false。
 *
 * 环境变量优先于配置文件，是为了「临时开一次看看」不必改文件、也不会忘记改回去。
 *
 * 注意开关**只挡日志输出，不挡 rpc 白名单**：`diag.report` / `diag.screen` 仍然
 * 正常应答（返回 ok），否则老客户端会拿到 rpc 错误。真正省掉客户端那侧开销的是
 * `sessions.features` 里的 `diag` 位——见 server.ts。
 */
export function diagEnabled(env: Record<string, string | undefined>, configured?: boolean): boolean {
  const raw = env.POCKETSHELL_DIAG;
  if (typeof raw === "string" && raw !== "") {
    const v = raw.trim().toLowerCase();
    // 显式的假值也要认：`POCKETSHELL_DIAG=0` 必须能压过 agent.json 里的 true，
    // 否则「临时关一下」就没有办法。
    if (v === "0" || v === "false" || v === "off" || v === "no") return false;
    return v === "1" || v === "true" || v === "on" || v === "yes";
  }
  return configured === true;
}

const MAX_TAG = 64;
const MAX_ERROR = 200;
const MAX_ARRAY = 64;

/** Kinds the agent is willing to record. Anything else is logged as "unknown". */
const KINDS = new Set(["atlas", "scroll", "reseed", "rpc", "attach", "seqgap", "drop", "screen", "write", "render", "resize"]);

const oneLine = (s: string, max: number) =>
  s.replace(/[\r\n\t]+/g, " ").slice(0, max);

// A non-number becomes 0 rather than being echoed: these arrays are counters,
// so any string in them is either a bug or an injection attempt.
const numArray = (v: unknown): number[] | undefined =>
  Array.isArray(v) ? v.slice(0, MAX_ARRAY).map((n) => (typeof n === "number" && Number.isFinite(n) ? n : 0)) : undefined;

const boolArray = (v: unknown): boolean[] | undefined =>
  Array.isArray(v) ? v.slice(0, MAX_ARRAY).map((b) => b === true) : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Build the single log line for a client diagnostic report.
 *
 * `now` is injected so tests can pin the timestamp.
 */
export function formatDiagReport(input: unknown, now: () => number = Date.now): string {
  const out: Record<string, unknown> = {};
  try {
    out.ts = new Date(now()).toISOString();
  } catch {
    out.ts = null;
  }
  try {
    const p = (input ?? {}) as Record<string, unknown>;
    out.tag = typeof p.tag === "string" ? oneLine(p.tag, MAX_TAG) : "";
    out.kind = typeof p.kind === "string" && KINDS.has(p.kind) ? p.kind : "unknown";
    if (typeof p.hasRenderer === "boolean") out.hasRenderer = p.hasRenderer;
    const pages = num(p.pages);
    if (pages !== undefined) out.pages = pages;
    const pv = numArray(p.pageVersions);
    if (pv) out.pageVersions = pv;
    const tv = numArray(p.textureVersions);
    if (tv) out.textureVersions = tv;
    const pb = boolArray(p.pagesBlank);
    if (pb) out.pagesBlank = pb;
    // pagesBlank on its own cannot tell "the pixels vanished" from "this page was
    // never drawn to" — both read as blank. These two carry that distinction.
    const pg = numArray(p.pageGlyphs);
    if (pg) out.pageGlyphs = pg;
    const pu = boolArray(p.pagesUsed);
    if (pu) out.pagesUsed = pu;
    const plv = num(p.pageLayoutVersion);
    if (plv !== undefined) out.pageLayoutVersion = plv;
    // 需求 3（12 期）的滚动状态快照。与 atlas 共用同一条 rpc 与同一套净化规则；
    // 字段名与 app/src/lib/term/scroll-probe.ts 的 ScrollSnapshot 逐字对应，
    // 两边漂移是静默的（字段被白名单丢掉，日志里只是少几个数，什么都不报错）。
    //
    // 注意 -1 与 0 的区别必须保住：-1 = 读不到（上游结构变了），0 = 真的塌陷。
    // num() 原样透传两者，不要在这里做任何归一。
    if (typeof p.bufferType === "string") out.bufferType = oneLine(p.bufferType, MAX_TAG);
    for (const k of [
      "bufferLength", "baseY", "ydisp", "rows", "cols",
      "cellHeight", "canvasHeight", "scrollHeight", "scrollTop", "clientHeight",
    ] as const) {
      const v = num(p[k]);
      if (v !== undefined) out[k] = v;
    }
    // 重灌历史的诊断（2026-08-08）。字段名与 app/src/lib/term/reseed.ts 的
    // ReseedReportInput 逐字对应。只有计数，没有终端内容。
    if (typeof p.trigger === "string") out.trigger = oneLine(p.trigger, MAX_TAG);
    if (typeof p.discarded === "boolean") out.discarded = p.discarded;
    for (const k of [
      "rttMs", "snapshotBytes", "framesDuringAwait", "bytesDuringAwait",
      "bufferLenBefore", "bufferLenAfter",
    ] as const) {
      const v = num(p[k]);
      if (v !== undefined) out[k] = v;
    }
    // resize 埋点（2026-08-24）。用户明确报告「终端在输出的时候我没有进行任何
    // 操作」，而 ResizeObserver 不需要用户操作就会触发（软键盘、滚动条出没、
    // 布局变化都算）。此前**完全没有 resize 埋点**，所以「有没有发生 resize」
    // 这个问题在日志里根本答不了 —— 只能靠猜。
    //
    // `why` 区分触发源（ro / window / activate / font / became-measurable），
    // fromCols→toCols 给出实际变化。没有内容，只有数字。
    if (typeof p.why === "string") out.why = oneLine(p.why, MAX_TAG);
    for (const k of ["fromCols", "fromRows", "toCols", "toRows", "sentToPty"] as const) {
      const v = num(p[k]);
      if (v !== undefined) out[k] = v;
    }
    if (typeof p.error === "string") out.error = oneLine(p.error, MAX_ERROR);
    // attach 埋点（2026-08-19）。**唯一由 agent 自己产出、不经客户端的 kind**
    // —— 见 server.ts 的 attach 分支。走同一条格式化是为了让日志里只有一种
    // 结构化行，用户 grep [pocketshell:diag] 就能一次拿全。`tag` 是 sessionId，
    // 与其它 kind 的用法一致（会话名是用户自己起的，不含终端内容）。
    if (typeof p.gap === "boolean") out.gap = p.gap;
    for (const k of ["lastSeq", "frames", "bytes"] as const) {
      const v = num(p[k]);
      if (v !== undefined) out[k] = v;
    }
    // 【2026-08-22 全链路埋点】下面四个 kind 是为「内容中间少几行、上下都在」
    // 这类故障配的。设计原则不变：**只放计数，绝不放终端内容** —— screen 对拍
    // 只上报「差异行数」与「首个差异行号」，不含任何字符。
    //
    //   drop   agent 侧 A6 背压丢帧（此前完全静默，见 server.ts deliverOutput）
    //   seqgap 客户端 seq 跳号 ⇒ 帧真的丢了，且能定位区间
    //   screen tmux 真值 vs xterm buffer 同刻对拍 ⇒ 判定「数据丢了」还是「没画出来」
    //   write  写入量 vs buffer 增量 ⇒ 写进去了但没进 buffer
    //   render 渲染器心跳 ⇒ 渲染器是否停摆
    if (typeof p.phase === "string") out.phase = oneLine(p.phase, MAX_TAG);
    // 渲染服务状态（app/src/lib/term/render-probe.ts）。**布尔要保住「读不到」**：
    // 字段缺席 = 上游结构变了，与 false（确实没暂停）是两回事，别在这里补默认值。
    for (const k of ["paused", "rendererSet", "needsFullRefresh", "domVisible"] as const) {
      if (typeof p[k] === "boolean") out[k] = p[k];
    }
    for (const k of [
      "durMs", "buffered",
      "expected", "got", "missing",
      "tmuxLines", "xtermLines", "missingLines", "extraLines", "firstDiff",
      "wroteFrames", "wroteBytes", "bufDelta",
      "renderFrames", "dirtyRows", "sinceMs",
    ] as const) {
      const v = num(p[k]);
      if (v !== undefined) out[k] = v;
    }
    // 12 期 rpc 压缩埋点。只放计数与方法名，绝不放载荷内容——这条日志用户
    // 可能直接贴进公开 issue。method 与 tag 同样过 oneLine + 长度上限。
    // 字段名与 app/src/lib/term/reseed.ts 的 buildRpcReport 逐字对应，漂移是
    // 静默的（字段被丢掉，日志里只少几个数，什么都不报错）。
    if (typeof p.method === "string") out.method = oneLine(p.method, MAX_TAG);
    const rtt = num(p.rttMs);
    if (rtt !== undefined) out.rttMs = rtt;
    const wire = num(p.wireBytes);
    if (wire !== undefined) out.wireBytes = wire;
    const rawB = num(p.rawBytes);
    if (rawB !== undefined) out.rawBytes = rawB;
    const chunks = num(p.chunks);
    if (chunks !== undefined) out.chunks = chunks;
  } catch {
    out.kind = "unknown";
  }
  let body: string;
  try {
    body = JSON.stringify(out);
  } catch {
    body = '{"kind":"unknown"}';
  }
  // JSON.stringify already escapes control characters inside strings, so this
  // only guards against a stray raw newline sneaking in some other way.
  return `${DIAG_PREFIX} ${body.replace(/[\r\n]+/g, " ")}`;
}
