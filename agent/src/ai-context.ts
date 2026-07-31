// 各 AI CLI 落盘文件的 token 用量解析。纯函数：收一段文件尾部文本，返回
// 当前上下文占用。文件 IO 与路径拼装在调用方（server.ts 的 notify 子命令）。
//
// 为什么只收尾部文本：这些 jsonl 可达数十 MB（本机存在 10MB 实例），全量
// 加载会把 agent 内存打爆。调用方读尾部 64KB 即可。
//
// 为什么倒序扫描而不是取最后一行：
//   - 目标记录之间夹着大量其他类型（claude 的 user/attachment、kimi 的
//     ContentPart），最后一行往往不是我们要的；
//   - 本机实测发现部分 kimi 会话的 StatusUpdate 根本没有 context_tokens
//     字段（4 个会话里 2 个如此，疑为旧版格式），所以不能「找到最后一条
//     StatusUpdate 就用」，必须找最后一条真正带齐字段的。
//
// 尾部从中间切开时第一行是残缺 JSON，解析失败即跳过——倒序扫描下它最后
// 才被检查，通常轮不到。

export type AiTool = "claude" | "kimi" | "codex" | "opencode";

export interface AiContext {
  used: number;
  /** claude 的 transcript 里没有窗口大小（模型名被剥了 [1m] 后缀，物理上
   *  区分不了 200k 与 1M），由 statusLine 单独提供，故此字段可缺省。 */
  total?: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// 一条记录 → 结果；不是目标记录或字段不全则返回 null，调用方继续往上找。
type LineParser = (j: any) => AiContext | null;

const PARSERS: Record<AiTool, LineParser | null> = {
  kimi: (j) => {
    if (j?.message?.type !== "StatusUpdate") return null;
    const p = j.message.payload;
    // 旧版会话没有这两个字段 —— 跳过，继续往上找带齐的那条
    if (typeof p?.context_tokens !== "number" || typeof p?.max_context_tokens !== "number") return null;
    return { used: p.context_tokens, total: p.max_context_tokens };
  },

  claude: (j) => {
    if (j?.type !== "assistant") return null;
    const u = j.message?.usage;
    if (!u) return null;
    // 官方口径：used_percentage 只算 input 侧三项之和，不含 output_tokens。
    // 手工计算必须用同一公式才能与 CC 自己显示的百分比对上。
    const used = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
    if (used <= 0) return null;
    return { used, total: undefined };
  },

  codex: (j) => {
    if (j?.type !== "token_count") return null;
    const info = j.info;
    const used = info?.last_token_usage?.input_tokens;
    // total_token_usage 是会话累计值，不是当前上下文占用（openai/codex#22354）。
    // 用错了会看到一个只涨不降的数字。
    if (typeof used !== "number") return null;
    const win = info?.model_context_window;
    return { used, total: typeof win === "number" ? win : undefined };
  },

  // opencode 的落盘格式版本不稳定（旧版 JSON、新版 SQLite），官方工具明确
  // 警告不要解析。它的数据由插件经 SDK 直接上报，见 notify-wire 的
  // OPENCODE_PLUGIN_SRC。
  opencode: null,
};

export function parseAiContext(tool: AiTool, tailText: string): AiContext | null {
  const parse = PARSERS[tool];
  if (!parse) return null;
  const lines = tailText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let j: unknown;
    try { j = JSON.parse(line); }
    catch { continue; }   // 残缺行（尾部截断）或非 JSON 行，跳过
    const r = parse(j);
    if (r) return r;
  }
  return null;
}
