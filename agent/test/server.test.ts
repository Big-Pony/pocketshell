import { test, expect } from "bun:test";
import { startServer } from "../src/server";
import { encode, decodeServer } from "../src/protocol";
import { fromB64 } from "../src/bytes";
import { TerminalService } from "../src/terminal";
import type { SecureChannel } from "../src/secure-channel";

// passthrough responder: identical to the one in src/server.test.ts
// first frame → handshake established; subsequent frames → plaintext message; send(pt)→pt
const M2 = new Uint8Array([2]);
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

// Helper: open a passthrough-secured WS, perform the marker handshake,
// then return the socket ready for business frames.
async function openHandshakedWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((res) => (ws.onopen = () => res()));
  // perform marker handshake: send dummy M1, server replies M2 (handshake established)
  await new Promise<void>((res) => {
    ws.onmessage = () => res();
    ws.send(new Uint8Array([1]));
  });
  // switch to text-mode handler for JSON business frames
  ws.onmessage = null;
  return ws;
}

// Helper: send a business frame as binary (UTF-8 encoded JSON) and collect a response
function sendBinary(ws: WebSocket, jsonStr: string) {
  ws.send(new Uint8Array(Buffer.from(jsonStr, "utf8")));
}

// Business-frame messages come back as binary (Uint8Array / ArrayBuffer) in passthrough mode
function parseFrame(ev: MessageEvent): ReturnType<typeof decodeServer> {
  const data = ev.data;
  if (data instanceof ArrayBuffer) return decodeServer(Buffer.from(data).toString("utf8"));
  if (data instanceof Uint8Array) return decodeServer(Buffer.from(data).toString("utf8"));
  return decodeServer(data as string);
}

const hasTmux = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;

test.skipIf(!hasTmux)("newSession + input round-trips output over WS", async () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  const outputs: string[] = [];
  ws.onmessage = (ev) => {
    const msg = parseFrame(ev);
    if (msg.type === "output") {
      outputs.push(new TextDecoder().decode(fromB64(msg.data)));
    }
  };

  const NAME = "pocketshell_ws_test";
  sendBinary(ws, encode({ type: "newSession", name: NAME }));
  sendBinary(ws, encode({ type: "attach", sessionId: NAME }));
  await Bun.sleep(400);
  sendBinary(ws, encode({ type: "input", sessionId: NAME, data: btoa("echo WS_OK\n") }));
  await Bun.sleep(700);

  try {
    expect(outputs.join("")).toContain("WS_OK");
  } finally {
    sendBinary(ws, encode({ type: "kill", sessionId: NAME }));
    await Bun.sleep(100);
    ws.close();
    srv.stop();
  }
});

test.skipIf(!hasTmux)("newSession broadcasts a sessions frame including the session", async () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  const sessionsFrames: string[][] = [];
  ws.onmessage = (ev) => {
    const msg = parseFrame(ev);
    if (msg.type === "sessions") sessionsFrames.push(msg.sessions.map((s) => s.name));
  };
  const NAME = "pocketshell_ws_sessions";
  try {
    sendBinary(ws, encode({ type: "newSession", name: NAME }));
    await Bun.sleep(300);
    sendBinary(ws, encode({ type: "renameSession", sessionId: NAME, name: NAME + "_r" }));
    await Bun.sleep(300);
    const flat = sessionsFrames.flat();
    expect(flat).toContain(NAME);
    expect(flat).toContain(NAME + "_r");
  } finally {
    sendBinary(ws, encode({ type: "kill", sessionId: NAME + "_r" }));
    await Bun.sleep(100);
    ws.close();
    srv.stop();
  }
});

const emptyTmux = () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });

test("listSessions on an empty agent returns an empty sessions frame", async () => {
  const terminal = new TerminalService({ tmux: emptyTmux });
  const srv = startServer({ port: 0, channelFactory: passthroughResponder, terminal });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  let got: string[] | null = null;
  ws.onmessage = (ev) => {
    const msg = parseFrame(ev);
    if (msg.type === "sessions") got = msg.sessions.map((s) => s.name);
  };
  sendBinary(ws, encode({ type: "listSessions" }));
  await Bun.sleep(150);
  expect(got).toEqual([]);
  ws.close();
  srv.stop();
});

test("attach with an evicted lastSeq sends a resync before backfill frames", async () => {
  const { ReplayService } = await import("../src/replay");
  const replay = new ReplayService(2);
  const enc = new TextEncoder();
  replay.ingest("x", enc.encode("a")); // seq1
  replay.ingest("x", enc.encode("b")); // seq2
  replay.ingest("x", enc.encode("c")); // seq3
  replay.ingest("x", enc.encode("d")); // seq4 -> oldest=3
  const srv = startServer({ port: 0, replay, channelFactory: passthroughResponder });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  const got: any[] = [];
  ws.onmessage = (ev) => got.push(parseFrame(ev));
  sendBinary(ws, encode({ type: "attach", sessionId: "x", lastSeq: 1 }));
  await Bun.sleep(150);
  const resync = got.find((m) => m.type === "resync");
  expect(resync).toEqual({ type: "resync", sessionId: "x", from: 3 });
  const outSeqs = got.filter((m) => m.type === "output").map((m) => m.seq);
  expect(outSeqs).toEqual([3, 4]);
  const resyncIdx = got.findIndex((m) => m.type === "resync");
  const firstOutputIdx = got.findIndex((m) => m.type === "output");
  expect(resyncIdx).toBeLessThan(firstOutputIdx);
  ws.close();
  srv.stop();
});

test("attach within buffer sends no resync", async () => {
  const { ReplayService } = await import("../src/replay");
  const replay = new ReplayService();
  const enc = new TextEncoder();
  replay.ingest("y", enc.encode("a")); // seq1
  replay.ingest("y", enc.encode("b")); // seq2
  const srv = startServer({ port: 0, replay, channelFactory: passthroughResponder });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  const got: any[] = [];
  ws.onmessage = (ev) => got.push(parseFrame(ev));
  sendBinary(ws, encode({ type: "attach", sessionId: "y", lastSeq: 1 }));
  await Bun.sleep(150);
  expect(got.some((m) => m.type === "resync")).toBe(false);
  expect(got.filter((m) => m.type === "output").map((m) => m.seq)).toEqual([2]);
  ws.close();
  srv.stop();
});

test("ping is answered with pong", async () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  const got: any[] = [];
  ws.onmessage = (ev) => got.push(parseFrame(ev));
  sendBinary(ws, encode({ type: "ping" }));
  await Bun.sleep(100);
  expect(got.some((m) => m.type === "pong")).toBe(true);
  ws.close();
  srv.stop();
});
