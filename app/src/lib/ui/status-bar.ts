// app/src/lib/status-bar.ts
// 信息分割条的纯逻辑：把 connection.ts 记账出来的原始数字（RTT 毫秒、窗口
// 字节数与窗口时长）格式化成分割条上显示的短文本。组件只做渲染，这里全部
// 是无副作用的纯函数，单测覆盖在 status-bar.test.ts。

/** 分支名最长显示字符数（超出保留尾部，前面加省略号）。 */
export const BRANCH_MAX = 14;

/**
 * 延迟显示。null / 负数 / 非有限值一律返回空串 —— 分割条的规则是「数据缺失
 * 即整块隐藏」，不显示 `--` 之类的占位符。
 */
export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1) return "<1ms";
  if (ms >= 999) return "999ms+";
  return `${Math.round(ms)}ms`;
}

/**
 * 下行速率显示。恒定占位宽度是刻意的：空闲时显示 `0KB/s` 而不是隐藏，
 * 否则数字进出会让分割条右侧布局抖动。
 *
 * elapsedMs <= 0 时返回空串（除零保护）——调用方还没攒够一个窗口。
 */
export function formatRate(bytes: number, elapsedMs: number): string {
  if (!Number.isFinite(bytes) || !Number.isFinite(elapsedMs)) return "";
  if (elapsedMs <= 0) return "";
  const perSec = Math.max(0, bytes) / (elapsedMs / 1000);
  if (perSec >= 1024 * 1024) return `${(perSec / (1024 * 1024)).toFixed(1)}MB/s`;
  if (perSec >= 1024) return `${Math.round(perSec / 1024)}KB/s`;
  // 1KB/s 以下给一位小数，免得小流量一律显示成 0KB/s 看不出有没有数据。
  // 但心跳本身也占几十字节，摊到 10s 窗口是 0.0x KB/s —— 真正空闲时该显示
  // 干净的 `0KB/s`，而不是一个永远挂着的 `0.0KB/s`。
  const kb = perSec / 1024;
  return kb < 0.05 ? "0KB/s" : `${kb.toFixed(1)}KB/s`;
}

/**
 * 分支名省略：保留尾部（`feature/…` 这种前缀共享的分支，尾部才是区分度所在）。
 * 省略号计入总长度，因此结果永远不超过 BRANCH_MAX 个字符。
 */
export function formatBranch(branch: string, dirty = false, max = BRANCH_MAX): string {
  const name = (branch ?? "").trim();
  if (!name) return "";
  const suffix = dirty ? "*" : "";
  const budget = max - suffix.length;
  if (name.length <= budget) return name + suffix;
  return "…" + name.slice(name.length - (budget - 1)) + suffix;
}

/**
 * AI 上下文用量显示。数据由各工具的 hook 在回合结束时推上来（见 agent 的
 * ContextStore），因此回合进行中数字不变——这是设计上接受的取舍。
 *
 * 三态，沿用本文件既有的「数据缺失即整块隐藏、不显示 -- 占位符」规则：
 *   已用缺失         → ""              分割条右组照常显示延迟与吞吐
 *   只有已用         → "142k"          claude 未接 statusLine 时就是这样，
 *                                      不编造一个可能错的分母
 *   两者齐全         → "142k/1M · 14%"
 */
export function formatContext(used?: number, total?: number): string {
  if (used === undefined || !Number.isFinite(used) || used < 0) return "";
  const u = abbrevTokens(used);
  if (total === undefined || !Number.isFinite(total) || total <= 0) return u;
  const pct = Math.round((used / total) * 100);
  return `${u}/${abbrevTokens(total)} · ${pct}%`;
}

// 1500000 → "1.5M"，2000000 → "2M"，63476 → "63k"，999 → "999"
function abbrevTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return (Number.isInteger(m) ? String(m) : m.toFixed(1)) + "M";
  }
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(Math.round(n));
}
