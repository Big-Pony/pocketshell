import { describe, it, expect } from "vitest";
import { urlBase64ToUint8Array, sessionFromUrl, webPushErrorKey } from "../src/lib/notify";

describe("webPushErrorKey", () => {
  // 真机上最常见的失败：手机连不上 FCM（国内网络），Chrome 抛这句原文，
  // 用户完全看不懂。必须映射成「推送服务连不上，需要代理/VPN」。
  it("maps Chrome's push service error to the unreachable hint", () => {
    const e = new DOMException("Registration failed - push service error", "AbortError");
    expect(webPushErrorKey(e)).toBe("notify.webpush.err.unreachable");
  });
  it("maps the same text regardless of DOMException name", () => {
    expect(webPushErrorKey(new Error("Registration failed - push service error")))
      .toBe("notify.webpush.err.unreachable");
  });
  it("maps a missing/blocked service worker to its own hint", () => {
    const e = new Error("Failed to execute 'subscribe' on 'PushManager': Subscription failed - no active Service Worker");
    expect(webPushErrorKey(e)).toBe("notify.webpush.err.noWorker");
  });
  it("returns null for an error it does not recognize, so the raw text still shows", () => {
    expect(webPushErrorKey(new Error("something else entirely"))).toBeNull();
  });
});

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
