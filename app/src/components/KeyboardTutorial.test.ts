import { test, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/svelte";
import KeyboardTutorial from "./KeyboardTutorial.svelte";

// 文案断言走 container.textContent 而不是 getByText：教程正文被拆成
// <b>导语</b> + 正文两个文本节点，而 testing-library 的默认匹配器只看
// **直接**子文本节点，同一个关键词会同时命中 <b> 与 <p>（以及 layered 演示图
// 里那颗 123 键帽），getByText 当场抛 "Found multiple elements"。
test("layered 教程讲的是切层，不是手势", () => {
  const { container } = render(KeyboardTutorial, { props: { tutorial: "layered", onClose: vi.fn() } });
  expect(container.textContent).toContain("分层");
  expect(container.textContent).toContain("123");
  expect(container.textContent, "分层教程不该提上滑，那是另一套布局的事").not.toContain("上滑");
});

test("flick 教程讲的是上滑", () => {
  const { container } = render(KeyboardTutorial, { props: { tutorial: "flick", onClose: vi.fn() } });
  expect(container.textContent).toContain("上滑");
});

test("两个按钮都关闭弹窗", async () => {
  for (const label of ["知道了", "开始使用"]) {
    const onClose = vi.fn();
    const { unmount } = render(KeyboardTutorial, { props: { tutorial: "flick", onClose } });
    await fireEvent.click(screen.getByText(label));
    expect(onClose, `「${label}」应关闭`).toHaveBeenCalledOnce();
    unmount();
  }
});

test("点遮罩关闭，点卡片内部不关闭", async () => {
  const onClose = vi.fn();
  const { container } = render(KeyboardTutorial, { props: { tutorial: "layered", onClose } });
  await fireEvent.click(container.querySelector(".kt-card") as HTMLElement);
  expect(onClose, "点卡片不该关").not.toHaveBeenCalled();
  await fireEvent.click(container.querySelector(".kt-mask") as HTMLElement);
  expect(onClose, "点遮罩该关").toHaveBeenCalledOnce();
});

test("是个 modal dialog（无障碍）", () => {
  const { container } = render(KeyboardTutorial, { props: { tutorial: "flick", onClose: vi.fn() } });
  const dlg = container.querySelector('[role="dialog"]');
  expect(dlg).toBeTruthy();
  expect(dlg?.getAttribute("aria-modal")).toBe("true");
});
