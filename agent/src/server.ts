// A3 (slice-1, plaintext): a Bun WebSocket server wiring the wire protocol to
// TerminalService (A2) + ReplayService (A4). Noise handshake + pairing land in
// a later slice; the message shapes here are the frozen contract from A3 §3.
import type { ServerWebSocket } from "bun";
import { loadConfig, type AgentConfig } from "./config";
import { TerminalService } from "./terminal";
import { ReplayService } from "./replay";
import { decodeClient, encode, type ServerMsg } from "./protocol";
import { toB64, fromB64 } from "./bytes";

interface Deps {
  port?: number;
  config?: AgentConfig;
  terminal?: TerminalService;
  replay?: ReplayService;
}

export function startServer(deps: Deps = {}) {
  const config = deps.config ?? loadConfig();
  const terminal = deps.terminal ?? new TerminalService();
  const replay = deps.replay ?? new ReplayService(config.replayBufferBytes);

  // All currently-open sockets (slice 1: broadcast output to every socket; a
  // later slice scopes delivery to the sockets that attached each session).
  const sockets = new Set<ServerWebSocket<unknown>>();

  const send = (ws: ServerWebSocket<unknown>, msg: ServerMsg) =>
    ws.send(encode(msg));

  // Number every output chunk, then fan out to attached clients.
  terminal.onOutput((name, chunk) => {
    const frame = replay.ingest(name, chunk);
    const out = encode({ type: "output", sessionId: name, seq: frame.seq, data: toB64(chunk) });
    for (const ws of sockets) ws.send(out);
  });
  terminal.onExit((name, code) => {
    for (const ws of sockets) send(ws, { type: "exit", sessionId: name, code });
  });

  const pushSessions = () => {
    const out = encode({ type: "sessions", sessions: terminal.list() });
    for (const ws of sockets) ws.send(out);
  };
  terminal.onSessionsChange(pushSessions);

  const server = Bun.serve({
    hostname: config.listen.host,
    port: deps.port ?? config.listen.port,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("PocketShell agent — WebSocket only", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        let msg;
        try {
          msg = decodeClient(String(raw));
        } catch {
          send(ws, { type: "error", code: "bad_json", message: "malformed message" });
          return;
        }
        switch (msg.type) {
          case "newSession":
            try {
              terminal.ensure(msg.name, { cmd: msg.cmd, cwd: msg.cwd });
            } catch (e) {
              send(ws, { type: "error", code: "ensure_failed", message: String(e) });
            }
            break;
          case "listSessions":
            send(ws, { type: "sessions", sessions: terminal.list() });
            break;
          case "renameSession":
            try {
              terminal.rename(msg.sessionId, msg.name);
            } catch (e) {
              send(ws, { type: "error", code: "rename_failed", message: String(e) });
            }
            break;
          case "attach": {
            const { frames, gap, oldestSeq } = replay.since(msg.sessionId, msg.lastSeq ?? 0);
            if (gap) send(ws, { type: "resync", sessionId: msg.sessionId, from: oldestSeq });
            for (const f of frames) {
              send(ws, { type: "output", sessionId: f.sessionId, seq: f.seq, data: toB64(f.data) });
            }
            break;
          }
          case "input":
            terminal.write(msg.sessionId, fromB64(msg.data));
            break;
          case "resize":
            terminal.resize(msg.sessionId, msg.cols, msg.rows);
            break;
          case "kill":
            void terminal.kill(msg.sessionId);
            break;
          case "ping":
            send(ws, { type: "pong" });
            break;
          default:
            send(ws, { type: "error", code: "unknown_type", message: "unknown message type" });
            break;
        }
      },
    },
  });

  return {
    port: server.port,
    stop() {
      terminal.dispose();
      server.stop(true);
    },
  };
}

// Allow `bun run src/server.ts` to boot directly.
if (import.meta.main) {
  const s = startServer();
  console.log(`[pocketshell] agent listening on :${s.port}`);
}
