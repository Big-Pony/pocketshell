import { test, expect } from "bun:test";
import { compressRpcPayload, RPC_COMPRESS_MIN_BYTES } from "./rpc-compress";

const envelope = (result: unknown) => JSON.stringify({ type: "response", id: "1", ok: true, result });

test("payload under the threshold is left alone", () => {
  const small = envelope({ content: "x".repeat(100) });
  expect(small.length).toBeLessThan(RPC_COMPRESS_MIN_BYTES);
  expect(compressRpcPayload(small, "fs.read", ["gzip"])).toEqual({ kind: "plain" });
});

test("no acceptEnc means never compress (old client)", () => {
  const big = envelope({ content: "hello world ".repeat(5000) });
  expect(compressRpcPayload(big, "fs.read", undefined)).toEqual({ kind: "plain" });
});

test("acceptEnc without gzip means never compress", () => {
  const big = envelope({ content: "hello world ".repeat(5000) });
  expect(compressRpcPayload(big, "fs.read", ["br"])).toEqual({ kind: "plain" });
});

test("a large compressible payload is compressed", () => {
  const big = envelope({ content: "hello world ".repeat(5000) });
  const out = compressRpcPayload(big, "fs.read", ["gzip"]);
  if (out.kind !== "zip") throw new Error("expected zip");
  // 解出来必须逐字节等于原 payload
  const raw = Buffer.from(Bun.gunzipSync(Buffer.from(out.data, "base64")));
  expect(raw.toString("utf8")).toBe(big);
});

test("fs.downloadChunk is skipped by name even when large", () => {
  // 下载分片是已压缩的媒体字节，压不动却要白烧 0.78ms/次；200MB 下载
  // 累计约 3.5 秒同步阻塞，还挤在 4 路并发的同一个事件循环上。
  const big = envelope({ dataB64: Buffer.from("z".repeat(60000)).toString("base64"), eof: false });
  expect(compressRpcPayload(big, "fs.downloadChunk", ["gzip"])).toEqual({ kind: "plain" });
});

test("incompressible payload falls back to plain (gzip made it bigger)", () => {
  // 高熵字节：gzip 之后 base64 回膨胀 4/3，最终上线字节必然更大。
  let s = 0x9e3779b9;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  const noise = Array.from({ length: 20000 }, () => String.fromCharCode(33 + (rnd() % 90))).join("");
  const big = envelope({ content: noise });
  expect(compressRpcPayload(big, "fs.read", ["gzip"])).toEqual({ kind: "plain" });
});

test("an ALREADY-gzipped payload (term.history) is refused a second pass", () => {
  // 这条守的是设计里最容易搞错的一点：外层 gzip 对 term.history 的信封其实
  // **很有效**（裸字节 -24.5%），但 base64 的 4/3 回膨胀刚好把增益吃干，
  // 净剩 +0.7%，所以被尺寸判据拒绝。
  //
  // 判据必须比【最终上线字节】。若改成比 gzip 的裸字节，这条会翻转成
  // "该压"，term.history 就会被白白压两遍。
  const scrollback = Buffer.from("[32m$ ls -la[0m\n".repeat(4000));
  const inner = Buffer.from(Bun.gzipSync(scrollback)).toString("base64");
  const big = envelope({ data: inner, seq: 7, enc: "gzip" });
  expect(compressRpcPayload(big, "term.history", ["gzip"])).toEqual({ kind: "plain" });
});
