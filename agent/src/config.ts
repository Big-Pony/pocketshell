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

export interface AgentConfig {
  listen: { host: string; port: number };
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

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const keyDir = env.POCKETSHELL_KEY_DIR ?? join(homedir(), ".pocketshell");
  const authorizedKeys = (env.POCKETSHELL_AUTHORIZED_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const registry = loadDeviceRegistry(join(keyDir, "devices.json"));
  const pairingMode = registry.list().length === 0 || env.POCKETSHELL_PAIR === "1";
  const pairing = pairingMode ? createPairing({ now: () => Date.now() }) : null;
  const tlsEnabled = env.POCKETSHELL_TLS === "1";
  const tls = {
    enabled: tlsEnabled,
    cert: env.POCKETSHELL_TLS_CERT,
    key: env.POCKETSHELL_TLS_KEY,
  };
  const audit = createAudit({ write: fileAuditWriter(join(keyDir, "audit.log")) });
  const rateLimiter = createRateLimiter({ now: () => Date.now(), onLock: (ip) => audit.log({ event: "ratelimit_lock", ip }) });
  return {
    listen: {
      host: env.POCKETSHELL_HOST ?? "127.0.0.1",
      port: env.POCKETSHELL_PORT ? Number(env.POCKETSHELL_PORT) : 8722,
    },
    workspaceRoot: env.POCKETSHELL_WORKSPACE ?? process.cwd(),
    replayBufferBytes: env.POCKETSHELL_REPLAY_BYTES ? Number(env.POCKETSHELL_REPLAY_BYTES) : 256 * 1024,
    keyDir,
    identity: loadOrCreateIdentity(keyDir),
    authorizedKeys,
    registry,
    pairingMode,
    pairing,
    tls,
    rateLimiter,
    audit,
  };
}
