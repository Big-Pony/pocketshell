import { describe, expect, it, vi, beforeEach } from "vitest";
import { hardReset, clearAppCaches } from "./cache-admin";

function stubEnv(opts: { regs?: unknown[] } = {}) {
  const unregister = vi.fn(async () => true);
  const update = vi.fn(async () => {});
  const regs = opts.regs ?? [{ unregister, update }];
  vi.stubGlobal("caches", {
    keys: async () => ["ps-v1.0.0", "someone-else"],
    delete: vi.fn(async () => true),
  });
  vi.stubGlobal("navigator", {
    serviceWorker: { getRegistrations: async () => regs },
  });
  vi.stubGlobal("location", { reload: vi.fn() });
  return { unregister, update };
}

const reloadCalls = () =>
  (globalThis.location as unknown as { reload: ReturnType<typeof vi.fn> }).reload;

beforeEach(() => { vi.unstubAllGlobals(); });

// 14 期需求 4：注销 SW 会连带销毁 push 订阅（Push API 规范：订阅是注册的
// 子对象）。这是"每次更新后推送就失效"的自伤来源，且设置面板的
// 「清除缓存并重载」走同一条路——手动清一次缓存就静默杀掉推送。
describe("hardReset 不再注销 Service Worker", () => {
  it("清缓存但不 unregister", async () => {
    const { unregister } = stubEnv();
    await hardReset();
    expect(unregister, "注销 SW 会连带销毁 push 订阅").not.toHaveBeenCalled();
  });

  it("改为触发 SW 更新检查（标准 update 流程）", async () => {
    const { update } = stubEnv();
    await hardReset();
    expect(update).toHaveBeenCalled();
  });

  it("无论如何都会 reload", async () => {
    stubEnv();
    await hardReset();
    expect(reloadCalls()).toHaveBeenCalled();
  });

  it("update 抛错也照样 reload（best-effort）", async () => {
    vi.stubGlobal("caches", { keys: async () => [], delete: vi.fn() });
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistrations: async () => [{ update: async () => { throw new Error("x"); } }] },
    });
    vi.stubGlobal("location", { reload: vi.fn() });
    await hardReset();
    expect(reloadCalls()).toHaveBeenCalled();
  });
});

// 缓存清理本身此前也没有任何测试。前缀判定错了会有两种后果：删多了（把别的
// origin 组件的桶也删掉）或删少了（旧桶永远留着，配额一路涨）。
describe("clearAppCaches 只删本 App 的桶", () => {
  it("按 ps-v 前缀筛选，别人的桶不动", async () => {
    const del = vi.fn(async (_k: string) => true);
    vi.stubGlobal("caches", { keys: async () => ["ps-v1.0.0", "ps-v0.9.0", "someone-else"], delete: del });
    await clearAppCaches();
    expect(del.mock.calls.map((c) => c[0])).toEqual(["ps-v1.0.0", "ps-v0.9.0"]);
  });
});
