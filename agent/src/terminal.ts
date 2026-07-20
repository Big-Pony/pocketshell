// A2 TerminalService: sessions are tmux sessions; a PTY attaches to each so we
// can stream bytes. Adds heuristic state inference (via inferState), lastLine
// capture, and a rename hook. Emits raw bytes only — seq/buffer is A4.
import { spawnPty, type PtyHandle } from "./pty";
import { inferState, StateHysteresis } from "./state";
import { toB64 } from "./bytes";
import { cjkFallbackLang } from "./pty-env";
import type { SessionMeta } from "./protocol";

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
// Async counterpart used on the hot probe paths (1s scanner + list()). Same
// TmuxResult contract and same failure semantics: a missing/failing tmux
// degrades to exitCode 1, never a throw.
export type AsyncTmuxRunner = (args: string[]) => Promise<TmuxResult>;

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

// Async default runner (WP-3a): Bun.spawn keeps the event loop free while
// tmux runs — the scanner + list() fan out several probes per round, and the
// old spawnSync versions blocked every RPC/output forward behind them.
const defaultTmuxAsync: AsyncTmuxRunner = async (args) => {
  try {
    const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToArrayBuffer(proc.stdout),
      Bun.readableStreamToArrayBuffer(proc.stderr),
      proc.exited,
    ]);
    return { exitCode, stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) };
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
  // Published per-session states with flip hysteresis (WP-3a). Fed ONLY by
  // the 1s scanner; list() reads these instead of re-inferring per call, so a
  // bursty session's run/wait flap neither reaches clients nor re-triggers
  // sessions broadcasts.
  private states = new Map<string, StateHysteresis>();
  private scanTimer: ReturnType<typeof setInterval>;
  private tmux: TmuxRunner;
  // Async runner for the hot probe paths (scanner + list). The sync runner
  // stays for one-shot, user-initiated RPC/control calls (history, paneInfo,
  // ensure, rename, ...).
  private tmuxAsync: AsyncTmuxRunner;
  private scanning = false;
  private disposed = false;
  // UTF-8 LANG to seed into new tmux sessions when the agent's own env has no
  // locale (see ensure() for why this must land on the server, not the client).
  private langFallback: string | null;

  constructor(deps: { tmux?: TmuxRunner; tmuxAsync?: AsyncTmuxRunner; langFallback?: string | null } = {}) {
    this.tmux = deps.tmux ?? defaultTmux;
    // Tests that inject only the sync fake get it wrapped, keeping the async
    // probe paths hermetic; production (no injected runner) gets real
    // non-blocking spawns via defaultTmuxAsync.
    this.tmuxAsync =
      deps.tmuxAsync ?? (deps.tmux ? async (args) => deps.tmux!(args) : defaultTmuxAsync);
    // `??` would treat an explicit `null` (tests asserting "no fallback") the
    // same as "omitted" and recompute a default — check presence instead so
    // callers can deliberately force no LANG injection.
    this.langFallback =
      deps.langFallback !== undefined ? deps.langFallback : cjkFallbackLang(process.env);
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

  private async hasSessionAsync(name: string): Promise<boolean> {
    return (await this.tmuxAsync(["has-session", "-t", name])).exitCode === 0;
  }

  // Recompute run/wait for live sessions; fire onSessionsChange only when a
  // debounced state actually flips. Probes run concurrently; a tick arriving
  // while the previous round is still probing is dropped rather than stacked
  // (the interval fires again in 1s — stacking would just queue more spawns).
  private scan(): void {
    if (this.scanning || this.disposed) return;
    this.scanning = true;
    void this.scanAsync()
      .catch(() => { /* an injected runner may throw; never kill the interval */ })
      .finally(() => {
        this.scanning = false;
      });
  }

  private async scanAsync(): Promise<void> {
    const now = Date.now();
    const entries = [...this.sessions.entries()];
    const probes = await Promise.all(
      entries.map(async ([name, live]) => ({
        name,
        inferred: inferState({
          hasSession: await this.hasSessionAsync(name),
          lastOutputAt: live.lastOutputAt,
          now,
        }),
      })),
    );
    if (this.disposed) return;
    let changed = false;
    for (const { name, inferred } of probes) {
      if (!this.sessions.has(name)) continue; // killed/renamed while probing
      let m = this.states.get(name);
      if (!m) {
        // No baseline (ensure() seeds one, so this is defensive): adopt the
        // first inference immediately instead of debouncing it.
        this.states.set(name, new StateHysteresis(inferred));
        continue;
      }
      if (m.next(inferred)) changed = true;
    }
    if (changed) this.emitSessionsChange();
  }

  // Grab the bottom-most non-empty line of the pane for the task-panel preview.
  // `-u` forces UTF-8 output: under launchd (no LANG/LC_*) tmux runs in the C
  // locale and sanitizes non-ASCII / control bytes to `_`, which would corrupt
  // CJK previews. Same locale issue as attach()/roster(); keep `-u`.
  private async captureLastLine(name: string): Promise<string> {
    const res = await this.tmuxAsync(["-u", "capture-pane", "-p", "-t", name]);
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
  //
  // A full 2000-line scrollback (~200KB of SGR) does not fit one Noise frame;
  // the rpc layer chunks oversize responses (WP-6), so this always returns the
  // complete capture — the WP-1 halving-retry shrink is gone.
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

  // Force tmux to re-push the pane's current screen to every attached client.
  // Used right after the frontend switches xterm into its alternate buffer:
  // tmux never forwards 1049h/1049l to attach clients, so the client-side
  // buffer switch leaves xterm's (empty) alt buffer blank until the pane app
  // redraws on its own — vim doesn't (the "vim opens to a blank screen" bug).
  // refresh-client makes tmux re-send the current grid; verified on tmux 3.6b
  // (client tty byte stream grows, screen text reappears). Gentler than the
  // resize-jiggle fallback (cols±1 -> SIGWINCH -> full repaint), so the jiggle
  // is not used. Read-only: it changes no session/pane state.
  redraw(name: string): { ok: boolean } {
    const clients = this.tmux(["list-clients", "-t", name, "-F", "#{client_name}"]);
    if (clients.exitCode !== 0) return { ok: false };
    const names = new TextDecoder()
      .decode(clients.stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    let ok = false;
    for (const c of names) {
      if (this.tmux(["refresh-client", "-t", c]).exitCode === 0) ok = true;
    }
    return { ok };
  }

  // The focused pane's real working directory (tmux #{pane_current_path}).
  // Used by the file panel's "set project root to focused tab" button. `-u`
  // forces UTF-8 so CJK path segments aren't sanitized under a C locale.
  pwd(name: string): { pwd: string } {
    const res = this.tmux(["-u", "display-message", "-p", "-t", name, "#{pane_current_path}"]);
    if (res.exitCode !== 0) return { pwd: "" };
    return { pwd: new TextDecoder().decode(res.stdout).trim() };
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
        this.states.delete(name);
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
    this.states.delete(name);
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
      // `-e`: seed the session environment so the shell (and any `claude` it
      // launches) inherit CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1. This forces
      // Claude Code into its classic renderer, which keeps the full transcript in
      // the NORMAL buffer (native scrollback) instead of a scrollback-less
      // alternate screen — so a long plan (hundreds of lines) is scrollable on the
      // phone and the input line stays visible. Also dodges the fullscreen
      // renderer's CJK-copy-corruption bug. (tmux 3.0+; `-e` before the command.)
      args.push("-e", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1");
      // `-e LANG=...`: a pane program's locale (what `vim`/the shell see) is
      // decided by the tmux SERVER's `new-session` environment, not by any
      // flag on the attach CLIENT — `-u` above only makes the attach client
      // itself UTF-8-aware, it does not reach the pane. Under launchd there is
      // no LANG/LC_* at all, so without this the pane runs in the C locale and
      // vim/CJK input gets garbled even though attach() looks correct. Only
      // seed a fallback when the agent's own env has no locale, so an operator
      // who explicitly configured one is never overridden (see cjkFallbackLang).
      if (this.langFallback) args.push("-e", `LANG=${this.langFallback}`);
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
      kind: "tmux",
      state: "run",
      cols,
      rows,
      lastLine: "",
      createdAt: Date.now(),
      attached: true,
    };
    const pty = this.attach(name, cols, rows);
    this.sessions.set(name, { pty, meta, lastOutputAt: Date.now() });
    this.states.set(name, new StateHysteresis("run"));
    this.emitSessionsChange();
  }

  // Public liveness check across owned + any live tmux session (foreign
  // included). Used by the server to reject a shell session whose name would
  // collide with an existing tmux session (cross-service name uniqueness).
  has(name: string): boolean {
    return this.sessions.has(name) || this.hasSession(name);
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
    this.states.delete(name);
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
    const m = this.states.get(name);
    this.states.delete(name);
    if (m) this.states.set(newName, m);
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
  private async roster(): Promise<TmuxRosterEntry[]> {
    const res = await this.tmuxAsync([
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

  // Async + concurrent (WP-3a): the roster spawn runs alongside per-session
  // capture-pane probes (Promise.all), so a round costs ~1 spawn round-trip
  // instead of 2S+1+F serialized spawnSyncs that blocked the event loop.
  // Owned sessions report the scanner-debounced state instead of re-probing
  // has-session per call: the 1s scanner already tracks liveness, and a fresh
  // raw inference here would reintroduce the run/wait flap the hysteresis
  // just filtered out.
  async list(): Promise<SessionMeta[]> {
    const rosterP = this.roster();
    const owned = await Promise.all(
      [...this.sessions.values()].map(async (l) => ({
        ...l.meta,
        state: this.states.get(l.meta.name)?.state ?? l.meta.state,
        lastLine: await this.captureLastLine(l.meta.name),
        attached: true,
      })),
    );
    const foreign = await Promise.all(
      (await rosterP)
        .filter((r) => !this.sessions.has(r.name))
        .map(async (r) => ({
          name: r.name,
          kind: "tmux" as const,
          state: "idle" as const,
          cols: r.cols,
          rows: r.rows,
          lastLine: await this.captureLastLine(r.name),
          createdAt: r.createdAt,
          attached: false,
        })),
    );
    return [...owned, ...foreign];
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.scanTimer);
    for (const l of this.sessions.values()) l.pty.kill();
    this.sessions.clear();
    this.states.clear();
  }
}
