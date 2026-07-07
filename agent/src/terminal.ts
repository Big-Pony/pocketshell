// A2 TerminalService: sessions are tmux sessions; a PTY attaches to each so we
// can stream bytes. Adds heuristic state inference (via inferState), lastLine
// capture, and a rename hook. Emits raw bytes only — seq/buffer is A4.
import { spawnPty, type PtyHandle } from "./pty";
import { inferState } from "./state";
import { toB64 } from "./bytes";
import type { SessionMeta, SessionState } from "./protocol";

interface Live {
  pty: PtyHandle;
  meta: SessionMeta;
  lastOutputAt: number;
  lastReattachAt?: number;
}

export interface TmuxResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}
export type TmuxRunner = (args: string[]) => TmuxResult;

interface TmuxRosterEntry {
  name: string;
  createdAt: number;
  cols: number;
  rows: number;
}

// Default runner: spawn real tmux. Resilient to a missing binary (returns a
// non-zero result instead of throwing) so callers degrade gracefully and unit
// tests without tmux still pass.
const defaultTmux: TmuxRunner = (args) => {
  try {
    const r = Bun.spawnSync(["tmux", ...args]);
    return {
      exitCode: r.exitCode ?? 0,
      stdout: r.stdout ?? new Uint8Array(),
      stderr: r.stderr ?? new Uint8Array(),
    };
  } catch {
    return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() };
  }
};

const SCAN_INTERVAL_MS = 1000;

export class TerminalService {
  private sessions = new Map<string, Live>();
  private outputCbs: ((name: string, chunk: Uint8Array) => void)[] = [];
  private exitCbs: ((name: string, code: number) => void)[] = [];
  private sessionsChangeCbs: (() => void)[] = [];
  private lastStates = new Map<string, SessionState>();
  private scanTimer: ReturnType<typeof setInterval>;
  private tmux: TmuxRunner;

  constructor(deps: { tmux?: TmuxRunner } = {}) {
    this.tmux = deps.tmux ?? defaultTmux;
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
    return this.tmux(["has-session", "-t", name]).exitCode === 0;
  }

  // Recompute run/wait for live sessions; fire onSessionsChange only on change.
  private scan(): void {
    const now = Date.now();
    let changed = false;
    for (const [name, live] of this.sessions) {
      const st = inferState({ hasSession: this.hasSession(name), lastOutputAt: live.lastOutputAt, now });
      if (this.lastStates.get(name) !== st) {
        this.lastStates.set(name, st);
        changed = true;
      }
    }
    if (changed) this.emitSessionsChange();
  }

  // Grab the bottom-most non-empty line of the pane for the task-panel preview.
  // `-u` forces UTF-8 output: under launchd (no LANG/LC_*) tmux runs in the C
  // locale and sanitizes non-ASCII / control bytes to `_`, which would corrupt
  // CJK previews. Same locale issue as attach()/roster(); keep `-u`.
  private captureLastLine(name: string): string {
    const res = this.tmux(["-u", "capture-pane", "-p", "-t", name]);
    if (res.exitCode !== 0) return "";
    const lines = new TextDecoder()
      .decode(res.stdout)
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.length > 0);
    return lines.length ? lines[lines.length - 1] : "";
  }

  // Export the pane's full scrollback + current visible content as raw bytes
  // with SGR colours preserved, so the frontend can seed xterm's buffer on
  // attach. `-e` keeps colours, `-J` unwraps tmux-folded long lines, `-S -`
  // starts at the top of history, `-E -` ends at the bottom of the visible
  // screen. The frontend clears its own buffer before writing, so the entire
  // captured pane is reproduced without duplication.
  history(name: string): { data: string } {
    const res = this.tmux(["-u", "capture-pane", "-e", "-p", "-J", "-S", "-", "-E", "-", "-t", name]);
    if (res.exitCode !== 0) return { data: "" };
    return { data: toB64(res.stdout) };
  }

  // Snapshot of the tmux pane's current state. Used by the frontend to decide
  // whether an alternate-screen buffer is a shell (stay in normal scrollback,
  // seed history) or a full-screen app (3x virtual rows + outer scrolling).
  paneInfo(name: string): { currentCommand: string; alternateOn: boolean; isShell: boolean } {
    const res = this.tmux(["display-message", "-p", "-t", name, "#{pane_current_command}|#{alternate_on}"]);
    if (res.exitCode !== 0) return { currentCommand: "", alternateOn: false, isShell: false };
    const [cmd = "", alt = ""] = new TextDecoder().decode(res.stdout).trim().split("|");
    const command = cmd.trim();
    const shellNames = new Set(["zsh", "bash", "fish", "sh", "csh", "ksh", "tcsh", "dash"]);
    return {
      currentCommand: command,
      alternateOn: alt.trim() === "1",
      isShell: shellNames.has(command),
    };
  }

  // Create the attach PTY and wire byte + exit callbacks. Extracted so Task 5
  // can re-attach on detach without duplicating wiring. Slice-3 stays S1-style:
  // PTY exit deletes the session (real-vs-detach split lands in Task 5).
  private attach(name: string, cols: number, rows: number): PtyHandle {
    // `-u` forces tmux into UTF-8 mode. Under launchd (and many service
    // managers) LANG/LC_* are unset, so tmux would otherwise decide the client
    // is non-UTF-8 and render every CJK cell as an underscore. The client is
    // always xterm.js (UTF-8), so forcing it is correct and needs no installed
    // locale. Must precede the `attach` subcommand (global flag).
    const pty = spawnPty({ cmd: ["tmux", "-u", "attach", "-t", name], cols, rows });
    pty.onData((chunk) => {
      const live = this.sessions.get(name);
      if (live) live.lastOutputAt = Date.now();
      for (const cb of this.outputCbs) cb(name, chunk);
    });
    pty.onExit((code) => this.onPtyExit(name, code));
    return pty;
  }

  // tmux session is the source of truth: a dead PTY may just be a detach.
  private onPtyExit(name: string, code: number): void {
    const live = this.sessions.get(name);
    if (!live) return; // already killed locally

    if (this.hasSession(name)) {
      // Session still alive -> this was a detach. Guard against a hot loop if
      // has-session flaps by demoting to "done" when re-attaches come too fast.
      const now = Date.now();
      if (now - (live.lastReattachAt ?? 0) < 500) {
        this.sessions.delete(name);
        this.lastStates.delete(name);
        for (const cb of this.exitCbs) cb(name, code);
        this.emitSessionsChange();
        return;
      }
      live.lastReattachAt = now;
      live.pty = this.attach(name, live.meta.cols, live.meta.rows);
      return;
    }

    // Session is really gone -> done.
    this.sessions.delete(name);
    this.lastStates.delete(name);
    for (const cb of this.exitCbs) cb(name, code);
    this.emitSessionsChange();
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
      // `-u`: create the tmux server in UTF-8 mode so panes store/parse CJK
      // correctly regardless of the (often absent under launchd) locale. See attach().
      const args = ["-u", "new-session", "-d", "-s", name];
      if (opt.cwd) args.push("-c", opt.cwd);
      if (opt.cmd) args.push(opt.cmd);
      const res = this.tmux(args);
      if (res.exitCode !== 0) {
        throw new Error(
          `tmux new-session failed for "${name}": ${new TextDecoder().decode(res.stderr)}`,
        );
      }
    }

    // Disable tmux's default status line (server-wide, idempotent). Two mobile
    // bugs both trace to it: (1) its green bar occupies the window's bottom row
    // and visually covers the shell prompt/input on the phone — and the app
    // already renders its own session tabs + connection status, so tmux's status
    // line is redundant; (2) its right side shows a clock that tmux redraws every
    // `status-interval` (15s default) — the only idle output tmux emits — which
    // periodically nudged the cursor down a row. With status off the window is a
    // clean 1:1 with xterm's rows and there is no periodic redraw.
    this.tmux(["set-option", "-g", "status", "off"]);

    const meta: SessionMeta = {
      name,
      state: "run",
      cols,
      rows,
      lastLine: "",
      createdAt: Date.now(),
      attached: true,
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
    this.tmux(["resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]);
  }

  async kill(name: string): Promise<void> {
    const live = this.sessions.get(name);
    live?.pty.kill();
    this.sessions.delete(name);
    this.lastStates.delete(name);
    this.tmux(["kill-session", "-t", name]);
    this.emitSessionsChange();
  }

  rename(name: string, newName: string): void {
    const live = this.sessions.get(name);
    if (!live) {
      // Foreign (non-owned) session: rename directly; next list() reflects it.
      const res = this.tmux(["rename-session", "-t", name, newName]);
      if (res.exitCode !== 0) {
        throw new Error(
          `tmux rename-session failed for "${name}": ${new TextDecoder().decode(res.stderr)}`,
        );
      }
      this.emitSessionsChange();
      return;
    }
    const res = this.tmux(["rename-session", "-t", name, newName]);
    if (res.exitCode !== 0) {
      throw new Error(
        `tmux rename-session failed for "${name}": ${new TextDecoder().decode(res.stderr)}`,
      );
    }
    live.meta.name = newName;
    this.sessions.delete(name);
    this.sessions.set(newName, live);
    const st = this.lastStates.get(name);
    this.lastStates.delete(name);
    if (st) this.lastStates.set(newName, st);
    // Re-wire the PTY so its onData/onExit closures capture the new name;
    // otherwise output for this session keeps being emitted under the old name
    // and the client (now keyed by the new name) receives nothing.
    live.pty.kill();
    live.pty = this.attach(newName, live.meta.cols, live.meta.rows);
    this.emitSessionsChange();
  }

  // Whole-machine tmux roster (one spawn). Tab-separated; session names cannot
  // contain a tab in practice, so a plain split is safe. Degrades to [] when
  // tmux is absent or the query fails.
  //
  // `-u` is REQUIRED, not cosmetic: without it, tmux under launchd (no LANG/LC_*
  // -> C locale) sanitizes the literal TAB delimiter in `-F` output to `_`, so
  // every line fails the 4-field split and the whole roster comes back empty
  // (the "task panel is empty in production" bug). Same root cause as the
  // CJK-underscore fix on attach()/new-session. Do not remove `-u`.
  private roster(): TmuxRosterEntry[] {
    const res = this.tmux([
      "-u",
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_created}\t#{window_width}\t#{window_height}",
    ]);
    if (res.exitCode !== 0) return [];
    return new TextDecoder()
      .decode(res.stdout)
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.length > 0)
      .map((l): TmuxRosterEntry | null => {
        const parts = l.split("\t");
        if (parts.length < 4) return null;
        const [name, created, width, height] = parts;
        return {
          name,
          createdAt: (Number(created) || 0) * 1000,
          cols: Number(width) || 80,
          rows: Number(height) || 24,
        };
      })
      .filter((e): e is TmuxRosterEntry => e !== null);
  }

  list(): SessionMeta[] {
    const now = Date.now();
    const owned: SessionMeta[] = [...this.sessions.values()].map((l) => ({
      ...l.meta,
      state: inferState({ hasSession: this.hasSession(l.meta.name), lastOutputAt: l.lastOutputAt, now }),
      lastLine: this.captureLastLine(l.meta.name),
      attached: true,
    }));
    const foreign: SessionMeta[] = this.roster()
      .filter((r) => !this.sessions.has(r.name))
      .map((r) => ({
        name: r.name,
        state: "idle" as const,
        cols: r.cols,
        rows: r.rows,
        lastLine: this.captureLastLine(r.name),
        createdAt: r.createdAt,
        attached: false,
      }));
    return [...owned, ...foreign];
  }

  dispose(): void {
    clearInterval(this.scanTimer);
    for (const l of this.sessions.values()) l.pty.kill();
    this.sessions.clear();
    this.lastStates.clear();
  }
}
