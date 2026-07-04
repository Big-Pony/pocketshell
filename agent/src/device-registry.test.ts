import { test, expect } from "bun:test";
import { loadDeviceRegistry } from "./device-registry";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "ps-dev-")), "devices.json");
}

test("add persists a device at 0600 and reloads", () => {
  const file = tmpFile();
  let t = 1000;
  const reg = loadDeviceRegistry(file, () => t);
  reg.add("PUBA", "iPhone");
  expect(reg.has("PUBA")).toBe(true);
  expect(existsSync(file)).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const reg2 = loadDeviceRegistry(file, () => t);
  expect(reg2.list()[0]).toMatchObject({ pubKey: "PUBA", name: "iPhone", lastSeen: null });
  rmSync(file, { force: true });
});

test("add is idempotent on name update; remove deletes; touch sets lastSeen", () => {
  const file = tmpFile();
  let t = 5000;
  const reg = loadDeviceRegistry(file, () => t);
  reg.add("PUBA", "old");
  reg.add("PUBA", "new");
  expect(reg.list().length).toBe(1);
  expect(reg.list()[0].name).toBe("new");
  t = 9000;
  reg.touch("PUBA");
  expect(reg.list()[0].lastSeen).toBe(new Date(9000).toISOString());
  expect(reg.remove("PUBA")).toBe(true);
  expect(reg.has("PUBA")).toBe(false);
  expect(reg.remove("PUBA")).toBe(false);
  rmSync(file, { force: true });
});
