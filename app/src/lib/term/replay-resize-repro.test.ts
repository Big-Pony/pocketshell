// 「按旧尺寸生成的 tmux 重绘字节，被重放进一个尺寸已经变了的 xterm」会不会丢内容。
//
//   REPRO=1 npx vitest run src/lib/term/replay-resize-repro.test.ts
//
// 不需要 tmux、不建任何会话 —— 判据是两个 xterm 的对照：一个全程 27 行（相当于
// 真值），一个在重放中途被 resize 成 25 行（相当于真机上的客户端）。
//
// 关键在**用哪一族转义序列**。第一版用 `\x1b[nA`（光标相对上移）打，缺 0 行——
// 相对移动天生对行数免疫，行数变了它照样往上数 N 行。真正依赖行数的是另一族：
//   · DECSTBM `\x1b[1;27r` 设滚动区
//   · `\x1b[r;cH` 绝对定位
// 而流到客户端的字节**不是 Claude Code 的原始输出，是 tmux 重绘出来的**，tmux
// 是全屏应用，用的正是这一族。要命的是 **xterm 里一行只有「滚出滚动区顶部」时
// 才会进 scrollback**：滚动区按 27 行设、终端却只有 25 行，行就被原地覆盖而不是
// 滚进 scrollback —— tmux 自己的 history 里有、xterm 的 scrollback 里没有。
//
// 线上取证（2026-08-25 02:45:34 / 02:52:47，两次形态一致）：
//   resize why=observer 61x27 → 61x25
//   attach gap=false frames=715 bytes=85975     ← 同一秒，补发 86KB
//   resize why=observer 61x25 → 61x27
// gap=false、无 drop、无 seqgap —— 字节一个没丢，错的是**写进去的位置**，
// 所以所有丢帧类探针全程为 0，一直把我们引向错误的方向。
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";

const COLS = 61;
const ROWS = 27;

const flush = (t: Terminal) => new Promise<void>((r) => t.write("", () => r()));

const allLines = (t: Terminal): string[] => {
  const out: string[] = [];
  const b = t.buffer.active;
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    if (l) out.push(l.translateToString(true).replace(/\s+$/, ""));
  }
  return out.filter((s) => s !== "");
};

/**
 * 造一段 **tmux 风格**的重绘字节流：进来先按 ROWS 设滚动区（DECSTBM），之后用
 * 绝对定位把光标放到区底再换行推进内容。这是全屏应用的标准形态，也是真实链路上
 * 客户端收到的形态 —— 客户端对面是 tmux，不是应用本身。
 */
function stream(blocks: number): string {
  let s = `\x1b[1;${ROWS}r`;          // 滚动区 = 整屏 27 行（按生成时的尺寸）
  s += `\x1b[${ROWS};1H`;             // 光标放到区底
  for (let b = 1; b <= blocks; b++) {
    for (let i = 1; i <= 9; i++) {
      s += `\x1b[${ROWS};1H\x1b[2K`; // 绝对定位到区底、擦行
      s += `blk${String(b).padStart(2, "0")}-line${String(i).padStart(2, "0")} payload-${b * 9 + i}`;
      s += "\r\n";                    // 在区底换行 => 顶部那行滚进 scrollback
    }
  }
  return s;
}

async function feed(chunks: string[], resizeAt: number | null): Promise<string[]> {
  const t = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 2000 });
  for (let i = 0; i < chunks.length; i++) {
    if (resizeAt !== null && i === resizeAt) t.resize(COLS, ROWS - 2);
    t.write(chunks[i]);
  }
  if (resizeAt !== null) t.resize(COLS, ROWS); // 抖回去，和线上一样
  await flush(t);
  const out = allLines(t);
  t.dispose();
  return out;
}

describe.skipIf(!process.env.REPRO)("补发字节重放进尺寸已变的终端", () => {
  const raw = stream(20);
  const chunks: string[] = [];
  for (let i = 0; i < raw.length; i += 900) chunks.push(raw.slice(i, i + 900));

  it("对照组：不 resize，两次喂同一份字节结果必须一致", async () => {
    const a = await feed(chunks, null);
    const b = await feed(chunks, null);
    expect(b).toEqual(a);
  });

  it("重放中途 resize（27→25→27）后，内容与不 resize 时一致吗", async () => {
    const truth = await feed(chunks, null);          // tmux 侧：按原尺寸，不动
    const client = await feed(chunks, 8);            // 客户端：重放中途变矮
    const missing = truth.filter((l) => !new Set(client).has(l));
    console.log(`\n真值 ${truth.length} 行，客户端 ${client.length} 行，客户端缺 ${missing.length} 行`);
    for (const l of missing.slice(0, 12)) console.log("  缺 " + JSON.stringify(l));
    expect(missing).toEqual([]);
  });
});
