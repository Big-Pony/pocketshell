import { test, expect } from "vitest";
import { Connection, type WebSocketLike, type Scheduler } from "../src/lib/connection";
import { encode } from "../src/lib/protocol";
import { toB64 } from "../src/lib/bytes";
import type { SecureChannel } from "../src/lib/secure-channel";
import type { SessionMeta } from "../src/lib/protocol";
import { applyPairing, getPendingPair } from "../src/lib/keystore";

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
  send(data: Uint8Array) { this.sent.push(data); }
  close() { this.onclose?.(); }
  // fire a bytes frame as if the server sent it
  fire(b: Uint8Array) {
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
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
  const sched: Scheduler = {
    setTimeout: (fn, ms) => { const id = nextId++; timeouts.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { every: ms, next: t + ms, fn }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    now: () => t,
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
  const meta: SessionMeta = { name: "s1", state: "run", cols: 80, rows: 24, lastLine: "hi", createdAt: 0 };
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
