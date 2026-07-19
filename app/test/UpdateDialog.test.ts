import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import UpdateDialog from "../src/components/UpdateDialog.svelte";

describe("UpdateDialog", () => {
  it("shows versions and fires onConfirm/onCancel", async () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    const { getByText } = render(UpdateDialog, {
      props: {
        info: { current: "0.3.0", latest: "0.4.0", hasUpdate: true, notes: "x", publishedAt: null, canApply: true },
        phase: null, onConfirm, onCancel,
      },
    });
    await fireEvent.click(getByText("更新"));
    expect(onConfirm).toHaveBeenCalled();
    await fireEvent.click(getByText("取消"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows progress phase with percent and disables backdrop dismissal while busy", async () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    const { getByText } = render(UpdateDialog, {
      props: {
        info: { current: "0.3.0", latest: "0.4.0", hasUpdate: true, notes: "", publishedAt: null, canApply: true },
        phase: "downloading", pct: 42, onConfirm, onCancel,
      },
    });
    expect(getByText(/下载中/)).toBeTruthy();
    expect(getByText(/42%/)).toBeTruthy();
  });

  it("shows error phase with retry/close actions", async () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    const { getByText } = render(UpdateDialog, {
      props: {
        info: { current: "0.3.0", latest: "0.4.0", hasUpdate: true, notes: "", publishedAt: null, canApply: true },
        phase: "error", message: "boom", onConfirm, onCancel,
      },
    });
    expect(getByText(/更新失败/)).toBeTruthy();
    await fireEvent.click(getByText("重试"));
    expect(onConfirm).toHaveBeenCalled();
    await fireEvent.click(getByText("关闭"));
    expect(onCancel).toHaveBeenCalled();
  });
});
