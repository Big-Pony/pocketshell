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
  });

  // Wire subprocess exit to exitCbs.
  proc.exited.then((code) => {
    for (const cb of exitCbs) cb(code ?? 0);
  });

  return {
    write(data) {
      terminal.write(data);
    },
    resize(cols, rows) {
      terminal.resize(cols, rows);
    },
    kill() {
      proc.kill();
      terminal.close();
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
  };
}
