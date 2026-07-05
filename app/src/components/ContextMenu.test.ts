// Sample component test — "render + interaction" style.
// Shows how to mount a Svelte 5 component in jsdom, query the DOM, fire an
// event, and assert on callback props. Use this as the template for testing
// presentational components (menus, dialogs, panels).
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import ContextMenu from "./ContextMenu.svelte";

test("renders each item and fires onSelect + onClose when one is clicked", async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(ContextMenu, { props: { items: [{ label: "重命名", onSelect }], onClose } });

  expect(screen.getByText("重命名")).toBeInTheDocument();
  await fireEvent.click(screen.getByText("重命名"));

  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1); // menu closes after a selection
});

test("the trailing cancel button closes without selecting anything", async () => {
  const onClose = vi.fn();
  render(ContextMenu, { props: { items: [], onClose } });

  await fireEvent.click(screen.getByText("取消"));
  expect(onClose).toHaveBeenCalledTimes(1);
});
