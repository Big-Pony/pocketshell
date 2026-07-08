// A3 (slice-1, plaintext): a Bun WebSocket server wiring the wire protocol to
// TerminalService (A2) + ReplayService (A4). Noise handshake + pairing land in
// a later slice; the message shapes here are the frozen contract from A3 §3.
// S4a: wrapped in SecureChannel handshake — plaintext message loop unchanged.
// S4b: in-channel pairing — pending state, pair verify, registry∪env authorize.
import type { ServerWebSocket } from "bun";
import { loadConfig, type AgentConfig, resolveTlsMaterial, buildPairingString, resolveAdvertise, advertiseToHttp } from "./config";
import { TerminalService } from "./terminal";
import { ReplayService } from "./replay";
import { fsTree, fsRead, fsDiff, fsOp, fsUploadCheck, fsResolveName, fsUploadChunk, fsDownloadChunk, fsArchive, sweepTmp } from "./fs-service";
import { gitLog, gitBranches, gitStatus } from "./git-service";
import { decodeClient, encode, type ServerMsg, type DeviceInfo } from "./protocol";
import { toB64, fromB64 } from "./bytes";
import { createResponderChannel, type SecureChannel } from "./secure-channel";
import { resolveStatic } from "./static-serve";
import { ASSETS } from "./embedded-manifest";
import { ensureTmux, realTmuxDeps } from "./ensure-tmux";
import { buildReadiness, isNonLocalBind } from "./readiness";
import { createPairing } from "./pairing";
import { isLocalAddr, deviceRows, ADMIN_HTML } from "./admin";

interface Deps {
  port?: number;
  config?: AgentConfig;
  terminal?: TerminalService;
  replay?: ReplayService;
  channelFactory?: () => SecureChannel;
  pairTimeoutMs?: number;
  assets?: Record<string, string>;
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
  const assets = deps.assets ?? ASSETS;
  const assetKeys = new Set(Object.keys(assets));

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

  // Refresh the whole-machine roster + previews for connected clients. Skipped
  // entirely when nobody is connected (pushSessions only targets live conns,
  // but this also avoids the tmux spawns list() would do).
  const periodicPush = () => { if (conns.size > 0) pushSessions(); };
  const pushTimer = setInterval(periodicPush, 3000);
  (pushTimer as unknown as { unref?: () => void }).unref?.();

  // Transfer temp cleanup: startup full clean + periodic age-scoped sweep.
  sweepTmp(config.tmpDir, -1, Date.now());
  const sweepTimer = setInterval(() => sweepTmp(config.tmpDir, 3_600_000, Date.now()), 1_800_000);
  (sweepTimer as unknown as { unref?: () => void }).unref?.();

  const pushSnippets = (target?: Conn) => {
    const items = config.snippets.list().map((r) => ({
      id: r.id, group: r.group, label: r.label, command: r.command, autoEnter: r.autoEnter,
    }));
    const msg: ServerMsg = { type: "snippets", items };
    if (target) sendSecure(target, msg);
    else for (const conn of conns.values()) sendSecure(conn, msg);
  };

  const finishPairing = (conn: Conn, deviceName: string) => {
    config.registry.add(conn.remoteStatic!, deviceName || "device");
    config.registry.touch(conn.remoteStatic!, conn.ip);
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
      case "pair":
        // Reaching handleClient means this conn is already authorized (its device
        // is registered) — the pending-pairing path is handled earlier in
        // onMessage. A 'pair' here is a redundant re-send from a client whose
        // pendingPair was never cleared (its original 'paired' reply was lost in
        // a reconnect drop). Answer idempotently so the client clears pendingPair
        // and goes online, instead of looping on an "unknown_type" error.
        sendSecure(conn, { type: "paired", ok: true });
        break;
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
      case "listSnippets":
        pushSnippets(conn);
        break;
      case "addSnippet":
        try {
          config.snippets.add({ group: msg.group, label: msg.label, command: msg.command, autoEnter: msg.autoEnter });
          pushSnippets();
        } catch (e) { sendSecure(conn, { type: "error", code: "snippet_add_failed", message: String(e) }); }
        break;
      case "removeSnippet":
        if (config.snippets.remove(msg.id)) pushSnippets();
        break;
      case "rpc": {
        const { id, method, params } = msg;
        const p = (params ?? {}) as any;
        try {
          let result: unknown;
          switch (method) {
            case "fs.tree": result = fsTree(String(p.path)); break;
            case "fs.read": result = fsRead(String(p.path)); break;
            case "fs.diff": result = fsDiff(String(p.path), p.cwd ? String(p.cwd) : undefined); break;
            case "fs.op": result = fsOp(p.op, String(p.path), p.to ? String(p.to) : undefined); break;
            case "fs.uploadCheck": result = fsUploadCheck(String(p.dir), (p.names ?? []) as string[]); break;
            case "fs.resolveName": result = fsResolveName(String(p.dir), String(p.name)); break;
            case "fs.uploadChunk": result = fsUploadChunk(config.tmpDir, String(p.uploadId), String(p.dataB64), { first: !!p.first, last: !!p.last, destPath: p.destPath ? String(p.destPath) : undefined }); break;
            case "fs.downloadChunk": result = fsDownloadChunk(String(p.path), Number(p.offset), Number(p.len)); break;
            case "fs.archive": result = fsArchive(config.tmpDir, String(p.path)); break;
            case "git.log": result = gitLog(String(p.cwd), Number(p.limit ?? 30), p.query ? String(p.query) : undefined); break;
            case "git.branches": result = gitBranches(String(p.cwd)); break;
            case "git.status": result = gitStatus(String(p.cwd)); break;
            case "term.history": result = terminal.history(String(p.session)); break;
            case "term.paneInfo": result = terminal.paneInfo(String(p.session)); break;
            case "terminal.pwd": result = terminal.pwd(String(p.session)); break;
            default:
              sendSecure(conn, { type: "response", id, ok: false, error: { code: "unknown_method", message: `unknown method: ${method}` } });
              return;
          }
          sendSecure(conn, { type: "response", id, ok: true, result });
        } catch (e) {
          sendSecure(conn, { type: "response", id, ok: false, error: { code: "rpc_error", message: String(e) } });
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
          if (conn.remoteStatic) config.registry.touch(conn.remoteStatic, conn.ip);
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

  const onlineIpByPub = () => {
    const m = new Map<string, string>();
    for (const c of conns.values()) if (c.ready && c.remoteStatic) m.set(c.remoteStatic, c.ip);
    return m;
  };

  const handleAdmin = async (url: URL, req: Request): Promise<Response> => {
    if (url.pathname === "/admin") {
      return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/admin-api/devices") {
      return Response.json(deviceRows(config.registry.list(), onlineIpByPub()));
    }
    if (url.pathname === "/admin-api/pair" && req.method === "POST") {
      config.pairing = createPairing({ now: () => Date.now() });
      config.pairingMode = true;
      const pairString = buildPairingString(config.identity.publicKey, resolveAdvertise(config), config.pairing.code);
      config.audit.log({ event: "admin_pair_new" });
      return Response.json({ code: config.pairing.code, pairString });
    }
    if (url.pathname === "/admin-api/revoke" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { pubKey?: string };
      const pub = String(body.pubKey ?? "");
      if (envKeys.has(pub)) return new Response("env keys are read-only", { status: 400 });
      const removed = config.registry.remove(pub);
      if (removed) {
        config.audit.log({ event: "revoke", pub, ip: "admin" });
        for (const c of conns.values()) if (c.remoteStatic === pub) c.ws.close();
      }
      return Response.json({ ok: removed });
    }
    return new Response("Not found", { status: 404 });
  };

  const tlsMaterial = resolveTlsMaterial(config.keyDir, config.tls);
  const server = Bun.serve({
    hostname: config.listen.host,
    port: deps.port ?? config.listen.port,
    tls: tlsMaterial ?? undefined,
    async fetch(req, srv) {
      if (srv.upgrade(req)) return;
      const url = new URL(req.url);
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/admin-api/")) {
        if (!config.adminEnabled) return new Response("Not found", { status: 404 });
        const ip = srv.requestIP(req)?.address ?? "";
        if (!isLocalAddr(ip)) return new Response("Forbidden", { status: 403 });
        return handleAdmin(url, req);
      }
      const r = resolveStatic(url.pathname, req.headers.get("accept") ?? "", assetKeys);
      if (r.status === 200 && r.assetKey) {
        return new Response(Bun.file(assets[r.assetKey]), { headers: r.headers });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) { onOpen(ws, (ws as any).remoteAddress ?? ""); },
      close(ws) { conns.delete(ws); console.log("[pocketshell] disconnect"); },
      message(ws, raw) { onMessage(ws, raw as any); },
    },
  });

  return {
    port: server.port,
    url: server.url,
    stop() {
      clearInterval(pushTimer);
      clearInterval(sweepTimer);
      terminal.dispose();
      server.stop(true);
    },
    __test: {
      open: (ws: any, ip = "") => onOpen(ws, ip),
      openWith: (ws: any, ip: string, factory: () => SecureChannel) => onOpen(ws, ip, factory),
      message: onMessage,
      broadcastOutputForTest: () => { for (const conn of conns.values()) sendSecure(conn, { type: "pong" }); },
      periodicPush,
      config,
    },
  };
}

// Allow `bun run src/server.ts` (or the compiled binary) to boot directly.
if (import.meta.main) {
  const cfg = loadConfig();
  ensureTmux(realTmuxDeps());
  const advertise = resolveAdvertise(cfg);
  const appUrl = advertiseToHttp(advertise);
  startServer({ config: cfg });
  const pairingString =
    cfg.pairingMode && cfg.pairing
      ? buildPairingString(cfg.identity.publicKey, advertise, cfg.pairing.code)
      : undefined;
  const lines = buildReadiness({
    advertise,
    appUrl,
    pubKeyB64: toB64(cfg.identity.publicKey),
    pairingString,
    pairingTtlSec: 300,
    advertiseExplicit: !!cfg.advertise,
    bindNonLocal: isNonLocalBind(cfg.listen.host),
  });
  console.log(`[pocketshell] listening on ${cfg.listen.host}:${cfg.listen.port} (TLS ${cfg.tls.enabled ? "on" : "off"})`);
  for (const l of lines) console.log(l);
}
