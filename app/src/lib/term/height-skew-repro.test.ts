// 「tmux 与 xterm 高度短暂错开 + 应用重画输出块」会不会让两侧 scrollback 分叉。
//
//   REPRO=1 npx vitest run src/lib/term/height-skew-repro.test.ts
//
// 假设来自线上转储里的周期性结构：同一个工具输出块，`Wrote N lines to` + 路径
// 缺、条目 1 在、条目 2/3/4 缺、条目 5 及以后在、`… +N lines` 缺，连续四个块
// 形状一致。这不像丢数据，像**两侧存了同一个块的不同渲染版本**——而 extraLines
// 与 missingLines 几乎相等，正说明 xterm 手里握着另一版的同样多行。
//
// 两侧什么时候会对「这块内容是否已滚出屏幕」产生分歧？高度不一致的时候。
// 真实系统里 refit() 先 term.resize()、再 conn.resize() 通知 PTY，中间隔一个
// RTT（真机中位 ~1.9s）——**xterm 比 tmux 先变矮**。线上实测的 27↔26 抖动
// 往返只有 109~478ms，比 RTT 还短，所以这个错开窗口是常态而不是边缘情况。
//
// 之前的 redraw-repro 打不中，是因为那一版 tmux 根本没参与（直接喂文本给 xterm），
// 「两侧高度分歧」这个前提压根不存在。
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { Terminal } from "@xterm/xterm";
import { bufferTailLines, hashLine, normLine } from "./screen-probe";

const S = "ps_skew_repro";
const RAW = "/tmp/ps-skew.raw";
const COLS = 61;
const ROWS = 27;
const START = "START-MARKER-7f3a";

const sh = (cmd: string) => execFileSync("bash", ["-lc", cmd], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const flush = (t: Terminal) => new Promise<void>((r) => t.write("", () => r()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const h = (l: string) => hashLine(normLine(l));
const EMPTY = h("");
const live = (a: string[]) => a.filter((l) => h(l) !== EMPTY);
const after = (a: string[]) => {
  const i = a.findIndex((l) => l.includes(START));
  return i < 0 ? a : a.slice(i + 1);
};

// 模拟 Claude Code 的工具输出块：先展开打印若干条目，再上移把它折叠成
// `… +N lines`。折叠就是「重画」——它决定了留在 scrollback 里的是哪一版。
const GEN = String.raw`
printf 'START-MARKER-7f3a\n'
for blk in $(seq 1 25); do
  printf '=> Write(file-%02d.ts)\n' "$blk"
  printf '   Wrote %d lines to\n' $((blk * 7))
  printf '   path/to/file-%02d.ts\n' "$blk"
  for i in $(seq 1 10); do printf '     %2d   entry-%02d-%02d value\n' "$i" "$blk" "$i"; done
  printf '\033[6A'
  printf '\033[2K     … +%d lines (collapsed)\n' $((blk * 7 - 4))
  for i in $(seq 1 5); do printf '\033[2K\n'; done
done
printf 'DONE-MARKER\n'
`;

/**
 * 跑一轮：tmux 侧在 pos 处抖动高度，xterm 侧提前 leadBytes 字节抖动。
 * leadBytes=0 表示两侧同步（对照组）；>0 表示 xterm 先变矮（真实顺序）。
 */
async function run(leadBytes: number) {
  try { sh(`tmux kill-session -t ${S} 2>/dev/null`); } catch { /* 本来就没有 */ }
  try { rmSync(RAW); } catch { /* 本来就没有 */ }

  sh(`tmux new-session -d -s ${S} -x ${COLS} -y ${ROWS} 'bash --noprofile --norc'`);
  sh(`tmux pipe-pane -o -t ${S} 'cat >> ${RAW}'`);
  sh(`tmux send-keys -t ${S} ${JSON.stringify(GEN.replace(/\n/g, "; "))} Enter`);

  // 输出跑起来之后，在中途抖一次高度，并记下当时的字节位置
  const marks: number[] = [];
  const size = () => { try { return statSync(RAW).size; } catch { return 0; } };
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (size() > 3000) break;
  }
  for (let flap = 0; flap < 6; flap++) {
    marks.push(size());
    sh(`tmux resize-window -t ${S} -x ${COLS} -y ${ROWS - 1} 2>/dev/null || tmux resize-pane -t ${S} -y ${ROWS - 1}`);
    await sleep(120);
    marks.push(size());
    sh(`tmux resize-window -t ${S} -x ${COLS} -y ${ROWS} 2>/dev/null || tmux resize-pane -t ${S} -y ${ROWS}`);
    await sleep(400);
  }
  for (let i = 0; i < 100; i++) {
    if (sh(`tmux capture-pane -p -t ${S} | tail -5`).includes("DONE-MARKER")) break;
    await sleep(200);
  }
  sh(`tmux pipe-pane -o -t ${S}`);

  const raw = readFileSync(RAW);
  const tmuxPhysical = after(sh(`tmux -u capture-pane -p -S -300 -E -1 -t ${S}`).split("\n"));

  const term = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 2000 });
  // xterm 侧在 mark - leadBytes 处抖动：leadBytes>0 = 比 tmux 先变矮
  const pending = marks.map((m, i) => ({ at: Math.max(0, m - leadBytes), rows: i % 2 === 0 ? ROWS - 1 : ROWS }));
  let cursor = 0;
  for (let i = 0; i < raw.length; i += 512) {
    term.write(raw.subarray(i, i + 512));
    while (cursor < pending.length && pending[cursor].at <= i + 512) {
      term.resize(COLS, pending[cursor].rows);
      cursor++;
    }
  }
  await flush(term);

  const t = live(tmuxPhysical);
  const xl = after(live(bufferTailLines(term, 300)));
  const xs = new Set(xl.map(h));
  const missing = t.map((l, i) => [i, l] as const).filter(([, l]) => !xs.has(h(l)));
  const real = missing.filter(([idx]) => idx > 0);

  console.log(`\n── lead=${leadBytes}B  tmux ${t.length}  xterm ${xl.length}  缺 ${missing.length}（除边界外 ${real.length}）`);
  for (const [idx, l] of real.slice(0, 10)) console.log(`   缺 tmux[${idx}] ${JSON.stringify(l)}`);

  term.dispose();
  try { sh(`tmux kill-session -t ${S}`); } catch { /* 已经没了 */ }
  return real.length;
}

describe.skipIf(!process.env.REPRO)("tmux/xterm 高度错开 + 输出块重画", () => {
  it("对照组：两侧同步抖动，应当一致", async () => {
    expect(await run(0)).toBe(0);
  }, 120000);

  it("真实顺序：xterm 先变矮（领先 4KB ≈ 一个 RTT 的字节量）", async () => {
    expect(await run(4096)).toBe(0);
  }, 120000);
});
