import { test, expect, vi } from "vitest";
import { Connection, type WebSocketLike, type Scheduler } from "./connection";
import { encode, decodeClient, type ServerMsg } from "./protocol";

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
