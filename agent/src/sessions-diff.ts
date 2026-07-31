// WP-3a diff push: shallow, field-by-field comparison of session rosters so
// an unchanged list() result is neither encoded nor broadcast. Order-sensitive
// on purpose — list() order is deterministic (owned insertion order, then the
// tmux roster order), so an order flip is treated as a change: it costs one
// extra broadcast, never a stale client.
import type { SessionMeta } from "./protocol";

export function sessionMetasEqual(a: SessionMeta, b: SessionMeta): boolean {
  return (
    a.name === b.name &&
    a.state === b.state &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.lastLine === b.lastLine &&
    a.createdAt === b.createdAt &&
    a.attached === b.attached &&
    // 必须纳入比较：这三个字段变了却判定相等，广播会被 diff 吃掉，
    // 分割条上的数字永远不更新（功能静默失效）。
    a.ctxTool === b.ctxTool &&
    a.ctxUsed === b.ctxUsed &&
    a.ctxTotal === b.ctxTotal
  );
}

export function sessionListsEqual(a: SessionMeta[], b: SessionMeta[]): boolean {
  return a.length === b.length && a.every((s, i) => sessionMetasEqual(s, b[i]));
}
