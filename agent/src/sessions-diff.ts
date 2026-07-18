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
    a.attached === b.attached
  );
}

export function sessionListsEqual(a: SessionMeta[], b: SessionMeta[]): boolean {
  return a.length === b.length && a.every((s, i) => sessionMetasEqual(s, b[i]));
}
