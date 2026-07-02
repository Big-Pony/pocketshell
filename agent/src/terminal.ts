// A2 TerminalService: sessions are tmux sessions; a PTY attaches to each so we
// can stream bytes. Emits raw bytes only — seq/buffer is A4, crypto is A3.
import { spawnPty, type PtyHandle } from "./pty";
import type { SessionMeta } from "./protocol";

interface Live {
  pty: PtyHandle;
  meta: SessionMeta;
}

export class TerminalService {
  private sessions = new Map<string, Live>();
  private outputCbs: ((name: string, chunk: Uint8Array) => void)[] = [];
  private exitCbs: ((name: string, code: number) => void)[] = [];

  onOutput(cb: (name: string, chunk: Uint8Array) => void): void {
    this.outputCbs.push(cb);
  }
  onExit(cb: (name: string, code: number) => void): void {
    this.exitCbs.push(cb);
  }

  ensure(
    name: string,
    opt: { cmd?: string; cwd?: string; cols?: number; rows?: number } = {},
  ): void {
    if (this.sessions.has(name)) return;

    const cols = opt.cols ?? 80;
    const rows = opt.rows ?? 24;

    // Create a detached tmux session if it doesn't exist yet.
    const exists = Bun.spawnSync(["tmux", "has-session", "-t", name]).exitCode === 0;
    if (!exists) {
      const args = ["tmux", "new-session", "-d", "-s", name];
      if (opt.cwd) args.push("-c", opt.cwd);
      if (opt.cmd) args.push(opt.cmd);
      Bun.spawnSync(args);
    }

    const pty = spawnPty({ cmd: ["tmux", "attach", "-t", name], cols, rows });
    const meta: SessionMeta = {
      name,
      state: "run",
      cols,
      rows,
      lastLine: "",
      createdAt: Date.now(),
    };
    pty.onData((chunk) => {
      for (const cb of this.outputCbs) cb(name, chunk);
    });
    pty.onExit((code) => {
      this.sessions.delete(name);
      for (const cb of this.exitCbs) cb(name, code);
    });
    this.sessions.set(name, { pty, meta });
  }

  write(name: string, data: Uint8Array): void {
    this.sessions.get(name)?.pty.write(data);
  }

  resize(name: string, cols: number, rows: number): void {
    const live = this.sessions.get(name);
    if (!live) return;
    live.meta.cols = cols;
    live.meta.rows = rows;
    live.pty.resize(cols, rows);
    // Also resize the tmux window so TUIs inside reflow to the phone viewport.
    Bun.spawnSync(["tmux", "resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]);
  }

  async kill(name: string): Promise<void> {
    const live = this.sessions.get(name);
    live?.pty.kill();
    this.sessions.delete(name);
    Bun.spawnSync(["tmux", "kill-session", "-t", name]);
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((l) => l.meta);
  }
}
