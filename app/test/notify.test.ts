import { describe, it, expect } from "vitest";
import { urlBase64ToUint8Array, sessionFromUrl, webPushErrorKey, needsResubscribe } from "../src/lib/notify";

describe("needsResubscribe", () => {
  // OTA 更新后 hardReset() 会 unregister service worker，连带销毁 push 订阅，
  // 但 agent 侧 notify.json 的 webPush 仍是 true —— 开关显示「开」却收不到推送，
  // 用户得手动关一次再开。启动时据此自愈。
  it("resubscribes when the agent says push is on but this browser lost its subscription", () => {
    expect(needsResubscribe({ cfgWebPush: true, hasBrowserSub: false, permission: "granted" })).toBe(true);
  });
  it("does nothing when both sides agree push is on", () => {
    expect(needsResubscribe({ cfgWebPush: true, hasBrowserSub: true, permission: "granted" })).toBe(false);
  });
  it("does not resurrect push the user turned off, even if a stale browser sub lingers", () => {
    expect(needsResubscribe({ cfgWebPush: false, hasBrowserSub: true, permission: "granted" })).toBe(false);
  });
  it("does nothing when push is off on both sides", () => {
    expect(needsResubscribe({ cfgWebPush: false, hasBrowserSub: false, permission: "granted" })).toBe(false);
  });

  // notify.json 的 webPush 是 agent 全局的，不是每设备一份。手机开了推送后，
  // 一台从没开过推送的新设备连上来也会读到 webPush=true —— 绝不能因此替它
  // 订阅。Notification.permission 是每设备独立、由浏览器持有的本地证据，
  // 「这台设备是否曾经同意过」只能问它。
  it("never subscribes a device that has not granted notification permission", () => {
    expect(needsResubscribe({ cfgWebPush: true, hasBrowserSub: false, permission: "default" })).toBe(false);
  });
  it("never subscribes a device where the user denied notifications", () => {
    expect(needsResubscribe({ cfgWebPush: true, hasBrowserSub: false, permission: "denied" })).toBe(false);
  });
});

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
