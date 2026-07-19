import { test, expect } from "bun:test";
import { loadConfig, buildPairingString, resolveTlsMaterial, advertiseToHttp, resolveAdvertise } from "./config";
import { toB64 } from "./bytes";
import { rmSync, mkdtempSync, statSync, existsSync, writeFileSync, readFileSync as _rf } from "node:fs";
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

test("advertiseToHttp maps ws->http and wss->https", () => {
  expect(advertiseToHttp("wss://pocket.example.com")).toBe("https://pocket.example.com");
  expect(advertiseToHttp("ws://192.168.1.5:8722")).toBe("http://192.168.1.5:8722");
  expect(advertiseToHttp("https://x")).toBe("https://x"); // passthrough
});

test("resolveAdvertise: explicit wins, else falls back to bind + tls scheme", () => {
  expect(resolveAdvertise({ advertise: "wss://d", listen: { host: "0.0.0.0", port: 9 }, tls: { enabled: false } })).toBe("wss://d");
  expect(resolveAdvertise({ listen: { host: "127.0.0.1", port: 8722 }, tls: { enabled: false } })).toBe("ws://127.0.0.1:8722");
  expect(resolveAdvertise({ listen: { host: "10.0.0.1", port: 443 }, tls: { enabled: true } })).toBe("wss://10.0.0.1:443");
});

test("loadConfig writes agent.json on first run (non-sensitive only), reuses on next", () => {
  const keyDir = tmpKeyDir();
  const cfg = loadConfig({ POCKETSHELL_KEY_DIR: keyDir });
  const file = join(keyDir, "agent.json");
  expect(existsSync(file)).toBe(true);
  const j = JSON.parse(_rf(file, "utf8"));
  expect(j.host).toBe("127.0.0.1");
  expect(j.port).toBe(8722);
  // must NOT leak secrets into agent.json
  expect(JSON.stringify(j)).not.toContain("secretKey");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  rmSync(keyDir, { recursive: true, force: true });
});

test("loadConfig priority: env > agent.json > default", () => {
  const keyDir = tmpKeyDir();
  // seed agent.json with a file-level host/port/advertise
  loadConfig({ POCKETSHELL_KEY_DIR: keyDir }); // creates keyDir
  writeFileSync(join(keyDir, "agent.json"),
    JSON.stringify({ host: "10.0.0.9", port: 9001, advertise: "wss://from-file" }));
  // no env override -> file wins
  const fromFile = loadConfig({ POCKETSHELL_KEY_DIR: keyDir });
  expect(fromFile.listen.host).toBe("10.0.0.9");
  expect(fromFile.listen.port).toBe(9001);
  expect(fromFile.advertise).toBe("wss://from-file");
  // env override -> env wins
  const fromEnv = loadConfig({ POCKETSHELL_KEY_DIR: keyDir, POCKETSHELL_HOST: "0.0.0.0", POCKETSHELL_ADVERTISE: "wss://from-env" });
  expect(fromEnv.listen.host).toBe("0.0.0.0");
  expect(fromEnv.advertise).toBe("wss://from-env");
  rmSync(keyDir, { recursive: true, force: true });
});

test("loadConfig exposes tmpDir under keyDir and creates it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-cfg-tmp-"));
  const cfg = loadConfig({ POCKETSHELL_KEY_DIR: dir } as any);
  expect(cfg.tmpDir).toBe(join(dir, "tmp"));
  expect(existsSync(cfg.tmpDir)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("POCKETSHELL_TLS=0 forces tls off even if agent.json enables it", () => {
  const keyDir = tmpKeyDir();
  loadConfig({ POCKETSHELL_KEY_DIR: keyDir });
  writeFileSync(join(keyDir, "agent.json"), JSON.stringify({ tls: true }));
  expect(loadConfig({ POCKETSHELL_KEY_DIR: keyDir }).tls.enabled).toBe(true);
  expect(loadConfig({ POCKETSHELL_KEY_DIR: keyDir, POCKETSHELL_TLS: "0" }).tls.enabled).toBe(false);
  rmSync(keyDir, { recursive: true, force: true });
});

test("adminEnabled defaults to true", () => {
  const keyDir = tmpKeyDir();
  expect(loadConfig({ POCKETSHELL_KEY_DIR: keyDir }).adminEnabled).toBe(true);
  rmSync(keyDir, { recursive: true, force: true });
});

test("adminEnabled is false when POCKETSHELL_ADMIN=0", () => {
  const keyDir = tmpKeyDir();
  expect(loadConfig({ POCKETSHELL_KEY_DIR: keyDir, POCKETSHELL_ADMIN: "0" }).adminEnabled).toBe(false);
  rmSync(keyDir, { recursive: true, force: true });
});

function envWith(over: Record<string, string | undefined>) {
  return { POCKETSHELL_KEY_DIR: mkdtempSync(join(tmpdir(), "ps-")), ...over };
}

test("update defaults: enabled + Big-Pony repo", () => {
  const c = loadConfig(envWith({}));
  expect(c.update.enabled).toBe(true);
  expect(c.update.repo).toBe("Big-Pony/pocketshell");
});

test("POCKETSHELL_UPDATE=0 disables OTA", () => {
  const c = loadConfig(envWith({ POCKETSHELL_UPDATE: "0" }));
  expect(c.update.enabled).toBe(false);
  expect(c.update.repo).toBeNull();
});

test("POCKETSHELL_UPDATE_REPO=off disables OTA", () => {
  const c = loadConfig(envWith({ POCKETSHELL_UPDATE_REPO: "off" }));
  expect(c.update.enabled).toBe(false);
});

test("custom repo honored", () => {
  const c = loadConfig(envWith({ POCKETSHELL_UPDATE_REPO: "me/fork" }));
  expect(c.update.repo).toBe("me/fork");
});
