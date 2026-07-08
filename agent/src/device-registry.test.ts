import { test, expect, describe } from "bun:test";
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

describe("device lastIp", () => {
  test("touch(pub, ip) records lastIp and lastSeen", () => {
    const file = tmpFile();
    try {
      let t = 1000;
      const reg = loadDeviceRegistry(file, () => t);
      reg.add("PUB", "phone");
      t = 2000;
      reg.touch("PUB", "203.0.113.7");
      const d = reg.list().find((x) => x.pubKey === "PUB")!;
      expect(d.lastIp).toBe("203.0.113.7");
      expect(d.lastSeen).toBe(new Date(2000).toISOString());
    } finally { rmSync(file, { force: true }); }
  });
  test("touch without ip leaves lastIp unset", () => {
    const file = tmpFile();
    try {
      const reg = loadDeviceRegistry(file, () => 1000);
      reg.add("PUB", "phone");
      reg.touch("PUB");
      expect(reg.list().find((x) => x.pubKey === "PUB")!.lastIp).toBeUndefined();
    } finally { rmSync(file, { force: true }); }
  });
});
