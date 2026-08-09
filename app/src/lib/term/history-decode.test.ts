import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeHistoryData } from "./history-decode";

// 计划示意里用的是 `Bun.gzipSync`，但 app 侧的 vitest 跑在 Node 22 下（没有 Bun
// 全局，实测 `typeof Bun === "undefined"`），故改用 node:zlib 的同名能力造样本。
// 产出的是同一种 gzip 字节流，与 agent 侧 `Bun.gzipSync` 的产物可互解。
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

describe("decodeHistoryData", () => {
  it("无 enc 时按原始 base64 解 —— 向后兼容", async () => {
    const raw = new TextEncoder().encode("hello\nworld");
    expect(await decodeHistoryData(b64(raw), undefined)).toBe("hello\nworld");
  });

  it("enc=gzip 时先解压", async () => {
    const raw = new TextEncoder().encode("x".repeat(5000));
    const gz = gzipSync(raw);
    expect(await decodeHistoryData(b64(gz), "gzip")).toBe("x".repeat(5000));
  });

  it("空载荷不炸", async () => {
    expect(await decodeHistoryData("", undefined)).toBe("");
    expect(await decodeHistoryData("", "gzip")).toBe("");
  });

  it("认不出的 enc 当作未压缩 —— 宁可显示乱码也不要整个终端空白", async () => {
    const raw = new TextEncoder().encode("plain");
    expect(await decodeHistoryData(b64(raw), "brotli-from-the-future")).toBe("plain");
  });

  it("UTF-8 多字节完整还原（CJK 是本项目主场景）", async () => {
    const s = "探索切换现状 · 中文测试";
    const gz = gzipSync(new TextEncoder().encode(s));
    expect(await decodeHistoryData(b64(gz), "gzip")).toBe(s);
  });
});
