import { test, expect } from "bun:test";
import { ReplayService, tailWithinBudget, GAP_BACKFILL_BUDGET_BYTES } from "./replay";

const b = (s: string) => new TextEncoder().encode(s);

test("ingest assigns monotonically increasing seq from 1", () => {
  const r = new ReplayService();
  expect(r.ingest("s", b("a")).seq).toBe(1);
  expect(r.ingest("s", b("b")).seq).toBe(2);
  expect(r.latestSeq("s")).toBe(2);
});

test("seq is per-session independent", () => {
  const r = new ReplayService();
  r.ingest("s1", b("a"));
  expect(r.ingest("s2", b("z")).seq).toBe(1);
});

test("since returns only frames after lastSeq, no gap when in buffer", () => {
  const r = new ReplayService();
  r.ingest("s", b("a"));
  r.ingest("s", b("b"));
  r.ingest("s", b("c"));
  const { frames, gap } = r.since("s", 1);
  expect(frames.map((f) => f.seq)).toEqual([2, 3]);
  expect(gap).toBe(false);
});

test("since on unknown session returns empty, no gap", () => {
  const r = new ReplayService();
  expect(r.since("nope", 0)).toEqual({ frames: [], gap: false, oldestSeq: 0 });
});

test("since reports gap when the client's next needed frame was evicted", () => {
  const r = new ReplayService(2); // 2-byte cap
  r.ingest("s", b("a")); // seq1, buffer=[1]
  r.ingest("s", b("b")); // seq2, buffer=[1,2]
  r.ingest("s", b("c")); // seq3, evict seq1 -> buffer=[2,3], oldest=2
  r.ingest("s", b("d")); // seq4, evict seq2 -> buffer=[3,4], oldest=3
  // Client last saw seq1, so it needs seq2 next — but seq2 was evicted
  // (buffer now starts at seq3), so there is a real gap.
  const { frames, gap } = r.since("s", 1);
  expect(frames.map((f) => f.seq)).toEqual([3, 4]);
  expect(gap).toBe(true);
});

test("since reports no gap when the client sits exactly at oldestSeq-1", () => {
  const r = new ReplayService(2); // 2-byte cap
  r.ingest("s", b("a")); // seq1
  r.ingest("s", b("b")); // seq2, buffer=[1,2]
  r.ingest("s", b("c")); // seq3, evict seq1 -> buffer=[2,3], oldest=2
  r.ingest("s", b("d")); // seq4, evict seq2 -> buffer=[3,4], oldest=3
  // Client last saw seq2, needs seq3 next — seq3 is the oldest retained
  // frame, so backfill is seamless: no gap.
  const { frames, gap } = r.since("s", 2);
  expect(frames.map((f) => f.seq)).toEqual([3, 4]);
  expect(gap).toBe(false);
});

test("since with current latestSeq returns nothing", () => {
  const r = new ReplayService();
  r.ingest("s", b("a"));
  expect(r.since("s", 1)).toEqual({ frames: [], gap: false, oldestSeq: 1 });
});

test("a batched frame (concatenated bursts) backfills as one frame with contiguous seq", () => {
  // A2: the server ingests a multi-chunk batch as ONE frame; since() must hand
  // it back verbatim so seq bookkeeping stays contiguous across the batch.
  const r = new ReplayService();
  const parts = [b("ab"), b("cd"), b("e")];
  const joined = new Uint8Array(5);
  joined.set(parts[0], 0); joined.set(parts[1], 2); joined.set(parts[2], 4);
  r.ingest("s", joined); // seq1 covers "abcde"
  r.ingest("s", b("f")); // seq2
  const { frames, gap } = r.since("s", 0);
  expect(gap).toBe(false);
  expect(frames.map((f) => f.seq)).toEqual([1, 2]);
  expect(Buffer.from(frames[0].data).toString()).toBe("abcde");
  expect(Buffer.from(frames[1].data).toString()).toBe("f");
});

test("oldestSeq tracks the retained window (0 when empty)", () => {
  const r = new ReplayService(2); // 2-byte cap
  expect(r.oldestSeq("s")).toBe(0);
  r.ingest("s", b("a")); // seq1
  expect(r.oldestSeq("s")).toBe(1);
  r.ingest("s", b("b")); // seq2
  r.ingest("s", b("c")); // seq3, evict seq1
  r.ingest("s", b("d")); // seq4, evict seq2
  expect(r.oldestSeq("s")).toBe(3);
});

test("since reports oldestSeq of the retained buffer on gap", () => {
  const r = new ReplayService(2); // 2-byte cap
  r.ingest("s", b("a")); // seq1
  r.ingest("s", b("b")); // seq2 -> buffer[1,2]
  r.ingest("s", b("c")); // seq3 -> evict1 -> buffer[2,3], oldest=2
  r.ingest("s", b("d")); // seq4 -> evict2 -> buffer[3,4], oldest=3
  const res = r.since("s", 1);
  expect(res.gap).toBe(true);
  expect(res.oldestSeq).toBe(3);
});

// —— gap 补发限量（2026-08-19）：gap 时只发覆盖一屏的最新 N 字节 ——
// 见 docs/域/终端与会话.md 的「断线重放」。这里钉的是纯函数的边界语义，
// server.ts 只负责「gap 时才调它」。

test("tailWithinBudget keeps the newest frames within the byte budget", () => {
  const frames = [1, 2, 3, 4, 5].map((seq) => ({ sessionId: "s", seq, data: new Uint8Array(10) }));
  // 预算 25B：从最新往回收，5(10) + 4(10) = 20 <= 25，再加 3 就 30 > 25。
  expect(tailWithinBudget(frames, 25).map((f) => f.seq)).toEqual([4, 5]);
});

test("tailWithinBudget keeps chronological order (replay must not arrive reversed)", () => {
  const frames = [1, 2, 3].map((seq) => ({ sessionId: "s", seq, data: new Uint8Array(4) }));
  expect(tailWithinBudget(frames, 8).map((f) => f.seq)).toEqual([2, 3]);
});

test("tailWithinBudget always keeps at least the newest frame, however big", () => {
  // 题眼：客户端的 `seen` 只由 output 帧推进（connection.ts:564）。一帧都不发
  // 会让 seen 永久钉死 → 每次重连必再判 gap → 粘性 resync 循环。所以哪怕单帧
  // 超预算也必须发出去。
  const frames = [{ sessionId: "s", seq: 7, data: new Uint8Array(99_999) }];
  expect(tailWithinBudget(frames, 1024).map((f) => f.seq)).toEqual([7]);
});

test("tailWithinBudget returns everything when the backlog fits", () => {
  const frames = [1, 2].map((seq) => ({ sessionId: "s", seq, data: new Uint8Array(4) }));
  expect(tailWithinBudget(frames, 1024).map((f) => f.seq)).toEqual([1, 2]);
});

test("tailWithinBudget on an empty backlog stays empty (no synthetic frame)", () => {
  expect(tailWithinBudget([], 1024)).toEqual([]);
});

test("the default gap budget covers a worst-case phone screen but is a fraction of the ring", () => {
  // 27 行 × 61 列（真机竖屏实测尺寸）满屏重绘，逐格带 SGR 的最坏情况远小于它；
  // 同时必须显著小于 256KB 的环容量，否则限量等于没限。
  expect(GAP_BACKFILL_BUDGET_BYTES).toBeGreaterThanOrEqual(27 * 61 * 10);
  expect(GAP_BACKFILL_BUDGET_BYTES).toBeLessThanOrEqual(256 * 1024 / 4);
});
