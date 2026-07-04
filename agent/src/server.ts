// A3 (slice-1, plaintext): a Bun WebSocket server wiring the wire protocol to
// TerminalService (A2) + ReplayService (A4). Noise handshake + pairing land in
// a later slice; the message shapes here are the frozen contract from A3 §3.
// S4a: wrapped in SecureChannel handshake — plaintext message loop unchanged.
// S4b: in-channel pairing — pending state, pair verify, registry∪env authorize.
import type { ServerWebSocket } from "bun";
import { loadConfig, type AgentConfig, resolveTlsMaterial, buildPairingString } from "./config";
import { TerminalService } from "./terminal";
import { ReplayService } from "./replay";
import { decodeClient, encode, type ServerMsg, type DeviceInfo } from "./protocol";
import { toB64, fromB64 } from "./bytes";
import { createResponderChannel, type SecureChannel } from "./secure-channel";

interface Deps {
  port?: number;
  config?: AgentConfig;
  terminal?: TerminalService;
  replay?: ReplayService;
  channelFactory?: () => SecureChannel;
  pairTimeoutMs?: number;
}

export function startServer(deps: Deps = {}) {
  const config = deps.config ?? loadConfig();
  const terminal = deps.terminal ?? new TerminalService();
  const replay = deps.replay ?? new ReplayService(config.replayBufferBytes);

  const envKeys = new Set(config.authorizedKeys);
  const authorize = (pub: string): "authorized" | "pending" | "reject" => {
    if (config.registry.has(pub) || envKeys.has(pub)) return "authorized";
    // Admit an unregistered peer to the pending window only while the pairing
    // code is still live (not consumed/expired). Once spent, unregistered peers
    // are rejected at the handshake rather than kept admissible for the whole
    // process lifetime.
    if (config.pairingMode && config.pairing?.isLive()) return "pending";
    return "reject";
  };

  const channelFactory =
    deps.channelFactory ??
    (() => createResponderChannel({ identity: config.identity, authorize }));

  const pairTimeoutMs = deps.pairTimeoutMs ?? 10_000;

  interface Conn {
    ws: ServerWebSocket<unknown>;
    channel: SecureChannel;
    ready: boolean;
    pending: boolean;
    remoteStatic: string | null;
    ip: string;
    pairTimer?: ReturnType<typeof setTimeout>;
  }
  const conns = new Map<ServerWebSocket<unknown>, Conn>();

  const sendSecure = (conn: Conn, msg: ServerMsg) => {
    if (!conn.ready) return;
    conn.ws.send(conn.channel.send(new Uint8Array(Buffer.from(encode(msg), "utf8"))));
  };

  // Number every output chunk, then fan out to attached clients.
  terminal.onOutput((name, chunk) => {
    const frame = replay.ingest(name, chunk);
    const msg: ServerMsg = { type: "output", sessionId: name, seq: frame.seq, data: toB64(chunk) };
    for (const conn of conns.values()) sendSecure(conn, msg);
  });
  terminal.onExit((name, code) => {
    for (const conn of conns.values()) sendSecure(conn, { type: "exit", sessionId: name, code });
  });

  const pushSessions = () => {
    for (const conn of conns.values()) sendSecure(conn, { type: "sessions", sessions: terminal.list() });
  };
  terminal.onSessionsChange(pushSessions);

  const finishPairing = (conn: Conn, deviceName: string) => {
    config.registry.add(conn.remoteStatic!, deviceName || "device");
    conn.pending = false;
    conn.ready = true;
    if (conn.pairTimer) clearTimeout(conn.pairTimer);
    sendSecure(conn, { type: "paired", ok: true });
    config.audit.log({ event: "pair_ok", pub: conn.remoteStatic, ip: conn.ip });
  };

  const handleClient = (conn: Conn, raw: string) => {
    let msg;
    try { msg = decodeClient(raw); }
    catch { sendSecure(conn, { type: "error", code: "bad_json", message: "malformed message" }); return; }
    switch (msg.type) {
      case "newSession":
        try { terminal.ensure(msg.name, { cmd: msg.cmd, cwd: msg.cwd }); }
        catch (e) { sendSecure(conn, { type: "error", code: "ensure_failed", message: String(e) }); }
        break;
      case "listSessions":
        sendSecure(conn, { type: "sessions", sessions: terminal.list() });
        break;
      case "renameSession":
        try { terminal.rename(msg.sessionId, msg.name); }
        catch (e) { sendSecure(conn, { type: "error", code: "rename_failed", message: String(e) }); }
        break;
      case "attach": {
        const { frames, gap, oldestSeq } = replay.since(msg.sessionId, msg.lastSeq ?? 0);
        if (gap) sendSecure(conn, { type: "resync", sessionId: msg.sessionId, from: oldestSeq });
        for (const f of frames) sendSecure(conn, { type: "output", sessionId: f.sessionId, seq: f.seq, data: toB64(f.data) });
        break;
      }
      case "input": terminal.write(msg.sessionId, fromB64(msg.data)); break;
      case "resize": terminal.resize(msg.sessionId, msg.cols, msg.rows); break;
      case "kill": void terminal.kill(msg.sessionId); break;
      case "ping": sendSecure(conn, { type: "pong" }); break;
      case "listDevices": {
        const envKeysArr = Array.from(envKeys);
        const list: DeviceInfo[] = [
          ...config.registry.list().map((d) => ({ ...d, source: "registry" as const, self: d.pubKey === conn.remoteStatic })),
          ...envKeysArr.map((pub) => ({ pubKey: pub, name: "env", addedAt: "", lastSeen: null, source: "env" as const, self: pub === conn.remoteStatic })),
        ];
        sendSecure(conn, { type: "devices", devices: list });
        break;
      }
      case "revokeDevice": {
        if (envKeys.has(msg.pubKey)) { sendSecure(conn, { type: "error", code: "revoke_denied", message: "env keys are read-only" }); break; }
        const removed = config.registry.remove(msg.pubKey);
        if (removed) {
          config.audit.log({ event: "revoke", pub: msg.pubKey, ip: conn.ip });
          for (const c of conns.values()) if (c.remoteStatic === msg.pubKey) c.ws.close();
        }
        break;
      }
      default: sendSecure(conn, { type: "error", code: "unknown_type", message: "unknown message type" }); break;
    }
  };

  const onOpen = (ws: ServerWebSocket<unknown>, ip = "", factory = channelFactory) => {
    if (ip && config.rateLimiter.isLocked(ip)) { ws.close(); return; }
    const conn: Conn = { ws, channel: factory(), ready: false, pending: false, remoteStatic: null, ip };
    conns.set(ws, conn);
    const m1 = conn.channel.start();
    if (m1) ws.send(m1); // responder returns null; kept for symmetry
  };

  const onMessage = (ws: ServerWebSocket<unknown>, raw: Uint8Array | string) => {
    const conn = conns.get(ws);
    if (!conn) return;
    const frame = typeof raw === "string" ? new Uint8Array(Buffer.from(raw, "utf8")) : new Uint8Array(raw as Uint8Array);
    const r = conn.channel.receive(frame);
    if (r.status === "fail") {
      console.warn("[pocketshell] channel fail:", r.reason);
      // Only handshake-phase failures (random keys / bad handshake) feed the
      // brute-force limiter. A transport-phase decrypt failure happens only
      // after a peer already completed the handshake (authorized or pending),
      // so it is not a handshake brute-force vector — don't count/mislabel it.
      const established = conn.ready || conn.pending;
      if (!established) {
        config.audit.log({ event: "handshake_fail", ip: conn.ip, reason: r.reason });
        config.rateLimiter.record(conn.ip);
      }
      ws.close();
      return;
    }
    if (r.status === "handshake") {
      if (r.reply) ws.send(r.reply);
      if (r.established) {
        conn.remoteStatic = r.remoteStatic ?? null;
        if (r.pending) {
          conn.pending = true;
          conn.pairTimer = setTimeout(() => { if (conn.pending) conn.ws.close(); }, pairTimeoutMs);
          console.log("[pocketshell] pending device awaiting pair");
        } else {
          conn.ready = true;
          if (conn.remoteStatic) config.registry.touch(conn.remoteStatic);
          config.audit.log({ event: "handshake_ok", pub: conn.remoteStatic, ip: conn.ip });
          console.log("[pocketshell] connect (authorized)");
        }
      }
      return;
    }
    // r.status === "message"
    const text = Buffer.from(r.plaintext).toString("utf8");
    if (conn.pending) {
      let msg: ReturnType<typeof decodeClient>;
      try { msg = decodeClient(text); } catch { conn.ws.close(); return; }
      if (msg.type !== "pair") { conn.ws.close(); return; }
      const v = config.pairing ? config.pairing.verify(msg.code) : { ok: false as const, reason: "no_attempts" as const };
      if (v.ok) { finishPairing(conn, msg.deviceName); }
      else {
        config.audit.log({ event: "pair_fail", ip: conn.ip, reason: v.reason });
        config.rateLimiter.record(conn.ip);
        conn.ws.send(conn.channel.send(new Uint8Array(Buffer.from(encode({ type: "error", code: "pair_failed", message: v.reason }), "utf8"))));
        conn.ws.close();
      }
      return;
    }
    handleClient(conn, text);
  };

  const tlsMaterial = resolveTlsMaterial(config.keyDir, config.tls);
  const server = Bun.serve({
    hostname: config.listen.host,
    port: deps.port ?? config.listen.port,
    tls: tlsMaterial ?? undefined,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("PocketShell agent — WebSocket only", { status: 426 });
    },
    websocket: {
      open(ws) { onOpen(ws, (ws as any).remoteAddress ?? ""); },
      close(ws) { conns.delete(ws); console.log("[pocketshell] disconnect"); },
      message(ws, raw) { onMessage(ws, raw as any); },
    },
  });

  return {
    port: server.port,
    stop() {
      terminal.dispose();
      server.stop(true);
    },
    __test: {
      open: (ws: any, ip = "") => onOpen(ws, ip),
      openWith: (ws: any, ip: string, factory: () => SecureChannel) => onOpen(ws, ip, factory),
      message: onMessage,
      broadcastOutputForTest: () => { for (const conn of conns.values()) sendSecure(conn, { type: "pong" }); },
    },
  };
}

// Allow `bun run src/server.ts` to boot directly.
if (import.meta.main) {
  const cfg = loadConfig();
  const proto = cfg.tls.enabled ? "wss" : "ws";
  const addr = `${proto}://${cfg.listen.host}:${cfg.listen.port}`;
  const s = startServer({ config: cfg });
  console.log(`[pocketshell] agent listening on ${addr}`);
  console.log(`[pocketshell] TLS:`, cfg.tls.enabled ? "enabled" : "disabled");
  console.log(`[pocketshell] pairing mode:`, cfg.pairingMode ? "on" : "off");
  console.log(`[pocketshell] registered devices:`, cfg.registry.list().length);
  console.log(`[pocketshell] agent public key:`, toB64(cfg.identity.publicKey));
  if (cfg.pairingMode && cfg.pairing) {
    console.log(`[pocketshell] pairing string:`, buildPairingString(cfg.identity.publicKey, addr, cfg.pairing.code));
  }
}
