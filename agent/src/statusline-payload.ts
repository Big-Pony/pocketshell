// 解析 Claude Code 喂给 statusLine 命令的 stdin JSON。
//
// 为什么要接 statusLine 而不是读 transcript：CC 的 transcript 里没有上下文
// 窗口大小，且 assistant 记录的 model 字段是 "claude-opus-5" —— [1m] 后缀
// 被剥掉了（本机实测），物理上区分不了 200k 与 1M 窗口。statusLine 的
// JSON 直接给 context_window_size，是唯一权威来源。既然要接，分子分母一起拿。
//
// 字段依据官方文档 https://code.claude.com/docs/en/statusline：
//   context_window.total_input_tokens  当前上下文里的 input 侧总量（含 cache）
//   context_window.context_window_size 窗口大小，200000 或 1000000
//   context_window.current_usage       最后一次 API 调用的明细；首次调用前
//                                      与 /compact 之后为 null，故不依赖它

export interface StatuslinePayload {
  sessionId: string;
  cwd: string;
  used?: number;
  total?: number;
}

function posNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export function parseStatuslinePayload(stdin: string): StatuslinePayload | null {
  let j: any;
  try { j = JSON.parse(stdin); }
  catch { return null; }
  const sessionId = j?.session_id;
  // 没有会话身份就无从归属，这条数据没有意义
  if (typeof sessionId !== "string" || !sessionId) return null;
  const cw = j.context_window;
  return {
    sessionId,
    cwd: typeof j.cwd === "string" ? j.cwd : "",
    used: posNum(cw?.total_input_tokens),
    total: posNum(cw?.context_window_size),
  };
}
