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
  expect(r.since("nope", 0)).toEqual({ frames: [], gap: false });
});

test("ring buffer evicts oldest and reports gap when lastSeq fell off", () => {
  const r = new ReplayService(3); // 3-byte cap
  r.ingest("s", b("a")); // seq1, buffer=[1]
  r.ingest("s", b("b")); // seq2, buffer=[1,2]
  r.ingest("s", b("c")); // seq3, buffer=[1,2,3] (3 bytes)
  r.ingest("s", b("d")); // seq4, evict seq1 -> buffer=[2,3,4]
  const { frames, gap } = r.since("s", 1); // asked from 1, but 1 evicted
  expect(frames.map((f) => f.seq)).toEqual([2, 3, 4]);
  expect(gap).toBe(true);
});

test("since with current latestSeq returns nothing", () => {
  const r = new ReplayService();
  r.ingest("s", b("a"));
  expect(r.since("s", 1)).toEqual({ frames: [], gap: false });
});
