import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import DeviceManager from "./DeviceManager.svelte";

// 14 期需求 5：假空态。listDevices 是 push 型（send 后等广播），
// 加载中 devices 为空数组，与"确实没有设备"共用一个条件，
// 于是用户先看到一句肯定的错话。
describe("DeviceManager 加载态", () => {
  it("加载中不显示「暂无已登记设备」", () => {
    const conn = { listDevices: vi.fn(), onDevices: vi.fn(() => () => {}) } as any;
    const { queryByText } = render(DeviceManager, { props: { conn, onClose: () => {} } });
    expect(queryByText("暂无已登记设备")).toBeNull();
  });

  it("确实加载完且为空时才显示空态", async () => {
    let cb: ((d: unknown[]) => void) | null = null;
    const conn = {
      listDevices: vi.fn(),
      onDevices: vi.fn((f: (d: unknown[]) => void) => { cb = f; return () => {}; }),
    } as any;
    const { findByText } = render(DeviceManager, { props: { conn, onClose: () => {} } });
    cb!([]);
    expect(await findByText("暂无已登记设备")).toBeTruthy();
  });
});
