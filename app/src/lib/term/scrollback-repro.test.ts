// 本地复现台：拿**真实会话的 tmux 历史**，喂进**真实 xterm**，再用**线上那套对拍**
// 比一次。目的是把「等手机复现 → 读日志」（几十分钟一轮）换成「跑一次 → 看结果」
// （几秒一轮）。
//
// 默认跳过：要 spawn tmux、依赖本机有活着的会话，CI 里两样都没有。
//   REPRO=1 SESSION=myppt npx vitest run src/lib/term/scrollback-repro.test.ts
//
// 为什么值得单独建一台：线上埋点只看得见 tmux 那一侧（客户端只上传哈希，隐私
// 硬约束不能为排障破例）。而「相邻的行有的进了 buffer、有的没进」这个现象，
// 不看 xterm 那一侧的**内容**就判不下去。本地两侧内容都在手上。
//
// 三个用例是**递进的**，用来把根因夹在中间：
//   A 纯重灌      —— 快照路径本身干不干净
//   B 重灌+实时流 —— 流式写入会不会丢
//   C B + resize  —— 尺寸抖动会不会吃掉行
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { Terminal } from "@xterm/xterm";
import { buildReseedPayload } from "./reseed";
import { bufferTailLines, hashLine, normLine } from "./screen-probe";

const SESSION = process.env.SESSION ?? "myppt";
const COLS = Number(process.env.COLS ?? 61);
const ROWS = Number(process.env.ROWS ?? 27);

const cap = (args: string[]): string[] => {
  const out = execFileSync("tmux", ["-u", "capture-pane", "-p", ...args, "-t", SESSION], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const lines = out.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

const flush = (t: Terminal) => new Promise<void>((r) => t.write("", () => r()));
const h = (l: string) => hashLine(normLine(l));
const EMPTY = h("");
const live = (a: string[]) => a.filter((l) => h(l) !== EMPTY);

/** 与线上 diffScreens 同一套判据：集合比对，只问「tmux 有、xterm 没有」。 */
function compare(tmuxPhysical: string[], term: Terminal) {
  const t = live(tmuxPhysical);
  const xl = live(bufferTailLines(term, 300));
  const xs = new Set(xl.map(h));
  const missing = t.map((l, i) => [i, l] as const).filter(([, l]) => !xs.has(h(l)));
  // tmux[0] 是窗口最老那一行，两侧窗口边界差一格就会稳定报它 —— 恒定噪音，
  // 不是故障。别把它算进判据，否则每次都红、真信号反而被淹掉。
  const real = missing.filter(([i]) => i > 0);
  return { t, xl, missing, real };
}

function report(label: string, term: Terminal, r: ReturnType<typeof compare>) {
  console.log(`\n── ${label} ──`);
  console.log(`buffer ${term.buffer.active.length} 行 (baseY=${term.buffer.active.baseY})  tmux ${r.t.length}  xterm ${r.xl.length}  缺 ${r.missing.length}（除边界外 ${r.real.length}）`);
  for (const [i, l] of r.real.slice(0, 12)) {
    console.log(`  缺 tmux[${i}] ${JSON.stringify(l)}`);
    const prev = r.t[i - 1];
    const anchor = r.xl.indexOf(prev);
    if (anchor >= 0) {
      console.log(`    xterm 里前一行在 idx ${anchor}，其后是:`);
      for (let k = anchor; k <= Math.min(r.xl.length - 1, anchor + 2); k++) {
        console.log(`      ${JSON.stringify(r.xl[k])}`);
      }
    } else {
      console.log("    xterm 里连它的前一行也找不到");
    }
  }
}

describe.skipIf(!process.env.REPRO)("scrollback 对拍的本地复现", () => {
  it("A 纯重灌 —— 快照路径本身", async () => {
    const seed = cap(["-J", "-S", "-500"]);
    const physical = cap(["-S", "-300", "-E", "-1"]);
    const term = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 2000 });
    term.write(buildReseedPayload(seed.join("\n") + "\n"));
    await flush(term);
    const r = compare(physical, term);
    report("A 纯重灌", term, r);
    term.dispose();
    expect(r.real.length).toBe(0);
  });

  it("B 重灌 + 实时流分块写入", async () => {
    const all = cap(["-J", "-S", "-500"]);
    const physical = cap(["-S", "-300", "-E", "-1"]);
    // 前 300 行当快照，其余当「重灌之后到达的实时输出」
    const head = all.slice(0, 300);
    const tail = all.slice(300);
    const term = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 2000 });
    term.write(buildReseedPayload(head.join("\n") + "\n"));
    // 逐块写：真实帧不按行对齐，所以按字节切，切点会落在行中间
    const bytes = new TextEncoder().encode(tail.join("\r\n") + "\r\n");
    for (let i = 0; i < bytes.length; i += 1024) term.write(bytes.slice(i, i + 1024));
    await flush(term);
    const r = compare(physical, term);
    report("B 重灌+实时流", term, r);
    term.dispose();
    expect(r.real.length).toBe(0);
  });

  it("C 实时流中途穿插 resize 抖动（27→26→27）", async () => {
    const all = cap(["-J", "-S", "-500"]);
    const physical = cap(["-S", "-300", "-E", "-1"]);
    const head = all.slice(0, 300);
    const tail = all.slice(300);
    const term = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 2000 });
    term.write(buildReseedPayload(head.join("\n") + "\n"));
    const bytes = new TextEncoder().encode(tail.join("\r\n") + "\r\n");
    let flap = 0;
    for (let i = 0; i < bytes.length; i += 1024) {
      term.write(bytes.slice(i, i + 1024));
      // 线上实测：同秒内 27→26→27 往返，间隔 109~478ms，用户无操作
      if (++flap % 3 === 0) { term.resize(COLS, ROWS - 1); term.resize(COLS, ROWS); }
    }
    await flush(term);
    const r = compare(physical, term);
    report("C 流+resize 抖动", term, r);
    term.dispose();
    expect(r.real.length).toBe(0);
  });
});
