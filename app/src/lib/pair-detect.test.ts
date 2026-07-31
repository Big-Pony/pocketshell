import { describe, expect, it } from "vitest";
import { detectPairing } from "./pair-detect";

// 用 pairing.test.ts 同款构造法造一个合法配对串
function makePairString(): string {
  const json = JSON.stringify({ v: 1, pub: "cHVia2V5", addr: "wss://example.com", code: "ABCD2345" });
  const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "pocketshell-pair:" + b64;
}

describe("detectPairing", () => {
  it("识别合法配对串并原样返回", () => {
    const s = makePairString();
    expect(detectPairing(s)).toBe(s);
  });

  it("去掉首尾空白后仍能识别", () => {
    const s = makePairString();
    expect(detectPairing("  \n" + s + "\n  ")).toBe(s);
  });

  it("普通文本返回 null", () => {
    expect(detectPairing("hello world")).toBeNull();
  });

  it("前缀对但载荷损坏返回 null", () => {
    expect(detectPairing("pocketshell-pair:@@@notbase64@@@")).toBeNull();
  });

  it("缺字段的载荷返回 null", () => {
    const b64 = btoa(JSON.stringify({ v: 1, pub: "x" })).replace(/=+$/, "");
    expect(detectPairing("pocketshell-pair:" + b64)).toBeNull();
  });

  it("null / undefined / 空串返回 null", () => {
    expect(detectPairing(null)).toBeNull();
    expect(detectPairing(undefined)).toBeNull();
    expect(detectPairing("")).toBeNull();
  });
});
