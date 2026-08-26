import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkForSend, fifoName, hexArgs, PaneChannel, PASTE_DIAG_BYTES, SEND_CHUNK } from "./pane-channel";
import type { TmuxResult } from "./terminal";

const OK: TmuxResult = { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };

describe("hexArgs —— send-keys -H 的载荷", () => {
  it("逐字节两位十六进制，不是逐码点", () => {
    // 逐码点会丢多字节字符（实测 16B→6B，见 spike/tmux-input-probe.ts），
    // 所以这里必须按 UTF-8 字节展开。
    expect(hexArgs(new TextEncoder().encode("你"))).toEqual(["e4", "bd", "a0"]);
  });

  it("控制字节与高位字节都补齐两位", () => {
    expect(hexArgs(new Uint8Array([0x00, 0x01, 0x0a, 0x1b, 0x7f, 0xff]))).toEqual(
      ["00", "01", "0a", "1b", "7f", "ff"],
    );
  });

  it("emoji（4 字节）不被拆坏", () => {
    expect(hexArgs(new TextEncoder().encode("🎉"))).toEqual(["f0", "9f", "8e", "89"]);
  });
});

describe("chunkForSend —— 单次 send-keys 的长度上限", () => {
  it("默认块长不超过实测安全值", () => {
    // 实测 4096B 通过、16384B 报 `command too long`，SEND_CHUNK 取一半留余量。
    expect(SEND_CHUNK).toBeLessThanOrEqual(4096);
  });

  it("恰好一块时不切", () => {
    expect(chunkForSend(new Uint8Array(SEND_CHUNK)).length).toBe(1);
  });

  it("超一字节就切成两块，且总字节数守恒", () => {
    const parts = chunkForSend(new Uint8Array(SEND_CHUNK + 1));
    expect(parts.length).toBe(2);
    expect(parts.reduce((n, p) => n + p.length, 0)).toBe(SEND_CHUNK + 1);
  });

  it("大粘贴按块数线性切分，顺序保持", () => {
    const data = new Uint8Array(SEND_CHUNK * 3 + 7);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const parts = chunkForSend(data);
    expect(parts.length).toBe(4);
    const rejoined = new Uint8Array(data.length);
    let o = 0;
    for (const p of parts) { rejoined.set(p, o); o += p.length; }
    expect([...rejoined]).toEqual([...data]);
  });
});

describe("fifoName —— 会话名进路径", () => {
  it("空格/斜杠/CJK 都被净化掉", () => {
    expect(fifoName("my proj/前端")).toMatch(/^pane-[A-Za-z0-9_-]*-[a-z0-9]+\.fifo$/);
  });

  it("净化后同形的不同会话名不会撞同一个文件", () => {
    // "a b" 与 "a/b" 净化后都是 "a_b"，必须靠哈希区分，否则两个会话共用一根管子。
    expect(fifoName("a b")).not.toBe(fifoName("a/b"));
  });

  it("同名稳定（重启后能对上同一个文件）", () => {
    expect(fifoName("dev")).toBe(fifoName("dev"));
  });
});

describe("PaneChannel —— 与 tmux 的交互", () => {
  const dirs: string[] = [];
  const mkdir = () => { const d = mkdtempSync(join(tmpdir(), "ps-pane-")); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const spy = () => {
    const calls: string[][] = [];
    return {
      calls,
      tmux: (args: string[]) => { calls.push(args); return OK; },
      tmuxAsync: async (args: string[]) => { calls.push(args); return OK; },
    };
  };

  it("开通道时用 -O 起 pipe-pane（-O = 只要窗格输出，不要输入回显）", () => {
    const s = spy();
    const ch = new PaneChannel("dev", { tmux: s.tmux, tmuxAsync: s.tmuxAsync, runDir: mkdir() });
    const pipe = s.calls.find((c) => c[0] === "pipe-pane");
    expect(pipe).toBeDefined();
    expect(pipe).toContain("-O");
    expect(pipe).toContain("dev");
    ch.kill();
  });

  it("write 走 send-keys -H，逐字节保真", async () => {
    const s = spy();
    const ch = new PaneChannel("dev", { tmux: s.tmux, tmuxAsync: s.tmuxAsync, runDir: mkdir() });
    ch.write(new TextEncoder().encode("你"));
    await Bun.sleep(10);
    const send = s.calls.find((c) => c[0] === "send-keys");
    expect(send).toEqual(["send-keys", "-H", "-t", "dev", "e4", "bd", "a0"]);
    ch.kill();
  });

  it("超长输入切成多次 send-keys，且按序发出", async () => {
    const s = spy();
    const ch = new PaneChannel("dev", { tmux: s.tmux, tmuxAsync: s.tmuxAsync, runDir: mkdir() });
    const data = new Uint8Array(SEND_CHUNK + 10).fill(0x61);
    data[SEND_CHUNK] = 0x62; // 第二块的头一个字节
    ch.write(data);
    await Bun.sleep(30);
    const sends = s.calls.filter((c) => c[0] === "send-keys");
    expect(sends.length).toBe(2);
    expect(sends[0]!.length).toBe(4 + SEND_CHUNK);
    expect(sends[1]![4]).toBe("62"); // 顺序没乱
    ch.kill();
  });

  it("空写不发命令（send-keys 不带参数会变成「重发上一个键」）", async () => {
    const s = spy();
    const ch = new PaneChannel("dev", { tmux: s.tmux, tmuxAsync: s.tmuxAsync, runDir: mkdir() });
    ch.write(new Uint8Array());
    await Bun.sleep(10);
    expect(s.calls.filter((c) => c[0] === "send-keys").length).toBe(0);
    ch.kill();
  });

  it("kill 先关 tmux 侧的管子，再关自己这侧", () => {
    const s = spy();
    const ch = new PaneChannel("dev", { tmux: s.tmux, tmuxAsync: s.tmuxAsync, runDir: mkdir() });
    s.calls.length = 0;
    ch.kill();
    expect(s.calls[0]).toEqual(["pipe-pane", "-t", "dev"]); // 不带 -O = 关闭
  });

  it("kill 之后不再发任何命令", async () => {
    const s = spy();
    const ch = new PaneChannel("dev", { tmux: s.tmux, tmuxAsync: s.tmuxAsync, runDir: mkdir() });
    ch.kill();
    s.calls.length = 0;
    ch.write(new TextEncoder().encode("x"));
    ch.resize(100, 40);
    await Bun.sleep(10);
    expect(s.calls).toEqual([]);
  });

  it("resize 落到 resize-window", () => {
    const s = spy();
    const ch = new PaneChannel("dev", { tmux: s.tmux, tmuxAsync: s.tmuxAsync, runDir: mkdir() });
    s.calls.length = 0;
    ch.resize(100, 40);
    expect(s.calls).toContainEqual(["resize-window", "-t", "dev", "-x", "100", "-y", "40"]);
    ch.kill();
  });

  it("send-keys 失败必须出声 —— 静默丢输入等于用户打的字凭空少一截", async () => {
    const calls: string[][] = [];
    const bad: TmuxResult = { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() };
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => { lines.push(String(m)); };
    try {
      const ch = new PaneChannel("dev", {
        tmux: (a) => { calls.push(a); return OK; },
        tmuxAsync: async (a) => { calls.push(a); return a[0] === "send-keys" ? bad : OK; },
        runDir: mkdir(),
      });
      ch.write(new TextEncoder().encode("hello"));
      await Bun.sleep(20);
      ch.kill();
    } finally { console.log = orig; }
    const drop = lines.find((l) => l.includes("input-drop"));
    expect(drop).toBeDefined();
    expect(drop).toContain('"bytes":5');
    // 内容绝不能进日志（日志会被贴进公开 issue）
    expect(drop).not.toContain("hello");
    expect(drop).not.toContain("68656c6c6f");
  });

  it("大块输入留计数埋点，逐键输入不留（否则日志被刷爆）", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => { lines.push(String(m)); };
    let ch: PaneChannel;
    try {
      const s = spy();
      ch = new PaneChannel("dev", { tmux: s.tmux, tmuxAsync: s.tmuxAsync, runDir: mkdir() });
      ch.write(new Uint8Array(1).fill(0x61));                 // 一次按键
      ch.write(new Uint8Array(PASTE_DIAG_BYTES).fill(0x62));  // 一次粘贴
      await Bun.sleep(20);
    } finally { console.log = orig; }
    const pastes = lines.filter((l) => l.includes("input-paste"));
    expect(pastes.length).toBe(1);
    expect(pastes[0]).toContain(`"bytes":${PASTE_DIAG_BYTES}`);
    expect(pastes[0]).not.toContain("62"); // 内容不进日志
    ch!.kill();
  });

  it("原始字节旁录默认关闭 —— 不设环境变量就不会把会话原文落盘", () => {
    const s = spy();
    const ch = new PaneChannel("dev", { tmux: s.tmux, tmuxAsync: s.tmuxAsync, runDir: mkdir() });
    const pipe = s.calls.find((c) => c[0] === "pipe-pane")!;
    expect(pipe[pipe.length - 1]).toStartWith("cat > ");
    ch.kill();
  });

  it("POCKETSHELL_PANE_TAP 打开时才 tee 一份到本机文件", () => {
    const s = spy();
    const dir = mkdir();
    process.env.POCKETSHELL_PANE_TAP = dir;
    try {
      const ch = new PaneChannel("dev", { tmux: s.tmux, tmuxAsync: s.tmuxAsync, runDir: mkdir() });
      const pipe = s.calls.find((c) => c[0] === "pipe-pane")!;
      expect(pipe[pipe.length - 1]).toStartWith(`tee -a '${dir}/`);
      ch.kill();
    } finally { delete process.env.POCKETSHELL_PANE_TAP; }
  });

  it("fail 只触发一次 onExit（会话清理不得跑两遍）", () => {
    const s = spy();
    const ch = new PaneChannel("dev", { tmux: s.tmux, tmuxAsync: s.tmuxAsync, runDir: mkdir() });
    let n = 0;
    ch.onExit(() => n++);
    ch.fail();
    ch.fail();
    expect(n).toBe(1);
  });
});
