// B2 对拍台：把**窗格原始字节流**（pipe-pane，即线上真实通路）喂进 xterm，
// 与 tmux 自己的 history 逐行对拍。这是「终端中间丢行」是否真被修好的判据。
//
//   bun run spike/b2-record.ts                              # 先录（要 Bun 的 PTY/tmux）
//   REPRO=1 npx vitest run src/lib/term/b2-repro.test.ts
//
// 【判据为什么要重写 —— 2026-08-25 的教训】上一版判据有三个结构性缺陷，导致它
// 报出来的每一个「缺 N 多 M」都不可信：
//   1. **用集合比对**。真值里有两个 ×38 的重复类（占全部行的 33%），这两类各丢
//      37 行都会报「缺 0」—— 判据对三分之一的内容是瞎的。现在用**多重集**。
//   2. **把空行全过滤掉**（真值 45% 是空行），而「中间丢行」的表现形式恰恰是空行
//      错位。现在**保留空行**，只裁掉两侧的尾随空白（tmux `-E -` 会带上光标下方的
//      空屏，xterm 同理，那部分两边都是噪音）。
//   3. **完全不看顺序**，而这个 bug 的机制就是错位。现在用 LCS 检查顺序。
// 语料侧也配套改了：`spike/b2-record.ts` 逐行带唯一序号，重复类不再掩盖丢失。
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Terminal } from "@xterm/xterm";
import { buildReseedPayload } from "./reseed";

const PRE = "/tmp/ps-b2";
const COLS = 80;
const ROWS = 24;

const flush = (t: Terminal) => new Promise<void>((r) => t.write("", () => r()));

/**
 * 读全部缓冲（scrollback + 当前屏），**保留内部空行**，只裁尾随空白行。
 *
 * 折行必须接回逻辑行：真值侧用的是 `capture-pane -J`，它把被屏宽折断的行合并成
 * 一行；xterm 这边同一个逻辑行是两个物理 row。不接回去的话，每一条超过屏宽的行
 * 都会被判成「缺失」—— 那是**比对口径**问题，不是丢数据。第一次跑就是这么报出
 * 60 行假缺失的（生成器故意造了最长 90 字符的行，屏宽 80）。
 */
function allLines(t: Terminal): string[] {
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.baseY + ROWS; i++) {
    const l = b.getLine(i);
    const s = l ? l.translateToString(true) : "";
    if (l?.isWrapped && out.length) out[out.length - 1] += s;
    else out.push(s);
  }
  const trimmed = out.map((l) => l.replace(/\s+$/, ""));
  while (trimmed.length && trimmed[trimmed.length - 1] === "") trimmed.pop();
  return trimmed;
}

function truthLines(text: string): string[] {
  const out = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** 多重集差：truth 里有而 xterm 里**份数不够**的行（含重复行的缺失份数）。 */
export function multisetMissing(truth: string[], got: string[]): string[] {
  const have = new Map<string, number>();
  for (const l of got) have.set(l, (have.get(l) ?? 0) + 1);
  const missing: string[] = [];
  for (const l of truth) {
    const n = have.get(l) ?? 0;
    if (n > 0) have.set(l, n - 1);
    else missing.push(l);
  }
  return missing;
}

/** 最长公共子序列长度 —— 顺序敏感。truth 全部按序出现时等于 truth.length。 */
export function lcsLength(a: string[], b: string[]): number {
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length]!;
}

/** 按精确字节偏移注入重灌（在块边界上凑合会跳过接缝后的字节，那是复现台自己造的假 bug）。 */
async function feed(raw: Buffer, reseedAt: number | null, snapshot: string): Promise<string[]> {
  const term = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 5000 });
  const cut = reseedAt === null ? raw.length : Math.min(reseedAt, raw.length);
  for (let i = 0; i < cut; i += 512) term.write(raw.subarray(i, Math.min(i + 512, cut)));
  // **不加 CUP**。应用真实的重灌路径就是 `concatReseedWrite(buildReseedPayload(data),
  // windowBytes)`（Terminal.svelte:770），payload = RIS + 快照，没有任何光标定位。
  // B2 下也不需要：流是纯追加的相对定位，没有「网格原点」要对齐 —— 这正是换掉
  // attach 重绘流换来的东西。（第一版对拍台自作主张加了 CUP，把命令回显打飞了一行。）
  if (reseedAt !== null) term.write(buildReseedPayload(snapshot));
  for (let i = cut; i < raw.length; i += 512) term.write(raw.subarray(i, Math.min(i + 512, raw.length)));
  await flush(term);
  const out = allLines(term);
  term.dispose();
  return out;
}

describe.skipIf(!process.env.REPRO || !existsSync(`${PRE}.raw`))("B2 窗格原始流 → xterm scrollback", () => {
  const raw = () => readFileSync(`${PRE}.raw`);
  const truth = () => truthLines(readFileSync(`${PRE}.tmux`, "utf8"));

  it("语料本身可信（生成器真的跑了，不是在比两侧的报错回显）", () => {
    const t = readFileSync(`${PRE}.tmux`, "utf8");
    expect(t).toMatch(/L0400-/);          // 生成器跑到最后一行
    expect(t).toContain("POST-DONE");     // 重连点之后那批也跑了
    expect(t).not.toContain("syntax error");
    expect(truth().length).toBeGreaterThan(300);
  });

  it("流里没有备用屏，也没有绝对定位 —— 根因在结构上不存在", () => {
    const s = new TextDecoder("latin1").decode(raw());
    expect(s).not.toContain("\x1b[?1049h");
    expect([...s.matchAll(/\x1b\[\d+;\d+H/g)].length).toBe(0);
  });

  it("纯流：xterm 的 scrollback 与 tmux 的历史逐行一致（多重集，不丢重复份数）", async () => {
    const got = await feed(raw(), null, "");
    const missing = multisetMissing(truth(), got);
    // 允许的唯一偏差是**首行**：pipe-pane 是在会话建好之后才挂上的，挂上之前
    // shell 打的首个提示符不在流里（这正是要靠 capture-pane 播种补的那一段）。
    expect(missing.filter((l) => !l.includes("$") && !l.includes("%")).length).toBe(0);
    expect(missing.length).toBeLessThanOrEqual(2);
  });

  it("纯流：顺序完全保持（LCS = 真值行数）", async () => {
    const got = await feed(raw(), null, "");
    const t = truth();
    // 掐掉可能缺失的开头提示符，比对其余部分的顺序
    const tail = t.slice(2);
    expect(lcsLength(tail, got)).toBe(tail.length);
  });

  it("中途重灌（模拟手机重连）：不丢行、不重复、顺序不乱", async () => {
    const mark = Number(readFileSync(`${PRE}.mark`, "utf8"));
    const snap = readFileSync(`${PRE}.snapshot`, "utf8");
    const got = await feed(raw(), mark, snap);
    const t = truth();

    // 不丢：真值每一行（含重复份数）都在
    const missing = multisetMissing(t, got);
    expect(missing.length).toBeLessThanOrEqual(2);

    // 不重复：重灌把快照又写了一遍，若接缝没对齐就会出现整段重影。
    // 判据是**带唯一序号的内容行**不得出现两次。
    const counts = new Map<string, number>();
    for (const l of got) if (/^[LPC]\d{4}-/.test(l)) counts.set(l, (counts.get(l) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, n]) => n > 1);
    expect(dupes.slice(0, 5)).toEqual([]);

    // 不乱序
    const tail = t.slice(2);
    expect(lcsLength(tail, got)).toBe(tail.length);
  });
});

describe("判据自检 —— 判据必须能看见它声称能看见的东西", () => {
  it("多重集能发现重复行的缺失份数（旧的集合判据在这里报 0）", () => {
    const truth = ["a", "a", "a", "b"];
    expect(multisetMissing(truth, ["a", "b"]).length).toBe(2);
    // 对照：集合判据会说「一个都不缺」
    const asSet = truth.filter((l) => !new Set(["a", "b"]).has(l));
    expect(asSet.length).toBe(0);
  });

  it("多重集不把空行当噪音", () => {
    expect(multisetMissing(["x", "", "y"], ["x", "y"])).toEqual([""]);
  });

  it("LCS 能发现错位（内容都在但顺序反了）", () => {
    expect(multisetMissing(["a", "b", "c"], ["c", "b", "a"]).length).toBe(0); // 多重集看不出
    expect(lcsLength(["a", "b", "c"], ["c", "b", "a"])).toBe(1);              // 顺序判据看得出
  });
});
