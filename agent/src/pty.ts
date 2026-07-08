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
    // The PTY client (tmux attach) needs a TERM whose terminfo exists, or tmux
    // aborts with "open terminal failed: terminal does not support clear". Under
    // launchd there is no TERM in the environment, so set one explicitly. The
    // frontend is xterm.js, so xterm-256color is the correct emulation (its
    // terminfo ships with macOS/Linux). tmux still overrides TERM inside panes
    // via its own default-terminal, so programs like Claude Code are unaffected.
    env: { ...process.env, TERM: "xterm-256color" },
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
