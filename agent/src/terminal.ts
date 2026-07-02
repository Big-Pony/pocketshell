// A2 TerminalService: sessions are tmux sessions; a PTY attaches to each so we
// can stream bytes. Adds heuristic state inference (via inferState), lastLine
// capture, and a rename hook. Emits raw bytes only — seq/buffer is A4.
import { spawnPty, type PtyHandle } from "./pty";
import { inferState } from "./state";
import type { SessionMeta, SessionState } from "./protocol";

interface Live {
  pty: PtyHandle;
  meta: SessionMeta;
  lastOutputAt: number;
}

const SCAN_INTERVAL_MS = 1000;

export class TerminalService {
  private sessions = new Map<string, Live>();
  private outputCbs: ((name: string, chunk: Uint8Array) => void)[] = [];
  private exitCbs: ((name: string, code: number) => void)[] = [];
  private sessionsChangeCbs: (() => void)[] = [];
  private lastStates = new Map<string, SessionState>();
  private scanTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.scanTimer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
    // Don't let the scanner keep the process (or `bun test`) alive on its own.
    (this.scanTimer as unknown as { unref?: () => void }).unref?.();
  }

  onOutput(cb: (name: string, chunk: Uint8Array) => void): void {
    this.outputCbs.push(cb);
  }
  onExit(cb: (name: string, code: number) => void): void {
    this.exitCbs.push(cb);
  }
  onSessionsChange(cb: () => void): void {
    this.sessionsChangeCbs.push(cb);
  }

  private emitSessionsChange(): void {
    for (const cb of this.sessionsChangeCbs) cb();
  }

  private hasSession(name: string): boolean {
    return Bun.spawnSync(["tmux", "has-session", "-t", name]).exitCode === 0;
  }

  // Recompute run/wait for live sessions; fire onSessionsChange only on change.
  private scan(): void {
    const now = Date.now();
    let changed = false;
    for (const [name, live] of this.sessions) {
      const st = inferState({ hasSession: this.hasSession(name), lastOutputAt: live.lastOutputAt, now });
      live.meta.state = st;
      if (this.lastStates.get(name) !== st) {
        this.lastStates.set(name, st);
        changed = true;
      }
    }
    if (changed) this.emitSessionsChange();
  }

  // Grab the bottom-most non-empty line of the pane for the task-panel preview.
  private captureLastLine(name: string): string {
    const res = Bun.spawnSync(["tmux", "capture-pane", "-p", "-t", name]);
    if (res.exitCode !== 0) return "";
    const lines = new TextDecoder()
      .decode(res.stdout)
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.length > 0);
    return lines.length ? lines[lines.length - 1] : "";
  }

  // Create the attach PTY and wire byte + exit callbacks. Extracted so Task 5
  // can re-attach on detach without duplicating wiring. Slice-3 stays S1-style:
  // PTY exit deletes the session (real-vs-detach split lands in Task 5).
  private attach(name: string, cols: number, rows: number): PtyHandle {
    const pty = spawnPty({ cmd: ["tmux", "attach", "-t", name], cols, rows });
    pty.onData((chunk) => {
      const live = this.sessions.get(name);
      if (live) live.lastOutputAt = Date.now();
      for (const cb of this.outputCbs) cb(name, chunk);
    });
    pty.onExit((code) => {
      this.sessions.delete(name);
      this.lastStates.delete(name);
      for (const cb of this.exitCbs) cb(name, code);
      this.emitSessionsChange();
    });
    return pty;
  }

  ensure(
    name: string,
    opt: { cmd?: string; cwd?: string; cols?: number; rows?: number } = {},
  ): void {
    if (this.sessions.has(name)) return;

    const cols = opt.cols ?? 80;
    const rows = opt.rows ?? 24;

    const exists = this.hasSession(name);
    if (!exists) {
      const args = ["tmux", "new-session", "-d", "-s", name];
      if (opt.cwd) args.push("-c", opt.cwd);
      if (opt.cmd) args.push(opt.cmd);
      const res = Bun.spawnSync(args);
      if (res.exitCode !== 0) {
        throw new Error(
          `tmux new-session failed for "${name}": ${new TextDecoder().decode(res.stderr)}`,
        );
      }
    }

    const meta: SessionMeta = {
      name,
      state: "run",
      cols,
      rows,
      lastLine: "",
      createdAt: Date.now(),
    };
    const pty = this.attach(name, cols, rows);
    this.sessions.set(name, { pty, meta, lastOutputAt: Date.now() });
    this.lastStates.set(name, "run");
    this.emitSessionsChange();
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
    Bun.spawnSync(["tmux", "resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]);
  }

  async kill(name: string): Promise<void> {
    const live = this.sessions.get(name);
    live?.pty.kill();
    this.sessions.delete(name);
    this.lastStates.delete(name);
    Bun.spawnSync(["tmux", "kill-session", "-t", name]);
    this.emitSessionsChange();
  }

  list(): SessionMeta[] {
    const now = Date.now();
    return [...this.sessions.values()].map((l) => ({
      ...l.meta,
      state: inferState({ hasSession: this.hasSession(l.meta.name), lastOutputAt: l.lastOutputAt, now }),
      lastLine: this.captureLastLine(l.meta.name),
    }));
  }

  dispose(): void {
    clearInterval(this.scanTimer);
    for (const l of this.sessions.values()) l.pty.kill();
    this.sessions.clear();
    this.lastStates.clear();
  }
}
