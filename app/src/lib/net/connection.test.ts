import { test, expect, vi, describe, it } from "vitest";
import { Connection, rpcDeadlineMs, RPC_BASE_TIMEOUT_MS, RPC_MAX_TIMEOUT_MS, type WebSocketLike, type Scheduler } from "./connection";
import { encode, decodeClient, type ServerMsg, type SessionMeta } from "./protocol";
import { toB64 } from "../bytes";
import type { SecureChannel } from "./secure-channel";
import { applyPairing, getPendingPair } from "./keystore";

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

// ──────────────────────────────────────────────────────────────
// Bandwidth-aware rpc deadline. The fixed 10s timer was a deadline on a
// QUEUE the caller does not control: uploadChunksWindowed keeps 4 chunks of
// ~60KB wire bytes in flight, so chunk #4's timer starts while chunks #1-3
// still occupy the uplink. Below ~200kbps that is unmeetable and a healthy
// upload dies at a few hundred KB. The deadline now grows with the bytes
// queued ahead of the call, so a slow link stretches the budget instead of
// failing; a dead agent is still caught because the budget is finite.
// ──────────────────────────────────────────────────────────────

test("rpcDeadlineMs: base for small payloads, grows with queue, hard-capped", () => {
  expect(rpcDeadlineMs(0)).toBe(RPC_BASE_TIMEOUT_MS);
  expect(rpcDeadlineMs(1_000)).toBe(RPC_BASE_TIMEOUT_MS);   // covered by the base
  // A full 4×60KB upload window queued ahead must buy well beyond the base.
  expect(rpcDeadlineMs(4 * 60_000)).toBeGreaterThan(RPC_BASE_TIMEOUT_MS * 2);
  expect(rpcDeadlineMs(Number.MAX_SAFE_INTEGER)).toBe(RPC_MAX_TIMEOUT_MS);
});

test("chunks queued behind a full upload window survive past 10s", async () => {
  const h = harness();
  // The real upload window: 4 chunks of ~60KB issued back-to-back. Chunk #1 is
  // at the head of the queue and legitimately keeps the base deadline; #2-#4
  // are the ones the old fixed timer killed while they waited their turn.
  const ps = Array.from({ length: 4 }, () => h.conn.rpc("fs.uploadChunk", { dataB64: "x".repeat(60_000) }));
  const outcomes = ps.map((p) => p.then(() => "ok", (e) => e.code));
  h.deliver({ type: "response", id: "1", ok: true, result: { written: 1 } } as any);
  // Well past the old deadline — the slow uplink is still draining chunk #1.
  h.sched.advance(15_000);
  for (let i = 1; i < 4; i++) {
    h.deliver({ type: "response", id: String(i + 1), ok: true, result: { written: 1 } } as any);
  }
  await expect(Promise.all(outcomes)).resolves.toEqual(["ok", "ok", "ok", "ok"]);
});

test("a small rpc keeps the 10s base deadline", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.tree", { path: "/" });
  const guard = expect(p).rejects.toMatchObject({ code: "rpc_timeout" });
  h.sched.advance(10_000);
  await guard;
});

test("the deadline is finite even for a huge queue (dead agent still detected)", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.uploadChunk", { dataB64: "x".repeat(60_000) });
  const guard = expect(p).rejects.toMatchObject({ code: "rpc_timeout" });
  h.sched.advance(10 * 60_000); // 10 minutes: nothing may hang forever
  await guard;
});

test("queued bytes are released once an rpc settles, so later rpcs are not over-budgeted", async () => {
  const h = harness();
  const big = h.conn.rpc("fs.uploadChunk", { dataB64: "x".repeat(60_000) });
  h.deliver({ type: "response", id: "1", ok: true, result: {} } as any);
  await expect(big).resolves.toEqual({});
  // With the queue drained, a small rpc is back to the base deadline.
  const small = h.conn.rpc("fs.tree", { path: "/" });
  const guard = expect(small).rejects.toMatchObject({ code: "rpc_timeout" });
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

// ---- 链路指标（分割条：延迟 + 吞吐）----
// 上面的 fakeScheduler 把 setInterval 打桩成空实现（心跳不参与那些用例）。
// 指标是按心跳周期结算的，所以这里换一个能真正跑 interval 的调度器。
function metricsHarness(heartbeatMs = 1000) {
  let seq = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const intervals = new Map<number, { fn: () => void; every: number; next: number }>();
  let clock = 0;
  const sched: Scheduler & { advance: (ms: number) => void } = {
    setTimeout: (fn, ms) => { const id = seq++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, every) => { const id = seq++; intervals.set(id, { fn, every, next: clock + every }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    now: () => clock,
    advance: (ms) => {
      const target = clock + ms;
      // 逐个 tick 推进，让 interval 在正确的时刻触发（而不是一次跳到终点）
      for (;;) {
        let nextAt = target;
        for (const t of timers.values()) if (t.at <= target && t.at < nextAt) nextAt = t.at;
        for (const iv of intervals.values()) if (iv.next <= target && iv.next < nextAt) nextAt = iv.next;
        if (nextAt >= target) break;
        clock = nextAt;
        for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); }
        for (const iv of intervals.values()) if (iv.next <= clock) { iv.next = clock + iv.every; iv.fn(); }
      }
      clock = target;
      for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); }
      for (const iv of intervals.values()) if (iv.next <= clock) { iv.next = clock + iv.every; iv.fn(); }
    },
  };
  let sock: any;
  const sent: Uint8Array[] = [];
  const wsFactory = (): WebSocketLike => {
    sock = { binaryType: "", onopen: null, onmessage: null, onclose: null,
      send: (d: Uint8Array) => sent.push(d), close: () => sock.onclose?.() };
    return sock;
  };
  const conn = new Connection({
    url: "ws://x", wsFactory, scheduler: sched, heartbeatMs, livenessMs: 60_000,
    channelFactory: passthroughChannel, getPairing: () => null,
  });
  sock.onopen();
  sock.onmessage({ data: new Uint8Array([2]).buffer });
  const samples: any[] = [];
  conn.onMetrics((m) => samples.push(m));
  const deliver = (msg: ServerMsg) => sock.onmessage({ data: new TextEncoder().encode(encode(msg)).buffer });
  // 送一个恰好 n 字节的**合法**帧：吞吐记的是链路字节数，与内容无关，但用垃圾
  // 字节会让 dispatch 打一堆 "dropped malformed frame"，把真实告警淹掉。
  // 用 output 帧撑长度，剩余空间用 data 的 base64 载荷补齐。
  const deliverBytes = (n: number) => {
    const base = encode({ type: "output", sessionId: "s", seq: 1, data: "" } as ServerMsg).length;
    // data 会被 atob 解码，长度必须是 4 的倍数，否则抛 InvalidCharacterError
    const padB64 = Math.max(0, Math.round((n - base) / 4) * 4);
    const frame = encode({ type: "output", sessionId: "s", seq: 1, data: "A".repeat(padB64) } as ServerMsg);
    sock.onmessage({ data: new TextEncoder().encode(frame).buffer });
    return frame.length;
  };
  return { conn, sched, sent, samples, deliver, deliverBytes, sock };
}

test("ping→pong records the round-trip time", () => {
  const h = metricsHarness(1000);
  h.sched.advance(1000);           // heartbeat fires → ping sent, ts recorded
  h.sched.advance(42);             // 42ms on the wire
  h.deliver({ type: "pong" });
  h.sched.advance(958);            // next heartbeat settles the window
  expect(h.samples[h.samples.length - 1].latency).toBe(42);
});

test("a pong arriving after the next ping is discarded, not shown as a tiny RTT", () => {
  const h = metricsHarness(1000);
  h.sched.advance(1000);           // ping #1 — no pong comes back
  h.sched.advance(1000);           // ping #2 — now 2 outstanding
  h.sched.advance(5);
  h.deliver({ type: "pong" });     // ambiguous: cannot tell if this is #1's or #2's
  h.sched.advance(995);
  // 5ms is the wrong answer — it is "time since ping #2", not a round trip.
  // With 2 pings in flight the sample is unattributable, so nothing is recorded.
  expect(h.samples[h.samples.length - 1].latency).toBe(null);
});

test("after an ambiguous pong the next clean exchange records a real RTT again", () => {
  const h = metricsHarness(1000);
  h.sched.advance(1000);           // ping #1, no reply
  h.sched.advance(1000);           // ping #2
  h.deliver({ type: "pong" });     // ambiguous → discarded, one ping still outstanding
  h.deliver({ type: "pong" });     // clears the backlog
  h.sched.advance(1000);           // ping #3, now the only one in flight
  h.sched.advance(17);
  h.deliver({ type: "pong" });
  h.sched.advance(983);
  expect(h.samples[h.samples.length - 1].latency).toBe(17);
});

test("two heartbeats with no pong clears the latency instead of showing a stale one", () => {
  const h = metricsHarness(1000);
  h.sched.advance(1000);
  h.sched.advance(30);
  h.deliver({ type: "pong" });     // one good sample
  h.sched.advance(970);
  expect(h.samples[h.samples.length - 1].latency).toBe(30);
  h.sched.advance(1000);           // miss #1 — still showing 30ms
  h.sched.advance(1000);           // miss #2 — cleared
  expect(h.samples[h.samples.length - 1].latency).toBe(null);
});

test("received bytes accumulate and settle per heartbeat window", () => {
  const h = metricsHarness(1000);
  h.sched.advance(1000);           // drain the connect-time frames into window #1
  const before = h.samples.length;
  const a = h.deliverBytes(4096);
  const b = h.deliverBytes(2048);
  h.sched.advance(1000);
  const m = h.samples[h.samples.length - 1];
  expect(h.samples.length).toBe(before + 1);
  expect(m.rxBytes).toBe(a + b);
  expect(m.elapsedMs).toBe(1000);
});

test("sent bytes are accounted too (upstream kept for later use)", () => {
  const h = metricsHarness(1000);
  h.sched.advance(1000);           // window #1 settles; this heartbeat's ping lands in window #2
  const before = h.samples.length;
  h.conn.newSession("x", {});
  h.sched.advance(1000);
  expect(h.samples[h.samples.length - 1].txBytes).toBeGreaterThan(0);
  expect(h.samples.length).toBe(before + 1);
});

test("byte counters reset each window rather than accumulating forever", () => {
  const h = metricsHarness(1000);
  h.deliverBytes(1024);
  h.sched.advance(1000);
  h.sched.advance(1000);           // a second window with no traffic
  expect(h.samples[h.samples.length - 1].rxBytes).toBe(0);
});

test("disconnect blanks latency and throughput right away", () => {
  const h = metricsHarness(1000);
  h.sched.advance(1000);
  h.sched.advance(20);
  h.deliver({ type: "pong" });
  h.deliverBytes(2048);
  h.sock.onclose();
  const m = h.samples[h.samples.length - 1];
  expect(m.latency).toBe(null);
  expect(m.rxBytes).toBe(0);
});

test("onMetrics unsubscribes cleanly", () => {
  const h = metricsHarness(1000);
  const seen: any[] = [];
  const off = h.conn.onMetrics((m) => seen.push(m));
  h.sched.advance(1000);
  const n = seen.length;
  expect(n).toBeGreaterThan(0);
  off();
  h.sched.advance(1000);
  expect(seen.length).toBe(n);
});

test("attach 默认沿用 seen 记账，不被传入的 seq 倒退覆盖", () => {
  const h = harness();
  // 先收一帧，把 seen 推到 5
  h.deliver({ type: "output", sessionId: "work", seq: 5, data: toB64(new Uint8Array([65])) } as any);
  h.conn.attach("work", 1); // 传入一个更小的 seq
  // sent[0] 是握手原始字节（非 JSON），只解最后一帧——即刚发出的 attach。
  const att = decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any;
  expect(att.type).toBe("attach");
  expect(att.lastSeq).toBe(5); // seen 赢，不是传入的 1
});

test("attach 传 seed:true 时用传入的 seq 覆盖 seen（首屏快照接管）", () => {
  const h = harness();
  h.deliver({ type: "output", sessionId: "work", seq: 5, data: toB64(new Uint8Array([65])) } as any);
  h.conn.attach("work", 99, { seed: true });
  const att = decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any;
  expect(att.type).toBe("attach");
  expect(att.lastSeq).toBe(99); // 传入值赢
});

// Handshake marker bytes for the passthrough channel
const M1 = new Uint8Array([1]);
const M2 = new Uint8Array([2]);

// Passthrough SecureChannel test double: identity encoding, IK-shaped handshake.
// start() -> M1; receive(M2) -> established; in transport receive(frame) -> {status:"message",plaintext:frame}
// send(pt) -> pt (no encryption, identity transform)
function passthroughInitiator(): SecureChannel {
  let state: SecureChannel["state"] = "handshaking";
  return {
    get state() { return state; },
    start() { return M1; },
    receive(frame: Uint8Array) {
      if (state === "handshaking") {
        if (frame[0] === M2[0]) { state = "transport"; return { status: "handshake" as const, established: true }; }
        return { status: "fail" as const, reason: "bad" };
      }
      return { status: "message" as const, plaintext: frame };
    },
    send(pt: Uint8Array) { return pt; },
  };
}

// Binary FakeWS: sends Uint8Array, receives via ArrayBuffer
class FakeWS implements WebSocketLike {
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Uint8Array[] = [];
  closed = false;
  // A real WebSocket's close() is asynchronous: readyState flips right away,
  // but `onclose` only fires on a later tick, not inside the close() call
  // itself. Every other test in this file relies on the simpler synchronous
  // default (matches this file's house style); pass { syncClose: false } to
  // model the real async gap, and call fireClose() to land the event by hand.
  constructor(private opts: { syncClose?: boolean } = {}) {}
  send(data: Uint8Array) { this.sent.push(data); }
  close() {
    this.closed = true;
    if (this.opts.syncClose === false) return;
    this.onclose?.();
  }
  // Land the close event for a socket created with { syncClose: false }.
  fireClose() { this.onclose?.(); }
  // fire a bytes frame as if the server sent it. The bytes are copied into a
  // fresh ArrayBuffer (not `b.buffer.slice(...)`, whose static type is the
  // wider ArrayBufferLike) so the payload matches a real ws "arraybuffer" event.
  fire(b: Uint8Array) {
    const data = new ArrayBuffer(b.byteLength);
    new Uint8Array(data).set(b);
    this.onmessage?.({ data });
  }
  // simulate open
  open() { this.onopen?.(); }
  // fire a server JSON message (post-handshake, in passthrough channel plaintext == wire bytes)
  emit(raw: string) { this.fire(new TextEncoder().encode(raw)); }
}

// Complete the handshake: open triggers M1 sent, then fire M2 to get established
function completeHandshake(ws: FakeWS) {
  ws.open();     // sends M1
  ws.fire(M2);   // established -> onEstablished() -> sends listSessions etc.
}

// Helper: decode a sent Uint8Array as JSON
function decodeMsg(bytes: Uint8Array) { return JSON.parse(new TextDecoder().decode(bytes)); }
// Helper: filter out the M1 handshake frame from sent array (index 0 after open)
function businessSent(ws: FakeWS) {
  // After open() and fire(M2): sent[0]=M1, sent[1..]=business frames
  return ws.sent.slice(1);
}

function makeFakeScheduler() {
  let t = 0;
  let nextId = 1;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  const sched: Scheduler & { pending: () => Array<{ id: number; delay: number }> } = {
    setTimeout: (fn, ms) => { const id = nextId++; timeouts.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { every: ms, next: t + ms, fn }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    now: () => t,
    // Exposes what's currently scheduled (timeouts AND intervals) so tests can
    // assert on "how many timers are pending" without reaching into private
    // Connection state. delay is ms-from-now, matching what was passed to
    // setTimeout/setInterval when nothing has advanced the clock since.
    pending: () => [
      ...[...timeouts.entries()].map(([id, x]) => ({ id, delay: x.at - t })),
      ...[...intervals.entries()].map(([id, x]) => ({ id, delay: x.next - t })),
    ],
  };
  function advance(ms: number) {
    const target = t + ms;
    while (true) {
      let due: { id: number; at: number; kind: "t" | "i" } | null = null;
      for (const [id, x] of timeouts) if (x.at <= target && (!due || x.at < due.at)) due = { id, at: x.at, kind: "t" };
      for (const [id, x] of intervals) if (x.next <= target && (!due || x.next < due.at)) due = { id, at: x.next, kind: "i" };
      if (!due) break;
      t = due.at;
      if (due.kind === "t") { const x = timeouts.get(due.id)!; timeouts.delete(due.id); x.fn(); }
      else { const x = intervals.get(due.id)!; x.next += x.every; x.fn(); }
    }
    t = target;
  }
  return { sched, advance };
}

// ──────────────────────────────────────────────────────────────
// TEST 1 (orig): status starts connecting, goes online on open, offline on close
// Preserved: online on established (post-handshake), offline on close
// ──────────────────────────────────────────────────────────────
test("status starts connecting, goes online on open, offline on close", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const seen: string[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  conn.onStatus((s) => seen.push(s));
  expect(conn.status).toBe("connecting");
  completeHandshake(ws);                 // open -> M1; M2 -> established -> "online"
  expect(conn.status).toBe("online");
  ws.close();
  expect(conn.status).toBe("offline");
  expect(seen).toEqual(["online", "offline"]);
  conn.dispose?.();
});

// ──────────────────────────────────────────────────────────────
// TEST 2 (orig): queues nothing until open, then flushes newSession + input
// Preserved: pre-open calls buffered, post-handshake flush includes queued msgs + listSessions
// ──────────────────────────────────────────────────────────────
test("queues nothing until open, then flushes newSession + input", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  conn.newSession("s1");
  conn.sendInput("s1", new TextEncoder().encode("hi"));
  expect(ws.sent.length).toBe(0);        // not open yet -> buffered
  completeHandshake(ws);
  // sent[0]=M1(handshake), then business frames flushed
  const types = businessSent(ws).map((b) => decodeMsg(b).type);
  expect(types).toEqual(["newSession", "input", "listSessions"]);
});

test("newSession forwards the kind field", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  conn.newSession("sh1", { kind: "shell" });
  const frame = businessSent(ws).map((b) => decodeMsg(b)).find((m) => m.type === "newSession");
  expect(frame).toMatchObject({ type: "newSession", name: "sh1", kind: "shell" });
});

// ──────────────────────────────────────────────────────────────
// TEST 3 (orig): decodes output frames and delivers decoded bytes
// Preserved: output bytes correctly delivered after handshake
// ──────────────────────────────────────────────────────────────
test("decodes output frames and delivers decoded bytes", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  const got: string[] = [];
  conn.onOutput((f) => got.push(new TextDecoder().decode(f.data)));
  ws.emit(encode({ type: "output", sessionId: "s1", seq: 1, data: toB64(new TextEncoder().encode("XYZ")) }));
  expect(got).toEqual(["XYZ"]);
});

// ──────────────────────────────────────────────────────────────
// TEST 4 (orig): dispatches a sessions frame to onSessions
// Preserved: sessions callback fires with correct payload after handshake
// ──────────────────────────────────────────────────────────────
test("dispatches a sessions frame to onSessions", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  const got: SessionMeta[][] = [];
  conn.onSessions((s) => got.push(s));
  const meta: SessionMeta = { name: "s1", kind: "tmux", state: "run", cols: 80, rows: 24, lastLine: "hi", createdAt: 0, attached: true };
  ws.emit(encode({ type: "sessions", sessions: [meta] }));
  expect(got).toEqual([[meta]]);
});

// ──────────────────────────────────────────────────────────────
// TEST 5 (orig): dispatches exit + error frames
// Preserved: exit/error callbacks fire with correct codes after handshake
// ──────────────────────────────────────────────────────────────
test("dispatches exit + error frames", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  const exits: number[] = [];
  const errs: string[] = [];
  conn.onExit((f) => exits.push(f.code));
  conn.onError((f) => errs.push(f.code));
  ws.emit(encode({ type: "exit", sessionId: "s1", code: 137 }));
  ws.emit(encode({ type: "error", code: "boom", message: "bad" }));
  expect(exits).toEqual([137]);
  expect(errs).toEqual(["boom"]);
});

// ──────────────────────────────────────────────────────────────
// TEST 6 (orig): listSessions + renameSession are sent once open
// Preserved: listSessions auto-sent on established, plus explicit calls both appear
// ──────────────────────────────────────────────────────────────
test("listSessions + renameSession are sent once open", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  conn.listSessions();
  conn.renameSession("s1", "claude");
  // businessSent skips M1; in order: listSessions(from onEstablished), listSessions(explicit), renameSession
  const msgs = businessSent(ws).map((b) => decodeMsg(b));
  expect(msgs).toEqual([
    { type: "listSessions" },
    { type: "listSessions" },
    { type: "renameSession", sessionId: "s1", name: "claude" },
  ]);
});

// ──────────────────────────────────────────────────────────────
// TEST 7 (orig): setStatus does not re-notify on the same status
// Preserved: duplicate "online" after second open (second handshake) is deduped
// ──────────────────────────────────────────────────────────────
test("setStatus does not re-notify on the same status", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  const seen: string[] = [];
  conn.onStatus((s) => seen.push(s));
  completeHandshake(ws);   // -> online
  // Simulate second onopen + handshake (same ws, second onopen call)
  ws.open();               // starts a new channel, sends M1
  ws.fire(M2);             // complete second handshake -> tries to setStatus("online") again
  expect(seen.filter((s) => s === "online").length).toBe(1);
  conn.dispose?.();
});

// ──────────────────────────────────────────────────────────────
// TEST 8 (orig): tracks max seq per session and attaches with it
// Preserved: seq tracking correct; attach sends correct lastSeq
// ──────────────────────────────────────────────────────────────
test("tracks max seq per session and attaches with it", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  ws.emit(encode({ type: "output", sessionId: "s1", seq: 5, data: toB64(new Uint8Array([65])) }));
  ws.emit(encode({ type: "output", sessionId: "s1", seq: 4, data: toB64(new Uint8Array([66])) })); // out-of-order lower, ignored for max
  ws.sent.length = 0; // clear all sent (including M1 + onEstablished frames)
  conn.attach("s1");
  // After clearing, first sent is the attach frame (channel is in transport, so sent directly)
  expect(decodeMsg(ws.sent[0])).toEqual({ type: "attach", sessionId: "s1", lastSeq: 5 });
});

// ──────────────────────────────────────────────────────────────
// TEST 9 (orig): dispatches resync frames to onResync
// Preserved: resync callback fires correctly after handshake
// ──────────────────────────────────────────────────────────────
test("dispatches resync frames to onResync", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  const got: any[] = [];
  conn.onResync((f) => got.push(f));
  ws.emit(encode({ type: "resync", sessionId: "s1", from: 9 }));
  expect(got).toEqual([{ sessionId: "s1", from: 9 }]);
});

// ──────────────────────────────────────────────────────────────
// TEST 10 (orig): reconnects after close with exponential backoff
// Preserved: reconnect creates new socket, backoff delay, new handshake → online
// ──────────────────────────────────────────────────────────────
test("reconnects after close with exponential backoff", () => {
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, random: () => 0.5, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; }, channelFactory: passthroughInitiator });
  completeHandshake(created[0]);
  expect(conn.status).toBe("online");
  created[0].close();
  expect(conn.status).toBe("offline");
  advance(500);                 // first backoff = 500ms
  expect(created.length).toBe(2); // a new socket was created
  completeHandshake(created[1]);
  expect(conn.status).toBe("online");
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// TEST 11 (orig): ignores stale socket callbacks after reconnect
// Preserved: stale socket's close event is ignored after new socket is live
// ──────────────────────────────────────────────────────────────
test("ignores stale socket callbacks after reconnect", () => {
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, random: () => 0.5, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; }, channelFactory: passthroughInitiator });
  completeHandshake(created[0]);
  created[0].close();
  advance(500);
  completeHandshake(created[1]);
  const seen: string[] = [];
  conn.onStatus((s) => seen.push(s));
  created[0].close();           // stale socket fires again -> must be ignored
  expect(conn.status).toBe("online");
  expect(seen).toEqual([]);
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// TEST 12 (orig): re-attaches all attached sessions with lastSeq on reconnect
// Preserved: re-attach sends correct lastSeq for each session after reconnect handshake
// ──────────────────────────────────────────────────────────────
test("re-attaches all attached sessions with lastSeq on reconnect", () => {
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, random: () => 0.5, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; }, channelFactory: passthroughInitiator });
  completeHandshake(created[0]);
  conn.attach("s1");
  conn.attach("s2");
  created[0].emit(encode({ type: "output", sessionId: "s1", seq: 3, data: toB64(new Uint8Array([65])) }));
  created[0].close();
  advance(500);
  completeHandshake(created[1]);
  const msgs = businessSent(created[1]).map((b) => decodeMsg(b));
  expect(msgs).toContainEqual({ type: "attach", sessionId: "s1", lastSeq: 3 });
  expect(msgs).toContainEqual({ type: "attach", sessionId: "s2", lastSeq: 0 });
  expect(msgs.some((m: any) => m.type === "listSessions")).toBe(true);
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// TEST 13 (orig): sends listSessions on connect even with no attached sessions
// Preserved: listSessions sent in onEstablished even with no sessions
// ──────────────────────────────────────────────────────────────
test("sends listSessions on connect even with no attached sessions", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  const msgs = businessSent(ws).map((b) => decodeMsg(b));
  expect(msgs.some((m: any) => m.type === "listSessions")).toBe(true);
  conn.dispose?.();
});

// ──────────────────────────────────────────────────────────────
// TEST 14 (orig): sends ping on heartbeat interval
// Preserved: encrypted ping sent on heartbeat interval (passthrough = identity, so decode works)
// ──────────────────────────────────────────────────────────────
test("sends ping on heartbeat interval", () => {
  const { sched, advance } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, heartbeatMs: 1000, livenessMs: 3000, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  ws.sent.length = 0;           // clear M1 + onEstablished frames
  advance(1000);
  expect(decodeMsg(ws.sent[0])).toEqual({ type: "ping" });
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// TEST 15 (orig): goes offline when no frame arrives within livenessMs
// Preserved: liveness check triggers close -> offline when no frames arrive
// ──────────────────────────────────────────────────────────────
test("goes offline when no frame arrives within livenessMs", () => {
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, heartbeatMs: 1000, livenessMs: 3000, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; }, channelFactory: passthroughInitiator });
  completeHandshake(created[0]);
  advance(4000); // no frames received -> liveness exceeded on a heartbeat tick
  expect(conn.status).toBe("offline");
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// TEST 16 (orig): liveness timer is refreshed by incoming frames
// Preserved: incoming frames reset liveness, preventing offline
// ──────────────────────────────────────────────────────────────
test("liveness timer is refreshed by incoming frames", () => {
  const { sched, advance } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, heartbeatMs: 1000, livenessMs: 3000, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  advance(2000);
  ws.emit(encode({ type: "pong" })); // refresh (pong is a valid ServerMsg, but dispatch ignores unknown types gracefully)
  advance(2000);
  expect(conn.status).toBe("online");
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// NEW TEST A: business sends queued until handshake completes, then flushed
// ──────────────────────────────────────────────────────────────
test("business sends are queued until handshake completes, then flushed encrypted-through", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({
    url: "ws://x", wsFactory: () => (ws = new FakeWS()), scheduler: sched,
    channelFactory: passthroughInitiator,
  });
  ws.open();                      // sends M1 (handshake), starts timeout
  expect(ws.sent[0]).toEqual(M1);
  conn.listSessions();            // business call before established -> queued
  expect(ws.sent.length).toBe(1); // still only M1
  ws.fire(M2);                    // handshake reply -> established -> flush
  // after established: listSessions flushed as plaintext JSON bytes (passthrough)
  const flushed = new TextDecoder().decode(ws.sent[ws.sent.length - 1]);
  expect(flushed).toBe(encode({ type: "listSessions" }));
});

// ──────────────────────────────────────────────────────────────
// NEW TEST B: handshake timeout -> offline
// ──────────────────────────────────────────────────────────────
test("handshake timeout -> offline + notice path (status offline)", () => {
  const { sched, advance } = makeFakeScheduler();
  let ws!: FakeWS;
  const statuses: string[] = [];
  const conn = new Connection({
    url: "ws://x", wsFactory: () => (ws = new FakeWS()), scheduler: sched,
    channelFactory: passthroughInitiator,
    handshakeTimeoutMs: 100,
  });
  conn.onStatus((s) => statuses.push(s));
  ws.open();           // starts handshake timeout
  advance(100);        // fire the handshake timeout (no M2 arrived)
  expect(statuses).toContain("offline");
});

// ──────────────────────────────────────────────────────────────
// NEW TEST C: channel init failure on open -> offline (does not hang)
// ──────────────────────────────────────────────────────────────
test("channel init failure on open -> offline (does not hang)", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const statuses: string[] = [];
  const conn = new Connection({
    url: "ws://x", scheduler: sched,
    wsFactory: () => (ws = new FakeWS()),
    channelFactory: () => { throw new Error("no agent pubkey"); },
  });
  conn.onStatus((s) => statuses.push(s));
  ws.open();  // fires onopen -> makeChannel throws -> handleDown -> offline
  expect(conn.status).toBe("offline");
});

// ──────────────────────────────────────────────────────────────
// NEW TEST D (S4b): a pending pairing code is sent on established (deferring
// listSessions), and a pair_failed rejection clears the code so it is NOT
// retried on reconnect (which would loop + self-trip the rate limiter).
// ──────────────────────────────────────────────────────────────
test("pairing: sends pair on established, and pair_failed clears the pending code", () => {
  localStorage.clear();
  applyPairing({ pub: "QUJD", addr: "ws://x", code: "ABCD2345", deviceName: "iPhone" });
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const errors: { code: string; message: string }[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  conn.onError((e) => errors.push(e));

  completeHandshake(ws); // open -> M1; M2 -> established -> should send pair (not listSessions)
  const types = businessSent(ws).map((b) => decodeMsg(b).type);
  expect(types).toContain("pair");
  expect(types).not.toContain("listSessions"); // deferred until paired
  expect(getPendingPair()).not.toBeNull();

  // agent rejects the code and closes
  ws.emit(encode({ type: "error", code: "pair_failed", message: "expired" }));
  expect(getPendingPair()).toBeNull();       // cleared -> no infinite retry
  expect(errors.some((e) => e.code === "pair_failed")).toBe(true);
});

// ──────────────────────────────────────────────────────────────
// NEW TEST E (S4b): a closed pairing window rejects at the handshake with no
// pair_failed message (just a socket close). Tolerate a transient blip, but
// after repeated pre-established closes drop the code so we stop looping.
// ──────────────────────────────────────────────────────────────
test("pairing: repeated pre-established closes clear the pending code", () => {
  localStorage.clear();
  applyPairing({ pub: "QUJD", addr: "ws://x", code: "ABCD2345", deviceName: "iPhone" });
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const errors: { code: string; message: string }[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, random: () => 0.5, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; }, channelFactory: passthroughInitiator });
  conn.onError((e) => errors.push(e));

  // attempt 1: open sends M1, then close before M2 (agent rejected at handshake)
  created[0].open(); created[0].close();
  expect(getPendingPair()).not.toBeNull();   // one blip tolerated
  advance(600); created[1].open(); created[1].close();
  expect(getPendingPair()).not.toBeNull();   // two tolerated
  advance(1100); created[2].open(); created[2].close();
  expect(getPendingPair()).toBeNull();       // third clears
  expect(errors.some((e) => e.code === "pair_failed")).toBe(true);
});

// ──────────────────────────────────────────────────────────────
// WP-2b: detach sends a frame and drops the session from the reconnect replay
// ──────────────────────────────────────────────────────────────
test("detach sends a frame and removes the session from reconnect replay", () => {
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, random: () => 0.5, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; }, channelFactory: passthroughInitiator });
  completeHandshake(created[0]);
  conn.attach("s1");
  conn.attach("s2");
  created[0].sent.length = 0;
  conn.detach("s1");
  expect(decodeMsg(created[0].sent[0])).toEqual({ type: "detach", sessionId: "s1" });
  created[0].close();
  advance(500);
  completeHandshake(created[1]);
  const msgs = businessSent(created[1]).map((b) => decodeMsg(b));
  expect(msgs.some((m: any) => m.type === "attach" && m.sessionId === "s1")).toBe(false);
  expect(msgs).toContainEqual({ type: "attach", sessionId: "s2", lastSeq: 0 });
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// WP-2b: a repeated detach (e.g. closeTopTab after toBackground) sends no
// second frame — the server already unsubscribed on the first one
// ──────────────────────────────────────────────────────────────
test("repeated detach sends no duplicate frame", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  conn.attach("s1");
  conn.detach("s1");
  ws.sent.length = 0;
  conn.detach("s1");
  expect(ws.sent.length).toBe(0);
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// WP-2b: re-attaching an already-subscribed session (Terminal remount,
// restored-tab loop) sends no duplicate attach — that would only make the
// agent replay the backlog twice
// ──────────────────────────────────────────────────────────────
test("re-attaching an already attached session sends no duplicate frame", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  conn.attach("s1");
  ws.sent.length = 0;
  conn.attach("s1");
  expect(ws.sent.length).toBe(0);
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// WP-2b: attach while the transport is down sends nothing and queues nothing;
// flushAndRestore replays it exactly once, with the baseline lastSeq
// ──────────────────────────────────────────────────────────────
test("attach while offline is replayed exactly once on connect, with baseline lastSeq", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  conn.attach("s1", 7); // before the socket even opens (Terminal mounted while connecting)
  expect(ws.sent.length).toBe(0);
  completeHandshake(ws);
  const msgs = businessSent(ws).map((b) => decodeMsg(b));
  const attaches = msgs.filter((m: any) => m.type === "attach" && m.sessionId === "s1");
  expect(attaches).toEqual([{ type: "attach", sessionId: "s1", lastSeq: 7 }]);
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// WP-2b: detach while offline needs no frame — the next connection starts
// with an empty subscription set server-side, and the session is gone from
// the reconnect replay
// ──────────────────────────────────────────────────────────────
test("detach while offline queues nothing and is not replayed", () => {
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, random: () => 0.5, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; }, channelFactory: passthroughInitiator });
  completeHandshake(created[0]);
  conn.attach("s1");
  created[0].close();
  advance(500); // reconnect socket created, but not yet established
  conn.detach("s1");
  completeHandshake(created[1]);
  const msgs = businessSent(created[1]).map((b) => decodeMsg(b));
  expect(msgs.some((m: any) => m.type === "detach")).toBe(false);
  expect(msgs.some((m: any) => m.type === "attach" && m.sessionId === "s1")).toBe(false);
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// WP-2b: detach keeps the seq bookkeeping so re-attaching (back to the
// foreground) resumes the replay from the last received seq
// ──────────────────────────────────────────────────────────────
test("re-attach after detach resumes from the last received seq", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  conn.attach("s1");
  ws.emit(encode({ type: "output", sessionId: "s1", seq: 9, data: toB64(new Uint8Array([65])) }));
  conn.detach("s1");
  ws.sent.length = 0;
  conn.attach("s1");
  expect(decodeMsg(ws.sent[0])).toEqual({ type: "attach", sessionId: "s1", lastSeq: 9 });
  conn.dispose();
});

test("seed attach after detach sends a frame and overwrites the retained seen value", () => {
  const h = harness();
  h.conn.attach("work");
  h.deliver({ type: "output", sessionId: "work", seq: 9, data: toB64(new Uint8Array([65])) } as any);
  h.conn.detach("work");
  const before = h.sent.length;

  h.conn.attach("work", 4, { seed: true });

  expect(h.sent.length).toBe(before + 1);
  const attach = decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any;
  expect(attach).toEqual({ type: "attach", sessionId: "work", lastSeq: 4 });

  h.conn.detach("work");
  h.conn.attach("work");
  const resumed = decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any;
  expect(resumed).toEqual({ type: "attach", sessionId: "work", lastSeq: 4 });
});

// ──────────────────────────────────────────────────────────────
// WP-3b (A9): the reconnect backoff carries ±20% jitter — random=0 pins the
// 500ms first backoff to its 400ms floor
// ──────────────────────────────────────────────────────────────
test("reconnect backoff jitter: random=0 lands at the 0.8× floor", () => {
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, random: () => 0, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; }, channelFactory: passthroughInitiator });
  completeHandshake(created[0]);
  created[0].close();
  advance(399);
  expect(created.length).toBe(1); // below the jittered delay: no reconnect yet
  advance(1);
  expect(created.length).toBe(2); // exactly 400ms
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// WP-3b (A9): random≈1 pins the same backoff to its 600ms ceiling
// ──────────────────────────────────────────────────────────────
test("reconnect backoff jitter: random=1 lands at the 1.2× ceiling", () => {
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, random: () => 0.999, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; }, channelFactory: passthroughInitiator });
  completeHandshake(created[0]);
  created[0].close();
  advance(599);
  expect(created.length).toBe(1);
  advance(1);
  expect(created.length).toBe(2); // exactly 600ms
  conn.dispose();
});

// ──────────────────────────────────────────────────────────────
// Task 11: OTA `update` broadcast frames dispatch to onUpdate subscribers
// ──────────────────────────────────────────────────────────────
test("dispatches an update frame to onUpdate", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()), channelFactory: passthroughInitiator });
  completeHandshake(ws);
  const seen: unknown[] = [];
  conn.onUpdate((u) => seen.push(u));
  ws.emit(encode({ type: "update", phase: "downloading", pct: 10, version: "0.4.0" }));
  expect(seen).toEqual([{ phase: "downloading", pct: 10, message: undefined, version: "0.4.0" }]);
});

// ──────────────────────────────────────────────────────────────
// dropConnection: closes the current socket by hand so tests (and the
// upcoming automation surface on window.pocketshell) can exercise the
// offline → reconnect path deterministically, instead of waiting out the
// 25s liveness window. Reuses the FakeWS + makeFakeScheduler fixtures from
// the reconnect/backoff tests above — same house style, not a new one.
// ──────────────────────────────────────────────────────────────
function makeConn() {
  const { sched, advance } = makeFakeScheduler();
  let socket!: FakeWS;
  const statuses: string[] = [];
  const conn = new Connection({
    url: "ws://x", scheduler: sched,
    wsFactory: () => (socket = new FakeWS()),
    channelFactory: passthroughInitiator,
  });
  conn.onStatus((s) => statuses.push(s));
  return { conn, socket, sched, statuses, advance };
}

describe("dropConnection", () => {
  it("closes the live socket and goes offline", () => {
    const { conn, socket, statuses } = makeConn();
    socket.onopen?.();                        // handshake started, not established yet
    expect(conn.status).toBe("connecting");   // still connecting pre-handshake

    conn.dropConnection();

    expect(socket.closed).toBe(true);
    expect(statuses).toContain("offline");
  });

  it("schedules a reconnect after dropping", () => {
    const { conn, socket, sched } = makeConn();
    socket.onopen?.();
    conn.dropConnection();
    // FakeWS.close() invokes onclose synchronously (same as every other test
    // in this file), so handleDown() has already run — no need to fire the
    // close event a second time by hand.

    // handleDown 排了一个 backoff timer；第一次退避是 500ms × (0.8~1.2)
    expect(sched.pending().length).toBe(1);
    expect(sched.pending()[0]!.delay).toBeLessThanOrEqual(600);
  });

  it("stops the heartbeat itself, before the async close event lands", () => {
    // FakeWS's default close() fires onclose synchronously, so handleDown()
    // (which also calls stopHeartbeat()) runs inside conn.dropConnection()
    // itself — a mutation test proved that setup can't tell whether
    // dropConnection() stops the heartbeat or handleDown() does it for free.
    // A real WebSocket's close() is async: onclose lands on a later tick, so
    // there is a real window where a live heartbeat interval would still fire
    // a ping at a socket that is already going away unless dropConnection()
    // stops it itself. { syncClose: false } models that gap.
    const { sched } = makeFakeScheduler();
    let socket!: FakeWS;
    const conn = new Connection({
      url: "ws://x", scheduler: sched,
      wsFactory: () => (socket = new FakeWS({ syncClose: false })),
      channelFactory: passthroughInitiator,
    });
    completeHandshake(socket);                // fully online, heartbeat running
    expect(sched.pending().length).toBe(1);   // just the heartbeat interval

    conn.dropConnection();
    // onclose has NOT fired yet (async) — handleDown() has not run. This only
    // reads 0 if dropConnection() clears the heartbeat interval itself.
    expect(sched.pending().length).toBe(0);

    socket.fireClose();                       // the close event lands, later
    expect(sched.pending().length).toBe(1);   // handleDown() scheduled the reconnect
  });
});

// ---- rpcZip：压缩响应 ----
import { gzipSync } from "node:zlib";

/** 把一个 response 帧压成 rpcZip 帧，与 agent 的 sendRpcResult 同构。 */
function zipFrame(id: string, result: unknown): ServerMsg {
  const payload = encode({ type: "response", id, ok: true, result } as ServerMsg);
  return { type: "rpcZip", id, data: gzipSync(Buffer.from(payload, "utf8")).toString("base64") } as ServerMsg;
}

test("rpcZip response is decompressed and resolves the rpc", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/big" });
  const id = (decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any).id;
  h.deliver(zipFrame(id, { content: "hello".repeat(3000) }));
  await expect(p).resolves.toEqual({ content: "hello".repeat(3000) });
});

test("rpcZip with corrupt payload rejects as rpc_zip_invalid", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/x" });
  const id = (decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any).id;
  h.deliver({ type: "rpcZip", id, data: "!!!not base64!!!" } as ServerMsg);
  await expect(p).rejects.toMatchObject({ code: "rpc_zip_invalid" });
});

test("rpc requests advertise acceptEnc gzip and bin", () => {
  const h = harness();
  h.conn.rpc("fs.read", { path: "/x" });
  const req = decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any;
  expect(req.acceptEnc).toEqual(["gzip", "bin"]);
});

test("GUARD: an rpcZip decoded after a reconnect does not re-enter dispatch on the stale socket", async () => {
  // 异步回喂绕过了 onmessage 的 stale-socket 守卫（connection.ts 里
  // `if (socket !== this.ws) return`）。没有等价检查的话，重连后旧 promise
  // 落地会把过期帧再灌回 dispatch 一次。
  //
  // 早期版本的这条测试只 close() 不真正重连，`this.ws` 从头到尾没变过，
  // `socket !== this.ws` 恒为 false——删掉守卫代码测试照样绿（评审用
  // mutation 测试抓出的假绿）。这里必须真正走完退避让 this.ws 换成新
  // socket 对象；断言也不能挑 pending/sent——断线已经把 pending 清空，
  // response 帧砸在空 pending 上本来就是 no-op，看 pending/sent 测不出
  // 差异。dispatch 的调用次数才是守卫是否生效的直接可观察量。
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/x" });
  const id = (decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any).id;

  const dispatchSpy = vi.spyOn(h.conn as any, "dispatch");

  h.deliver(zipFrame(id, { content: "x".repeat(9000) })); // 外层 rpcZip 帧本身触发一次 dispatch；解压异步进行中
  const callsAfterDelivery = dispatchSpy.mock.calls.length;

  h.sock.onclose();                       // 解压还在 await 中就断线，pending 被 rejectAllPending 结算
  await expect(p).rejects.toBeTruthy();

  h.sched.advance(10_000);                // 走完重连退避 → this.ws 换成新 socket 实例

  await new Promise((r) => setTimeout(r, 5)); // 让悬空的解压 promise 落地

  // 有守卫：解压成功后发现 socket !== this.ws，直接 return，不会再调用 dispatch。
  expect(dispatchSpy.mock.calls.length).toBe(callsAfterDelivery);
  dispatchSpy.mockRestore();
});

test("GUARD: a compressed rpcChunk sequence reassembles and decompresses", async () => {
  const h = harness();
  const p = h.conn.rpc("git.log", { cwd: "/" });
  const id = (decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any).id;
  const payload = encode({ type: "response", id, ok: true, result: { entries: "e".repeat(50000) } } as ServerMsg);
  const gz = gzipSync(Buffer.from(payload, "utf8"));
  const half = Math.ceil(gz.length / 2);
  h.deliver({ type: "rpcChunk", id, index: 0, total: 2, data: gz.subarray(0, half).toString("base64"), enc: "gzip" } as ServerMsg);
  h.deliver({ type: "rpcChunk", id, index: 1, total: 2, data: gz.subarray(half).toString("base64"), enc: "gzip" } as ServerMsg);
  await expect(p).resolves.toEqual({ entries: "e".repeat(50000) });
});

test("GUARD: a compressed rpcChunk decoded after a reconnect does not re-enter dispatch on the stale socket", async () => {
  // 对称覆盖 handleRpcChunk 里 enc==="gzip" 分支的同款 stale-socket 守卫。
  // 断言方式与上面的 rpcZip 版一致：数 dispatch 调用次数，而不是看
  // pending/sent（断线已把 pending 清空，第二次 dispatch 即便发生也不会
  // resolve/reject 任何东西，光看 promise 状态测不出差异）。
  const h = harness();
  const p = h.conn.rpc("git.log", { cwd: "/" });
  const id = (decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any).id;
  const payload = encode({ type: "response", id, ok: true, result: { entries: "e".repeat(50000) } } as ServerMsg);
  const gz = gzipSync(Buffer.from(payload, "utf8"));
  const half = Math.ceil(gz.length / 2);

  const dispatchSpy = vi.spyOn(h.conn as any, "dispatch");

  h.deliver({ type: "rpcChunk", id, index: 0, total: 2, data: gz.subarray(0, half).toString("base64"), enc: "gzip" } as ServerMsg);
  h.deliver({ type: "rpcChunk", id, index: 1, total: 2, data: gz.subarray(half).toString("base64"), enc: "gzip" } as ServerMsg);
  // 分片齐全触发同步 feed + 异步 gunzip；此刻 dispatch 只因这两次外层
  // rpcChunk 帧的投递被调用过（onmessage → dispatch(raw) → handleRpcChunk）。
  const callsAfterDelivery = dispatchSpy.mock.calls.length;

  h.sock.onclose();                       // 解压还在 await 中就断线
  await expect(p).rejects.toBeTruthy();

  h.sched.advance(10_000);                // 走完重连退避 → this.ws 换成新 socket 实例

  await new Promise((r) => setTimeout(r, 5)); // 让悬空的解压 promise 落地

  expect(dispatchSpy.mock.calls.length).toBe(callsAfterDelivery);
  dispatchSpy.mockRestore();
});

// ---- rpc 压缩埋点采样门槛（C1/I2）----
// C1 修复前：reportRpcIfBig 只看 wireBytes>8192，对方法无差别。
// fs.downloadChunk 的响应恒为 45KB base64（≈61531 字节）且在压缩黑名单里，
// 永远越过门槛却永远没压缩——200MB 下载 4552 个分片就是 4552 次白打的
// diag rpc，还跟下载窗口抢同一条链路。这里补两条此前完全没有回归保护的
// 用例：把被测的门槛判断删掉，这两条测试必须能挂。

test("C1: 大但未压缩的明帧响应不触发 diag 上报", async () => {
  const h = harness();
  // 显式开诊断能力位：不开的话这条会被 2026-08-23 的「诊断默认关闭」短路，
  // 测到的是开关而不是这里要钉的「未压缩就不报」门槛——假绿。
  (h.conn as any).features = new Set(["diag"]);
  const rpcSpy = vi.spyOn(h.conn, "rpc");
  const p = h.conn.rpc("fs.downloadChunk", { path: "/big.bin", offset: 0 });
  const id = (decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any).id;
  // 明帧 response：wireOverride 为空，wireBytes 由这一帧的字节数现算，
  // 天然等于 rawBytes——这正是黑名单方法（以及任何从未压缩过的响应）的
  // 真实形状。61531 字节复刻的是 45KB 分片 base64 后的真实体积。
  const dataB64 = "a".repeat(61531);
  h.deliver({ type: "response", id, ok: true, result: { dataB64, eof: false } } as any);
  await expect(p).resolves.toMatchObject({ eof: false });

  const diagCalls = rpcSpy.mock.calls.filter((c) => c[0] === "diag.report");
  expect(diagCalls.length).toBe(0);
});

test("I2: 真正压缩过的大响应会触发 diag 上报，且字段值正确", async () => {
  const h = harness();
  (h.conn as any).features = new Set(["diag"]);
  const rpcSpy = vi.spyOn(h.conn, "rpc");
  const p = h.conn.rpc("git.log", { cwd: "/repo" });
  const id = (decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any).id;
  // 中等熵的 fixture：太规整（如单字符重复）会被 gzip 压到几百字节，
  // 反而低于 RPC_DIAG_SAMPLE_MIN_BYTES(8192) 触发第一道门槛提前返回——
  // 假绿。这里复用 rpc-compress.test.ts 的 PRNG 手法，压出一个 wireBytes
  // 明确落在「> 8192 且 < rawBytes」区间的样本。
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const CH = "abcdefghijklmnopqrstuvwxyz0123456789";
  const line = () => "\x1b[32m$\x1b[0m " + Array.from({ length: 40 }, () => CH[rnd() % 36]).join("") + "\n";
  const content = Array.from({ length: 400 }, line).join("");
  const expectedRawBytes = new TextEncoder().encode(
    encode({ type: "response", id, ok: true, result: { content } } as ServerMsg),
  ).length;
  h.deliver(zipFrame(id, { content }));
  await expect(p).resolves.toEqual({ content });

  const diagCalls = rpcSpy.mock.calls.filter((c) => c[0] === "diag.report");
  expect(diagCalls.length).toBe(1);
  const report = diagCalls[0][1] as Record<string, unknown>;
  expect(report.method).toBe("git.log");
  expect(report.chunks).toBe(1);
  expect(report.rawBytes).toBe(expectedRawBytes);
  expect(report.wireBytes as number).toBeLessThan(report.rawBytes as number);
});

// ---- inflightBytes 泄漏防护（m1）----
// 评审做 mutation 时发现：把 handleRpcZip 错误分支里的 releaseRpc 删掉，
// 全套测试依然全绿——缺的就是这条。少一步就是 inflightBytes 泄漏，后续
// rpc 会拿到虚高的死线预算，把真实故障掩盖成"偶发变慢"。

test("m1: rpcZip 解压失败后 inflightBytes 精确回落到 reject 之前的水平", async () => {
  const h = harness();
  const p1 = h.conn.rpc("fs.read", { path: "/corrupt" });
  const id1 = (decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any).id;
  const bytesAfterFirst = (h.conn as any).inflightBytes;
  expect(bytesAfterFirst).toBeGreaterThan(0);

  // 留一路继续挂着做基线对照：只有 rpc1 的预留字节应当被释放，rpc2 的
  // 那部分必须原封不动——多了说明 releaseRpc 漏调（泄漏），少了说明误删
  // 了别人的账。
  const p2 = h.conn.rpc("fs.read", { path: "/still-pending" });
  const bytes2 = (h.conn as any).inflightBytes - bytesAfterFirst;
  expect(bytes2).toBeGreaterThan(0);

  h.deliver({ type: "rpcZip", id: id1, data: "!!!not base64!!!" } as ServerMsg);
  await expect(p1).rejects.toMatchObject({ code: "rpc_zip_invalid" });

  expect((h.conn as any).inflightBytes).toBe(bytes2);

  void p2.catch(() => {}); // harness 拆除时 p2 仍是 pending，避免未处理 rejection 噪音
});

// ──────────────────────────────────────────────────────────────
// Task 8: 客户端入站二进制帧（rpcZip/rpcChunk 仍可能以 JSON 帧到达——agent 侧
// 对「未压缩但超单帧预算」的响应仍走 chunkRpcPayload + sendSecure 这条纯
// JSON 老路径，dispatch() 的 rpcZip/rpcChunk 分支因此保留、只是内部转成字节
// 喂给同一套 bytes-only 的 handler；rpcBin 与压缩后的 rpcZip/rpcChunk 则
// 只走二进制帧）。
// ──────────────────────────────────────────────────────────────
import { packBinFrame } from "./binframe";

/** 喂裸字节（二进制帧）：passthroughChannel 是恒等函数，onmessage 收到的
 *  bytes 就是 channel.receive() 返回的 plaintext，不用额外包装。 */
function feedBytes(h: ReturnType<typeof harness>, bytes: Uint8Array): void {
  h.sock.onmessage({ data: bytes.buffer as ArrayBuffer });
}

/** 已发出的 rpc 请求帧的 method 列表，按发出顺序。 */
function sentMethods(h: ReturnType<typeof harness>): string[] {
  return h.sent
    .map((b) => { try { return JSON.parse(new TextDecoder().decode(b)); } catch { return null; } })
    .filter((m): m is { type: string; method?: string } => !!m && m.type === "rpc")
    .map((m) => m.method as string);
}

test("收到二进制 rpcZip 帧，rpc 正常 resolve，内容完好", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.read", { path: "/a" });
  const id = lastRpcId(h);
  const inner = JSON.stringify({ type: "response", id, ok: true, result: { content: "hello" } });
  feedBytes(h, packBinFrame({ type: "rpcZip", id }, gzipSync(Buffer.from(inner, "utf8"))));
  await expect(p).resolves.toEqual({ content: "hello" });
});

test("收到 rpcBin 帧，resolve 出的 bytes 逐字节正确（非法 UTF-8）", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.downloadChunk", { path: "/a", offset: 0, len: 100 });
  const id = lastRpcId(h);
  const EVIL = new Uint8Array([0xed, 0xa0, 0x80, 0x80, 0xff, 0xfe]);
  feedBytes(h, packBinFrame({ type: "rpcBin", id, result: { eof: true, size: 6 } }, EVIL));
  const r = (await p) as { bytes: Uint8Array; eof: boolean; size: number };
  expect(Array.from(r.bytes)).toEqual(Array.from(EVIL));
  expect(r.eof).toBe(true);
  expect(r.size).toBe(6);
});

test("rpcBin 结算干净：pending 清空、inflightBytes 归零、无重复释放", async () => {
  const h = harness();
  const p = h.conn.rpc("fs.downloadChunk", { path: "/a", offset: 0, len: 100 });
  const id = lastRpcId(h);
  feedBytes(h, packBinFrame({ type: "rpcBin", id, result: { eof: true, size: 3 } }, new Uint8Array([1, 2, 3])));
  await p;
  expect((h.conn as any).pending.size).toBe(0);
  expect((h.conn as any).inflightBytes).toBe(0);
  // 重复投递同一帧不得二次释放（会把 inflightBytes 推成负数或误伤后续 rpc）
  feedBytes(h, packBinFrame({ type: "rpcBin", id, result: { eof: true, size: 3 } }, new Uint8Array([1, 2, 3])));
  expect((h.conn as any).inflightBytes).toBe(0);
});

test("rpcBin 不触发 diag 埋点 —— 它没压缩任何东西", async () => {
  // 一阶段的 C1：仅按字节门槛采样时，fs.downloadChunk 的响应恒为 61531 字节、
  // 必然越过门槛，200MB 下载 = 4552 次白打的 diag rpc + 778KB 上行，且信息量
  // 为零。第二条判据（wireBytes < rawBytes）是唯一屏障。
  //
  // rpcBin 是新的 rpcWireOverride 生产者：若按直觉记 rawBytes = 原 JSON 大小，
  // 判据会从恒假变**恒真**，那条 Critical 原地复活。所以必须 rawBytes = wireBytes。
  //
  // 注意这条测试不能靠"删掉 wireBytes < rawBytes 那行"来 mutation 验证——
  // 守卫行还在，变的是喂进去的值。只能直接断言 diag rpc 数为 0。
  const h = harness();
  const p = h.conn.rpc("fs.downloadChunk", { path: "/a", offset: 0, len: 46000 });
  const id = lastRpcId(h);
  const big = new Uint8Array(46000).fill(0x41);
  feedBytes(h, packBinFrame({ type: "rpcBin", id, result: { eof: false, size: 200000 } }, big));
  await p;
  expect(sentMethods(h).filter((m) => m === "diag.report").length).toBe(0);
});

test("坏的二进制帧被静默丢弃，不关连接、不杀掉后续帧处理", async () => {
  const h = harness();
  feedBytes(h, new Uint8Array([0x00, 0xff, 0xff, 0x7b])); // 坏帧
  const p = h.conn.rpc("fs.read", { path: "/a" });
  const id = lastRpcId(h);
  feedBytes(h, new TextEncoder().encode(JSON.stringify({ type: "response", id, ok: true, result: 42 })));
  await expect(p).resolves.toBe(42);
});

// ──────────────────────────────────────────────────────────────
// Task 9: 客户端出站 —— rpcBin()、字节记账、队列类型。
// disconnectedHarness 镜像 harness()，但不调用 sock.onopen()/握手 onmessage，
// 连接停在 "connecting"、this.channel 未设置 —— 用于测 transport 未就绪时
// rpcBin 的门控（与既有 send() 的判断逐字一致）。
// ──────────────────────────────────────────────────────────────
function disconnectedHarness() {
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
  return { conn, sched, sent, sock };
}

test("rpcBin 的死线按 header + blob 全长计算，不是只按 header", async () => {
  // blob 移出 JSON 后若只记账 header，inflightBytes 从 ~61583 掉到 ~120，
  // 4 片窗口的死线从 39413ms 塌回 10000ms 下限；而 150kbps 下排空 4×46080 B
  // 实际需要 9830ms——健康上传会在几百 KB 处整体失败。
  // 这类 bug 回环测不出来（本地零延迟），只能用记账断言钉住。
  const h = harness();
  (h.conn as any).features = new Set(["bin"]);
  const blob = new Uint8Array(46000).fill(0x41);
  void h.conn.rpcBin("fs.uploadChunk", { uploadId: "u", first: true }, blob);
  expect((h.conn as any).inflightBytes).toBeGreaterThan(46000);
});

test("未声明 bin 能力时，rpcBin 回落到 base64 的普通 rpc", async () => {
  const h = harness();
  // features 未设置 = 老 agent
  void h.conn.rpcBin("fs.uploadChunk", { uploadId: "u", first: true }, new Uint8Array([1, 2, 3]));
  const last = h.sent[h.sent.length - 1];
  expect(last[0]).toBe(0x7b); // '{' —— 是 JSON 帧
  const msg = JSON.parse(new TextDecoder().decode(last));
  expect(msg.params.dataB64).toBe("AQID");
});

test("信道未 transport 时 rpcBin 不抛异常，帧进队列", () => {
  // SecureChannel.send 在非 transport 状态同步 throw；既有 send() 用
  // `this.open && state === "transport"` 挡住，rpcBin 必须复刻这个判断。
  const h = disconnectedHarness();
  (h.conn as any).features = new Set(["bin"]);
  expect(() => void h.conn.rpcBin("fs.uploadChunk", { uploadId: "u" }, new Uint8Array([1]))).not.toThrow();
  expect((h.conn as any).queue.length).toBeGreaterThan(0);
});

test("二进制出站计入 txBytes（分割条的上行吞吐依赖它）", () => {
  const h = harness();
  (h.conn as any).features = new Set(["bin"]);
  const before = (h.conn as any).txBytes;
  void h.conn.rpcBin("fs.uploadChunk", { uploadId: "u" }, new Uint8Array(1000));
  expect((h.conn as any).txBytes).toBeGreaterThan(before + 1000);
});

test("sessions 帧的 features 字段被记录，驱动 rpcBin 的能力位回落判断", () => {
  const h = harness();
  h.deliver({ type: "sessions", sessions: [], features: ["bin"] } as unknown as ServerMsg);
  expect((h.conn as any).features.has("bin")).toBe(true);
});

// ──────────────────────────────────────────────────────────────
// 14 期需求 3：下载方向的死线记账（rpc 的 expectBytes）。
//
// rpc() 此前只记**请求 JSON**（约 150 字节），56KB 的响应体完全不入账 ——
// 下载死线因此恒为基线 10s。上传方向的 rpcBin 一直计整帧是对的，这是一处
// 上下行不对称，且该路径此前**无回归测试**。
// 窗口提到 16 之后这条更要紧：16 lane 各等一个 56KB 响应体，不修死线的话
// 要下行 ≥716kbps 才不超时，慢链路上健康的下载会整体失败。
// ──────────────────────────────────────────────────────────────
describe("rpc expectBytes 记账（14 期需求 3）", () => {
  it("不传 expectBytes 时死线仍恰好是基线 10s（既有调用点行为零变化）", async () => {
    const h = harness();
    const p = h.conn.rpc("git.status", { cwd: "/x" });
    const rejected = p.then(() => "resolved", (e: any) => e.code);
    // 差 1ms 不该超时……
    h.sched.advance(RPC_BASE_TIMEOUT_MS - 1);
    expect((h.conn as any).pending.size).toBe(1);
    // ……整 10s 就该超时。小 rpc 拿到的仍是**恰好** 10s。
    h.sched.advance(1);
    expect(await rejected).toBe("rpc_timeout");
  });

  it("传 expectBytes 时按预期响应体大小放宽死线（满窗下载）", async () => {
    // 单片 56KB（57344B）还在 BASE_COVERED_BYTES(62500) 之内，按 rpcDeadlineMs
    // 的设计本就该拿恰好 10s——**真正会挂掉的是满窗**：16 lane 并发时后面的
    // lane 要等前面的响应体先排空，排队量约 918KB，远超基线覆盖量。
    // 这也正是修复前的失效形状：响应体不入账 ⇒ 16 个 lane 全都以为只排了
    // 16×124B ⇒ 每个都拿恰好 10s ⇒ 下行低于约 716kbps 时健康的下载整体失败。
    const h = harness();
    const len = 56 * 1024;
    const W = 16;
    const ps = Array.from({ length: W }, (_, i) =>
      h.conn.rpc("fs.downloadChunk", { path: "/f", offset: i * len, len }, { expectBytes: len })
        .then(() => "resolved", (e: any) => e.code),
    );
    // 满窗排队量：16 × (请求字节 + 56KB)。
    const queued = (h.conn as any).inflightBytes as number;
    expect(queued).toBeGreaterThan(W * len);
    // 最后发出的那个 lane 的死线 = rpcDeadlineMs(满窗排队量)，必须远超 10s。
    const want = rpcDeadlineMs(queued);
    expect(want, "满窗死线必须超过 10s 基线，否则慢链路上健康的下载会整体失败")
      .toBeGreaterThan(RPC_BASE_TIMEOUT_MS);
    // 基线 10s 处：只有**第一个** lane 该超时——它入队时前面什么都没排，
    // 自己的 56KB 又在基线覆盖量之内，按设计本就拿恰好 10s。其余 15 个都
    // 排在别人后面，必须活过基线。修复前它们会在这一刻全部倒下。
    h.sched.advance(RPC_BASE_TIMEOUT_MS);
    expect((h.conn as any).pending.size, "排在队尾的 lane 必须活过 10s 基线").toBe(W - 1);
    expect(await ps[0]).toBe("rpc_timeout");
    // 走到最后一个 lane 的死线，它才该超时（说明死线确实是按排队量算的）。
    h.sched.advance(want - RPC_BASE_TIMEOUT_MS - 1);
    expect((h.conn as any).pending.size).toBe(1);
    h.sched.advance(1);
    expect(await ps[W - 1]).toBe("rpc_timeout");
    await Promise.all(ps);
  });

  it("结算时把 expectBytes 一并释放，不泄漏 inflightBytes", async () => {
    const h = harness();
    const len = 56 * 1024;
    const p = h.conn.rpc("fs.downloadChunk", { path: "/f", offset: 0, len }, { expectBytes: len });
    expect((h.conn as any).inflightBytes).toBeGreaterThan(len);
    const id = lastRpcId(h);
    h.deliver({ type: "response", id, ok: true, result: {} } as any);
    await p;
    // 完全释放 —— pending 里存的 bytes 已含 expectBytes，releaseRpc 读的是
    // 同一个字段，所以 response/超时/断线三条释放路径自动正确。
    expect((h.conn as any).inflightBytes).toBe(0);
  });
});

// ── 2026-08-19 真机取证：首屏 seed 的 attach 被「预先 attach」吞掉 ───────────
//
// App.svelte 恢复时曾对每个存活标签页先发一次 attach(id)（不带 seq → lastSeq=0），
// 随后 TerminalView 的 seedFromHistory 再发 attach(seq, {seed:true})。真机日志显示
// 服务端只收到前者：整环回放 2384 帧 / 221406B，而后者根本没上线。
// 根因就在下面这条断言里——attach() 的 `subscribed` 提前返回在 seen 覆盖**之后**，
// 于是第二次调用只改记账、不发帧。8 个 tab 各来一份 221KB 就是 1.7MB，直接顶穿
// 服务端 1MB 高水位触发背压丢帧，表现为「同时开 8 个 tmux 重进全空白」。
test("预先 attach 之后，seed attach 只改记账不发帧（故障机理）", () => {
  const h = harness();
  h.conn.attach("work");                       // App 恢复时的预先 attach
  const first = decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any;
  expect(first.type).toBe("attach");
  expect(first.lastSeq).toBe(0);               // 整环回放的源头
  const nAfterFirst = h.sent.length;

  h.conn.attach("work", 4321, { seed: true }); // 快照回来后的 seed attach
  expect(h.sent.length).toBe(nAfterFirst);     // 一个字节都没发出去
});

test("不预先 attach 时，seed attach 带着快照 seq 真的上线", () => {
  const h = harness();
  h.conn.attach("work", 4321, { seed: true }); // TerminalView 挂载后唯一的一次
  const att = decodeClient(new TextDecoder().decode(h.sent[h.sent.length - 1])) as any;
  expect(att.type).toBe("attach");
  expect(att.lastSeq).toBe(4321);              // 服务端只补快照之后的增量
});

// ── seq 缺口检测（2026-08-22）─────────────────────────────────────────────
// 「内容中间少几行、上下都在」靠症状分不清丢在哪一层。seq 是服务端单调递增
// 发的，缺号即丢帧，且能定位到具体区间。
test("seq 跳号时报告缺口，区间与数量都对", () => {
  const h = harness();
  const seen: any[] = [];
  h.conn.onSeqGap((f) => seen.push(f));
  const out = (seq: number) => h.deliver({ type: "output", sessionId: "w", seq, data: toB64(new Uint8Array([65])) } as any);
  out(1); out(2); out(7);          // 3..6 丢了
  expect(seen).toEqual([{ sessionId: "w", expected: 3, got: 7, missing: 4 }]);
});

test("首帧不算缺口 —— prev=0 时服务端从快照 seq 之后开始发，跳号是正常的", () => {
  const h = harness();
  const seen: any[] = [];
  h.conn.onSeqGap((f) => seen.push(f));
  h.deliver({ type: "output", sessionId: "w", seq: 5000, data: toB64(new Uint8Array([65])) } as any);
  expect(seen).toEqual([]);
});

test("重发/乱序不算缺口 —— attach 后必然出现一批 seq<=prev", () => {
  const h = harness();
  const seen: any[] = [];
  h.conn.onSeqGap((f) => seen.push(f));
  const out = (seq: number) => h.deliver({ type: "output", sessionId: "w", seq, data: toB64(new Uint8Array([65])) } as any);
  out(1); out(5); seen.length = 0;  // 清掉 2..4 那条真缺口
  out(3); out(4); out(5);           // 重发，不该再报
  expect(seen).toEqual([]);
});

test("连号不报 —— 正常流不该产生任何噪音", () => {
  const h = harness();
  const seen: any[] = [];
  h.conn.onSeqGap((f) => seen.push(f));
  for (let i = 1; i <= 50; i++) h.deliver({ type: "output", sessionId: "w", seq: i, data: toB64(new Uint8Array([65])) } as any);
  expect(seen).toEqual([]);
});

test("多会话各自记账，互不串扰", () => {
  const h = harness();
  const seen: any[] = [];
  h.conn.onSeqGap((f) => seen.push(f));
  const out = (sid: string, seq: number) => h.deliver({ type: "output", sessionId: sid, seq, data: toB64(new Uint8Array([65])) } as any);
  out("a", 1); out("b", 100); out("a", 2); out("b", 101);
  expect(seen).toEqual([]);        // 两条流各自连续
  out("a", 9);
  expect(seen).toEqual([{ sessionId: "a", expected: 3, got: 9, missing: 6 }]);
});

describe("会话重命名 —— 本地订阅账要跟服务端一起迁（2026-08-26 回归）", () => {
  // 服务端的订阅集**按会话名**记，rename 成功后它把订阅从旧名迁到新名。客户端
  // attach() 有个 `subscribed` 早退守卫（避免重复 attach 白补一遍 backlog），本地这份
  // 账一旦不迁，旧名就永远留在 attached 里，而服务端那侧根本没有它。
  const mk = () => {
    const { sched, advance } = makeFakeScheduler();
    const created: FakeWS[] = [];
    const conn = new Connection({
      url: "ws://x", scheduler: sched, random: () => 0.5,
      wsFactory: () => { const w = new FakeWS(); created.push(w); return w; },
      channelFactory: passthroughInitiator,
    });
    completeHandshake(created[0]!);
    return { conn, created, advance };
  };
  const msgs = (w: FakeWS) => businessSent(w).map((b) => decodeMsg(b) as any);

  it("重命名后用同一个名字新建会话，attach 帧必须真的发出去", () => {
    // 真机症状：重命名 aippt→teachppt 后新建的 aippt「输入什么都不显示，别的窗口正常」。
    // 早退守卫吃掉了 attach 帧 → 服务端没有这个订阅 → 该会话每一帧输出都被丢弃。
    const h = mk();
    h.conn.attach("aippt");
    h.conn.renameSession("aippt", "teachppt");
    h.conn.attach("aippt"); // 同名新会话
    const a = msgs(h.created[0]!).filter((m) => m.type === "attach" && m.sessionId === "aippt");
    expect(a.length).toBe(2); // 重命名前一次、同名新会话一次
    h.conn.dispose();
  });

  it("重命名后重连，flushAndRestore 用新名 attach，不再拿旧名", () => {
    const h = mk();
    h.conn.attach("aippt");
    h.conn.renameSession("aippt", "teachppt");
    h.created[0]!.close();
    h.advance(500);
    completeHandshake(h.created[1]!);
    const ids = msgs(h.created[1]!).filter((m) => m.type === "attach").map((m) => m.sessionId);
    expect(ids).toContain("teachppt");
    expect(ids).not.toContain("aippt");
    h.conn.dispose();
  });

  it("从未 attach 过的会话被重命名，不会凭空订阅新名", () => {
    // rename 失败、或该标签页压根没打开过时，不能自作主张把新名塞进 attached，
    // 否则重连会订阅一个用户根本没在看的会话。
    const h = mk();
    h.conn.renameSession("aippt", "teachppt");
    h.created[0]!.close();
    h.advance(500);
    completeHandshake(h.created[1]!);
    expect(msgs(h.created[1]!).filter((m) => m.type === "attach").length).toBe(0);
    h.conn.dispose();
  });

  it("旧名的 seq 进度要清掉 —— 同名新会话不能拿着旧 seq 去要回放", () => {
    // 服务端的 replay 环同样按名字建，同名新会话是一条从 1 开始的新环。带着旧名的
    // 高 seq 去 attach，开头那几帧会被当成「已经收过」而静默跳过。
    const h = mk();
    h.conn.attach("aippt");
    h.created[0]!.emit(encode({ type: "output", sessionId: "aippt", seq: 42, data: toB64(new Uint8Array([65])) }));
    h.conn.renameSession("aippt", "teachppt");
    h.conn.attach("aippt");
    const a = msgs(h.created[0]!).filter((m) => m.type === "attach" && m.sessionId === "aippt");
    expect(a.length).toBe(2); // 没发出第二个 attach 的话，下面这条断言会空过
    expect(a[1]!.lastSeq).toBe(0);
    h.conn.dispose();
  });
});
