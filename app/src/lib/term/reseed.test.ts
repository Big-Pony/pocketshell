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

// ── 以下为 2026-08-18「多会话空白与输出丢失」修复新增 ──

import { historyExpectBytes, HISTORY_WIRE_BYTES_PER_LINE, seedRetryDelayMs, SEED_MAX_ATTEMPTS, concatReseedWrite } from "./reseed";
import { rpcDeadlineMs, RPC_BASE_TIMEOUT_MS } from "../net/connection";

describe("historyExpectBytes（优先级 1a：term.history 的死线记账）", () => {
  it("按行数线性估算 —— 精度不重要，量级正确即可", () => {
    expect(historyExpectBytes(1000)).toBe(1000 * HISTORY_WIRE_BYTES_PER_LINE);
    expect(historyExpectBytes(200)).toBe(200 * HISTORY_WIRE_BYTES_PER_LINE);
  });

  it("非法/零输入退回 0（等价于不传，行为不变）", () => {
    expect(historyExpectBytes(0)).toBe(0);
    expect(historyExpectBytes(-5)).toBe(0);
    expect(historyExpectBytes(Number.NaN)).toBe(0);
  });

  it("量级要落在真机实测区间内（8 会话压缩快照 8~22KB，原始 40~83KB）", () => {
    // 默认 1000 行。上线的是「压缩 + base64」，即 11~30KB —— 估算值必须同量级，
    // 太小则死线不放大（等于没修），太大则慢链路上白等。
    const est = historyExpectBytes(1000);
    expect(est).toBeGreaterThanOrEqual(11_000);
    expect(est).toBeLessThanOrEqual(120_000);
  });

  it("★ 核心：8 个并发 term.history 传了 expectBytes 后死线确实放大", () => {
    const one = historyExpectBytes(1000);
    // 修复前：只记出站的那几十个字节，8 并发的排队量 < BASE_COVERED_BYTES，
    // 死线恒为 10s —— 与单个一模一样。
    const before = rpcDeadlineMs(8 * 200);
    expect(before).toBe(RPC_BASE_TIMEOUT_MS);
    // 修复后：第 8 个 lane 的预算覆盖前 7 个响应体 + 自己。
    const after = rpcDeadlineMs(8 * one);
    expect(after).toBeGreaterThan(RPC_BASE_TIMEOUT_MS * 3);
  });
});

describe("seedRetryDelayMs（优先级 1b：首屏失败不再是吸收态）", () => {
  it("至少重试两次以上 —— 一次抖动不该让首屏永久空白", () => {
    expect(SEED_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
  });

  it("退避递增且有上限（慢链路上不能无脑立刻重打）", () => {
    const d0 = seedRetryDelayMs(0);
    const d1 = seedRetryDelayMs(1);
    const d2 = seedRetryDelayMs(2);
    expect(d0).toBeGreaterThan(0);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
    expect(seedRetryDelayMs(99)).toBeLessThanOrEqual(30_000);
  });
});

describe("concatReseedWrite（优先级 4：窗口旁录必须与 RIS 拼进同一次 write）", () => {
  it("没有旁录字节时原样返回字符串 —— 既有路径零变化", () => {
    expect(concatReseedWrite("\x1bcabc", null)).toBe("\x1bcabc");
    expect(concatReseedWrite("\x1bcabc", new Uint8Array(0))).toBe("\x1bcabc");
  });

  it("有旁录字节时产出**一个** Uint8Array，RIS/快照/窗口三段同在其中", () => {
    const win = new TextEncoder().encode("LIVE");
    const out = concatReseedWrite("\x1bcSNAP", win);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(out as Uint8Array)).toBe("\x1bcSNAPLIVE");
  });

  it("走字节而不是字符串拼接 —— 实时帧可能在多字节字符中间切开", () => {
    // "中" = E4 B8 AD。分两帧到达时，按字符串各自解码会各产生一个 U+FFFD。
    const win = new Uint8Array([0xe4, 0xb8, 0xad]);
    const out = concatReseedWrite("\x1bc", win) as Uint8Array;
    expect(new TextDecoder().decode(out)).toBe("\x1bc中");
  });
});

describe("buildReseedReport 的失败分支（优先级 1c：埋点不能只有幸存者）", () => {
  it("带 error 时如实上报 —— 字段名必须落在 agent 白名单内", () => {
    const r = buildReseedReport({
      trigger: "seed", rttMs: 10_001, discarded: false, snapshotBytes: 0,
      framesDuringAwait: 0, bytesDuringAwait: 0, bufferLenBefore: 24, bufferLenAfter: 24,
      error: "rpc_timeout",
    });
    expect(r.error).toBe("rpc_timeout");
    expect(r.kind).toBe("reseed");
  });

  it("不带 error 时不得凭空多出该字段（成功样本的形状保持不变）", () => {
    const r = buildReseedReport({
      trigger: "resync", rttMs: 1, discarded: false, snapshotBytes: 1,
      framesDuringAwait: 0, bytesDuringAwait: 0, bufferLenBefore: 1, bufferLenAfter: 1,
    });
    expect("error" in r).toBe(false);
  });
});
