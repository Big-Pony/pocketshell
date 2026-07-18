import { test, expect, vi } from "vitest";
import { Connection, type WebSocketLike, type Scheduler } from "./connection";
import { encode, decodeClient, type ServerMsg } from "./protocol";
import { toB64 } from "./bytes";

// A fake scheduler with manual clock control.
function fakeScheduler() {
  let seq = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let clock = 0;
  const s: Scheduler & { advance: (ms: number) => void } = {
    setTimeout: (fn, ms) => { const id = seq++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0, clearInterval: () => {},
    now: () => clock,
    advance: (ms) => { clock += ms; for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); } },
  };
  return s;
}

// A passthrough channel: no crypto, established after first receive.
function passthroughChannel() {
  let state: "handshaking" | "transport" = "handshaking";
  return {
    get state() { return state; },
    start() { return new Uint8Array([1]); },
    receive(frame: Uint8Array) {
      if (state === "handshaking") { state = "transport"; return { status: "handshake" as const, established: true }; }
      return { status: "message" as const, plaintext: frame };
    },
    send: (pt: Uint8Array) => pt,
  };
}

function harness() {
  const sched = fakeScheduler();
  let sock: any;
  const sent: Uint8Array[] = [];
  const wsFactory = (): WebSocketLike => {
    sock = { binaryType: "", onopen: null, onmessage: null, onclose: null,
      send: (d: Uint8Array) => sent.push(d), close: () => sock.onclose?.() };
    return sock;
  };
  const conn = new Connection({
    url: "ws://x", wsFactory, scheduler: sched,
    channelFactory: passthroughChannel, getPairing: () => null,
  });
  sock.onopen();                 // start handshake
  sock.onmessage({ data: new Uint8Array([2]).buffer }); // established → online
  const deliver = (msg: ServerMsg) => sock.onmessage({ data: new TextEncoder().encode(encode(msg)).buffer });
  return { conn, sched, sent, deliver, sock };
}

test("rpc resolves with result when response ok arrives", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.tree", { path: "/" });
  // last sent frame is the rpc request; recover its id
  const req = decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1]));
  expect(req.type).toBe("rpc");
  const id = (req as any).id;
  h.deliver({ type: "response", id, ok: true, result: { nodes: [] } } as any);
  await expect(p).resolves.toEqual({ nodes: [] });
});

test("rpc rejects with code on error response", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/x" });
  const id = (decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any).id;
  h.deliver({ type: "response", id, ok: false, error: { code: "enoent", message: "no file" } } as any);
  await expect(p).rejects.toMatchObject({ code: "enoent" });
});

test("rpc rejects with rpc_timeout after 10s", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.tree", { path: "/" });
  const guard = expect(p).rejects.toMatchObject({ code: "rpc_timeout" });
  h.sched.advance(10_000);
  await guard;
});

test("pending rpc rejects on disconnect", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.tree", { path: "/" });
  const guard = expect(p).rejects.toMatchObject({ code: "disconnected" });
  h.sock.onclose();
  await guard;
});

// ──────────────────────────────────────────────────────────────
// WP-6: chunked rpc responses (rpcChunk) are reassembled and delivered
// through the exact same resolve/reject path as a single-frame response
// ──────────────────────────────────────────────────────────────

// Split a full response frame into rpcChunk frames exactly like the agent
// does: JSON-encode, slice the BYTES (UTF-8 safe — reassembly happens on
// bytes before decoding), base64 each slice.
function chunkResponse(msg: ServerMsg & { id: string }, slice: number): ServerMsg[] {
  const raw = new TextEncoder().encode(encode(msg));
  const total = Math.ceil(raw.length / slice);
  const frames: ServerMsg[] = [];
  for (let i = 0; i < total; i++) {
    frames.push({ type: "rpcChunk", id: msg.id, index: i, total, data: toB64(raw.subarray(i * slice, (i + 1) * slice)) });
  }
  return frames;
}

function lastRpcId(h: ReturnType<typeof harness>): string {
  const req = decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1]));
  if (req.type !== "rpc") throw new Error("last sent frame is not an rpc");
  return req.id;
}

test("chunked response resolves rpc with the full result", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/big" });
  const id = lastRpcId(h);
  const result = { content: "x".repeat(1000), lang: "text" };
  const frames = chunkResponse({ type: "response", id, ok: true, result }, 100);
  expect(frames.length).toBeGreaterThan(1);
  for (const f of frames) h.deliver(f);
  await expect(p).resolves.toEqual(result);
});

test("62KB-tier response reassembles end to end (server-shaped 60KB slices)", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/70k" });
  const id = lastRpcId(h);
  const content = "0123456789abcdef".repeat(4375); // 70000 chars → JSON > 62KB fail threshold
  const raw = new TextEncoder().encode(encode({ type: "response", id, ok: true, result: { content } }));
  expect(raw.length).toBeGreaterThan(62 * 1024);
  const frames = chunkResponse({ type: "response", id, ok: true, result: { content } }, 60 * 1024);
  expect(frames.length).toBeGreaterThanOrEqual(2);
  for (const f of frames) h.deliver(f);
  await expect(p).resolves.toEqual({ content });
});

test("512KB-tier response reassembles end to end", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/512k" });
  const id = lastRpcId(h);
  const content = "ab\n".repeat(Math.ceil((512 * 1024) / 3)).slice(0, 512 * 1024); // exactly 512KB of text
  const frames = chunkResponse({ type: "response", id, ok: true, result: { content } }, 60 * 1024);
  expect(frames.length).toBeGreaterThanOrEqual(9);
  for (const f of frames) h.deliver(f);
  const r = (await p) as { content: string };
  expect(r.content.length).toBe(512 * 1024);
  expect(r.content).toBe(content);
});

test("chunked error response rejects with the original code", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/nope" });
  const id = lastRpcId(h);
  const guard = expect(p).rejects.toMatchObject({ code: "eio", message: "disk gone" });
  const frames = chunkResponse({ type: "response", id, ok: false, error: { code: "eio", message: "disk gone" } }, 10);
  expect(frames.length).toBeGreaterThan(1);
  for (const f of frames) h.deliver(f);
  await guard;
});

test("chunks for an unknown id are dropped silently and disturb nothing", async () => {
  const h = harness();
  h.deliver({ type: "rpcChunk", id: "999", index: 0, total: 1, data: toB64(new TextEncoder().encode("{}")) });
  // the connection is unaffected: a real rpc still resolves normally
  const p = h.conn.rpc("fs.tree", { path: "/" });
  const id = lastRpcId(h);
  h.deliver({ type: "response", id, ok: true, result: { nodes: [] } });
  await expect(p).resolves.toEqual({ nodes: [] });
});

test("structurally invalid chunk rejects the rpc immediately (rpc_chunk_invalid)", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/x" });
  const id = lastRpcId(h);
  const guard = expect(p).rejects.toMatchObject({ code: "rpc_chunk_invalid" });
  h.deliver({ type: "rpcChunk", id, index: 0, total: 0, data: "QQ==" }); // total ≤ 0 is illegal
  await guard;
});

test("a missing chunk falls back to the 10s rpc timeout and cleans up", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/x" });
  const id = lastRpcId(h);
  const frames = chunkResponse({ type: "response", id, ok: true, result: { content: "y".repeat(200) } }, 100);
  expect(frames.length).toBeGreaterThanOrEqual(2);
  h.deliver(frames[0]); // first slice arrives, the rest never do
  const guard = expect(p).rejects.toMatchObject({ code: "rpc_timeout" });
  h.sched.advance(10_000);
  await guard;
  h.deliver(frames[frames.length - 1]); // a late slice is dropped silently — pending and buffer are gone
});

test("disconnect mid-chunks rejects with disconnected and drops the buffer", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/x" });
  const id = lastRpcId(h);
  const frames = chunkResponse({ type: "response", id, ok: true, result: { content: "y".repeat(200) } }, 100);
  h.deliver(frames[0]);
  const guard = expect(p).rejects.toMatchObject({ code: "disconnected" });
  h.sock.onclose();
  await guard;
  h.deliver(frames[1]); // late slice after teardown: silently dropped
});

test("interleaved chunks of concurrent rpcs reassemble independently", async () => {
  const h = harness();
  const p1 = h.conn.rpc("fs.read", { path: "/a" });
  const id1 = lastRpcId(h);
  const p2 = h.conn.rpc("fs.read", { path: "/b" });
  const id2 = lastRpcId(h);
  const f1 = chunkResponse({ type: "response", id: id1, ok: true, result: { content: "A".repeat(300) } }, 100);
  const f2 = chunkResponse({ type: "response", id: id2, ok: true, result: { content: "B".repeat(300) } }, 100);
  h.deliver(f1[0]);
  h.deliver(f2[0]);
  for (const f of f2.slice(1)) h.deliver(f); // rpc2 completes first
  await expect(p2).resolves.toEqual({ content: "B".repeat(300) });
  for (const f of f1.slice(1)) h.deliver(f);
  await expect(p1).resolves.toEqual({ content: "A".repeat(300) });
});
