import { test, expect, vi, beforeAll } from "vitest";
import { Terminal } from "@xterm/xterm";
import { buildReseedPayload } from "../lib/term/reseed";

// jsdom 没有 matchMedia，而 term.open() 会去读它（CoreBrowserService._updateDpr）。
// vitest-setup.ts 里没有全局桩，所以每个开真终端的测试文件都要自己桩一份
// ——照抄 Terminal.suspend.test.ts 的写法。
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

// Terminal.svelte 的 reloadHistory()：清空 + 写入 tmux capture-pane 的全量输出。
// 【2026-08-08】那两步已经合成一步——清空走**流内 RIS**，与内容拼进同一次
// write（reset() 同步而 write() 异步入队，挡不住排队字节，见 lib/term/reseed.ts）。
// 这里照样调 buildReseedPayload，保证本文件复刻的是组件真正在做的事。
function reseed(t: Terminal, capture: string): Promise<void> {
  return flush(t, buildReseedPayload(capture));
}

// 需求 4（12 期）：光标停在行中间时重灌历史，第 0 行会变成「旧内容 + 历史首行」。
// 实测（xterm 6.1）：clear() 只重置 y/ybase/ydisp，光标列 x 原样留着，于是
// 紧接着写入的 capture 从第 10 列开始落笔，与残留的旧字符熔成一行，整份历史
// 横向错位。Claude Code 的输入行几乎总把光标停在列中间,所以命中率很高——
// 这正是「表格正常显示的情况是少数」。
test("reseeding history after the cursor stopped mid-line must not fuse onto the leftover row", async () => {
  const t = openTerm();
  // 末行不以换行结束：光标停在第 10 列，正是真实终端里输入行的样子。
  await flush(t, "AAAA\r\nBBBB\r\nCCCC\r\nDDDDDDDDDD");

  await reseed(t, "1111\r\n2222\r\n3333");

  expect(t.buffer.active.getLine(0)?.translateToString(true)).toBe("1111");
});

// 同一个缺陷的另一半：clear() 也不重置 SGR，于是重灌进来的整份历史会继承
// 上一屏最后的图形属性（反色/颜色）。表现是「颜色整片糊掉」而不是熔行，
// 但根因与修法是同一处，所以钉在一起。
test("reseeding history must not inherit the previous screen's SGR attributes", async () => {
  const t = openTerm();
  await flush(t, "\x1b[7mDDDDDDDDDD"); // 开着反色且光标停在列中

  await reseed(t, "1111\r\n2222");

  expect(t.buffer.active.getLine(0)?.getCell(0)?.isInverse()).toBe(0);
});

// 修法不能以「上翻没了」为代价——scrollback 必须照旧重建，否则修了需求 4
// 就制造了一个和需求 3 长得一样的新 bug。
test("reseeding history still rebuilds scrollback so the user can scroll up", async () => {
  const t = openTerm();
  for (let i = 0; i < 30; i++) await flush(t, `old${i}\r\n`);

  await reseed(t, Array.from({ length: 30 }, (_, i) => `hist${i}`).join("\r\n"));

  expect(t.buffer.active.length).toBeGreaterThan(t.rows);
  expect(t.buffer.active.baseY).toBeGreaterThan(0);
});
