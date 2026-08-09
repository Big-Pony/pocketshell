import { test, expect } from "bun:test";
import { packBinFrame, BIN_FRAME_PREFIX_BYTES } from "./binframe";
import { encodedBytes, chunkRpcPayload, RPC_FIT_SAFE_BYTES } from "./rpc-fit";

// 收益的回归防线。**不看压缩率，看最终上线字节** —— 这条断言会在有人不小心
// 把 base64 加回某条路径时立刻挂，而内容断言看不见那种回退（base64 往返是
// 字节无损的）。
//
// 分路径断言而不是一刀切：fs.downloadChunk 今天走的是 2 个 rpcChunk 帧
// （45KiB 的 payload = 61528 B，超出 RPC_FIT_SAFE_BYTES=61440 整 88 字节），
// 降幅比单帧路径高得多。用统一区间会挂。

const gz = (b: Uint8Array) => Bun.gzipSync(b);

test("rpcZip 单帧：二进制承载相对 base64 承载省 24~26%", () => {
  let s = 0x1234;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  const CH = "abcdefghijklmnopqrstuvwxyz0123456789 \n";
  const text = Array.from({ length: 40000 }, () => CH[rnd() % 38]).join("");
  const payload = JSON.stringify({ type: "response", id: "1", ok: true, result: { content: text } });
  const g = gz(Buffer.from(payload, "utf8"));

  const b64Wire = encodedBytes({ type: "rpcZip", id: "1", data: Buffer.from(g).toString("base64") });
  const binWire = packBinFrame({ type: "rpcZip", id: "1" }, g).length;
  const cut = 1 - binWire / b64Wire;
  expect(cut).toBeGreaterThan(0.24);
  expect(cut).toBeLessThan(0.26);
});

test("fs.downloadChunk：二进制单帧相对今天的 2 个分片帧省 43~45%", () => {
  const buf = Buffer.alloc(45 * 1024);
  for (let i = 0; i < buf.length; i++) buf[i] = i % 256;
  const payload = JSON.stringify({
    type: "response", id: "12", ok: true,
    result: { dataB64: buf.toString("base64"), eof: false, size: 45 * 1024 },
  });
  // 前提：今天这条路径确实走分片（差 88 字节跨过阈值）。前提变了要重算收益。
  expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(RPC_FIT_SAFE_BYTES);
  const todayBytes = chunkRpcPayload("12", payload).reduce((n, c) => n + encodedBytes(c), 0);

  const binWire = packBinFrame(
    { type: "rpcBin", id: "12", result: { eof: false, size: 45 * 1024 } },
    new Uint8Array(buf),
  ).length;
  const cut = 1 - binWire / todayBytes;
  expect(cut).toBeGreaterThan(0.43);
  expect(cut).toBeLessThan(0.45);
});

test("fs.uploadChunk：二进制相对 base64 省 24~26%", () => {
  const buf = Buffer.alloc(45 * 1024, 0x41);
  const b64Wire = Buffer.byteLength(JSON.stringify({
    type: "rpc", id: "1", method: "fs.uploadChunk",
    params: { uploadId: "u-123456", dataB64: buf.toString("base64"), first: false, last: false },
    acceptEnc: ["gzip", "bin"],
  }), "utf8");
  const binWire = packBinFrame({
    type: "rpc", id: "1", method: "fs.uploadChunk",
    params: { uploadId: "u-123456", first: false, last: false },
    acceptEnc: ["gzip", "bin"],
  }, new Uint8Array(buf)).length;
  const cut = 1 - binWire / b64Wire;
  expect(cut).toBeGreaterThan(0.24);
  expect(cut).toBeLessThan(0.26);
});

test("二进制帧的固定开销就是 3 字节前缀 + JSON 头，没有隐藏膨胀", () => {
  const blob = new Uint8Array(1000).fill(7);
  const header = { type: "rpcBin", id: "1", result: { eof: true, size: 1000 } };
  const frame = packBinFrame(header, blob);
  expect(frame.length).toBe(
    BIN_FRAME_PREFIX_BYTES + Buffer.byteLength(JSON.stringify(header), "utf8") + blob.length,
  );
});
