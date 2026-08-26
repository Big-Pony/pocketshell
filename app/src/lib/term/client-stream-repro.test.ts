// 把 **tmux 重绘给客户端的字节流** 喂进 xterm，与 tmux 自己的 scrollback 对拍。
//
//   bun run spike/client-stream-capture.ts        # 先录（要 Bun 的 PTY）
//   REPRO=1 npx vitest run src/lib/term/client-stream-repro.test.ts
//
// 为什么必须是这一份流：此前几台复现台喂的都是 `pipe-pane` 抓的字节，那是「应用
// 打给窗格」的输出，用 `\x1b[nA` 这类**相对**定位——错位了内容也还在。而手机上的
// xterm 收到的是 tmux 的重绘流，用**绝对定位**，行一对不上就是直接覆盖，内容当场
// 消失。线上天天复现、本地全绿，差别就在这里。
//
// 录制放在 spike/ 而不是这里：xterm 要 jsdom（vitest 环境），PTY 要 Bun.Terminal
// （bun 环境），两者不共存。所以录一次、这里消费产物。
//
// 【2026-08-25 的教训，别再犯】此前三台 tmux 复现台把多行生成器用
// `\n` → `"; "` 压成一行喂 send-keys，`for ...; do` 后面的换行变成 `do;`，bash
// 当场语法错误。窗格里满是被回显的命令文本，两侧回显一致 —— 对拍照样「全绿」，
// 而生成器一次都没执行。所以下面第一条断言先验「真实输出确实存在」。
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Terminal } from "@xterm/xterm";
import { buildReseedPayload } from "./reseed";
import { bufferTailLines, hashLine, normLine } from "./screen-probe";

const RAW = "/tmp/ps-client.raw";
const TRUTH = "/tmp/ps-client.tmux";
const SNAP = "/tmp/ps-client.snapshot";
const COLS = 61;
const ROWS = 27;
const START = "START-MARKER-7f3a";

const flush = (t: Terminal) => new Promise<void>((r) => t.write("", () => r()));
const h = (l: string) => hashLine(normLine(l));
const EMPTY = h("");
const live = (a: string[]) => a.filter((l) => h(l) !== EMPTY);
const after = (a: string[]) => {
  const i = a.findIndex((l) => l.includes(START));
  return i < 0 ? a : a.slice(i + 1);
};

/** 读**正常屏**（而非 active）的尾部若干行 —— D 变体活在备用屏里，active 是空的。 */
function normalTailLines(t: Terminal, n: number): string[] {
  const b = (t.buffer as unknown as { normal: typeof t.buffer.active }).normal;
  const out: string[] = [];
  const end = b.baseY;
  for (let i = Math.max(0, end - n); i < end; i++) {
    const l = b.getLine(i);
    if (l) out.push(l.translateToString(true));
  }
  return out;
}

/** pad>0 时在快照后补 pad 个换行，把快照整体推进 scrollback、给 tmux 留出空白屏。 */
async function feed(raw: Buffer, reseedAt: number | null, snapshot: string, pad = 0, backToAlt = false, cup = ""): Promise<string[]> {
  const term = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 2000 });
  // 重灌必须插在**精确字节偏移**上，不能凑到 512 的块边界。
  // 【2026-08-25 的坑】原来的写法是「写完含 reseedAt 的那一块再插」，于是
  // [reseedAt, 块边界) 这段**接缝之后**的字节被整段跳过、从没喂进 xterm。那里正好
  // 是在飞那个输出块的擦除/折叠指令，于是恒定少三行——查了半天的「接缝缺行」其实
  // 是复现台自己造的。判据：按精确偏移注入后，缺行回落到与无重灌变体相同的基线。
  const cut = reseedAt === null ? raw.length : Math.min(reseedAt, raw.length);
  for (let i = 0; i < cut; i += 512) term.write(raw.subarray(i, Math.min(i + 512, cut)));
  if (reseedAt !== null) {
    term.write(buildReseedPayload(snapshot) + "\r\n".repeat(pad) + cup + (backToAlt ? "\x1b[?1049h" : ""));
  }
  for (let i = cut; i < raw.length; i += 512) term.write(raw.subarray(i, i + 512));
  await flush(term);
  const out = after(live(backToAlt ? normalTailLines(term, 1200) : bufferTailLines(term, 1200)));
  term.dispose();
  return out;
}

function compare(label: string, truth: string[], xl: string[]) {
  const xs = new Set(xl.map(h));
  const missing = truth.map((l, i) => [i, l] as const).filter(([, l]) => !xs.has(h(l)));
  const real = missing.filter(([i]) => i > 0); // tmux[0] 是窗口边界噪音
  const ts = new Set(truth.map(h));
  const extra = xl.filter((l) => !ts.has(h(l))).length;
  console.log(`\n── ${label}: tmux ${truth.length} / xterm ${xl.length} / 缺 ${real.length} / 多 ${extra}`);
  for (const [i, l] of real.slice(0, 12)) console.log(`   缺 tmux[${i}] ${JSON.stringify(l)}`);
  return real.length;
}

// 可比对多份录制：PREFIXES 用逗号分隔（默认只比 /tmp/ps-client）
const PREFIXES = (process.env.PREFIXES ?? "/tmp/ps-client").split(",");

describe.skipIf(!process.env.REPRO)("tmux 客户端重绘流 → xterm scrollback", () => {
  for (const pre of PREFIXES) {
    it(`对拍 ${pre}`, async () => {
      const raw = readFileSync(`${pre}.raw`);
      const truthText = readFileSync(`${pre}.tmux`, "utf8");
      const truth = after(live(truthText.split("\n")));
      // 先验录制可信：生成器真的执行了，不是在比两侧回显的报错文本
      expect(truthText).toMatch(/entry-\d\d-\d\d/);
      expect(truthText).not.toContain("syntax error");
      expect(truth.length).toBeGreaterThan(100);

      // A：纯客户端流。tmux 一 attach 就发 1049h 进备用屏，备用屏没有 scrollback，
      // 所以这里 xterm 拿到 0 行是**预期结果**，不是故障 —— 它正是根因的直接证据。
      const plain = await feed(raw, null, "");
      compare(`${pre} A 纯客户端流（预期 0 行）`, truth, plain);

      // B：中途重灌。RIS 把 xterm 踢出备用屏，快照进正常屏形成 scrollback，
      // 而 tmux 仍按备用屏网格发绝对定位重绘 —— 差多少就是被覆盖掉多少。
      const snap = readFileSync(`${pre}.snapshot`, "utf8");
      const mark = Number(readFileSync(`${pre}.mark`, "utf8"));
      const miss = compare(`${pre} B 重灌@${mark}`, truth, await feed(raw, mark, snap));
      // C：重灌后补 ROWS 个换行 —— 把快照整体推进 scrollback，tmux 的网格只落在空白区
      const missPad = compare(`${pre} C 重灌+补${ROWS}换行`, truth, await feed(raw, mark, snap, ROWS));
      // D：重灌后立刻送回备用屏 —— tmux 的实时绘制落在备用屏，正常屏的历史不受影响
      const missAlt = compare(`${pre} D 重灌+回备用屏`, truth, await feed(raw, mark, snap, 0, true));
      // E：改喂**窗格原始输出**（pipe-pane）。它没有 1049h、没有屏幕差分，
      // 是应用自己打的字节流 —— 与「直接 spawn shell」的终端拿到的完全同类。
      let missPipe = -1;
      if (existsSync(`${pre}.pipe`)) {
        missPipe = compare(`${pre} E 窗格原始输出`, truth, await feed(readFileSync(`${pre}.pipe`), null, ""));
      }
      // F：**iTerm2 的架构**——中途重连：先用 capture-pane 播种历史，再接窗格原始
      // 输出。这是真实场景（客户端半路接入、需要看到之前的历史），也是提案的形态。
      let missSeed = -1;
      if (existsSync(`${pre}.pipe`)) {
        const pipe = readFileSync(`${pre}.pipe`);
        missSeed = compare(`${pre} F 播种+原始流`, truth,
          await feed(pipe, Number(readFileSync(`${pre}.pipemark`, "utf8")), readFileSync(`${pre}.snapshot`, "utf8")));
      }
      // G/H：重灌后把光标摆回 tmux 的 (cursor_x, cursor_y)。快照尾部含屏底空行，
      // 不同步的话 xterm 光标停在屏底、tmux 的还在上面，之后流里的 \033[6A 一类
      // 相对定位就全部落错行——这正是接缝那 3 行的真正病因（不是字节丢了）。
      let missCupA = -1, missCupB = -1;
      if (existsSync(`${pre}.cursor`)) {
        const [cx = "0", cy = "0"] = readFileSync(`${pre}.cursor`, "utf8").trim().split(/\s+/);
        const cup = `\x1b[${Number(cy) + 1};${Number(cx) + 1}H`;
        // G/H：**不带 -J** 的快照（一屏行 = 一个物理行，行数与屏幕行数等长）+ 光标同步。
        // 带 -J 时反折会把两个物理行并成一行，快照行数与屏幕行数不等长，CUP 的行号
        // 就没有共同原点——这是前面 CUP 变体反而更差的原因。
        const nj = existsSync(`${pre}.snapshotnj`) ? readFileSync(`${pre}.snapshotnj`, "utf8") : snap;
        missCupA = compare(`${pre} G 不带-J快照+去尾换行+光标同步`, truth,
          await feed(raw, mark, nj.replace(/\n$/, ""), 0, false, cup));
        missCupB = compare(`${pre} H 不带-J快照+光标同步`, truth, await feed(raw, mark, nj, 0, false, cup));
        // I：保留 -J（长行仍反折，观感不变），只加光标同步 —— 分清是哪个变量在起作用
        compare(`${pre} I 保留-J+光标同步`, truth, await feed(raw, mark, snap, 0, false, cup));
        // J：不带 -J，但不做光标同步
        compare(`${pre} J 不带-J快照+不同步光标`, truth, await feed(raw, mark, nj, 0, false, ""));
      }
      console.log(`   >>> ${pre}  G 缺${missCupA} / H 缺${missCupB}`);
      console.log(`   >>> ${pre}  F 缺${missSeed}`);
      console.log(`   >>> ${pre}  B 缺${miss} / C 缺${missPad} / D 缺${missAlt} / E 缺${missPipe}`);
    }, 60000);
  }
});
