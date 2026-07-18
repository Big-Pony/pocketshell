// WP-2a behaviour tests: A2 output batching at the server boundary, A3
// subscription fan-out, A6 backpressure drop + resync. Uses the same
// passthrough-channel / fake-ws harness as src/server.test.ts.
import { test, expect } from "bun:test";
import { startServer } from "./server";
import type { SecureChannel } from "./secure-channel";
import { encode, decodeServer } from "./protocol";
import { ReplayService } from "./replay";
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

// fake ServerWebSocket with a settable bufferedAmount for backpressure tests
function fakeWs() {
  const sent: Uint8Array[] = [];
  return {
    sent,
    bufferedAmount: 0,
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
  ws.bufferedAmount = 2 * 1024 * 1024; // above the 1MB high water
  srv.__test.emitOutput("s", b("dropped"));
  srv.__test.flushOutput("s");
  expect(outputs(ws).length).toBe(0); // frame dropped for this conn
  ws.bufferedAmount = 0; // socket drained
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
  ws.bufferedAmount = 2 * 1024 * 1024;
  srv.__test.emitOutput("s", b("b"));
  srv.__test.flushOutput("s"); // seq2 dropped
  ws.bufferedAmount = 0;
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
  ws.bufferedAmount = 2 * 1024 * 1024;
  srv.__test.emitOutput("s", b("x"));
  srv.__test.flushOutput("s"); // dropped
  ws.bufferedAmount = 512 * 1024; // below high water but above the 256KB low water
  srv.__test.drain(ws as any);
  expect(frames(ws).some((m) => m.type === "resync")).toBe(false);
  ws.bufferedAmount = 128 * 1024; // now below low water
  srv.__test.drain(ws as any);
  expect(frames(ws).some((m) => m.type === "resync")).toBe(true);
  srv.stop();
});

test("A6: control messages still reach a backed-up conn (only output frames are dropped)", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  attach(srv, ws, "s");
  ws.bufferedAmount = 2 * 1024 * 1024;
  srv.__test.message(ws as any, utf8(encode({ type: "ping" })));
  expect(frames(ws).some((m) => m.type === "pong")).toBe(true);
  srv.stop();
});

test("A6: a detached session earns no resync after drain", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  openReady(srv, ws);
  attach(srv, ws, "s");
  ws.bufferedAmount = 2 * 1024 * 1024;
  srv.__test.emitOutput("s", b("x"));
  srv.__test.flushOutput("s"); // dropped, session flagged for resync
  srv.__test.message(ws as any, utf8(encode({ type: "detach", sessionId: "s" })));
  ws.bufferedAmount = 0;
  srv.__test.drain(ws as any);
  expect(frames(ws).some((m) => m.type === "resync")).toBe(false);
  srv.stop();
});
