import { test, expect, vi, beforeAll } from "vitest";
import { Terminal } from "@xterm/xterm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// jsdom 没有 matchMedia，而 term.open() 会去读它（CoreBrowserService._updateDpr）。
// 每个开真终端的测试文件都要自己桩一份——照抄 Terminal.reseed.test.ts 的写法。
beforeAll(() => {
  (window as any).matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
  });
});

const flush = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, () => r()));

function openTerm(): Terminal {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const t = new Terminal({ cols: 20, rows: 5, scrollback: 100 });
  t.open(el);
  return t;
}

// ---------------------------------------------------------------------------
// 真机 bug（12 期）：「内容照常刷新，但怎么都滚不上去，只有关掉 tab 重开才好」。
//
// 探针在现场拍到的证据（agent.out.log，2026-08-06）：
//     tmux:  pocketshell  alternate_on=0        ← tmux 说：正常缓冲区
//     xterm: bufferType=alternate  len=26(=rows)  baseY=0
//            scrollHeight==clientHeight  scrollTop=0
// 两边不一致。alt 屏本来就没有 scrollback，几千行历史都在 normal 缓冲区里没显示，
// 所以不是滚动手势坏了，是**根本没东西可滚**。
//
// 这个文件钉的是 classifyPane 的判定逻辑，不是 Svelte 组件——判定是纯函数式的
// 三值比较，把它单独拎出来测比渲染整个终端可靠得多（poll 是 2s 定时 + RPC，
// 组件级测试要么等 2 秒要么改成假时钟，都在测调度而不是测判定）。
// ---------------------------------------------------------------------------

type PaneMode = "normal" | "alt";

/**
 * classifyPane 里那句判定的等价提取（Terminal.svelte）。
 * 返回 true = 放行（什么都不做），false = 进修复分支。
 */
function shouldSkip(tmux: PaneMode, applied: PaneMode | null, actual: PaneMode): boolean {
  return tmux === applied && tmux === actual;
}

test("tmux 与 xterm 一致时不动屏幕（边沿触发的本意，不能因为修 bug 就每轮重画）", () => {
  expect(shouldSkip("normal", "normal", "normal")).toBe(true);
  expect(shouldSkip("alt", "alt", "alt")).toBe(true);
});

test("tmux 变了就修（原本就成立的边沿）", () => {
  expect(shouldSkip("alt", "normal", "normal")).toBe(false);
  expect(shouldSkip("normal", "alt", "alt")).toBe(false);
});

// 本次 bug 的守门人。只比 appliedMode 的旧实现在这里会返回 true（放行），
// 于是永远修不回来——这正是「必须关掉 tab 重开」的机理。
test("appliedMode 与 xterm 真实缓冲区脱钩时必须修，哪怕 tmux 报的和 appliedMode 一致", () => {
  // 现场的形态：tmux=normal，我们以为 normal，但 xterm 卡在 alt
  expect(shouldSkip("normal", "normal", "alt")).toBe(false);
  // 反向脱钩同样要修
  expect(shouldSkip("alt", "alt", "normal")).toBe(false);
});

// 上面三条测的是 shouldSkip —— 那是判定逻辑在测试里的**复刻**，复刻对了不代表
// 源码对了。这条把源码本身钉住：判定必须带上 currentBuffer，只比 appliedMode
// 的写法（`if (mode === appliedMode) return;`）就是这个 bug 本身。
test("源码里的判定确实带上了 xterm 真实缓冲区", () => {
  const src = readFileSync(resolve(__dirname, "./Terminal.svelte"), "utf8");
  const guard = src.match(/if \(mode === appliedMode[^\n]*\) return;/)?.[0] ?? "";
  expect(guard, "classifyPane 的边沿判定没找到").toBeTruthy();
  expect(guard, "只比 appliedMode 会让脱钩后永久修不回来").toMatch(/actual/);
  expect(src, "actual 必须取自 onBufferChange 跟踪的 currentBuffer").toMatch(
    /const actual: PaneMode = currentBuffer === "alternate" \? "alt" : "normal";/,
  );
});

// ---------------------------------------------------------------------------
// 上面钉的是判定，下面钉的是「修复动作确实能恢复滚动」——两者都成立才算修好。
// 判定对了但修复动作无效，用户看到的还是滚不动。
// ---------------------------------------------------------------------------

test("卡在 alt 缓冲区时上方零行可滚（复现用户看到的现象）", async () => {
  const t = openTerm();
  for (let i = 0; i < 30; i++) await flush(t, `hist${i}\r\n`);
  expect(t.buffer.active.baseY, "前提：normal 缓冲区本来有历史可滚").toBeGreaterThan(0);

  await flush(t, "\x1b[?1049h"); // 进 alt 屏

  expect(t.buffer.active.type).toBe("alternate");
  expect(t.buffer.active.baseY, "alt 屏上方零行可滚——这就是「滚不动」").toBe(0);
});

test("发 1049l 退出 alt 屏后，normal 缓冲区的历史与滚动能力都回来", async () => {
  const t = openTerm();
  for (let i = 0; i < 30; i++) await flush(t, `hist${i}\r\n`);
  const baseYBefore = t.buffer.active.baseY;
  await flush(t, "\x1b[?1049h");

  await flush(t, "\x1b[?1049l"); // classifyPane 的修复动作

  expect(t.buffer.active.type).toBe("normal");
  expect(t.buffer.active.baseY).toBe(baseYBefore);
  expect(t.buffer.active.baseY).toBeGreaterThan(0);
});
