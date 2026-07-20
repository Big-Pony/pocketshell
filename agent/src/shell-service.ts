// A raw-PTY shell session, isolated from tmux. Used for ephemeral foreground
// work: survives client disconnects (server-side PTY + replay ring), destroyed
// on explicit kill or agent restart. Never enters the tmux roster/task panel.
import { spawnPty, type PtyHandle } from "./pty";
import { ReplayService } from "./replay";
import type { SessionMeta } from "./protocol";

export type PtySpawner = (opts: { cmd: string[]; cols: number; rows: number }) => PtyHandle;

interface Live {
  pty: PtyHandle;
  meta: SessionMeta;
}

export class ShellService {
  private sessions = new Map<string, Live>();
  private replay = new ReplayService();
  private outputCbs: ((name: string, chunk: Uint8Array) => void)[] = [];
  private exitCbs: ((name: string, code: number) => void)[] = [];
  private changeCbs: (() => void)[] = [];
  private spawn: PtySpawner;
  private shellCmd: string[];

  constructor(deps: { spawn?: PtySpawner; shellCmd?: string[] } = {}) {
    this.spawn = deps.spawn ?? spawnPty;
    this.shellCmd = deps.shellCmd ?? [process.env.SHELL || "/bin/bash"];
  }

  onOutput(cb: (name: string, chunk: Uint8Array) => void): void { this.outputCbs.push(cb); }
  onExit(cb: (name: string, code: number) => void): void { this.exitCbs.push(cb); }
  onChange(cb: () => void): void { this.changeCbs.push(cb); }
  private emitChange(): void { for (const cb of this.changeCbs) cb(); }

  has(name: string): boolean { return this.sessions.has(name); }

  create(name: string, opt: { cols?: number; rows?: number } = {}): void {
    if (this.sessions.has(name)) return;
    const cols = opt.cols ?? 80;
    const rows = opt.rows ?? 24;
    const pty = this.spawn({ cmd: this.shellCmd, cols, rows });
    pty.onData((chunk) => {
      this.replay.ingest(name, chunk);
      for (const cb of this.outputCbs) cb(name, chunk);
    });
    pty.onExit((code) => {
      if (!this.sessions.has(name)) return;
      this.sessions.delete(name);
      for (const cb of this.exitCbs) cb(name, code);
      this.emitChange();
    });
    const meta: SessionMeta = {
      name, kind: "shell", state: "run", cols, rows,
      lastLine: "", createdAt: Date.now(), attached: true,
    };
    this.sessions.set(name, { pty, meta });
    this.emitChange();
  }

  write(name: string, data: Uint8Array): void { this.sessions.get(name)?.pty.write(data); }

  resize(name: string, cols: number, rows: number): void {
    const l = this.sessions.get(name);
    if (!l) return;
    l.meta.cols = cols;
    l.meta.rows = rows;
    l.pty.resize(cols, rows);
  }

  kill(name: string): void {
    const l = this.sessions.get(name);
    l?.pty.kill();
    this.sessions.delete(name);
    this.emitChange();
  }

  since(name: string, lastSeq: number) { return this.replay.since(name, lastSeq); }
  latestSeq(name: string): number { return this.replay.latestSeq(name); }

  list(): SessionMeta[] { return [...this.sessions.values()].map((l) => ({ ...l.meta })); }

  dispose(): void {
    for (const l of this.sessions.values()) l.pty.kill();
    this.sessions.clear();
  }
}
