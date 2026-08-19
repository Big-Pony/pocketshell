// WP-2a behaviour tests: A2 output batching at the server boundary, A3
// subscription fan-out, A6 backpressure drop + resync. Uses the same
// passthrough-channel / fake-ws harness as src/server.test.ts.
import { test, expect } from "bun:test";
import { startServer } from "./server";
import type { SecureChannel } from "./secure-channel";
import { encode, decodeServer } from "./protocol";
import { ReplayService, GAP_BACKFILL_BUDGET_BYTES } from "./replay";
import { TerminalService } from "./terminal";
import { fromB64 } from "./bytes";

const M1 = new Uint8Array([1]);
const M2 = new Uint8Array([2]);
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const b = (s: string) => new TextEncoder().encode(s);

// passthrough responder: identical to the one in src/server.test.ts
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

// Fake ServerWebSocket for the backpressure tests.
//
// The queued-bytes accessor MUST mirror the real Bun `ServerWebSocket`, which
// exposes a `getBufferedAmount()` METHOD and has NO `bufferedAmount` property.
// This double used to carry a plain `bufferedAmount` field; production read
// that field, got `undefined` on a real socket, and the entire A6 backpressure
// path was dead for two weeks while these tests stayed green. Tests set the
// level via `setBufferedAmount(n)`; production only ever calls the getter.
// `wsContract()` at the bottom of this file pins the shape against a real
// socket so the two can't drift apart again.
function fakeWs() {
  const sent: Uint8Array[] = [];
  let buffered = 0;
  return {
    sent,
    /** test-only knob; not part of the ServerWebSocket surface */
    setBufferedAmount(n: number) { buffered = n; },
    getBufferedAmount() { return buffered; },
    send(d: Uint8Array | string) { sent.push(typeof d === "string" ? utf8(d) : d); },
    close() {},
  };
}

type FakeWs = ReturnType<typeof fakeWs>;

function openReady(srv: ReturnType<typeof startServer>, ws: FakeWs) {
  srv.__test.open(ws as any);
  srv.__test.message(ws as any, M1); // marker handshake -> ready
  ws.sent.length = 0;
}

function attach(srv: ReturnType<typeof startServer>, ws: FakeWs, sessionId: string, lastSeq?: number) {
  srv.__test.message(ws as any, utf8(encode({ type: "attach", sessionId, lastSeq })));
  ws.sent.length = 0; // discard any backfill frames; tests assert live frames only
}

const frames = (ws: FakeWs) => ws.sent.map((f) => decodeServer(Buffer.from(f).toString("utf8")));
const outputs = (ws: FakeWs) => frames(ws).filter((m) => m.type === "output");

// --- A2: batching at the server boundary -----------------------------------

test("A2: bursts within the window become ONE output frame (one seq, concatenated bytes)", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  attach(srv, ws, "s");
  srv.__test.emitOutput("s", b("ab"));
  srv.__test.emitOutput("s", b("cd"));
  expect(ws.sent.length).toBe(0); // nothing before the window closes
  srv.__test.flushOutput("s");
  const out = outputs(ws);
  expect(out.length).toBe(1);
  if (out[0].type === "output") {
    expect(out[0].seq).toBe(1);
    expect(Buffer.from(fromB64(out[0].data)).toString()).toBe("abcd");
  }
  srv.stop();
});

test("A2: exit flushes the session's tail bytes before the exit notice", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  attach(srv, ws, "s");
  srv.__test.emitOutput("s", b("tail"));
  srv.__test.emitExit("s", 0); // must flush "tail" first, then send exit
  const got = frames(ws);
  expect(got.map((m) => m.type)).toEqual(["output", "exit"]);
  srv.stop();
});

// --- A3: subscription fan-out ----------------------------------------------

test("A3: output is delivered only to conns that attached the session", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const wsA = fakeWs();
  const wsB = fakeWs();
  openReady(srv, wsA);
  openReady(srv, wsB);
  attach(srv, wsA, "s"); // only A subscribes
  srv.__test.emitOutput("s", b("x"));
  srv.__test.flushOutput("s");
  expect(outputs(wsA).length).toBe(1);
  expect(wsB.sent.length).toBe(0);
  srv.stop();
});

test("A3: detach unsubscribes — output and exit stop for that conn only", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const wsA = fakeWs();
  const wsB = fakeWs();
  openReady(srv, wsA);
  openReady(srv, wsB);
  attach(srv, wsA, "s");
  attach(srv, wsB, "s");
  srv.__test.message(wsA as any, utf8(encode({ type: "detach", sessionId: "s" })));
  srv.__test.emitOutput("s", b("x"));
  srv.__test.flushOutput("s");
  expect(outputs(wsA).length).toBe(0);
  expect(outputs(wsB).length).toBe(1);
  srv.__test.emitExit("s", 0);
  expect(frames(wsA).some((m) => m.type === "exit")).toBe(false);
  expect(frames(wsB).some((m) => m.type === "exit")).toBe(true);
  srv.stop();
});

test("A3: rename moves the subscription so output keeps flowing under the new name", () => {
  // Stub tmux so rename-session succeeds without a real session.
  const emptyTmux = () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });
  const terminal = new TerminalService({ tmux: emptyTmux });
  const srv = startServer({ port: 0, channelFactory: passthroughResponder, terminal });
  const ws = fakeWs();
  openReady(srv, ws);
  attach(srv, ws, "old");
  srv.__test.message(ws as any, utf8(encode({ type: "renameSession", sessionId: "old", name: "new" })));
  ws.sent.length = 0;
  srv.__test.emitOutput("new", b("x"));
  srv.__test.flushOutput("new");
  expect(outputs(ws).length).toBe(1);
  srv.stop();
});

// --- A6: backpressure --------------------------------------------------------

test("A6: a backed-up conn drops output frames, then earns a resync after the buffer drains", () => {
  const replay = new ReplayService();
  const srv = startServer({ port: 0, replay, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  attach(srv, ws, "s");
  ws.setBufferedAmount(2 * 1024 * 1024); // above the 1MB high water
  srv.__test.emitOutput("s", b("dropped"));
  srv.__test.flushOutput("s");
  expect(outputs(ws).length).toBe(0); // frame dropped for this conn
  ws.setBufferedAmount(0); // socket drained
  srv.__test.drain(ws as any);
  const rs = frames(ws).filter((m) => m.type === "resync");
  expect(rs).toEqual([{ type: "resync", sessionId: "s", from: 1 }]);
  // The dropped bytes live on in replay: a re-attach backfills them (seq continuity).
  srv.__test.message(ws as any, utf8(encode({ type: "attach", sessionId: "s", lastSeq: 0 })));
  const backfill = outputs(ws);
  expect(backfill.length).toBe(1);
  if (backfill[0].type === "output") {
    expect(backfill[0].seq).toBe(1);
    expect(Buffer.from(fromB64(backfill[0].data)).toString()).toBe("dropped");
  }
  srv.stop();
});

test("A6: delivery resumes after the resync, with seq continuing untouched", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  attach(srv, ws, "s");
  srv.__test.emitOutput("s", b("a"));
  srv.__test.flushOutput("s"); // seq1 delivered normally
  ws.setBufferedAmount(2 * 1024 * 1024);
  srv.__test.emitOutput("s", b("b"));
  srv.__test.flushOutput("s"); // seq2 dropped
  ws.setBufferedAmount(0);
  srv.__test.drain(ws as any); // resync for the hole
  srv.__test.emitOutput("s", b("c"));
  srv.__test.flushOutput("s"); // seq3 delivered normally again
  const got = frames(ws);
  expect(got.map((m) => m.type)).toEqual(["output", "resync", "output"]);
  expect(outputs(ws).map((m) => (m.type === "output" ? m.seq : 0))).toEqual([1, 3]);
  srv.stop();
});

test("A6: hysteresis — no resync while the buffer is still above the low water mark", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  attach(srv, ws, "s");
  ws.setBufferedAmount(2 * 1024 * 1024);
  srv.__test.emitOutput("s", b("x"));
  srv.__test.flushOutput("s"); // dropped
  ws.setBufferedAmount(512 * 1024); // below high water but above the 256KB low water
  srv.__test.drain(ws as any);
  expect(frames(ws).some((m) => m.type === "resync")).toBe(false);
  ws.setBufferedAmount(128 * 1024); // now below low water
  srv.__test.drain(ws as any);
  expect(frames(ws).some((m) => m.type === "resync")).toBe(true);
  srv.stop();
});

test("A6: control messages still reach a backed-up conn (only output frames are dropped)", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  attach(srv, ws, "s");
  ws.setBufferedAmount(2 * 1024 * 1024);
  srv.__test.message(ws as any, utf8(encode({ type: "ping" })));
  expect(frames(ws).some((m) => m.type === "pong")).toBe(true);
  srv.stop();
});

test("A6: a detached session earns no resync after drain", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  attach(srv, ws, "s");
  ws.setBufferedAmount(2 * 1024 * 1024);
  srv.__test.emitOutput("s", b("x"));
  srv.__test.flushOutput("s"); // dropped, session flagged for resync
  srv.__test.message(ws as any, utf8(encode({ type: "detach", sessionId: "s" })));
  ws.setBufferedAmount(0);
  srv.__test.drain(ws as any);
  expect(frames(ws).some((m) => m.type === "resync")).toBe(false);
  srv.stop();
});

// --- Guard: the fake WS must not drift away from Bun's real ServerWebSocket ---
//
// Backstory (do not delete these tests): A6 above was dead code from 2026-07-18
// to 2026-08-03 because server.ts read `conn.ws.bufferedAmount`, a property Bun's
// SERVER-side socket does not have (that's the browser/client `WebSocket` API —
// the server one only offers `getBufferedAmount()`). It read `undefined`, `?? 0`
// turned it into a constant 0, and every drop/resync branch became unreachable.
// The tests above stayed green the whole time because the double invented a
// `bufferedAmount` field that only existed in the tests. Nothing compared the
// double to the real thing, so nobody noticed.
//
// The three tests below close that hole from both sides: they pin the real API
// shape, pin the double against it, and run production against a socket that
// REFUSES any member the real socket doesn't have.

/** The socket members src/server.ts actually touches (grep `conn.ws.` / `ws.`). */
const PROD_WS_MEMBERS = ["send", "close", "getBufferedAmount"] as const;
/** Knobs that belong to the double only — never touched by production. */
const TEST_ONLY_MEMBERS = new Set(["sent", "setBufferedAmount"]);

/** Boot a throwaway Bun WS server and hand the live server-side socket to `fn`. */
async function withRealServerSocket<T>(fn: (ws: any) => T): Promise<T> {
  let resolveSock: (ws: any) => void;
  const sock = new Promise<any>((r) => { resolveSock = r; });
  const srv = Bun.serve({
    port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response("no"); },
    websocket: { open(ws) { resolveSock(ws); }, message() {} },
  });
  const client = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  try {
    const ws = await Promise.race([
      sock,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no ws upgrade in 5s")), 5000)),
    ]);
    return fn(ws);
  } finally {
    client.close();
    srv.stop(true);
  }
}

test("guard: Bun's real ServerWebSocket exposes getBufferedAmount() and has NO bufferedAmount property", async () => {
  await withRealServerSocket((ws) => {
    // The method production must use.
    expect(typeof ws.getBufferedAmount).toBe("function");
    expect(typeof ws.getBufferedAmount()).toBe("number");
    // The property production must NOT use — absent, so reading it yields
    // `undefined` and any `?? 0` fallback silently becomes a constant 0.
    expect("bufferedAmount" in ws).toBe(false);
    expect(ws.bufferedAmount).toBeUndefined();
  });
});

test("guard: fakeWs() matches the real ServerWebSocket on every member production uses", async () => {
  await withRealServerSocket((real) => {
    const fake = fakeWs() as any;
    for (const m of PROD_WS_MEMBERS) {
      expect(`${m}:${typeof real[m]}`).toBe(`${m}:function`);        // real has it
      expect(`${m}:${typeof fake[m]}`).toBe(`${m}:function`);        // so must the double
    }
    // A `bufferedAmount` field on the double is exactly the drift that hid the
    // bug: it makes production's wrong read look like it works.
    expect("bufferedAmount" in fake).toBe(false);
    // And the double must not sprout members the real socket lacks.
    for (const k of Object.keys(fake)) {
      if (TEST_ONLY_MEMBERS.has(k)) continue;
      expect(`${k} on real socket: ${k in real}`).toBe(`${k} on real socket: true`);
    }
  });
});

test("guard: backpressure works against a socket that refuses non-existent members (real shape)", async () => {
  // Captures the real socket's member names, then runs the drop+resync scenario
  // through a double that THROWS on any other property read. If server.ts ever
  // goes back to `conn.ws.bufferedAmount` (or reaches for any other invented
  // member), this test throws instead of silently passing.
  const realMembers = await withRealServerSocket(
    (ws) => new Set<string>(Object.getOwnPropertyNames(Object.getPrototypeOf(ws))),
  );
  expect(realMembers.has("getBufferedAmount")).toBe(true);
  expect(realMembers.has("bufferedAmount")).toBe(false);

  const inner = fakeWs();
  const strictWs = new Proxy(inner as any, {
    get(target, prop, recv) {
      if (typeof prop === "string" && !realMembers.has(prop) && !TEST_ONLY_MEMBERS.has(prop)
          && prop !== "then" && prop !== "constructor") {
        throw new Error(
          `server.ts read ws.${prop}, which Bun's ServerWebSocket does not have ` +
          `(members: ${[...realMembers].sort().join(", ")})`,
        );
      }
      return Reflect.get(target, prop, recv);
    },
  }) as FakeWs;

  const replay = new ReplayService();
  const srv = startServer({ port: 0, replay, channelFactory: passthroughResponder });
  openReady(srv, strictWs);
  attach(srv, strictWs, "s");
  strictWs.setBufferedAmount(2 * 1024 * 1024); // backed up, via the REAL accessor only
  srv.__test.emitOutput("s", b("dropped"));
  srv.__test.flushOutput("s");
  expect(outputs(strictWs).length).toBe(0); // the drop branch really ran
  strictWs.setBufferedAmount(0);
  srv.__test.drain(strictWs as any);
  expect(frames(strictWs).filter((m) => m.type === "resync"))
    .toEqual([{ type: "resync", sessionId: "s", from: 1 }]);
  srv.stop();
});

// --- gap 补发限量 + attach 埋点（2026-08-19，见 docs/域/终端与会话.md「断线重放」）

test("attach with a gap backfills only the newest frames within the budget, not the whole ring", () => {
  // 环容量远大于预算：制造一个「有 gap 且积压远超一屏」的局面。
  const replay = new ReplayService(1024 * 1024);
  const srv = startServer({ port: 0, replay, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  // 200 帧 × 4KB = 800KB 积压，全部在环里（没被驱逐）。
  for (let i = 0; i < 200; i++) replay.ingest("s", new Uint8Array(4096));
  // lastSeq=0 但 oldestSeq=1 → 无 gap，这一支必须完整补齐（回归护栏在下一条）。
  // 这里手工驱逐出 gap：再灌到超过 cap。
  const replay2 = new ReplayService(64 * 1024);
  const srv2 = startServer({ port: 0, replay: replay2, channelFactory: passthroughResponder });
  const ws2 = fakeWs();
  openReady(srv2, ws2);
  for (let i = 0; i < 200; i++) replay2.ingest("t", new Uint8Array(4096));
  srv2.__test.message(ws2 as any, utf8(encode({ type: "attach", sessionId: "t", lastSeq: 1 })));
  const got = frames(ws2);
  expect(got.some((m) => m.type === "resync")).toBe(true);
  const outs = got.filter((m) => m.type === "output");
  // 环里有 16 帧（64KB / 4KB），预算只放得下 3 帧（12KB <= 16KB）。
  expect(outs.length).toBeGreaterThan(0);      // 必须仍发帧：seen 要能推进
  expect(outs.length).toBeLessThan(16);        // 但绝不是整环
  const bytes = outs.reduce((n, m) => n + (m.type === "output" ? fromB64(m.data).byteLength : 0), 0);
  expect(bytes).toBeLessThanOrEqual(GAP_BACKFILL_BUDGET_BYTES);
  // 发的必须是**最新**的那几帧（含 latestSeq），否则 seen 推不到当前进度。
  const seqs = outs.map((m) => (m.type === "output" ? m.seq : 0));
  expect(seqs.at(-1)).toBe(replay2.latestSeq("t"));
  srv.stop(); srv2.stop();
});

test("attach WITHOUT a gap still backfills the complete backlog (budget must not touch this path)", () => {
  const replay = new ReplayService(1024 * 1024);
  const srv = startServer({ port: 0, replay, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  // 100 帧 × 4KB = 400KB，远超 gap 预算，但没有驱逐 → 无 gap → 必须一帧不少。
  for (let i = 0; i < 100; i++) replay.ingest("u", new Uint8Array(4096));
  srv.__test.message(ws as any, utf8(encode({ type: "attach", sessionId: "u", lastSeq: 0 })));
  const got = frames(ws);
  expect(got.some((m) => m.type === "resync")).toBe(false);
  expect(got.filter((m) => m.type === "output").length).toBe(100);
  srv.stop();
});

test("attach logs one diag line with {sessionId,lastSeq,gap,frames,bytes}", () => {
  const replay = new ReplayService(64 * 1024);
  const srv = startServer({ port: 0, replay, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  for (let i = 0; i < 200; i++) replay.ingest("v", new Uint8Array(4096));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    srv.__test.message(ws as any, utf8(encode({ type: "attach", sessionId: "v", lastSeq: 1 })));
  } finally { console.log = orig; }
  const diag = lines.filter((l) => l.startsWith("[pocketshell:diag]"));
  expect(diag.length).toBe(1);
  const body = JSON.parse(diag[0].slice("[pocketshell:diag]".length).trim());
  expect(body.kind).toBe("attach");
  expect(body.tag).toBe("v");
  expect(body.lastSeq).toBe(1);
  expect(body.gap).toBe(true);
  expect(typeof body.frames).toBe("number");
  expect(typeof body.bytes).toBe("number");
  // 埋点记的必须是**实际发出去**的量，否则修复效果无从验证。
  const outs = frames(ws).filter((m) => m.type === "output");
  expect(body.frames).toBe(outs.length);
  expect(body.bytes).toBe(outs.reduce((n, m) => n + (m.type === "output" ? fromB64(m.data).byteLength : 0), 0));
  srv.stop();
});
