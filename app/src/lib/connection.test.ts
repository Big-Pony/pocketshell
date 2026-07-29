import { test, expect, vi } from "vitest";
import { Connection, rpcDeadlineMs, RPC_BASE_TIMEOUT_MS, RPC_MAX_TIMEOUT_MS, type WebSocketLike, type Scheduler } from "./connection";
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
