import { test, expect } from "bun:test";
import { loadConfig } from "./config";
import { toB64 } from "./bytes";
import { rmSync, mkdtempSync, statSync, existsSync } from "node:fs";
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
