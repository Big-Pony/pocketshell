// 全局 JS 异常取证（2026-08-28）。
//
// 为什么加：WriteBuffer 楔形卡死的最可能根因是「_innerWrite 的 setTimeout 回调
// 里同步抛了异常」（见 lib/term/write-pump.ts 文件头的路径 A）。这类异常在页面
// 上唯一的可见痕迹是 window 的 error 事件 —— 不写进任何日志，手机上更是连
// DevTools 都没有。2026-08-28 的桌面冻结实例就是这个盲区：故障成立与否、抛在
// 哪一行，全都答不上。
//
// 这里把 error / unhandledrejection 两类事件采成一条 diag.report。纪律：
//   - **绝不外传内容之外的敏感面**：消息与栈只含代码位置与错误文本，不含终端
//     内容；长度封顶（agent 侧还有一道 oneLine 白名单兜底）。
//   - **限流去重**：错误循环（每帧都抛的那种）不能把 rpc 打爆。同一条消息最多
//     报 3 次，整个页面生命周期最多 30 条。超限静默丢弃 —— 取证不需要第 31 条。
//   - 上报由调用方接线（App.svelte 负责 diag 门控与 rpc），本模块只管采集、
//     清洗、限流，纯函数好测。

export interface JsErrorReport {
  /** 错误消息（单行，≤300 字符）。 */
  message: string;
  /** 堆栈（单行化，≤1500 字符）。拿不到栈时缺席。 */
  stack?: string;
  /** "file:line:col" 来源位置（≤200 字符）。拿不到时缺席。 */
  source?: string;
}

export interface JsErrorHookOptions {
  /** 同一条消息的上报上限，默认 3。 */
  maxPerMessage?: number;
  /** 页面生命周期的总上报上限，默认 30。 */
  maxTotal?: number;
}

const MAX_MSG = 300;
const MAX_STACK = 1500;
const MAX_SOURCE = 200;

const oneLine = (s: string, max: number): string =>
  s.replace(/[\r\n\t]+/g, " ").slice(0, max);

interface ErrorEventLike {
  message?: unknown;
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
  error?: { stack?: unknown; message?: unknown } | null;
}

interface RejectionEventLike {
  reason?: unknown;
}

/** 注入最小 window 切面，测试里用替身。 */
export interface JsErrorWindow {
  addEventListener(type: string, cb: EventListener): void;
  removeEventListener(type: string, cb: EventListener): void;
}

/**
 * 挂全局异常采集，返回卸载函数。`report` 的异常绝不外溢（取证把页面搞挂比
 * 没有取证更糟 —— 与 Terminal.svelte 每个探针包 try 是同一原则）。
 */
export function installJsErrorHook(
  report: (r: JsErrorReport) => void,
  opts: JsErrorHookOptions = {},
  w: JsErrorWindow = window,
): () => void {
  const maxPerMessage = opts.maxPerMessage ?? 3;
  const maxTotal = opts.maxTotal ?? 30;
  const perMessage = new Map<string, number>();
  let total = 0;

  const emit = (r: JsErrorReport) => {
    try {
      if (total >= maxTotal) return;
      const seen = (perMessage.get(r.message) ?? 0) + 1;
      perMessage.set(r.message, seen);
      if (seen > maxPerMessage) return;
      total++;
      report(r);
    } catch { /* 取证绝不能影响任何东西 */ }
  };

  const onError = (e: ErrorEventLike) => {
    try {
      const message = oneLine(String(e?.message ?? "unknown error"), MAX_MSG);
      const out: JsErrorReport = { message };
      const stack = e?.error?.stack;
      if (typeof stack === "string" && stack) out.stack = oneLine(stack, MAX_STACK);
      if (typeof e?.filename === "string" && e.filename) {
        const ln = typeof e.lineno === "number" ? e.lineno : 0;
        const col = typeof e.colno === "number" ? e.colno : 0;
        out.source = oneLine(`${e.filename}:${ln}:${col}`, MAX_SOURCE);
      }
      emit(out);
    } catch { /* 同上 */ }
  };

  const onRejection = (e: RejectionEventLike) => {
    try {
      const reason = e?.reason as { stack?: unknown; message?: unknown } | string | null | undefined;
      const message = oneLine(
        "unhandledrejection: " + String(
          typeof reason === "object" && reason !== null
            ? (reason.message ?? reason)
            : reason,
        ),
        MAX_MSG,
      );
      const out: JsErrorReport = { message };
      if (typeof reason === "object" && reason !== null && typeof reason.stack === "string" && reason.stack) {
        out.stack = oneLine(reason.stack, MAX_STACK);
      }
      emit(out);
    } catch { /* 同上 */ }
  };

  w.addEventListener("error", onError as EventListener);
  w.addEventListener("unhandledrejection", onRejection as EventListener);
  return () => {
    try {
      w.removeEventListener("error", onError as EventListener);
      w.removeEventListener("unhandledrejection", onRejection as EventListener);
    } catch { /* 卸载也不抛 */ }
  };
}
