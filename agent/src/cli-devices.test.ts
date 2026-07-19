import { test, expect } from "bun:test";
import { fingerprint, formatDeviceList, matchDevice, parseArgv } from "./cli-devices";
import type { DeviceRecord } from "./device-registry";

const recs: DeviceRecord[] = [
  { pubKey: "PUBKEY_AAA", name: "phone", addedAt: "2026-07-01T00:00:00Z", lastSeen: null },
  { pubKey: "PUBKEY_BBB", name: "tablet", addedAt: "2026-07-02T00:00:00Z", lastSeen: "2026-07-10T00:00:00Z", lastIp: "10.0.0.9" },
];

test("fingerprint is stable, 16 hex chars, and differs per key", () => {
  const fa = fingerprint("PUBKEY_AAA");
  expect(fa).toMatch(/^[0-9a-f]{16}$/);
  expect(fingerprint("PUBKEY_AAA")).toBe(fa);
  expect(fingerprint("PUBKEY_BBB")).not.toBe(fa);
});

test("formatDeviceList: empty vs populated", () => {
  expect(formatDeviceList([])).toContain("No paired devices");
  const out = formatDeviceList(recs);
  expect(out).toContain("phone");
  expect(out).toContain(fingerprint("PUBKEY_AAA"));
  expect(out).toContain("10.0.0.9");
});

test("matchDevice: exact pubKey, fingerprint prefix, none, ambiguous", () => {
  expect(matchDevice(recs, "PUBKEY_BBB")).toEqual({ kind: "one", record: recs[1] });
  const fb = fingerprint("PUBKEY_BBB");
  expect(matchDevice(recs, fb.slice(0, 8))).toEqual({ kind: "one", record: recs[1] });
  expect(matchDevice(recs, "zzzzzzzz")).toEqual({ kind: "none" });
  // both fingerprints share no common prefix in general; force ambiguity with "" -> matches all
  const amb = matchDevice(recs, "");
  expect(amb.kind).toBe("ambiguous");
});

test("parseArgv covers the three subcommands and unknown", () => {
  expect(parseArgv(["devices", "list"])).toEqual({ cmd: "devices-list" });
  expect(parseArgv(["devices", "remove", "abc123"])).toEqual({ cmd: "devices-remove", query: "abc123" });
  expect(parseArgv(["pair"])).toEqual({ cmd: "pair", name: undefined });
  expect(parseArgv(["pair", "--name", "myphone"])).toEqual({ cmd: "pair", name: "myphone" });
  const u = parseArgv(["devices"]);
  expect(u.cmd).toBe("unknown");
});
