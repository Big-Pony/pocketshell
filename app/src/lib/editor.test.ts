import { describe, it, expect } from "vitest";
import { encodeWriteChunks, saveFile, isConflictError, langExtension } from "./editor";
import { fromB64 } from "./bytes";

function decodeAll(chunks: string[]): string {
  const parts = chunks.map(fromB64);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return new TextDecoder().decode(buf);
}

describe("encodeWriteChunks", () => {
  it("empty text → single empty chunk", () => {
    expect(encodeWriteChunks("")).toEqual([""]);
  });
  it("byte-slices reassemble to the original even when CJK chars split across chunks", () => {
    const text = "你好a世界"; // 3+3+1+3+3 = 13 utf8 bytes
    const chunks = encodeWriteChunks(text, 4); // forces splits inside CJK sequences
    expect(chunks.length).toBe(4); // 4+4+4+1
    expect(decodeAll(chunks)).toBe(text);
  });
  it("each chunk stays within the raw-byte cap", () => {
    const chunks = encodeWriteChunks("x".repeat(100_000), 45 * 1024);
    for (const c of chunks) expect(fromB64(c).length).toBeLessThanOrEqual(45 * 1024);
    expect(decodeAll(chunks).length).toBe(100_000);
  });
});

describe("saveFile", () => {
  function fakeConn() {
    const calls: any[] = [];
    return { calls, rpc: async (_m: string, p: any) => { calls.push(p); return p.last ? { ok: true, mtime: 42 } : { written: 1 }; } };
  }
  it("small file: one chunk carrying first+last+path+expectMtime, resolves mtime", async () => {
    const c = fakeConn();
    const r = await saveFile(c, "/a.txt", "hi", 1234);
    expect(r.mtime).toBe(42);
    expect(c.calls.length).toBe(1);
    expect(c.calls[0]).toMatchObject({ first: true, last: true, path: "/a.txt", expectMtime: 1234 });
  });
  it("large file: serial chunks, only the last carries path/expectMtime, same writeId", async () => {
    const c = fakeConn();
    await saveFile(c, "/a.txt", "x".repeat(100 * 1024), 1);
    expect(c.calls.length).toBe(3); // 45+45+10 KB
    expect(c.calls[0]).toMatchObject({ first: true, last: false });
    expect(c.calls[0].path).toBeUndefined();
    expect(c.calls[2]).toMatchObject({ last: true, path: "/a.txt", expectMtime: 1 });
    expect(new Set(c.calls.map((p) => p.writeId)).size).toBe(1);
  });
  it("omitted expectMtime (force) is not sent", async () => {
    const c = fakeConn();
    await saveFile(c, "/a.txt", "hi");
    expect("expectMtime" in c.calls[0]).toBe(false);
  });
});

describe("isConflictError / langExtension", () => {
  it("matches the agent's conflict prefix only", () => {
    expect(isConflictError(new Error("conflict: file changed on disk"))).toBe(true);
    expect(isConflictError(new Error("write exceeds 1 bytes"))).toBe(false);
    expect(isConflictError("conflict")).toBe(false);
  });
  it("loads a Lezer language and returns null for unknown", async () => {
    expect(await langExtension("javascript")).not.toBeNull();
    expect(await langExtension("plaintext")).toBeNull();
  });
});
