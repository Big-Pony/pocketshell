import { test, expect } from "vitest";
import { ChunkReassembler, MAX_CHUNKS, type ChunkFrame } from "./rpc-chunks";
import { toB64 } from "./bytes";

const frame = (id: string, index: number, total: number, bytes: Uint8Array): ChunkFrame =>
  ({ id, index, total, data: toB64(bytes) });
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

test("single chunk (total=1) completes immediately", () => {
  const r = new ChunkReassembler();
  const res = r.feed(frame("1", 0, 1, bytes("hello")));
  expect(res.status).toBe("done");
  expect(text((res as any).bytes)).toBe("hello");
  expect(r.has("1")).toBe(false); // buffer released on completion
});

test("multiple chunks concatenate in index order", () => {
  const r = new ChunkReassembler();
  expect(r.feed(frame("1", 0, 3, bytes("abc"))).status).toBe("pending");
  expect(r.feed(frame("1", 1, 3, bytes("def"))).status).toBe("pending");
  expect(r.has("1")).toBe(true);
  const res = r.feed(frame("1", 2, 3, bytes("ghi")));
  expect(res.status).toBe("done");
  expect(text((res as any).bytes)).toBe("abcdefghi");
});

test("out-of-order arrival is tolerated and reassembled by index", () => {
  const r = new ChunkReassembler();
  expect(r.feed(frame("1", 2, 3, bytes("ghi"))).status).toBe("pending");
  expect(r.feed(frame("1", 0, 3, bytes("abc"))).status).toBe("pending");
  const res = r.feed(frame("1", 1, 3, bytes("def")));
  expect(res.status).toBe("done");
  expect(text((res as any).bytes)).toBe("abcdefghi");
});

test("invalid totals are rejected: 0, negative, non-integer, over MAX_CHUNKS", () => {
  for (const total of [0, -1, 1.5, MAX_CHUNKS + 1]) {
    const r = new ChunkReassembler();
    const res = r.feed(frame("1", 0, total, bytes("x")));
    expect(res.status).toBe("error");
    expect((res as any).reason).toBe("bad_total");
    expect(r.has("1")).toBe(false); // nothing buffered on a hard error
  }
});

test("out-of-range index is rejected", () => {
  const r = new ChunkReassembler();
  expect((r.feed(frame("1", 3, 3, bytes("x"))) as any).reason).toBe("bad_index");
  expect((r.feed(frame("1", -1, 3, bytes("x"))) as any).reason).toBe("bad_index");
  expect((r.feed(frame("1", 1.5, 3, bytes("x"))) as any).reason).toBe("bad_index");
});

test("total changing mid-stream is rejected", () => {
  const r = new ChunkReassembler();
  expect(r.feed(frame("1", 0, 3, bytes("abc"))).status).toBe("pending");
  const res = r.feed(frame("1", 1, 4, bytes("def")));
  expect(res.status).toBe("error");
  expect((res as any).reason).toBe("total_mismatch");
});

test("undecodable base64 data is rejected", () => {
  const r = new ChunkReassembler();
  const res = r.feed({ id: "1", index: 0, total: 1, data: "!!!" });
  expect(res.status).toBe("error");
  expect((res as any).reason).toBe("bad_data");
});

test("a duplicate chunk is ignored, assembly still completes once", () => {
  const r = new ChunkReassembler();
  expect(r.feed(frame("1", 0, 2, bytes("abc"))).status).toBe("pending");
  expect(r.feed(frame("1", 0, 2, bytes("ZZZ"))).status).toBe("pending"); // dup index 0
  const res = r.feed(frame("1", 1, 2, bytes("def")));
  expect(res.status).toBe("done");
  expect(text((res as any).bytes)).toBe("abcdef"); // first write wins
});

test("drop discards partial state; the id starts fresh afterwards", () => {
  const r = new ChunkReassembler();
  expect(r.feed(frame("1", 0, 2, bytes("abc"))).status).toBe("pending");
  r.drop("1");
  expect(r.has("1")).toBe(false);
  // a new stream for the same id must not see the stale slice
  const res = r.feed(frame("1", 0, 1, bytes("solo")));
  expect(res.status).toBe("done");
  expect(text((res as any).bytes)).toBe("solo");
});

test("clear discards all partial buffers", () => {
  const r = new ChunkReassembler();
  r.feed(frame("1", 0, 2, bytes("a")));
  r.feed(frame("2", 0, 5, bytes("b")));
  r.clear();
  expect(r.has("1")).toBe(false);
  expect(r.has("2")).toBe(false);
});

test("independent ids assemble independently", () => {
  const r = new ChunkReassembler();
  r.feed(frame("1", 0, 2, bytes("A")));
  r.feed(frame("2", 0, 2, bytes("x")));
  const res2 = r.feed(frame("2", 1, 2, bytes("y")));
  expect(text((res2 as any).bytes)).toBe("xy");
  expect(r.has("1")).toBe(true); // id 1 untouched
  const res1 = r.feed(frame("1", 1, 2, bytes("B")));
  expect(text((res1 as any).bytes)).toBe("AB");
});
