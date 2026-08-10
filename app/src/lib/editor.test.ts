import { describe, it, expect, test } from "vitest";
import { encodeWriteChunks, saveFile, isConflictError, langExtension } from "./editor";
import { CHUNK_BYTES } from "./net/transfer";

function decodeAll(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of chunks) { buf.set(p, o); o += p.length; }
  return new TextDecoder().decode(buf);
}

describe("encodeWriteChunks", () => {
  it("empty text → single empty chunk", () => {
    const chunks = encodeWriteChunks("");
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(0);
  });
  it("byte-slices reassemble to the original even when CJK chars split across chunks", () => {
    const text = "你好a世界"; // 3+3+1+3+3 = 13 utf8 bytes
    const chunks = encodeWriteChunks(text, 4); // forces splits inside CJK sequences
    expect(chunks.length).toBe(4); // 4+4+4+1
    expect(decodeAll(chunks)).toBe(text);
  });
  it("each chunk stays within the raw-byte cap", () => {
    const chunks = encodeWriteChunks("x".repeat(100_000), 45 * 1024);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(45 * 1024);
    expect(decodeAll(chunks).length).toBe(100_000);
  });
});

describe("saveFile", () => {
  function fakeConn() {
    const calls: any[] = [];
    return {
      calls,
      rpc: async (_m: string, p: any) => { calls.push(p); return p.last ? { ok: true, mtime: 42 } : { written: 1 }; },
      rpcBin: async (_m: string, p: any, blob: Uint8Array) => {
        calls.push({ ...p, blob }); return p.last ? { ok: true, mtime: 42 } : { written: 1 };
      },
    };
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
    // 分片数从 CHUNK_BYTES 推导，不抄死数字 —— 它是传输层的共享常量
    // （14 期把它从 45KB 提到 56KB 时，写死 3 的断言当场翻车）。
    // 取 2.5 个分片那么长的文本，保证恰好切成 3 片（首、中、尾）。
    const text = "x".repeat(Math.floor(CHUNK_BYTES * 2.5));
    await saveFile(c, "/a.txt", text, 1);
    expect(c.calls.length).toBe(3);
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

test("saveFile 走 rpcBin，内容含 CJK 与 emoji 时逐字节正确", async () => {
  const calls: { params: any; blob: Uint8Array }[] = [];
  const conn = {
    rpc: async () => ({ ok: true, mtime: 1 }),
    rpcBin: async (_m: string, params: unknown, blob: Uint8Array) => {
      calls.push({ params: params as any, blob }); return { ok: true, mtime: 1 };
    },
  };
  const text = "const s = '中文与 emoji 🎉';\n";
  await saveFile(conn as any, "/a.ts", text);
  const joined = new Uint8Array(calls.reduce<number[]>((a, c) => a.concat(Array.from(c.blob)), []));
  expect(new TextDecoder().decode(joined)).toBe(text);
  expect(calls[calls.length - 1].params.path).toBe("/a.ts");
});

describe("isConflictError / langExtension", () => {
  it("detects conflict by structured error code, not message text", () => {
    const conflict = Object.assign(new Error("conflict: file changed on disk"), { code: "conflict" });
    expect(isConflictError(conflict)).toBe(true);
    // Message text alone must NOT trigger — a generic failure whose text happens
    // to contain "conflict" (e.g. a path named conflict.ts) is not a real conflict.
    expect(isConflictError(new Error("conflict: file changed on disk"))).toBe(false);
    expect(isConflictError(Object.assign(new Error("boom"), { code: "rpc_error" }))).toBe(false);
    expect(isConflictError("conflict")).toBe(false);
  });
  it("loads a Lezer language and returns null for unknown", async () => {
    expect(await langExtension("javascript")).not.toBeNull();
    expect(await langExtension("plaintext")).toBeNull();
  });
});
