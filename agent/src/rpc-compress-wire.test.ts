import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server";
import type { SecureChannel } from "./secure-channel";
import { decodeServer, encode } from "./protocol";

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

/** 客户端解压镜像：把 rpcZip / 带 enc 的 rpcChunk 还原成原始 response 对象。 */
function decodeReply(frames: Uint8Array[]): any {
  const msgs = frames.map((f) => decodeServer(Buffer.from(f).toString("utf8")));
  if (msgs.length === 1 && msgs[0].type === "rpcZip") {
    const raw = Bun.gunzipSync(Buffer.from((msgs[0] as any).data, "base64"));
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  }
  if (msgs.length === 1 && msgs[0].type === "response") return msgs[0];
  const parts = msgs.map((m) => {
    if (m.type !== "rpcChunk") throw new Error(`expected rpcChunk, got ${m.type}`);
    return { m, bytes: Buffer.from((m as any).data, "base64") };
  });
  const joined = Buffer.concat(parts.map((p) => p.bytes));
  const enc = (parts[0].m as any).enc;
  const raw = enc === "gzip" ? Buffer.from(Bun.gunzipSync(joined)) : joined;
  return JSON.parse(raw.toString("utf8"));
}

test("a large fs.read with acceptEnc arrives as ONE rpcZip frame, content intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-zip-"));
  const file = join(dir, "big.txt");
  const text = "export const value = 42;\n".repeat(3000); // ~72KB，高度可压
  writeFileSync(file, text);
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });

  const frames = rpcFramesWith(srv, "z1", "fs.read", { path: file }, ["gzip"]);
  expect(frames).toHaveLength(1);
  expect(decodeServer(Buffer.from(frames[0]).toString("utf8")).type).toBe("rpcZip");

  const reply = decodeReply(frames);
  expect(reply.ok).toBe(true);
  expect(reply.id).toBe("z1");
  expect(reply.result.content).toBe(text); // 逐字节相同，压缩是纯优化

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
