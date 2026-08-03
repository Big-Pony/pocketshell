import { test, expect, beforeEach } from "vitest";
import { loadOrCreateIdentity, getAgentPubKey, getAgentAddr, applyPairing, getPendingPair, clearPendingPair } from "./keystore";
import { toB64 } from "./bytes";

beforeEach(() => localStorage.clear());

test("loadOrCreateIdentity persists and reloads a 32-byte identity", () => {
  const a = loadOrCreateIdentity();
  expect(a.publicKey.length).toBe(32);
  const b = loadOrCreateIdentity();
  expect(toB64(a.publicKey)).toBe(toB64(b.publicKey));
});

test("getAgentPubKey prefers localStorage over env default", () => {
  expect(getAgentPubKey()).toBe(null); // nothing configured, no env in test
  const fake = new Uint8Array(32).fill(7);
  localStorage.setItem("pocketshell.agentPubKey", toB64(fake));
  expect(toB64(getAgentPubKey()!)).toBe(toB64(fake));
});

test("applyPairing stores agent pubkey, addr, pending code; clear removes code", () => {
  applyPairing({ pub: "AGENTKEY", addr: "ws://h:8722", code: "ABCD2345", deviceName: "iPhone" });
  expect(localStorage.getItem("pocketshell.agentPubKey")).toBe("AGENTKEY");
  expect(getAgentAddr()).toBe("ws://h:8722");
  expect(getPendingPair()).toEqual({ code: "ABCD2345", deviceName: "iPhone" });
  clearPendingPair();
  expect(getPendingPair()).toBeNull();
});
