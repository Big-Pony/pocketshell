// 「原地重绘会不会让 xterm 与 tmux 的 scrollback 分叉」——用**自建的 tmux 会话**验证，
// 不碰任何真实会话。
//
//   REPRO=1 npx vitest run src/lib/term/redraw-repro.test.ts
//
// 为什么造这一台：scrollback-repro 里 A/B/C 三级（纯重灌 / 加实时流 / 加 resize 抖动）
// 全过，说明**纯文本**写入路径是干净的。真实流与它只剩一处差别——ANSI 转义序列。
// Claude Code 是原地重绘的（上移光标、擦行、重写），而「一行到底进不进 scrollback」
// 完全由这些序列决定。所以把重绘单独隔离出来打。
//
// 生成器刻意模拟三种真实模式：
//   1. spinner 原地转（\r + 覆写，不换行）
//   2. 光标上移若干行后重写（Claude Code 刷新它的输出块）
//   3. 正常滚动输出（把内容推进 scrollback）
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { Terminal } from "@xterm/xterm";
import { bufferTailLines, hashLine, normLine } from "./screen-probe";

const S = "ps_redraw_repro";
const RAW = "/tmp/ps-redraw.raw";
const COLS = 61;
const ROWS = 27;

const sh = (cmd: string) => execFileSync("bash", ["-lc", cmd], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const flush = (t: Terminal) => new Promise<void>((r) => t.write("", () => r()));
const h = (l: string) => hashLine(normLine(l));
const EMPTY = h("");
const live = (a: string[]) => a.filter((l) => h(l) !== EMPTY);

// 生成器：往 stdout 打真实的转义序列。用 printf 而不是 echo -e，可移植性更好。
const START = "START-MARKER-7f3a";

const GEN = String.raw`
printf 'START-MARKER-7f3a\n'
for blk in $(seq 1 12); do
  # 1) spinner 原地转 —— \r 覆写同一行，不产生新行
  for f in '|' '/' '-' '\'; do printf '\r  spinner %s block %02d' "$f" "$blk"; done
  printf '\r%-60s\r' ''
  # 2) 正常滚动输出，把内容推进 scrollback
  for i in $(seq 1 6); do printf 'blk%02d-line%02d  %s\n' "$blk" "$i" "$(head -c 20 /dev/zero | tr '\0' 'x')"; done
  # 3) 光标上移 3 行后原地重写它们（Claude Code 刷新输出块的典型形态）
  printf '\033[3A'
  for i in 4 5 6; do printf '\033[2Kblk%02d-line%02d  REWRITTEN\n' "$blk" "$i"; done
done
printf 'DONE-MARKER\n'
`;

describe.skipIf(!process.env.REPRO)("原地重绘下的 scrollback 一致性", () => {
  it("把真实 PTY 字节流喂进 xterm，与 tmux 自己的 capture 对拍", async () => {
    try { sh(`tmux kill-session -t ${S} 2>/dev/null`); } catch { /* 本来就没有 */ }
    try { rmSync(RAW); } catch { /* 本来就没有 */ }

    sh(`tmux new-session -d -s ${S} -x ${COLS} -y ${ROWS} 'bash --noprofile --norc'`);
    // pipe-pane 只旁路输出，不往会话里送任何输入
    sh(`tmux pipe-pane -o -t ${S} 'cat >> ${RAW}'`);
    sh(`tmux send-keys -t ${S} ${JSON.stringify(GEN.replace(/\n/g, "; "))} Enter`);
    // 等生成器跑完：轮询 DONE-MARKER，别用固定 sleep
    for (let i = 0; i < 100; i++) {
      const now = sh(`tmux capture-pane -p -t ${S} | tail -5`);
      if (now.includes("DONE-MARKER")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    sh(`tmux pipe-pane -o -t ${S}`); // 关掉旁路

    const raw = readFileSync(RAW);
    // pipe-pane 挂上之前 shell 已经打过启动横幅，那几行只存在于 tmux 侧。
    // 那是复现台的缺口，不是故障 —— 用起始标记把两侧对齐到同一个起点。
    const after = (a: string[]) => {
      const i = a.findIndex((l) => l.includes(START));
      return i < 0 ? a : a.slice(i + 1);
    };
    const tmuxPhysical = after(sh(`tmux -u capture-pane -p -S -300 -E -1 -t ${S}`).split("\n"));

    const term = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 2000 });
    // 按 1KB 切块喂 —— 真实帧不按行对齐，切点会落在转义序列中间
    for (let i = 0; i < raw.length; i += 1024) term.write(raw.subarray(i, i + 1024));
    await flush(term);

    const t = live(tmuxPhysical);
    const xl = after(live(bufferTailLines(term, 300)));
    const xs = new Set(xl.map(h));
    const missing = t.map((l, i) => [i, l] as const).filter(([, l]) => !xs.has(h(l)));
    const real = missing.filter(([i]) => i > 0); // tmux[0] 是窗口边界噪音

    console.log(`\n── 原地重绘 ──`);
    console.log(`raw ${raw.length} 字节  buffer ${term.buffer.active.length} 行 (baseY=${term.buffer.active.baseY})  tmux ${t.length}  xterm ${xl.length}  缺 ${missing.length}（除边界外 ${real.length}）`);
    for (const [i, l] of real.slice(0, 12)) {
      console.log(`  缺 tmux[${i}] ${JSON.stringify(l)}`);
      const anchor = xl.indexOf(t[i - 1]);
      if (anchor >= 0) {
        console.log(`    xterm 里前一行在 idx ${anchor}，其后是:`);
        for (let k = anchor; k <= Math.min(xl.length - 1, anchor + 2); k++) console.log(`      ${JSON.stringify(xl[k])}`);
      } else {
        console.log("    xterm 里连它的前一行也找不到");
      }
    }

    term.dispose();
    try { sh(`tmux kill-session -t ${S}`); } catch { /* 已经没了 */ }

    expect(real.length).toBe(0);
  }, 40000);
});
