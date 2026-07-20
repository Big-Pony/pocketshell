import { describe, it, expect } from "vitest";
import { urlBase64ToUint8Array, sessionFromUrl } from "../src/lib/notify";

describe("notify pure helpers", () => {
  it("decodes urlBase64 VAPID key to bytes", () => {
    const bytes = urlBase64ToUint8Array("BBBB"); // 3 bytes of zero after padding
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(3);
  });
  it("extracts session from query", () => {
    expect(sessionFromUrl("?session=work")).toBe("work");
    expect(sessionFromUrl("?x=1")).toBeNull();
    expect(sessionFromUrl("?session=a%20b")).toBe("a b");
  });
});
