import { describe, it, expect } from "vitest";
import { imeSendText } from "./ime-send";

describe("imeSendText", () => {
  it("empty buffer sends a bare Enter", () => {
    expect(imeSendText("")).toBe("\r");
  });
  it("non-empty buffer sends text then Enter", () => {
    expect(imeSendText("你好 world")).toBe("你好 world\r");
  });
});
