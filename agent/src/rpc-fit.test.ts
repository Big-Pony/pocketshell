import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server";
import type { SecureChannel } from "./secure-channel";
import { encode, decodeServer } from "./protocol";
import { TerminalService } from "./terminal";
import { fsDiff } from "./fs-service";
import {
  RPC_FIT_SAFE_BYTES,
  NOISE_MAX_PLAINTEXT_BYTES,
  RPC_CHUNK_PAYLOAD_BYTES,
  RPC_CHUNK_FRAME_MAX_BYTES,
  encodedBytes,
  chunkRpcPayload,
} from "./rpc-fit";

const M1 = new Uint8Array([1]);
const M2 = new Uint8Array([2]);
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const ok = (s = "") => ({ exitCode: 0, stdout: utf8(s), stderr: new Uint8Array() });

// passthrough responder: no crypto, frames pass as-is after a marker handshake
// (same stub as server.test.ts — a sent frame is the raw response JSON, so its
// byte length is exactly what the cipher would have to carry).
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

// Run one rpc through a passthrough-secured conn; returns ALL response frames
// (one `response` frame on the fast path, N `rpcChunk` frames when chunked).
function rpcFrames(srv: ReturnType<typeof startServer>, id: string, method: string, params: unknown): Uint8Array[] {
  const ws = fakeWs();
  srv.__test.open(ws as any);
  srv.__test.message(ws as any, M1); // marker handshake -> ready
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "rpc", id, method, params })));
  if (ws.sent.length === 0) throw new Error("no response frame");
  return ws.sent;
}

// Client-side reassembly mirror: every frame must be an rpcChunk with
// consecutive indexes and a constant total; the original response is the
// JSON.parse of the concatenated shard BYTES (not strings).
function reassemble(frames: Uint8Array[]): any {
  const chunks = frames.map((f) => {
    const msg = decodeServer(Buffer.from(f).toString("utf8"));
    if (msg.type !== "rpcChunk") throw new Error(`expected rpcChunk, got ${msg.type}`);
    return msg;
  });
  chunks.forEach((c, i) => {
    expect(c.index).toBe(i);
    expect(c.total).toBe(chunks.length);
  });
  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c.data, "base64")));
  return JSON.parse(bytes.toString("utf8"));
}

test("safe budget leaves headroom under the Noise plaintext cap", () => {
  expect(RPC_FIT_SAFE_BYTES).toBe(60 * 1024);
  expect(NOISE_MAX_PLAINTEXT_BYTES - RPC_FIT_SAFE_BYTES).toBeGreaterThan(1024);
});

test("chunk sizing keeps a worst-case rpcChunk frame under the plaintext ceiling", () => {
  expect(RPC_CHUNK_PAYLOAD_BYTES).toBe(43 * 1024);
  expect(RPC_CHUNK_FRAME_MAX_BYTES).toBe(60_000);
  // Worst case: full-size shard, 64-char id, 5-digit index/total.
  const worst = {
    type: "rpcChunk" as const,
    id: "i".repeat(64),
    index: 99999,
    total: 99999,
    data: Buffer.alloc(RPC_CHUNK_PAYLOAD_BYTES).toString("base64"),
  };
  const size = encodedBytes(worst);
  expect(size).toBeLessThanOrEqual(RPC_CHUNK_FRAME_MAX_BYTES);
  expect(size).toBeLessThanOrEqual(NOISE_MAX_PLAINTEXT_BYTES);
  // ...with real headroom, not a knife-edge (measured: ~1.1KB slack).
  expect(RPC_CHUNK_FRAME_MAX_BYTES - size).toBeGreaterThan(1024);
});

test("chunkRpcPayload slices payload bytes into ordered shards that reassemble byte-for-byte", () => {
  const payloadOf = (n: number) => "x".repeat(n);

  // exact multiple of the slice size -> all shards full
  let chunks = chunkRpcPayload("c1", payloadOf(RPC_CHUNK_PAYLOAD_BYTES * 3));
  expect(chunks).toHaveLength(3);
  for (const c of chunks) expect(Buffer.from(c.data, "base64").length).toBe(RPC_CHUNK_PAYLOAD_BYTES);

  // one byte over -> a 1-byte tail shard
  chunks = chunkRpcPayload("c2", payloadOf(RPC_CHUNK_PAYLOAD_BYTES * 3 + 1));
  expect(chunks).toHaveLength(4);
  expect(Buffer.from(chunks[3].data, "base64").length).toBe(1);

  // index/total bookkeeping + byte-exact reassembly, on a payload whose slice
  // boundaries land mid-CJK-character (3 bytes each): the cut is byte-level
  // and reassembly concatenates bytes before parsing, so nothing corrupts.
  const cjk = JSON.stringify({ content: "中".repeat(50000), tail: "😀".repeat(1000) });
  chunks = chunkRpcPayload("c3", cjk);
  expect(chunks.length).toBeGreaterThan(1);
  chunks.forEach((c, i) => {
    expect(c.index).toBe(i);
    expect(c.total).toBe(chunks.length);
    expect(c.id).toBe("c3");
    expect(encodedBytes(c)).toBeLessThanOrEqual(RPC_CHUNK_FRAME_MAX_BYTES);
  });
  const joined = Buffer.concat(chunks.map((c) => Buffer.from(c.data, "base64")));
  expect(joined.equals(Buffer.from(cjk, "utf8"))).toBe(true); // byte-for-byte
  expect(JSON.parse(joined.toString("utf8"))).toEqual(JSON.parse(cjk));
});

// Fake tmux whose capture-pane honours -S: full = `total` lines of ~100B,
// -S -N = last N+24 lines, -S 0 = the 24 visible lines.
function bigScrollbackTmux(total: number, calls?: string[][]) {
  const line = "l".repeat(100) + "\n";
  return (args: string[]) => {
    calls?.push(args);
    if (args.includes("capture-pane")) {
      const s = args[args.indexOf("-S") + 1];
      const lines = s === "-" ? total : s === "0" ? 24 : Math.min(parseInt(s.slice(1), 10) + 24, total);
      return ok(line.repeat(lines));
    }
    return ok();
  };
}

test("history() keeps a small scrollback to a single full-window capture", () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => { calls.push(args); return args.includes("capture-pane") ? ok("line1\nline2\n") : ok(); },
  });
  const r = term.history("work");
  term.dispose();
  expect(Buffer.from(r.data, "base64").toString("utf8")).toBe("line1\nline2\n");
  const caps = calls.filter((a) => a.includes("capture-pane"));
  expect(caps).toHaveLength(1);
  expect(caps[0]).toEqual(["-u", "capture-pane", "-e", "-p", "-J", "-S", "-", "-E", "-", "-t", "work"]);
});

test("history() returns the full oversize scrollback in ONE capture (rpc chunking carries the size)", () => {
  const calls: string[][] = [];
  const term = new TerminalService({ tmux: bigScrollbackTmux(2000, calls) });
  const r = term.history("work");
  term.dispose();
  // WP-1's halving retries are gone: a single -S - capture, all 2000 lines.
  const caps = calls.filter((a) => a.includes("capture-pane"));
  expect(caps).toHaveLength(1);
  expect(caps[0]).toEqual(["-u", "capture-pane", "-e", "-p", "-J", "-S", "-", "-E", "-", "-t", "work"]);
  const data = Buffer.from(r.data, "base64").toString("utf8");
  expect(data).toBe(("l".repeat(100) + "\n").repeat(2000));
});

test("rpc fs.read of a 70KB file is chunked into rpcChunk frames reassembling to the COMPLETE response", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-chunk-"));
  const file = join(dir, "big.txt");
  // ~84KB with CJK mixed in, so shard boundaries land in multi-byte territory
  const text = ("中".repeat(100) + "a".repeat(900) + "\n").repeat(70);
  writeFileSync(file, text);
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const frames = rpcFrames(srv, "big1", "fs.read", { path: file });
  expect(frames.length).toBeGreaterThan(1); // chunked, not one frame
  for (const f of frames) expect(f.length).toBeLessThanOrEqual(RPC_CHUNK_FRAME_MAX_BYTES);
  const reply = reassemble(frames);
  expect(reply.type).toBe("response");
  expect(reply.ok).toBe(true); // no rpc_error
  expect(reply.id).toBe("big1");
  expect(reply.result.content).toBe(text); // complete, untruncated
  expect(reply.result.lang).toBe("plaintext");
  expect("truncated" in reply.result).toBe(false);
  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("rpc fs.read fast-path boundary: exactly SAFE bytes = one frame, SAFE+1 = chunked", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-chunk-edge-"));
  const file = join(dir, "edge.txt");
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  // Measure the constant envelope overhead with the same id + path: a 10-byte
  // ASCII content (no JSON escapes) gives size = overhead + 10.
  writeFileSync(file, "a".repeat(10));
  const probe = rpcFrames(srv, "edge", "fs.read", { path: file });
  expect(probe).toHaveLength(1);
  const overhead = probe[0].length - 10;

  // exactly at the budget -> single-frame fast path, frame exactly SAFE bytes
  writeFileSync(file, "a".repeat(RPC_FIT_SAFE_BYTES - overhead));
  const at = rpcFrames(srv, "edge", "fs.read", { path: file });
  expect(at).toHaveLength(1);
  expect(at[0].length).toBe(RPC_FIT_SAFE_BYTES);
  const atMsg = decodeServer(Buffer.from(at[0]).toString("utf8"));
  expect(atMsg.type).toBe("response"); // a plain response, not an rpcChunk

  // one byte over -> chunked (2 shards: 43KiB + tail)
  writeFileSync(file, "a".repeat(RPC_FIT_SAFE_BYTES - overhead + 1));
  const over = rpcFrames(srv, "edge", "fs.read", { path: file });
  expect(over).toHaveLength(2);
  const reply = reassemble(over);
  expect(reply.ok).toBe(true);
  expect(reply.result.content).toBe("a".repeat(RPC_FIT_SAFE_BYTES - overhead + 1));
  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("rpc fs.read of a small file is untouched (fast path: one frame, no rpcChunk)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-chunk-small-"));
  const file = join(dir, "small.txt");
  writeFileSync(file, "hello\n");
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const frames = rpcFrames(srv, "s1", "fs.read", { path: file });
  expect(frames).toHaveLength(1);
  const reply = decodeServer(Buffer.from(frames[0]).toString("utf8"));
  if (reply.type !== "response" || !reply.ok) throw new Error("expected ok response");
  const r = reply.result as any;
  expect(r.content).toBe("hello\n");
  expect(r.truncated).toBeUndefined();
  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("rpc fs.diff of a large diff delivers ALL hunks via chunking (no truncation)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-chunk-diff-"));
  const file = join(dir, "f.txt");
  const lines = Array.from({ length: 2400 }, (_, i) => `line-${i}`);
  writeFileSync(file, lines.join("\n") + "\n");
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]);
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "T"]);
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  // scatter 300 small changes >6 lines apart -> ~300 separate hunks (~100KB)
  writeFileSync(file, lines.map((l, i) => (i % 8 === 0 ? l + "-mod" : l)).join("\n") + "\n");
  const full = fsDiff(file, dir); // ground truth, computed off the wire
  expect(encodedBytes({ type: "response", id: "d1", ok: true, result: full })).toBeGreaterThan(RPC_FIT_SAFE_BYTES);
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const frames = rpcFrames(srv, "d1", "fs.diff", { path: file, cwd: dir });
  expect(frames.length).toBeGreaterThan(1);
  for (const f of frames) expect(f.length).toBeLessThanOrEqual(RPC_CHUNK_FRAME_MAX_BYTES);
  const reply = reassemble(frames);
  expect(reply.ok).toBe(true);
  expect(reply.result).toEqual(full); // every hunk, no truncated flag
  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("rpc term.history with an oversize scrollback arrives COMPLETE via rpcChunk", () => {
  const terminal = new TerminalService({ tmux: bigScrollbackTmux(2000) });
  const srv = startServer({ port: 0, channelFactory: passthroughResponder, terminal });
  const frames = rpcFrames(srv, "h1", "term.history", { session: "work" });
  expect(frames.length).toBeGreaterThan(1); // ~270KB payload -> several shards
  for (const f of frames) expect(f.length).toBeLessThanOrEqual(RPC_CHUNK_FRAME_MAX_BYTES);
  const reply = reassemble(frames);
  expect(reply.ok).toBe(true);
  // the full 2000-line scrollback, not a halved prefix
  expect(Buffer.from(reply.result.data, "base64").toString("utf8")).toBe(("l".repeat(100) + "\n").repeat(2000));
  srv.stop();
});

test("rpc error replies stay single-frame (ok:false, never chunked)", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const frames = rpcFrames(srv, "e1", "fs.read", { path: "/no/such/file" });
  expect(frames).toHaveLength(1);
  const reply = decodeServer(Buffer.from(frames[0]).toString("utf8"));
  if (reply.type !== "response" || reply.ok) throw new Error("expected error response");
  expect(reply.id).toBe("e1");
  expect(reply.error.code).toBe("rpc_error");
  srv.stop();
});
