import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { startServer } from "./server";
import type { SecureChannel } from "./secure-channel";
import { decodeServer, encode } from "./protocol";
import { unpackBinFrame } from "./binframe";

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const M1 = new Uint8Array([1]);
const M2 = new Uint8Array([2]);

// passthrough responder: no crypto, frames pass as-is after a marker handshake
// (照抄 rpc-fit.test.ts 顶部的同名实现——若那边有变化，以那边为准，不在这里维护第二份).
function passthroughResponder(): SecureChannel {
  let state: SecureChannel["state"] = "handshaking";
  return {
    get state() { return state; },
    start() { return null; },
    receive(frame) {
      if (state === "handshaking") { state = "transport"; return { status: "handshake", reply: M2, established: true }; }
      return { status: "message", plaintext: frame };
    },
    send(pt) { return pt; },
  };
}

function fakeWs() {
  const sent: Uint8Array[] = [];
  return { sent, send(d: Uint8Array | string) { sent.push(typeof d === "string" ? utf8(d) : d); }, close() {} };
}

function rpcFramesWith(
  srv: ReturnType<typeof startServer>, id: string, method: string,
  params: unknown, acceptEnc?: string[],
): Uint8Array[] {
  const ws = fakeWs();
  srv.__test.open(ws as any);
  srv.__test.message(ws as any, M1);
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "rpc", id, method, params, acceptEnc } as any)));
  if (ws.sent.length === 0) throw new Error("no response frame");
  return ws.sent;
}

/** 解一个二进制帧回复：返回 {header, blob}[]。非二进制帧（任意一帧解不出）返回 null。 */
function decodeBinReply(frames: Uint8Array[]): { header: any; blob: Uint8Array }[] | null {
  const out: { header: any; blob: Uint8Array }[] = [];
  for (const f of frames) {
    const r = unpackBinFrame(f);
    if (!r) return null;
    out.push({ header: r.header as any, blob: r.blob });
  }
  return out;
}

/** 客户端解压镜像：把 rpcZip / 带 enc 的 rpcChunk 还原成原始 response 对象。 */
function decodeReply(frames: Uint8Array[]): any {
  // 二进制帧优先（二阶段后 rpcZip/rpcChunk 都走这条）；JSON 帧是老路径。
  const bins = frames.map((f) => unpackBinFrame(f));
  if (bins.every((b) => b !== null)) {
    const heads = bins.map((b) => b!.header as any);
    if (heads.length === 1 && heads[0].type === "rpcZip") {
      return JSON.parse(gunzipSync(Buffer.from(bins[0]!.blob)).toString("utf8"));
    }
    const joined = Buffer.concat(bins.map((b) => Buffer.from(b!.blob)));
    const raw = heads[0].enc === "gzip" ? gunzipSync(joined) : joined;
    return JSON.parse(raw.toString("utf8"));
  }
  const msgs = frames.map((f) => decodeServer(Buffer.from(f).toString("utf8")));
  if (msgs.length === 1 && msgs[0].type === "response") return msgs[0];
  const parts = msgs.map((m) => {
    if (m.type !== "rpcChunk") throw new Error(`expected rpcChunk, got ${m.type}`);
    return { m, bytes: Buffer.from((m as any).data, "base64") };
  });
  const joined = Buffer.concat(parts.map((p) => p.bytes));
  const enc = (parts[0].m as any).enc;
  const raw = enc === "gzip" ? gunzipSync(joined) : joined;
  return JSON.parse(raw.toString("utf8"));
}

test("大 fs.read 只带 acceptEnc:['gzip']（不含 'bin'——真实 v1.16.0 客户端的形状）时，rpcZip 走 JSON 帧而非二进制帧", () => {
  // 回归用例：wantsBin 门只看 acceptEnc 是否含 "bin"，跟载荷压没压是两码事。
  // v1.16.0 客户端只发 acceptEnc:["gzip"]，它的 onmessage 末尾是无条件
  // TextDecoder().decode() 回 dispatch，没有首字节嗅探——撞上 0x00 开头的
  // 二进制帧会 decodeServer 抛、丢帧、rpc 挂到 10 秒超时（term.history 每次
  // 挂载终端都会跑），等于老客户端被新 agent 砖化而不是降级。
  const dir = mkdtempSync(join(tmpdir(), "ps-zip-"));
  const file = join(dir, "big.txt");
  const text = "export const value = 42;\n".repeat(3000); // ~72KB，高度可压
  writeFileSync(file, text);
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });

  const frames = rpcFramesWith(srv, "z1", "fs.read", { path: file }, ["gzip"]);
  expect(frames).toHaveLength(1);
  // 首字节必须是 '{'：一个二进制帧都不许发给没声明 "bin" 的客户端。
  expect(frames[0][0]).toBe(0x7b);
  expect(decodeBinReply(frames)).toBeNull();

  const msg = decodeServer(Buffer.from(frames[0]).toString("utf8")) as any;
  expect(msg.type).toBe("rpcZip");
  const inner = JSON.parse(gunzipSync(Buffer.from(msg.data, "base64")).toString("utf8"));
  expect(inner.ok).toBe(true);
  expect(inner.id).toBe("z1");
  expect(inner.result.content).toBe(text); // 逐字节相同，压缩是纯优化

  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("PROTECTION: the same request WITHOUT acceptEnc is never compressed", () => {
  // 这是整套改动里最重要的一条守卫：老客户端（PWA 缓存里的旧 app）不发
  // acceptEnc，新 agent 必须给它发原样的 response/rpcChunk。这条挂了 =
  // 升级 agent 后老客户端直接失联。
  const dir = mkdtempSync(join(tmpdir(), "ps-zip-old-"));
  const file = join(dir, "big.txt");
  writeFileSync(file, "export const value = 42;\n".repeat(3000));
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });

  const frames = rpcFramesWith(srv, "old1", "fs.read", { path: file }); // 不带 acceptEnc
  const types = new Set(frames.map((f) => decodeServer(Buffer.from(f).toString("utf8")).type));
  expect(types.has("rpcZip")).toBe(false);
  for (const f of frames) {
    const m = decodeServer(Buffer.from(f).toString("utf8")) as any;
    if (m.type === "rpcChunk") expect(m.enc).toBeUndefined();
  }

  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("PROTECTION: a small response stays a plain single `response` frame", () => {
  // 挡的是"顺手把所有响应都压了"的退化：8KB 以下必须走原同步快路径。
  const dir = mkdtempSync(join(tmpdir(), "ps-zip-small-"));
  const file = join(dir, "small.txt");
  writeFileSync(file, "hi");
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });

  const frames = rpcFramesWith(srv, "s1", "fs.read", { path: file }, ["gzip"]);
  expect(frames).toHaveLength(1);
  expect(decodeServer(Buffer.from(frames[0]).toString("utf8")).type).toBe("response");

  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("大 fs.read 带 acceptEnc:['gzip','bin'] 时走二进制 rpcZip 帧，内容完好", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-bin-"));
  const file = join(dir, "big.txt");
  // 高熵内容：低熵会被压到阈值以下，函数在阈值那行就短路，测不到压缩分支。
  // 行数（1400）经实测校准：3000 行的高熵文本 gzip 后 122232B，远超单帧预算
  // 61440B，会走 rpcChunk 分片而非本用例要测的单帧 rpcZip 路径；1400 行 gzip
  // 后 57064B，落在阈值内且留有余量。
  let s = 0x12345678;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  const CH = "abcdefghijklmnopqrstuvwxyz0123456789 ";
  const text = Array.from({ length: 1400 }, () =>
    Array.from({ length: 60 }, () => CH[rnd() % 37]).join("")).join("\n");
  writeFileSync(file, text);
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });

  const frames = rpcFramesWith(srv, "zb1", "fs.read", { path: file }, ["gzip", "bin"]);
  const bins = decodeBinReply(frames);
  expect(bins).not.toBeNull();
  expect(bins!.length).toBe(1);
  expect(bins![0].header.type).toBe("rpcZip");
  // blob 是 gzip 字节，解开后就是原样的 response JSON 文本
  const inner = JSON.parse(gunzipSync(Buffer.from(bins![0].blob)).toString("utf8"));
  expect(inner.type).toBe("response");
  expect(inner.ok).toBe(true);
  expect(inner.result.content).toBe(text);

  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("fs.downloadChunk 走 rpcBin 单帧，blob 逐字节等于文件内容", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-dlbin-"));
  const file = join(dir, "f.bin");
  // 含非法 UTF-8：任何 toString("utf8") 往返都会毁掉它们。
  const content = Buffer.concat([
    Buffer.from([0xed, 0xa0, 0x80, 0x80, 0xff, 0xfe]),
    Buffer.alloc(10000, 0x41),
  ]);
  writeFileSync(file, content);
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });

  const frames = rpcFramesWith(srv, "db1", "fs.downloadChunk", { path: file, offset: 0, len: 65536 }, ["gzip", "bin"]);
  const bins = decodeBinReply(frames);
  expect(bins).not.toBeNull();
  expect(bins!.length).toBe(1);
  expect(bins![0].header.type).toBe("rpcBin");
  expect(bins![0].header.result.eof).toBe(true);
  expect(bins![0].header.result.size).toBe(content.length);
  expect(Array.from(bins![0].blob)).toEqual(Array.from(content));

  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("rpcBin 超单帧预算时回落到分片，不是抛异常", () => {
  // fsDownloadChunk 的 len 完全来自线上参数、服务端不校验上限。今天靠
  // chunkRpcPayload 自动切片兜住；rpcBin 撤掉了那张网，必须自己判。
  // 不判的话：单帧明文 204868 B > Noise 65519 上限 → cipher.js 抛 → 退化成
  // 一个与原因毫无关系的 rpc_error，一条本能工作的下载路径永久失败。
  const dir = mkdtempSync(join(tmpdir(), "ps-dlbig-"));
  const file = join(dir, "big.bin");
  writeFileSync(file, Buffer.alloc(200 * 1024, 0x5a));
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });

  const frames = rpcFramesWith(srv, "db2", "fs.downloadChunk", { path: file, offset: 0, len: 200 * 1024 }, ["gzip", "bin"]);
  // 每一帧的明文都不得超过 Noise 上限
  for (const f of frames) expect(f.length).toBeLessThanOrEqual(65519);
  expect(frames.length).toBeGreaterThan(1);

  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("老客户端（acceptEnc 不含 'bin'）仍收到纯 JSON 帧", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-old-"));
  const file = join(dir, "f.bin");
  writeFileSync(file, Buffer.alloc(1000, 0x41));
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });

  const frames = rpcFramesWith(srv, "db3", "fs.downloadChunk", { path: file, offset: 0, len: 65536 }, ["gzip"]);
  // 首字节必须是 '{' —— 一个二进制帧都不许发给没声明 bin 的客户端
  for (const f of frames) expect(f[0]).toBe(0x7b);

  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});
