// 用真 xterm 实例钉死三个真机故障形态（docs/bug/内容重复或者消失部分）。
//
// 每个用例都成对写：先证明 term.reset() 会坏，再证明流内 RIS 是好的。对照组
// 不是冗余 —— 它们是「为什么不能改回去」的可执行证据。
import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { buildReseedPayload } from "./reseed";

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
