// 用真 xterm 实例钉死三个真机故障形态（docs/bug/内容重复或者消失部分）。
//
// 每个用例都成对写：先证明 term.reset() 会坏，再证明流内 RIS 是好的。对照组
// 不是冗余 —— 它们是「为什么不能改回去」的可执行证据。
import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { buildReseedPayload, concatReseedWrite } from "./reseed";
import { PendingBuffer } from "./pending-buffer";

// xterm 的 write 是异步入队的，断言前必须等队列排空。空 write 的回调排在
// 队尾，回调触发即代表此前所有字节都已解析完。
const flush = (t: Terminal) => new Promise<void>((r) => t.write("", () => r()));

const lines = (t: Terminal): string[] => {
  const out: string[] = [];
  for (let i = 0; i < t.buffer.active.length; i++) {
    const l = t.buffer.active.getLine(i);
    if (l) out.push(l.translateToString(true));
  }
  return out.filter((s) => s.length > 0);
};

describe("形态一：字符熔合（真机截图里的 p8rmissions）", () => {
  it("term.reset() 挡不住排队字节 —— 复现故障", async () => {
    const t = new Terminal({ allowProposedApi: true });
    t.write("p8");                      // 实时帧，入队未解析
    t.reset();                          // 同步执行，队列纹丝不动
    t.write("rmissions\r\nline2\r\n");  // 快照
    await flush(t);
    expect(lines(t)[0]).toBe("p8rmissions"); // 熔了
    t.dispose();
  });

  it("流内 RIS 干净 —— 修复生效", async () => {
    const t = new Terminal({ allowProposedApi: true });
    t.write("p8");
    t.write(buildReseedPayload("rmissions\nline2\n"));
    await flush(t);
    expect(lines(t)).toEqual(["rmissions", "line2"]);
    t.dispose();
  });
});

describe("形态二：多世代堆叠（截图里 8 tasks 出现三次且尾部各异）", () => {
  it("两次 term.reset() 全部空转 —— 复现故障", async () => {
    const t = new Terminal({ allowProposedApi: true });
    t.reset(); t.write("GEN-A-1\r\nGEN-A-2\r\n");
    t.reset(); t.write("GEN-B-1\r\nGEN-B-2\r\n");
    await flush(t);
    expect(lines(t)).toEqual(["GEN-A-1", "GEN-A-2", "GEN-B-1", "GEN-B-2"]);
    t.dispose();
  });

  it("流内 RIS 让最后一代赢 —— 修复生效", async () => {
    const t = new Terminal({ allowProposedApi: true });
    t.write(buildReseedPayload("GEN-A-1\nGEN-A-2\n"));
    t.write(buildReseedPayload("GEN-B-1\nGEN-B-2\n"));
    await flush(t);
    expect(lines(t)).toEqual(["GEN-B-1", "GEN-B-2"]);
    t.dispose();
  });
});

describe("形态三：排队的控制序列穿透 reset（内容被整体下移）", () => {
  // 这里不能用上面的 lines()——它过滤空行，而本用例的损坏形态**就是**多出来的
  // 空行（内容被整体下移），滤掉就等于把证据抹了。
  const firstNonEmptyRow = (t: Terminal): number => {
    const b = t.buffer.active;
    for (let i = 0; i < b.length; i++) {
      if ((b.getLine(i)?.translateToString(true).trim() ?? "") !== "") return i;
    }
    return -1;
  };

  it("排队的光标定位穿透 reset，快照从第 4 行开始落笔 —— 复现故障", async () => {
    const t = new Terminal({ allowProposedApi: true });
    t.write("\x1b[4;1H\x1b[K");                     // 定位到第 4 行，入队未解析
    t.reset();                                      // 同步，队列纹丝不动
    t.write("AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE\r\n"); // 快照
    await flush(t);
    // 内容一个字节没丢，但整份被下移 3 行：上方凭空多出三个空行。真机上这就是
    // 「屏幕跳了一下、上面空出一块」，行数一多就把内容顶出可视区。
    expect(firstNonEmptyRow(t)).toBe(3);
    t.dispose();
  });

  it("流内 RIS 后快照从第 0 行开始 —— 修复生效", async () => {
    const t = new Terminal({ allowProposedApi: true });
    t.write("\x1b[4;1H\x1b[K");
    t.write(buildReseedPayload("AAA\nBBB\nCCC\nDDD\nEEE\n"));
    await flush(t);
    expect(firstNonEmptyRow(t)).toBe(0);
    expect(lines(t)).toEqual(["AAA", "BBB", "CCC", "DDD", "EEE"]);
    t.dispose();
  });
});

describe("RIS 的副作用边界（支撑「不必担心光标可见性回退」的判断）", () => {
  it("RIS 不改动 cols/rows", async () => {
    const t = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
    t.write(buildReseedPayload("x\n"));
    await flush(t);
    expect([t.cols, t.rows]).toEqual([100, 30]);
    t.dispose();
  });
});

describe("xterm 自带 reflow（支撑删除 resize 触发点的决定）", () => {
  it("软折行在变宽后合并回一行 —— 所以 resize 不需要重灌历史", async () => {
    const t = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    t.write("X".repeat(75) + "\r\n");
    await flush(t);
    expect(lines(t).length).toBe(2);          // 40 列下折成两行

    t.resize(80, 10);
    await flush(t);
    expect(lines(t).length).toBe(1);          // 合并回一行
    expect(lines(t)[0].length).toBe(75);      // 内容完整
    t.dispose();
  });
});

// 形态四：t0..t1 窗口内的实时字节被 RIS 抹掉（2026-08-18，「中间几行消失」的根因）
//
// reloadHistory 的 await 窗口在真机上中位 1931ms、最高 9283ms。期间 PTY 输出照常
// 写进 xterm，然后快照带着 RIS 到达把它们清掉 —— 这些字节快照里没有（拍摄时还没
// 产生），RIS 又抹掉，永久消失。丢的是**时间中段**，所以症状是「中间几行不见了」
// 而不是「最新几行不见了」，与用户描述精确吻合。
describe("形态四：await 窗口内的实时字节被 RIS 抹掉", () => {
  it("不旁录 —— 复现故障：窗口内的 LIVE 行永久消失", async () => {
    const t = new Terminal({ allowProposedApi: true });
    t.write(buildReseedPayload("SNAP-0\n"));         // 上一轮的屏幕
    t.write("LIVE-A\r\nLIVE-B\r\n");                 // t0..t1 窗口内到达的实时帧
    t.write(buildReseedPayload("SNAP-1\nSNAP-2\n")); // t1 快照（不含 LIVE-*）
    await flush(t);
    expect(lines(t)).toEqual(["SNAP-1", "SNAP-2"]);  // LIVE-A / LIVE-B 没了
    t.dispose();
  });

  it("旁录后拼进同一次 write —— 修复生效：窗口内的行回来了", async () => {
    const t = new Terminal({ allowProposedApi: true });
    const enc = new TextEncoder();
    t.write(buildReseedPayload("SNAP-0\n"));

    // 组件里 onOutput 的 active 分支：写 xterm 的同时旁录进 windowBuf。
    const windowBuf = new PendingBuffer();
    const live = enc.encode("LIVE-A\r\nLIVE-B\r\n");
    t.write(live);
    windowBuf.push(live);

    // 快照到达：RIS + 快照 + 窗口，**一次** write。
    // 快照末尾的空行 = 光标行（服务端 `-E <cursor_y>` 的语义，见 reseed.ts 的
    // normalizeReseedRows）：窗口字节在真机上就是从光标那一行开始写的。
    t.write(concatReseedWrite(buildReseedPayload("SNAP-1\nSNAP-2\n\n"), windowBuf.take()));
    await flush(t);
    expect(lines(t)).toEqual(["SNAP-1", "SNAP-2", "LIVE-A", "LIVE-B"]);
    t.dispose();
  });

  it("窗口字节跨帧切开一个中文字符也不能变成乱码", async () => {
    const t = new Terminal({ allowProposedApi: true });
    const windowBuf = new PendingBuffer();
    // "中" = E4 B8 AD，被分成两帧到达（真机上 PTY 分帧与字符边界毫无关系）。
    for (const part of [new Uint8Array([0xe4]), new Uint8Array([0xb8, 0xad])]) {
      t.write(part);
      windowBuf.push(part);
    }
    t.write(concatReseedWrite(buildReseedPayload("SNAP\n\n"), windowBuf.take()));
    await flush(t);
    expect(lines(t)).toEqual(["SNAP", "中"]);
    t.dispose();
  });

  it("窗口为空时载荷与旧行为逐字节一致 —— 没有输出的会话零影响", async () => {
    const t = new Terminal({ allowProposedApi: true });
    t.write("stale");
    t.write(concatReseedWrite(buildReseedPayload("SNAP\n"), new PendingBuffer().take()));
    await flush(t);
    expect(lines(t)).toEqual(["SNAP"]);
    t.dispose();
  });
});
