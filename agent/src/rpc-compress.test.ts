import { test, expect } from "bun:test";
import { compressRpcPayload, RPC_COMPRESS_MIN_BYTES } from "./rpc-compress";
import { BIN_FRAME_PREFIX_BYTES } from "./binframe";

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
  const raw = Buffer.from(Bun.gunzipSync(out.data));
  expect(raw.toString("utf8")).toBe(big);
});

test("fs.downloadChunk is skipped by name even when large", () => {
  // 下载分片是已压缩的媒体字节，压不动却要白烧 0.78ms/次；200MB 下载
  // 累计约 3.5 秒同步阻塞，还挤在 4 路并发的同一个事件循环上。
  const big = envelope({ dataB64: Buffer.from("z".repeat(60000)).toString("base64"), eof: false });
  expect(compressRpcPayload(big, "fs.downloadChunk", ["gzip"])).toEqual({ kind: "plain" });
});

// 【二阶段删除】此处原有两条「不可压载荷应被判 plain」的测试。
//
// 它们在 base64 承载时代成立：gzip 对受限字母表文本（ASCII 噪声 90 符号、
// base64 64 符号）只能吃掉字母表冗余，增益不大，而 base64 的 4/3 回膨胀恰好
// 把它抵消，于是判据正确地拒绝。
//
// 二进制承载消掉了那 4/3 之后，这些载荷**真的压得动**（实测 ASCII 噪声省
// 17.5%、randomBytes.base64 省 24.4%），判据判「压」是正确行为。
//
// 更根本的是：**JSON 字符串装不下任意字节**，任何编码（base64/hex/latin1）都会
// 把字母表限制到远低于 8 bit/byte，所以在这一层造不出真正不可压的载荷——
// 拒绝分支在二进制承载下几乎不可达。判据保留是作为安全网（压缩异常、极小
// 载荷、未来新载荷形态），不是因为有已知的常规载荷会走到它。
//
// 若日后要测拒绝分支，得从 compressRpcPayload 之外构造（例如 mock gzip 返回
// 更大的结果），而不是靠挑 fixture。

test("已内层压过的载荷（term.history）在二进制承载下**应当**被二次压缩", () => {
  // 一阶段这条断言是反的（refused a second pass），因为当时 data 走 base64：
  // 外层 gzip 对信封其实很有效（裸字节 -24.5%），但 base64 的 4/3 回膨胀刚好
  // 把增益吃干，净剩 +0.6%，尺寸判据据此拒绝。
  //
  // 二进制承载消掉了那 4/3，外层增益真正生效，判据必须放行。实测真实语料
  // （475KiB 带 ANSI 的 git log/diff，重复率 1.7:1）：inner-only 206245 →
  // inner+outer 155294，省 24.7%。
  //
  // fixture 必须是**高熵**的：早先用 4000 行相同文本，gzip 后只剩 552 字节、
  // 套信封 632 字节，低于 RPC_COMPRESS_MIN_BYTES(8192)，函数在阈值那行就返回
  // plain，压根走不到判据分支——测试假绿。
  let s = 0x9e3779b9;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  const CH = "abcdefghijklmnopqrstuvwxyz0123456789";
  const line = () => "\x1b[32m$\x1b[0m " + Array.from({ length: 40 }, () => CH[rnd() % 36]).join("") + "\n";
  const scrollback = Buffer.from(Array.from({ length: 2000 }, line).join(""));

  const inner = Buffer.from(Bun.gzipSync(scrollback)).toString("base64");
  const big = envelope({ data: inner, seq: 7, enc: "gzip" });

  // 前提：payload 要真的越过阈值，逼函数走到 gzip + 判据比较那一步。
  expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(RPC_COMPRESS_MIN_BYTES);

  const out = compressRpcPayload(big, "term.history", ["gzip"]);
  expect(out.kind).toBe("zip");
  // 且真的更小：解出的字节 + 帧头开销必须低于原 payload。
  if (out.kind === "zip") {
    const wire = BIN_FRAME_PREFIX_BYTES + Buffer.byteLength(JSON.stringify({ type: "rpcZip", id: "1" }), "utf8") + out.data.length;
    expect(wire).toBeLessThan(Buffer.byteLength(big, "utf8"));
  }
});
