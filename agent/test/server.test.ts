import { test, expect } from "bun:test";
import { startServer } from "../src/server";
import { encode, decodeServer } from "../src/protocol";
import { fromB64 } from "../src/bytes";

const hasTmux = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;

test.skipIf(!hasTmux)("newSession + input round-trips output over WS", async () => {
  const srv = startServer({ port: 0 }); // ephemeral port
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  const outputs: string[] = [];

  await new Promise<void>((res) => (ws.onopen = () => res()));
  ws.onmessage = (ev) => {
    const msg = decodeServer(ev.data as string);
    if (msg.type === "output") {
      outputs.push(new TextDecoder().decode(fromB64(msg.data)));
    }
  };

  const NAME = "pocketshell_ws_test";
  ws.send(encode({ type: "newSession", name: NAME }));
  ws.send(encode({ type: "attach", sessionId: NAME }));
  await Bun.sleep(400);
  ws.send(encode({ type: "input", sessionId: NAME, data: btoa("echo WS_OK\n") }));
  await Bun.sleep(700);

  try {
    expect(outputs.join("")).toContain("WS_OK");
  } finally {
    ws.send(encode({ type: "kill", sessionId: NAME }));
    await Bun.sleep(100); // let the kill flush before tearing down
    ws.close();
    srv.stop();
  }
});

test.skipIf(!hasTmux)("newSession broadcasts a sessions frame including the session", async () => {
  const srv = startServer({ port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  const sessionsFrames: string[][] = [];
  await new Promise<void>((res) => (ws.onopen = () => res()));
  ws.onmessage = (ev) => {
    const msg = decodeServer(ev.data as string);
    if (msg.type === "sessions") sessionsFrames.push(msg.sessions.map((s) => s.name));
  };
  const NAME = "pocketshell_ws_sessions";
  try {
    ws.send(encode({ type: "newSession", name: NAME }));
    await Bun.sleep(300);
    ws.send(encode({ type: "renameSession", sessionId: NAME, name: NAME + "_r" }));
    await Bun.sleep(300);
    const flat = sessionsFrames.flat();
    expect(flat).toContain(NAME);          // seen before rename
    expect(flat).toContain(NAME + "_r");   // seen after rename
  } finally {
    ws.send(encode({ type: "kill", sessionId: NAME + "_r" }));
    await Bun.sleep(100);
    ws.close();
    srv.stop();
  }
});

test("listSessions on an empty agent returns an empty sessions frame", async () => {
  const srv = startServer({ port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  let got: string[] | null = null;
  await new Promise<void>((res) => (ws.onopen = () => res()));
  ws.onmessage = (ev) => {
    const msg = decodeServer(ev.data as string);
    if (msg.type === "sessions") got = msg.sessions.map((s) => s.name);
  };
  ws.send(encode({ type: "listSessions" }));
  await Bun.sleep(150);
  expect(got).toEqual([]);
  ws.close();
  srv.stop();
});

test("attach with an evicted lastSeq sends a resync before backfill frames", async () => {
  const { ReplayService } = await import("../src/replay");
  const replay = new ReplayService(2); // tiny cap forces a gap
  const enc = new TextEncoder();
  replay.ingest("x", enc.encode("a")); // seq1
  replay.ingest("x", enc.encode("b")); // seq2
  replay.ingest("x", enc.encode("c")); // seq3 -> buffer[2,3]
  replay.ingest("x", enc.encode("d")); // seq4 -> buffer[3,4], oldest=3
  const srv = startServer({ port: 0, replay });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  const got: any[] = [];
  await new Promise<void>((res) => (ws.onopen = () => res()));
  ws.onmessage = (ev) => got.push(decodeServer(ev.data as string));
  ws.send(encode({ type: "attach", sessionId: "x", lastSeq: 1 }));
  await Bun.sleep(150);
  const resync = got.find((m) => m.type === "resync");
  expect(resync).toEqual({ type: "resync", sessionId: "x", from: 3 });
  const outSeqs = got.filter((m) => m.type === "output").map((m) => m.seq);
  expect(outSeqs).toEqual([3, 4]);
  ws.close();
  srv.stop();
});

test("attach within buffer sends no resync", async () => {
  const { ReplayService } = await import("../src/replay");
  const replay = new ReplayService();
  const enc = new TextEncoder();
  replay.ingest("y", enc.encode("a")); // seq1
  replay.ingest("y", enc.encode("b")); // seq2
  const srv = startServer({ port: 0, replay });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  const got: any[] = [];
  await new Promise<void>((res) => (ws.onopen = () => res()));
  ws.onmessage = (ev) => got.push(decodeServer(ev.data as string));
  ws.send(encode({ type: "attach", sessionId: "y", lastSeq: 1 }));
  await Bun.sleep(150);
  expect(got.some((m) => m.type === "resync")).toBe(false);
  expect(got.filter((m) => m.type === "output").map((m) => m.seq)).toEqual([2]);
  ws.close();
  srv.stop();
});

test("ping is answered with pong", async () => {
  const srv = startServer({ port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  const got: any[] = [];
  await new Promise<void>((res) => (ws.onopen = () => res()));
  ws.onmessage = (ev) => got.push(decodeServer(ev.data as string));
  ws.send(encode({ type: "ping" }));
  await Bun.sleep(100);
  expect(got.some((m) => m.type === "pong")).toBe(true);
  ws.close();
  srv.stop();
});
