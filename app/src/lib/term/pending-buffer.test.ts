import { describe, expect, it } from "vitest";
import { PendingBuffer } from "./pending-buffer";

const b = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe("PendingBuffer 基本语义（R1 隐藏暂存）", () => {
  it("空缓冲 take 返回 null", () => {
    expect(new PendingBuffer().take()).toBeNull();
  });

  it("按顺序拼接，take 后清空", () => {
    const p = new PendingBuffer();
    p.push(b(2, 1));
    p.push(b(2, 2));
    expect(Array.from(p.take()!)).toEqual([1, 1, 2, 2]);
    expect(p.take()).toBeNull();
  });

  it("超过上限即丢弃并置 dirty —— 宁可丢也不能把内存吃穿", () => {
    const p = new PendingBuffer(4);
    p.push(b(8, 1));
    expect(p.dirty).toBe(true);
    expect(p.take()).toBeNull();
  });

  it("dirty 之后 push 全部忽略，直到 clearDirty", () => {
    const p = new PendingBuffer(4);
    p.push(b(8, 1));
    p.push(b(1, 2));
    expect(p.take()).toBeNull();
    p.clearDirty();
    p.push(b(1, 3));
    expect(Array.from(p.take()!)).toEqual([3]);
  });
});

// 【2026-08-23】重连重复内容的修复（真机症状：重连后出现长串重复）。
//
// 机制：gap 重连时服务端**先发 resync、再补发**最新 32KB 实时字节；客户端 onResync
// 同步发起重灌，旁录窗口因此在补发帧到达前就开好了，那 32KB 全落进旁录。而
// term.history 先取号后快照，返回的 seq 即分界线 —— seq ≤ 它的字节已经在快照里，
// 旁录再拼一遍就是重复。
describe("takeAfter（按快照 seq 过滤旁录）", () => {
  it("滤掉 seq ≤ 快照 seq 的字节 —— 那些已经在快照里了", () => {
    const p = new PendingBuffer();
    p.push(b(4, 1), 10);   // 补发的（在快照里）
    p.push(b(4, 2), 20);   // 补发的（在快照里）
    p.push(b(4, 3), 30);   // 快照之后真正新到的
    expect(Array.from(p.takeAfter(20)!)).toEqual([3, 3, 3, 3]);
  });

  it("全部 ≤ 快照 seq ⇒ null（一个字节都不该重写）", () => {
    const p = new PendingBuffer();
    p.push(b(4, 1), 5);
    p.push(b(4, 2), 9);
    expect(p.takeAfter(9)).toBeNull();
  });

  it("边界：seq 等于快照 seq 的那一帧要被滤掉（快照含它）", () => {
    const p = new PendingBuffer();
    p.push(b(2, 7), 100);
    expect(p.takeAfter(100)).toBeNull();
    const q = new PendingBuffer();
    q.push(b(2, 7), 101);
    expect(q.takeAfter(100)).not.toBeNull();
  });

  it("seq=0（没有序号信息）永不被滤 —— R1 暂存路径的语义不能变", () => {
    const p = new PendingBuffer();
    p.push(b(3, 9));
    expect(Array.from(p.takeAfter(9999)!)).toEqual([9, 9, 9]);
  });

  it("take() 等价于不过滤，既有调用点行为不变", () => {
    const p = new PendingBuffer();
    p.push(b(2, 1), 1);
    p.push(b(2, 2), 2);
    expect(Array.from(p.take()!)).toEqual([1, 1, 2, 2]);
  });

  it("takeAfter 之后缓冲清空", () => {
    const p = new PendingBuffer();
    p.push(b(4, 1), 10);
    p.takeAfter(0);
    expect(p.takeAfter(0)).toBeNull();
  });

  it("保持时间顺序（过滤不改变剩余字节的先后）", () => {
    const p = new PendingBuffer();
    p.push(b(1, 1), 1);
    p.push(b(1, 2), 5);
    p.push(b(1, 3), 6);
    p.push(b(1, 4), 7);
    expect(Array.from(p.takeAfter(5)!)).toEqual([3, 4]);
  });

  it("故障还原：整批补发都在快照内 ⇒ 快照后面不再追加任何字节", () => {
    // 服务端补发 seq 8354..8393（gap 后的最新 32KB），快照 seq = 8393
    const p = new PendingBuffer();
    for (let seq = 8354; seq <= 8393; seq++) p.push(b(64, seq % 256), seq);
    expect(p.takeAfter(8393)).toBeNull();
  });
});

describe("dropUpTo —— 快照落地后丢掉已被它覆盖的积压（2026-08-27 teachppt）", () => {
  it("丢 seq ≤ 分界线的，留 seq > 分界线的，顺序不变", () => {
    const p = new PendingBuffer();
    p.push(b(1, 1), 1);
    p.push(b(1, 2), 2);
    p.push(b(1, 3), 3);
    p.dropUpTo(2);
    expect(Array.from(p.take()!)).toEqual([3]);
  });

  it("缓冲不清空 —— 丢完还能继续 push，激活时一起 flush", () => {
    const p = new PendingBuffer();
    p.push(b(1, 1), 1);
    p.dropUpTo(1);
    p.push(b(1, 9), 2);
    expect(Array.from(p.take()!)).toEqual([9]);
  });

  it("整批都在快照内 ⇒ 什么都不剩（teachppt 那 104KB 的形状）", () => {
    const p = new PendingBuffer();
    for (let seq = 1; seq <= 645; seq++) p.push(b(160, seq % 256), seq);
    p.dropUpTo(645);
    expect(p.take()).toBeNull();
  });

  it("seq=0（没有序号信息）永不被丢 —— 与 takeAfter 同语义", () => {
    const p = new PendingBuffer();
    p.push(b(2, 7));
    p.dropUpTo(9999);
    expect(Array.from(p.take()!)).toEqual([7, 7]);
  });

  it("分界线非法（0 / NaN）时一个字节都不丢", () => {
    const p = new PendingBuffer();
    p.push(b(1, 1), 1);
    p.dropUpTo(0);
    p.dropUpTo(Number.NaN);
    expect(Array.from(p.take()!)).toEqual([1]);
  });

  it("丢弃要把字节数一起扣掉 —— 否则长时间隐藏的会话会被虚高的计数推到 dirty", () => {
    const p = new PendingBuffer(100);
    p.push(b(80, 1), 1);
    p.dropUpTo(1);
    p.push(b(80, 2), 2);   // 计数没扣的话这里就越限、置 dirty
    expect(p.dirty).toBe(false);
    expect(Array.from(p.take()!).length).toBe(80);
  });
});
