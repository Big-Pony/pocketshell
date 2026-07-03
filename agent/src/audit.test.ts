import { test, expect } from "bun:test";
import { createAudit } from "./audit";

test("log writes one JSON line per event with ts + fields", () => {
  const lines: string[] = [];
  const audit = createAudit({ write: (l) => lines.push(l), now: () => 1000 });
  audit.log({ event: "pair_ok", pub: "PUBA", ip: "1.2.3.4" });
  expect(lines.length).toBe(1);
  const parsed = JSON.parse(lines[0]);
  expect(parsed).toEqual({ ts: new Date(1000).toISOString(), event: "pair_ok", pub: "PUBA", ip: "1.2.3.4" });
});

test("omits undefined optional fields", () => {
  const lines: string[] = [];
  const audit = createAudit({ write: (l) => lines.push(l), now: () => 0 });
  audit.log({ event: "handshake_fail", ip: "5.6.7.8", reason: "unauthorized" });
  const parsed = JSON.parse(lines[0]);
  expect("pub" in parsed).toBe(false);
  expect(parsed.reason).toBe("unauthorized");
});
