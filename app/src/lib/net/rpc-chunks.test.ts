import { test, expect } from "vitest";
import { ChunkReassembler, MAX_CHUNKS, type ChunkFrame } from "./rpc-chunks";

const frame = (id: string, index: number, total: number, bytes: Uint8Array): ChunkFrame =>
  ({ id, index, total, bytes });
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

test("feed 吃字节，重组结果逐字节正确（含非法 UTF-8）", () => {
  const r = new ChunkReassembler();
  const a = new Uint8Array([0xed, 0xa0, 0x80]);
  const b = new Uint8Array([0xff, 0xfe, 0x00]);
  expect(r.feed({ id: "1", index: 0, total: 2, bytes: a }).status).toBe("pending");
  const done = r.feed({ id: "1", index: 1, total: 2, bytes: b });
  expect(done.status).toBe("done");
  if (done.status === "done") {
    expect(Array.from(done.bytes)).toEqual([0xed, 0xa0, 0x80, 0xff, 0xfe, 0x00]);
  }
});

test("存进 buffer 的分片必须是真拷贝，不与来帧共享底层 buffer", () => {
  // blob 是 unpackBinFrame 返回的零拷贝视图，持有**整帧**的底层 buffer。
  // 分片要驻留到全部到齐才重组——不 slice 的话 10 个分片各钉住一整帧，
  // 内存放大 10 倍。这条没法用普通断言测（内容是对的），只能查 .buffer 身份。
  const r = new ChunkReassembler();
  const backing = new Uint8Array(1000);
  const view = backing.subarray(100, 110);
  r.feed({ id: "x", index: 0, total: 2, bytes: view });
  const stored = (r as any).buffers.get("x").parts[0] as Uint8Array;
  expect(stored.buffer).not.toBe(backing.buffer);
  expect(Array.from(stored)).toEqual(Array.from(view));
});
