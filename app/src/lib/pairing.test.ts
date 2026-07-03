import { describe, it, expect } from "vitest";
import { parsePairingString } from "./pairing";

function build(obj: unknown): string {
  return "pocketshell-pair:" + btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("parsePairingString", () => {
  it("parses a valid v1 string", () => {
    const s = build({ v: 1, pub: "PUBB64", addr: "ws://h:8722", code: "ABCD2345" });
    const r = parsePairingString(s.trim());
    expect(r).toEqual({ ok: true, value: { pub: "PUBB64", addr: "ws://h:8722", code: "ABCD2345" } });
  });
  it("rejects a bad prefix", () => {
    expect(parsePairingString("nope:xxx").ok).toBe(false);
  });
  it("rejects wrong version / missing fields", () => {
    expect(parsePairingString(build({ v: 2, pub: "x", addr: "y", code: "z" })).ok).toBe(false);
    expect(parsePairingString(build({ v: 1, pub: "x" })).ok).toBe(false);
  });
});
