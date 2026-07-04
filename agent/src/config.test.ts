import { test, expect } from "bun:test";
import { loadConfig, buildPairingString, resolveTlsMaterial } from "./config";
import { toB64 } from "./bytes";
import { rmSync, mkdtempSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpKeyDir(): string {
  return join(mkdtempSync(join(tmpdir(), "ps-key-")), "keys");
}

test("loadConfig generates a 32-byte static identity persisted at 600", () => {
  const keyDir = tmpKeyDir();
  const env = { POCKETSHELL_KEY_DIR: keyDir };
  const cfg = loadConfig(env);
  expect(cfg.identity.publicKey.length).toBe(32);
  expect(cfg.identity.secretKey.length).toBe(32);
  const file = join(keyDir, "agent_key");
  expect(existsSync(file)).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(keyDir).mode & 0o777).toBe(0o700);
  rmSync(keyDir, { recursive: true, force: true });
});

test("loadConfig reloads the same identity on second call", () => {
  const keyDir = tmpKeyDir();
  const env = { POCKETSHELL_KEY_DIR: keyDir };
  const a = loadConfig(env);
  const b = loadConfig(env);
  expect(toB64(a.identity.publicKey)).toBe(toB64(b.identity.publicKey));
  expect(toB64(a.identity.secretKey)).toBe(toB64(b.identity.secretKey));
  rmSync(keyDir, { recursive: true, force: true });
});

test("loadConfig parses POCKETSHELL_AUTHORIZED_KEYS (comma-separated)", () => {
  const keyDir = tmpKeyDir();
  const cfg = loadConfig({
    POCKETSHELL_KEY_DIR: keyDir,
    POCKETSHELL_AUTHORIZED_KEYS: "aaa==, bbb==",
  });
  expect(cfg.authorizedKeys).toEqual(["aaa==", "bbb=="]);
  rmSync(keyDir, { recursive: true, force: true });
});

test("empty registry -> pairingMode auto-on with a pairing code", () => {
  const keyDir = tmpKeyDir();
  const cfg = loadConfig({ POCKETSHELL_KEY_DIR: keyDir });
  expect(cfg.pairingMode).toBe(true);
  expect(cfg.pairing).not.toBeNull();
  expect(cfg.pairing!.code).toMatch(/^[A-Z2-7]{8}$/);
  rmSync(keyDir, { recursive: true, force: true });
});

test("non-empty registry -> pairingMode off unless POCKETSHELL_PAIR=1", () => {
  const keyDir = tmpKeyDir();
  // seed a device so registry is non-empty
  const first = loadConfig({ POCKETSHELL_KEY_DIR: keyDir });
  first.registry.add("SEEDPUB", "seed");
  const cfg = loadConfig({ POCKETSHELL_KEY_DIR: keyDir });
  expect(cfg.pairingMode).toBe(false);
  expect(cfg.pairing).toBeNull();
  const forced = loadConfig({ POCKETSHELL_KEY_DIR: keyDir, POCKETSHELL_PAIR: "1" });
  expect(forced.pairingMode).toBe(true);
  expect(forced.pairing).not.toBeNull();
  rmSync(keyDir, { recursive: true, force: true });
});

test("buildPairingString is decodable back to fields", () => {
  const s = buildPairingString(new Uint8Array([1, 2, 3]), "ws://h:8722", "ABCD2345");
  expect(s.startsWith("pocketshell-pair:")).toBe(true);
  const json = JSON.parse(Buffer.from(s.slice("pocketshell-pair:".length), "base64url").toString("utf8"));
  expect(json.v).toBe(1);
  expect(json.addr).toBe("ws://h:8722");
  expect(json.code).toBe("ABCD2345");
});

test("tls off by default, on with POCKETSHELL_TLS=1", () => {
  const keyDir = tmpKeyDir();
  expect(loadConfig({ POCKETSHELL_KEY_DIR: keyDir }).tls.enabled).toBe(false);
  const keyDir2 = tmpKeyDir();
  expect(loadConfig({ POCKETSHELL_KEY_DIR: keyDir2, POCKETSHELL_TLS: "1" }).tls.enabled).toBe(true);
  rmSync(keyDir, { recursive: true, force: true });
  rmSync(keyDir2, { recursive: true, force: true });
});

test("resolveTlsMaterial: disabled->null, present->contents, missing->throws (no silent downgrade)", () => {
  const keyDir = tmpKeyDir();
  loadConfig({ POCKETSHELL_KEY_DIR: keyDir }); // create keyDir
  expect(resolveTlsMaterial(keyDir, { enabled: false })).toBeNull();
  const cert = join(keyDir, "c.pem");
  const key = join(keyDir, "k.pem");
  writeFileSync(cert, "CERTDATA");
  writeFileSync(key, "KEYDATA");
  expect(resolveTlsMaterial(keyDir, { enabled: true, cert, key })).toEqual({ cert: "CERTDATA", key: "KEYDATA" });
  // enabled but material absent must throw, not return null
  expect(() => resolveTlsMaterial(keyDir, { enabled: true })).toThrow(/TLS enabled/);
  rmSync(keyDir, { recursive: true, force: true });
});
