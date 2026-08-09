import { describe, it, expect } from "vitest";
import { buildReseedPayload, ReseedGate } from "./reseed";

describe("buildReseedPayload", () => {
  it("总是以 RIS 开头 —— 清空必须和内容在同一个字符串里", () => {
    expect(buildReseedPayload("hello")).toBe("\x1bchello");
  });

  it("把裸 \\n 规范成 \\r\\n（xterm 跑在 convertEol:false 下，裸 \\n 只下移不回列）", () => {
    expect(buildReseedPayload("a\nb")).toBe("\x1bca\r\nb");
  });

  it("不把已有的 \\r\\n 变成 \\r\\r\\n", () => {
    expect(buildReseedPayload("a\r\nb")).toBe("\x1bca\r\nb");
  });

  it("空内容也要带 RIS —— 快照为空意味着 pane 是空的，屏幕也该被清干净", () => {
    expect(buildReseedPayload("")).toBe("\x1bc");
  });
});

describe("ReseedGate", () => {
  it("首次 begin 返回 1，且不过期", () => {
    const g = new ReseedGate();
    const gen = g.begin();
    expect(gen).toBe(1);
    expect(g.isStale(gen)).toBe(false);
  });

  it("后一次 begin 让前一代过期 —— 旧快照必须被整份丢弃", () => {
    const g = new ReseedGate();
    const first = g.begin();
    const second = g.begin();
    expect(g.isStale(first)).toBe(true);
    expect(g.isStale(second)).toBe(false);
  });

  it("代际单调递增", () => {
    const g = new ReseedGate();
    expect([g.begin(), g.begin(), g.begin()]).toEqual([1, 2, 3]);
  });
});

import { buildReseedReport } from "./reseed";

describe("buildReseedReport", () => {
  const base = {
    trigger: "alt-normal" as const,
    rttMs: 120,
    discarded: false,
    snapshotBytes: 4096,
    framesDuringAwait: 3,
    bytesDuringAwait: 800,
    bufferLenBefore: 500,
    bufferLenAfter: 480,
  };

  it("kind 固定为 reseed —— agent 侧按它路由白名单", () => {
    expect(buildReseedReport(base).kind).toBe("reseed");
  });

  it("原样带上所有计数字段", () => {
    const r = buildReseedReport(base);
    expect(r.trigger).toBe("alt-normal");
    expect(r.rttMs).toBe(120);
    expect(r.framesDuringAwait).toBe(3);
    expect(r.bytesDuringAwait).toBe(800);
    expect(r.bufferLenBefore).toBe(500);
    expect(r.bufferLenAfter).toBe(480);
    expect(r.snapshotBytes).toBe(4096);
  });

  it("discarded 为真时如实带上 —— 那是「并发被拦下」的证据", () => {
    expect(buildReseedReport({ ...base, discarded: true }).discarded).toBe(true);
  });
});

import { buildRpcReport } from "./reseed";

describe("buildRpcReport", () => {
  it("kind 固定为 rpc —— agent 侧按它路由白名单", () => {
    expect(buildRpcReport({ method: "fs.read", rttMs: 1, wireBytes: 2, rawBytes: 3, chunks: 1 }).kind).toBe("rpc");
  });

  it("字段名与 agent 白名单逐字对应", () => {
    const r = buildRpcReport({ method: "git.log", rttMs: 820, wireBytes: 116636, rawBytes: 184859, chunks: 3 });
    expect(Object.keys(r).sort()).toEqual(["chunks", "kind", "method", "rawBytes", "rttMs", "wireBytes"]);
  });
});
