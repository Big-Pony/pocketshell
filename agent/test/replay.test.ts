import { test, expect } from "bun:test";
import { ReplayService } from "../src/replay";

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
