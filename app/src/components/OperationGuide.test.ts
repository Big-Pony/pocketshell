import { test, expect } from "vitest";
import { render } from "@testing-library/svelte";
import OperationGuide from "./OperationGuide.svelte";

test("renders all section headings and closes on the × button", () => {
  let closed = 0;
  const { getByText, getByLabelText } = render(OperationGuide, { props: { onClose: () => closed++ } });
  expect(getByText("上区标签页")).toBeInTheDocument();   // tabs.h (vitest is fixed to zh)
  expect(getByText("图标按钮")).toBeInTheDocument();     // icons.h
  expect(getByText("手势")).toBeInTheDocument();         // gestures.h
  getByLabelText("关闭").click();
  expect(closed).toBe(1);
});
