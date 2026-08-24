import { describe, expect, it } from "bun:test";
import { DUMP_MAX_LINES, dumpEnabled, formatMissingDump, missingDumpPath } from "./diag-dump";

describe("dumpEnabled —— 落盘原文要比查故障多一道授权", () => {
  it("默认关闭：POCKETSHELL_DIAG 开着也不够", () => {
    expect(dumpEnabled({})).toBe(false);
    expect(dumpEnabled({ POCKETSHELL_DIAG: "1" })).toBe(false);
    expect(dumpEnabled({ POCKETSHELL_DIAG_DUMP: "" })).toBe(false);
  });

  it("显式真值才开", () => {
    for (const v of ["1", "true", "on", "yes", "TRUE", " on "]) {
      expect(dumpEnabled({ POCKETSHELL_DIAG_DUMP: v })).toBe(true);
    }
    for (const v of ["0", "false", "off", "no", "maybe"]) {
      expect(dumpEnabled({ POCKETSHELL_DIAG_DUMP: v })).toBe(false);
    }
  });
});

describe("formatMissingDump", () => {
  // live 下标跳过空行，raw 行号不跳 —— 两者都要出现在输出里，否则对不上
  // capture-pane 的原始输出。
  const raw = ["a0", "", "b1", "c2", "", "d3", "e4", "f5"];

  it("缺行标 >，上下文标空格，live/raw 两个行号都给", () => {
    // live = a0(raw0) b1(raw2) c2(raw3) d3(raw5) e4(raw6) f5(raw7)
    const out = formatMissingDump({ tag: "t", ts: "TS", raw, missingAt: [2] });
    expect(out).toContain('  live[  1] row[  2] "b1"');
    expect(out).toContain('> live[  2] row[  3] "c2"');
    expect(out).toContain('  live[  3] row[  5] "d3"');
    // 没被点到的行不该出现
    expect(out).not.toContain('"a0"');
  });

  it("不连续的区段之间插省略号，不把整窗搬进来", () => {
    const wide = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    const out = formatMissingDump({ tag: "t", ts: "TS", raw: wide, missingAt: [2, 40] });
    expect(out).toContain("…");
    expect(out).toContain('"line-2"');
    expect(out).toContain('"line-40"');
    expect(out).not.toContain('"line-20"');
  });

  it("原文用 JSON.stringify 包起来 —— 行尾空白与不可见字符必须看得见", () => {
    const out = formatMissingDump({ tag: "t", ts: "TS", raw: ["  x  \t"], missingAt: [0] });
    expect(out).toContain('"  x  \\t"');
  });

  it("超过上限只列前 DUMP_MAX_LINES 行，并说明还剩多少", () => {
    const many = Array.from({ length: 200 }, (_, i) => `l${i}`);
    const at = Array.from({ length: 100 }, (_, i) => i);
    const out = formatMissingDump({ tag: "t", ts: "TS", raw: many, missingAt: at });
    expect(out).toContain(`还有 ${100 - DUMP_MAX_LINES} 行未列出`);
  });

  it("空行不进 live —— 缺行下标与 ScreenDiff.missingAt 同源", () => {
    const out = formatMissingDump({ tag: "t", ts: "TS", raw, missingAt: [0] });
    // live[0] 是 "a0"（raw 0），live[1] 是 "b1"（raw 2）—— 中间那个空行被跳过
    expect(out).toContain('> live[  0] row[  0] "a0"');
    expect(out).toContain('  live[  1] row[  2] "b1"');
  });
});

describe("missingDumpPath", () => {
  it("跟随 POCKETSHELL_KEY_DIR", () => {
    expect(missingDumpPath({ POCKETSHELL_KEY_DIR: "/tmp/ps" })).toBe("/tmp/ps/diag-missing.txt");
  });
});
