// B1.6 keystore: this device's persistent Noise static identity (localStorage)
// + the Agent's static public key (localStorage override, VITE env default).
import DH from "noise-handshake/dh";
import { toB64, fromB64 } from "./bytes";

const ID_KEY = "pocketshell.identity";
const AGENT_KEY = "pocketshell.agentPubKey";
const ADDR_KEY = "pocketshell.agentAddr";
const PENDING_KEY = "pocketshell.pendingPair";

export function loadOrCreateIdentity(store: Storage = localStorage): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const raw = store.getItem(ID_KEY);
  if (raw) {
    const j = JSON.parse(raw);
    return { publicKey: fromB64(j.publicKey), secretKey: fromB64(j.secretKey) };
  }
  const kp = DH.generateKeyPair();
  const pub = new Uint8Array(kp.publicKey);
  const sec = new Uint8Array(kp.secretKey);
  store.setItem(ID_KEY, JSON.stringify({ publicKey: toB64(pub), secretKey: toB64(sec) }));
  // Surface the public key so the developer can add it to the Agent allowlist.
  console.log("[pocketshell] this device public key (add to agent authorizedKeys):", toB64(pub));
  return { publicKey: pub, secretKey: sec };
}

export function getAgentPubKey(store: Storage = localStorage): Uint8Array | null {
  const b64 = store.getItem(AGENT_KEY) ?? (import.meta.env.VITE_AGENT_PUBKEY as string | undefined);
  return b64 ? fromB64(b64) : null;
}

export function getAgentAddr(store: Storage = localStorage): string | null {
  return store.getItem(ADDR_KEY);
}

export function applyPairing(p: { pub: string; addr: string; code: string; deviceName: string }, store: Storage = localStorage): void {
  store.setItem(AGENT_KEY, p.pub);
  store.setItem(ADDR_KEY, p.addr);
  store.setItem(PENDING_KEY, JSON.stringify({ code: p.code, deviceName: p.deviceName }));
}

export function getPendingPair(store: Storage = localStorage): { code: string; deviceName: string } | null {
  const raw = store.getItem(PENDING_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function clearPendingPair(store: Storage = localStorage): void {
  store.removeItem(PENDING_KEY);
}
