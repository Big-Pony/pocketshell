// PTY adapter: the ONLY place that touches Bun's raw PTY API.
// Everything else depends on PtyHandle, so a runtime swap (node-pty fallback)
// never leaks past this file.
//
// Bun 1.3.14 API notes (confirmed by spike/pty-tmux.ts):
//   - Use `new Bun.Terminal({ cols, rows, data, exit })` to create a PTY.
//   - `data(term, chunk)` callback receives Uint8Array output from the PTY.
//   - `exit(term, code, signal)` fires on PTY EOF (NOT subprocess exit).
//   - Pass the Terminal object to `Bun.spawn({ terminal })`.
//   - Write to PTY via `terminal.write(data)`.
//   - Resize via `terminal.resize(cols, rows)`.
//   - When `terminal` option is used, proc.stdin/stdout/stderr are all null.
//   - Use `proc.exited` Promise for actual subprocess exit code.

import { ptyEnv } from "./pty-env";

// WP-5: resize idempotency gate (defense in depth — the client already
// suppresses resize frames whose size did not change). Bun.Terminal.resize
// plus the SIGWINCH nudge below are only pushed when the size actually differs
// from the last applied one. The FIRST resize always goes through, even if it
// matches the spawn size: tmux may have attached at a different size and needs
// the SIGWINCH to renegotiate/repaint.
export class ResizeGate {
  private cols = -1;
  private rows = -1;

  // Records (cols, rows) as the last applied size and returns true when it
  // differs from the previously recorded one (or none was recorded yet),
  // i.e. when the PTY really needs terminal.resize + SIGWINCH.
  shouldResize(cols: number, rows: number): boolean {
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;
    return true;
  }
}

export interface PtyHandle {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  onExit(cb: (code: number) => void): void;
}

export function spawnPty(opts: { cmd: string[]; cols: number; rows: number }): PtyHandle {
  let killed = false;
  const dataCbs: ((chunk: Uint8Array) => void)[] = [];
  const exitCbs: ((code: number) => void)[] = [];
  const resizeGate = new ResizeGate();

  // Create the PTY terminal with data/exit callbacks.
  const terminal = new Bun.Terminal({
    cols: opts.cols,
    rows: opts.rows,
    data(_term, chunk) {
      for (const cb of dataCbs) cb(chunk);
    },
    exit(_term, _code, _signal) {
      // PTY EOF — terminal stream closed. Actual exit code comes from proc.exited.
    },
  });

  const proc = Bun.spawn(opts.cmd, {
    terminal,
    // ptyEnv keeps TERM correct and guarantees a UTF-8 locale (LANG) when the
    // service manager (launchd) provides none, so vim/shell inside tmux handle
    // CJK input correctly. See pty-env.ts.
    env: ptyEnv(process.env),
  });

  // Wire subprocess exit to exitCbs.
  proc.exited.then((code) => {
    for (const cb of exitCbs) cb(code ?? 0);
  });

  return {
    write(data) {
      if (!killed) terminal.write(data);
    },
    resize(cols, rows) {
      if (killed) return;
      // Idempotency gate: skip the winsize ioctl AND the SIGWINCH when the
      // size did not change — a redundant SIGWINCH makes tmux repaint for
      // nothing on every no-op resize frame.
      if (!resizeGate.shouldResize(cols, rows)) return;
      terminal.resize(cols, rows);
      // Bun.Terminal.resize updates the PTY winsize (TIOCSWINSZ) but does NOT
      // deliver SIGWINCH to the child (verified: bash sees the new `stty size`
      // because it re-reads live, but a SIGWINCH trap never fires). tmux and
      // other TUIs only re-read their size on SIGWINCH, so without this the
      // tmux attach client stays pinned at its spawn size (80x24) while the
      // window is resized independently. The size mismatch makes tmux paint the
      // client's overflow area with `·` fill chars ("session-attach dots"),
      // which stream into xterm and look like "Chinese turned into dots" on the
      // phone. Nudge the child with SIGWINCH so it renegotiates to the new size.
      try {
        proc.kill("SIGWINCH");
      } catch {
        // child already exited — nothing to notify
      }
    },
    kill() {
      killed = true;
      proc.kill();
      terminal.close();
      dataCbs.length = 0;
      exitCbs.length = 0;
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
  };
}
