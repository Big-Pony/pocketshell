// DECRQM（requestMode）回归测试（2026-08-28）。
//
// 背景：@xterm/xterm 6.1.0-beta.292 的 lib/xterm.mjs 里，InputHandler.requestMode
// 带一段 TS const enum 编译残留的 IIFE 死代码 `(te=>(...))(r||={})`。vite/rollup
// 打包 + esbuild minify 时它被压成 `var g;(v=>...)(void 0||(i={}))`——声明与
// 引用被重命名成两个名字，生产构建里一执行到 requestMode 就抛
// `ReferenceError: i is not defined`。
//
// 这个异常抛在 WriteBuffer._innerWrite 的 setTimeout 回调里，直接把写泵链炸断：
// 之后 write() 只入队不调度，终端静默冻结（字节照收、buffer 停更、零渲染），
// 只能关掉重开。claude code 启动/退出/resize 时会发 DECRQM 查询模式（如 2026
// synchronized output），所以这条路径必然被踩中。真机取证见
// agent 日志 kind=js-error（2026-08-28T14:26 起多次）。
//
// 修复：patches/@xterm%2Fxterm@6.1.0-beta.292.patch 删掉那段死代码（它是
// const enum 的命名空间初始化残留，运行时无人使用）。本测试钉住行为：
// 发 DECRQM 查询 2026，泵必须活着并回 DECRPM 应答。patch 若丢失（重装依赖时
// 没带 patches），requestMode 抛异常 → 泵断 → 应答永远不来 → 测试红。

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Terminal } from "@xterm/xterm";

// WriteBuffer 的泵是 setTimeout(0) 异步的，给它几个事件循环。
const flushPump = () => new Promise((r) => setTimeout(r, 120));

describe("DECRQM requestMode（xterm beta.292 打包 bug 回归）", () => {
  // 这个 bug 只在 vite/rollup + esbuild minify 后才显形（未压缩的 mjs 里那段
  // IIFE 是合法代码），所以行为测试之外还要一个哨兵：直接断言依赖产物里不带
  // 那段死代码。升级 xterm 后若新版本又有同样的 const enum 残留而 patch 没跟上，
  // 这条会红——它钉住的是「打包雷区不存在」，而不是某个具体函数名。
  test("哨兵：xterm.mjs 里没有 requestMode 的 const enum 残留 IIFE", () => {
    // jsdom 下 import.meta.url 不是 file://，用 cwd（vitest 在 app/ 下跑）。
    const mjs = readFileSync(
      "node_modules/@xterm/xterm/lib/xterm.mjs",
      "utf8",
    );
    // 未 patch 的 beta.292：requestMode(e,t){let r;(te=>(te[te.NOT_RECOGNIZED=0]=...))(r||={});
    expect(mjs.includes('NOT_RECOGNIZED=0]="NOT_RECOGNIZED"')).toBe(false);
  });

  test("查询 2026（synchronized output）应回 DECRPM，泵不断", async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    let responded = "";
    term.onData((d) => (responded += d));
    // CSI ? 2026 $ p —— claude code 入场时真实发送的查询之一
    term.write("\x1b[?2026$p");
    await flushPump();
    // DECRPM 应答：ESC[?2026;<v>$y（v=1 或 2，取决于当前 sync output 状态）
    expect(responded).toMatch(/\x1b\[\?2026;[12]\$y/);
    // 泵还活着：再写普通文本必须能进 buffer
    term.write("after-decrqm");
    await flushPump();
    expect(term.buffer.active.getLine(0)?.translateToString()).toContain("after-decrqm");
    term.dispose();
  });

  test("查询 2004（bracketed paste）与 ANSI 侧 4（insert mode）也不抛", async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    let responded = "";
    term.onData((d) => (responded += d));
    term.write("\x1b[?2004$p\x1b[4$p");
    await flushPump();
    expect(responded).toMatch(/\x1b\[\?2004;\d\$y/);
    expect(responded).toMatch(/\x1b\[4;\d\$y/);
    term.dispose();
  });
});
