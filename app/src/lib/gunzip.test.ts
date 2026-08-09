import { test, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { gunzip } from "./gunzip";

// app 的 vitest 跑在 Node 22 上，没有 Bun.gzipSync —— 用 node:zlib 造样本，
// 同一 gzip 流，与 agent 侧互通。
test("gunzip round-trips a UTF-8 payload", async () => {
  const text = "你好，world\n".repeat(500);
  const gz = new Uint8Array(gzipSync(Buffer.from(text, "utf8")));
  const out = await gunzip(gz);
  expect(new TextDecoder().decode(out)).toBe(text);
});

test("gunzip rejects on a non-gzip stream", async () => {
  await expect(gunzip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
});

test("gunzip handles a payload spanning multiple internal chunks", async () => {
  const big = "x".repeat(400_000);
  const gz = new Uint8Array(gzipSync(Buffer.from(big, "utf8")));
  const out = await gunzip(gz);
  expect(out.length).toBe(400_000);
});
