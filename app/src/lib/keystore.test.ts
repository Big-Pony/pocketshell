import { test, expect, beforeEach } from "vitest";
import { loadOrCreateIdentity, getAgentPubKey } from "./keystore";
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
