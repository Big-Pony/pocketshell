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

test("I1: non-array acceptEnc falls back to plain instead of throwing", () => {
  // acceptEnc 是外部协议输入，decodeClient 是裸 JSON.parse，不做类型校验。
  // `acceptEnc?.includes("gzip")` 在非数组值上会直接抛 TypeError，炸穿整条
  // rpc；字符串更阴险——"gzip".includes 恰好存在，会被误判成"客户端接受gzip"。
  const big = envelope({ content: "hello world ".repeat(5000) });
  // number/object 在旧实现下会抛 TypeError，rpc 整条失败
  expect(() => compressRpcPayload(big, "fs.read", 5 as unknown as string[])).not.toThrow();
  expect(compressRpcPayload(big, "fs.read", 5 as unknown as string[])).toEqual({ kind: "plain" });
  expect(() => compressRpcPayload(big, "fs.read", {} as unknown as string[])).not.toThrow();
  expect(compressRpcPayload(big, "fs.read", {} as unknown as string[])).toEqual({ kind: "plain" });
  // 字符串 "gzip" 在旧实现下会被 .includes 误判为已声明支持，被收紧后必须拒绝
  expect(compressRpcPayload(big, "fs.read", "gzip" as unknown as string[])).toEqual({ kind: "plain" });
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
  // 净剩 +0.6%，所以被尺寸判据拒绝。
  //
  // 判据必须比【最终上线字节】。若改成比 gzip 的裸字节，这条会翻转成
  // "该压"，term.history 就会被白白压两遍。
  //
  // fixture 必须是**高熵**的：早先用 4000 行相同文本，gzip 后只剩 552 字节、
  // 套信封 632 字节，低于 RPC_COMPRESS_MIN_BYTES(8192)，函数在阈值那行就返回
  // plain，压根走不到判据分支——测试假绿。同样的坑在 rpc-fit.test.ts 发生过
  // 一次（见那里 noisyScrollbackTmux 的注释）。
  let s = 0x9e3779b9;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  const CH = "abcdefghijklmnopqrstuvwxyz0123456789";
  const line = () => "\x1b[32m$\x1b[0m " + Array.from({ length: 40 }, () => CH[rnd() % 36]).join("") + "\n";
  const scrollback = Buffer.from(Array.from({ length: 2000 }, line).join(""));

  const inner = Buffer.from(Bun.gzipSync(scrollback)).toString("base64");
  const big = envelope({ data: inner, seq: 7, enc: "gzip" });

  // 前提必须成立，否则这条测试又会变成假绿：payload 要真的越过阈值，
  // 逼函数走到 gzip + encodedBytes 比较那一步。
  expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(RPC_COMPRESS_MIN_BYTES);

  expect(compressRpcPayload(big, "term.history", ["gzip"])).toEqual({ kind: "plain" });
});
