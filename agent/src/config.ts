// A1 config — S4a adds a persistent Noise static identity + authorized-keys
// allowlist. S4b adds DeviceRegistry + pairing mode/code + TLS flag.
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import DH from "noise-handshake/dh";
import { toB64, fromB64 } from "./bytes";
import { loadDeviceRegistry, type DeviceRegistry } from "./device-registry";
import { createPairing, type Pairing } from "./pairing";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import { createAudit, fileAuditWriter, type Audit } from "./audit";
import { openSnippetStore, type SnippetStore } from "./snippet-store";

export interface AgentConfig {
  listen: { host: string; port: number };
  advertise?: string;
  workspaceRoot: string;
  replayBufferBytes: number;
  keyDir: string;
  identity: { publicKey: Uint8Array; secretKey: Uint8Array };
  authorizedKeys: string[];
  registry: DeviceRegistry;
  pairingMode: boolean;
  pairing: Pairing | null;
  tls: { enabled: boolean; cert?: string; key?: string };
  rateLimiter: RateLimiter;
  audit: Audit;
  snippets: SnippetStore;
}

function loadOrCreateIdentity(keyDir: string): { publicKey: Uint8Array; secretKey: Uint8Array } {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  chmodSync(keyDir, 0o700);
  const file = join(keyDir, "agent_key");
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return { publicKey: fromB64(j.publicKey), secretKey: fromB64(j.secretKey) };
  }
  const kp = DH.generateKeyPair();
  const pub = new Uint8Array(kp.publicKey);
  const sec = new Uint8Array(kp.secretKey);
  writeFileSync(file, JSON.stringify({ publicKey: toB64(pub), secretKey: toB64(sec) }), { mode: 0o600 });
  return { publicKey: pub, secretKey: sec };
}

export function buildPairingString(pub: Uint8Array, addr: string, code: string): string {
  const json = JSON.stringify({ v: 1, pub: toB64(pub), addr, code });
  return "pocketshell-pair:" + Buffer.from(json, "utf8").toString("base64url");
}

export function advertiseToHttp(wsUrl: string): string {
  if (wsUrl.startsWith("wss://")) return "https://" + wsUrl.slice("wss://".length);
  if (wsUrl.startsWith("ws://")) return "http://" + wsUrl.slice("ws://".length);
  return wsUrl;
}

export function resolveAdvertise(cfg: {
  advertise?: string;
  listen: { host: string; port: number };
  tls: { enabled: boolean };
}): string {
  if (cfg.advertise) return cfg.advertise;
  const scheme = cfg.tls.enabled ? "wss" : "ws";
  return `${scheme}://${cfg.listen.host}:${cfg.listen.port}`;
}

interface AgentFileConfig {
  advertise?: string;
  host?: string;
  port?: number;
  tls?: boolean;
  tlsCert?: string;
  tlsKey?: string;
}

function loadAgentJson(keyDir: string): AgentFileConfig {
  const file = join(keyDir, "agent.json");
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")) as AgentFileConfig; }
  catch { return {}; } // malformed file -> ignore, fall back to env/defaults
}

function persistAgentJson(keyDir: string, cfg: AgentFileConfig): void {
  const file = join(keyDir, "agent.json");
  if (existsSync(file)) return; // never clobber user edits
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

export function resolveTlsMaterial(
  keyDir: string,
  tls: { enabled: boolean; cert?: string; key?: string },
): { cert: string; key: string } | null {
  if (!tls.enabled) return null;
  const certPath = tls.cert ?? join(keyDir, "tls_cert.pem");
  const keyPath = tls.key ?? join(keyDir, "tls_key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
  }
  // Fail loudly rather than silently downgrade to plaintext ws: a silent
  // downgrade would still print "wss" in the boot log and encode "wss://" into
  // the pairing string, leaving the app unable to connect. No auto-generation
  // in this slice — the operator supplies the cert/key (self-signed is fine).
  throw new Error(
    `[pocketshell] TLS enabled (POCKETSHELL_TLS=1) but cert/key not found at ${certPath} + ${keyPath}. ` +
    `Provide POCKETSHELL_TLS_CERT / POCKETSHELL_TLS_KEY, or generate a self-signed pair once:\n` +
    `  openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${certPath} -days 3650 -subj "/CN=pocketshell"`,
  );
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const keyDir = env.POCKETSHELL_KEY_DIR ?? join(homedir(), ".pocketshell");
  const authorizedKeys = (env.POCKETSHELL_AUTHORIZED_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const registry = loadDeviceRegistry(join(keyDir, "devices.json"));
  const pairingMode = registry.list().length === 0 || env.POCKETSHELL_PAIR === "1";
  const pairing = pairingMode ? createPairing({ now: () => Date.now() }) : null;

  const file = loadAgentJson(keyDir);

  const host = env.POCKETSHELL_HOST ?? file.host ?? "127.0.0.1";
  const port = env.POCKETSHELL_PORT ? Number(env.POCKETSHELL_PORT) : (file.port ?? 8722);
  const advertise = env.POCKETSHELL_ADVERTISE ?? file.advertise;

  const tlsEnabled =
    env.POCKETSHELL_TLS === "1" ? true :
    env.POCKETSHELL_TLS === "0" ? false :
    (file.tls ?? false);
  const tls = {
    enabled: tlsEnabled,
    cert: env.POCKETSHELL_TLS_CERT ?? file.tlsCert,
    key: env.POCKETSHELL_TLS_KEY ?? file.tlsKey,
  };

  const audit = createAudit({ write: fileAuditWriter(join(keyDir, "audit.log")) });
  const rateLimiter = createRateLimiter({ now: () => Date.now(), onLock: (ip) => audit.log({ event: "ratelimit_lock", ip }) });
  const identity = loadOrCreateIdentity(keyDir);
  const snippets = openSnippetStore(join(keyDir, "pocketshell.db"));

  // First run: write a non-sensitive agent.json the operator can edit. Secrets
  // (Noise keys) never go here — they stay in agent_key (0600).
  const toWrite: AgentFileConfig = { host, port, tls: tlsEnabled };
  if (advertise) toWrite.advertise = advertise;
  if (tls.cert) toWrite.tlsCert = tls.cert;
  if (tls.key) toWrite.tlsKey = tls.key;
  persistAgentJson(keyDir, toWrite);

  return {
    listen: { host, port },
    advertise,
    workspaceRoot: env.POCKETSHELL_WORKSPACE ?? process.cwd(),
    replayBufferBytes: env.POCKETSHELL_REPLAY_BYTES ? Number(env.POCKETSHELL_REPLAY_BYTES) : 256 * 1024,
    keyDir,
    identity: identity,
    authorizedKeys,
    registry,
    pairingMode,
    pairing,
    tls,
    rateLimiter,
    audit,
    snippets,
  };
}
