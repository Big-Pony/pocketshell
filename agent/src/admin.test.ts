import { describe, it, expect } from "bun:test";
import { isLocalAddr, deviceRows, ADMIN_HTML } from "./admin";

describe("isLocalAddr", () => {
  it("accepts loopback forms", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLocalAddr(a)).toBe(true);
  });
  it("rejects remote addresses", () => {
    for (const a of ["203.0.113.7", "10.0.0.2", "::ffff:203.0.113.7", ""]) expect(isLocalAddr(a)).toBe(false);
  });
});

describe("deviceRows", () => {
  it("uses live ip when online, else lastIp", () => {
    const recs = [
      { pubKey: "A", name: "phone", addedAt: "t0", lastSeen: "t1", lastIp: "1.1.1.1" },
      { pubKey: "B", name: "pad", addedAt: "t0", lastSeen: null },
    ];
    const online = new Map([["A", "9.9.9.9"]]);
    const rows = deviceRows(recs, online);
    expect(rows.find((r) => r.pubKey === "A")).toMatchObject({ online: true, ip: "9.9.9.9" });
    expect(rows.find((r) => r.pubKey === "B")).toMatchObject({ online: false, ip: "" });
  });
});

describe("ADMIN_HTML", () => {
  it("is a self-contained html page", () => {
    expect(ADMIN_HTML).toContain("<!doctype html>");
    expect(ADMIN_HTML).toContain("/admin-api/");
  });
  it("escapes device-supplied fields before innerHTML (no raw d.name)", () => {
    // Guard against stored XSS via a crafted device name: the row renderer must
    // wrap device fields in esc(...) rather than concatenating them raw.
    expect(ADMIN_HTML).toContain("function esc(");
    expect(ADMIN_HTML).toContain("esc(d.name)");
    expect(ADMIN_HTML).not.toContain("+ d.name +");
  });
});
