// A1 config — S4a adds a persistent Noise static identity + authorized-keys
// allowlist. Pairing TTL / device registry remain later slices.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import DH from "noise-handshake/dh";
import { toB64, fromB64 } from "./bytes";

export interface AgentConfig {
  listen: { host: string; port: number };
  workspaceRoot: string;
  replayBufferBytes: number;
  keyDir: string;
  identity: { publicKey: Uint8Array; secretKey: Uint8Array };
  authorizedKeys: string[];
}

function loadOrCreateIdentity(keyDir: string): { publicKey: Uint8Array; secretKey: Uint8Array } {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
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

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const keyDir = env.POCKETSHELL_KEY_DIR ?? join(homedir(), ".pocketshell");
  const authorizedKeys = (env.POCKETSHELL_AUTHORIZED_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  };
}
