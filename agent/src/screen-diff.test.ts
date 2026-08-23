import { describe, expect, it } from "bun:test";
import { diffScreens, hashLine, hashLines, normLine } from "./screen-diff";

describe("normLine", () => {
  it("去行尾空白（tmux 会补空格到 pane 宽度，xterm 不会）", () => {
    expect(normLine("abc   ")).toBe("abc");
    expect(normLine("abc\t")).toBe("abc");
  });
  it("**不**去行首空白——那是缩进，属于真实内容", () => {
    expect(normLine("  abc")).toBe("  abc");
  });
  it("两端归一后一致 ⇒ 哈希一致（这条是对拍成立的前提）", () => {
    expect(hashLine(normLine("  ⏺ 明白  "))).toBe(hashLine(normLine("  ⏺ 明白")));
  });
});

// 跨仓契约：app/src/lib/term/screen-probe.ts 里有一份**逐字相同**的 hashLine，
// 因为 app 不依赖 agent 的源码树。两端一旦漂移，对拍出来的差异全是假的（每行
// 都不一样 ⇒ 永远报「buffer 少了内容」）。这组固定向量在两处测试里逐字相同：
// 改动任一侧的实现，两处同时红。
describe("哈希固定向量（与 app/src/lib/term/screen-probe.test.ts 逐字相同）", () => {
  it("固定向量", () => {
    expect(hashLine("")).toBe(2166136261);
    expect(hashLine("a")).toBe(3826002220);
    expect(hashLine("hello")).toBe(1335831723);
  });
});

describe("hashLine", () => {
  it("不同内容不同哈希", () => {
    expect(hashLine("a")).not.toBe(hashLine("b"));
  });
  it("空行稳定且为 32 位无符号", () => {
    const h = hashLine("");
    expect(h).toBe(hashLine(""));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
  it("CJK 与 emoji 不炸", () => {
    expect(typeof hashLine("你好 🚀 世界")).toBe("number");
  });
});

describe("diffScreens（集合比对）", () => {
  const H = (...ls: string[]) => hashLines(ls);

  it("完全一致 ⇒ 无缺失（判定：数据在 buffer 里，是没画出来）", () => {
    const a = H("l1", "l2", "l3");
    expect(diffScreens(a, [...a])).toMatchObject({ missingLines: 0, extraLines: 0, firstDiff: -1 });
  });

  it("故障形态：xterm 中间几行整体消失 ⇒ missingLines 抓到（判定：buffer 真的少了）", () => {
    const t = H("head", "row1", "row2", "row3", "tail");
    const x = H("head", "row3", "tail");
    expect(diffScreens(t, x)).toMatchObject({ missingLines: 2, firstDiff: 1 });
  });

  it("**位置无关**：整体滚动一行不再是差异（旧的按位置比对会顶满）", () => {
    const t = H("a", "b", "c", "d");
    const x = H("b", "c", "d", "e");
    // a 在 xterm 里没有 ⇒ 只算 1 条缺失；c/d 位置全错开却不计入
    expect(diffScreens(t, x).missingLines).toBe(1);
  });

  it("**行划分不同**不再放大：xterm 把长行拆成两行，其余行照常匹配", () => {
    const t = H("head", "一整行很长的内容", "tail");
    const x = H("head", "一整行很长的内容", "tail", "多出来的续行");
    expect(diffScreens(t, x)).toMatchObject({ missingLines: 0, extraLines: 1 });
  });

  it("动画行（spinner/计时）只落一条 missing + 一条 extra，不放大成整屏", () => {
    // 实测：同一 pane 相隔毫秒的两次 capture 就已差在 spinner 字符上
    const t = H("head", "· Orbiting… (13m 19s)", "tail");
    const x = H("head", "✢ Orbiting… (13m 19s)", "tail");
    const d = diffScreens(t, x);
    expect(d.missingLines).toBe(1);
    expect(d.extraLines).toBe(1);
  });

  it("空行不参与：两边空行数量本来就不同（tmux 补白 vs xterm 稀疏）", () => {
    const t = H("a", "", "", "b");
    const x = H("a", "b");
    expect(diffScreens(t, x)).toMatchObject({ missingLines: 0, extraLines: 0 });
  });

  it("firstDiff 指向 tmux 侧首个缺失行的行号", () => {
    const t = H("a", "b", "c", "d");
    const x = H("a", "b", "d");
    expect(diffScreens(t, x)).toMatchObject({ missingLines: 1, firstDiff: 2 });
  });

  it("extraLines：xterm 留着 tmux 已经没有的陈旧行", () => {
    const t = H("new1", "new2");
    const x = H("new1", "new2", "旧内容");
    expect(diffScreens(t, x)).toMatchObject({ missingLines: 0, extraLines: 1 });
  });

  it("两边全空不炸", () => {
    expect(diffScreens([], [])).toMatchObject({ missingLines: 0, extraLines: 0, firstDiff: -1 });
  });

  it("xterm 整个空 ⇒ tmux 的每一非空行都算缺失（首屏空白的形态）", () => {
    expect(diffScreens(H("a", "b", "c"), []).missingLines).toBe(3);
  });
});

// 成对扣除的判据（在 rpc-router 的 diag.screen 里实施，这里钉住它依赖的性质）。
// 线上实测样本：`缺=1 陈旧=1`、`缺=2 陈旧=2`、`缺=14 陈旧=15` —— 全是动画行
// （spinner 转帧、计时跳秒）在两侧各记一条造成的，不是真丢内容。
describe("动画行的成对特征（成对扣除的依据）", () => {
  const H = (...ls: string[]) => hashLines(ls);

  it("一行变了内容 ⇒ missing 与 extra 各 1（成对）", () => {
    const t = H("head", "· Orbiting… (13m 19s)", "tail");
    const x = H("head", "✢ Orbiting… (13m 20s)", "tail");
    const d = diffScreens(t, x);
    expect(d.missingLines).toBe(1);
    expect(d.extraLines).toBe(1);
    // 扣除成对后净缺失为 0
    expect(d.missingLines - Math.min(d.missingLines, d.extraLines)).toBe(0);
  });

  it("真丢内容 ⇒ missing 有、extra 没有（不成对，扣不掉）", () => {
    const t = H("head", "row1", "row2", "row3", "tail");
    const x = H("head", "row3", "tail");
    const d = diffScreens(t, x);
    expect(d.missingLines).toBe(2);
    expect(d.extraLines).toBe(0);
    // 扣除成对后净缺失仍是 2 —— 真信号活下来了，这才是成对扣除可用的前提
    expect(d.missingLines - Math.min(d.missingLines, d.extraLines)).toBe(2);
  });

  it("丢内容 + 动画同时发生 ⇒ 扣掉动画那一对，真缺失仍报出来", () => {
    const t = H("head", "row1", "row2", "· spin", "tail");
    const x = H("head", "row2", "✢ spin", "tail");   // row1 真丢了，spin 变了
    const d = diffScreens(t, x);
    const net = d.missingLines - Math.min(d.missingLines, d.extraLines);
    expect(net).toBe(1);
  });
});
