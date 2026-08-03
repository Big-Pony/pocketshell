import { describe, it, expect } from "bun:test";
import { isLocalAddr } from "./net-addr";

describe("isLocalAddr", () => {
  it("accepts loopback forms", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLocalAddr(a)).toBe(true);
  });
  it("rejects remote addresses", () => {
    for (const a of ["203.0.113.7", "10.0.0.2", "::ffff:203.0.113.7", ""]) expect(isLocalAddr(a)).toBe(false);
  });
});
