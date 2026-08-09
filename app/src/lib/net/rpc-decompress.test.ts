import { test, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeZipFrame } from "./rpc-decompress";

const toB64 = (b: Buffer) => b.toString("base64");

test("decodeZipFrame returns the original response JSON text", async () => {
  const original = JSON.stringify({ type: "response", id: "7", ok: true, result: { content: "hi".repeat(1000) } });
  const data = toB64(gzipSync(Buffer.from(original, "utf8")));
  expect(await decodeZipFrame(data)).toBe(original);
});

test("decodeZipFrame rejects on invalid base64 (SYNC throw must be caught)", async () => {
  // fromB64 用 atob，坏输入是**同步** InvalidCharacterError。若实现里只写了
  // .catch()，这个异常会从 dispatch 逃到无 try/catch 的 onmessage，杀掉整帧处理。
  await expect(decodeZipFrame("!!!not base64!!!")).rejects.toThrow();
});

test("decodeZipFrame rejects on valid base64 that is not gzip", async () => {
  await expect(decodeZipFrame(toB64(Buffer.from([1, 2, 3, 4])))).rejects.toThrow();
});

test("decodeZipFrame round-trips a multi-byte UTF-8 payload", async () => {
  const original = JSON.stringify({ type: "response", id: "8", ok: true, result: { content: "中文内容".repeat(2000) } });
  const data = toB64(gzipSync(Buffer.from(original, "utf8")));
  expect(await decodeZipFrame(data)).toBe(original);
});
