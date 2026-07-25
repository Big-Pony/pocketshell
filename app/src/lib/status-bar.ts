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
  // 1KB/s 以下给一位小数，免得一切都显示成 0KB/s 看不出有没有流量
  const kb = perSec / 1024;
  return `${kb === 0 ? "0" : kb.toFixed(1)}KB/s`;
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
