import { test, expect } from "bun:test";
import { buildReadiness, isNonLocalBind } from "./readiness";

test("isNonLocalBind true only for non-loopback hosts", () => {
  expect(isNonLocalBind("127.0.0.1")).toBe(false);
  expect(isNonLocalBind("::1")).toBe(false);
  expect(isNonLocalBind("localhost")).toBe(false);
  expect(isNonLocalBind("0.0.0.0")).toBe(true);
  expect(isNonLocalBind("10.0.0.1")).toBe(true);
});

test("buildReadiness always shows app url + advertise + pubkey", () => {
  const lines = buildReadiness({
    advertise: "wss://d", appUrl: "https://d", pubKeyB64: "PUB",
    advertiseExplicit: true, bindNonLocal: true,
  }).join("\n");
  expect(lines).toContain("https://d");
  expect(lines).toContain("wss://d");
  expect(lines).toContain("PUB");
});

test("buildReadiness includes pairing lines only when a pairing string is present", () => {
  const withPair = buildReadiness({
    advertise: "wss://d", appUrl: "https://d", pubKeyB64: "PUB",
    pairingString: "pocketshell-pair:XYZ", pairingTtlSec: 300,
    advertiseExplicit: true, bindNonLocal: false,
  }).join("\n");
  expect(withPair).toContain("pocketshell-pair:XYZ");
  expect(withPair).toContain("300");

  const noPair = buildReadiness({
    advertise: "wss://d", appUrl: "https://d", pubKeyB64: "PUB",
    advertiseExplicit: true, bindNonLocal: false,
  }).join("\n");
  expect(noPair).not.toContain("pocketshell-pair:");
});

test("buildReadiness warns when advertise unset AND bind is non-local", () => {
  const warn = buildReadiness({
    advertise: "ws://0.0.0.0:8722", appUrl: "http://0.0.0.0:8722", pubKeyB64: "PUB",
    advertiseExplicit: false, bindNonLocal: true,
  }).join("\n");
  expect(warn).toMatch(/POCKETSHELL_ADVERTISE/);

  const noWarn = buildReadiness({
    advertise: "ws://127.0.0.1:8722", appUrl: "http://127.0.0.1:8722", pubKeyB64: "PUB",
    advertiseExplicit: false, bindNonLocal: false,
  }).join("\n");
  expect(noWarn).not.toMatch(/for your phone to reach/i);
});
