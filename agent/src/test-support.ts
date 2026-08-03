// Test-only helpers. Nothing under src/ that ships imports this file — it exists
// beside the tests so `.test.ts` files can share it without a second tsconfig root.
//
// Why this exists: `Bun.spawnSync` THROWS when the executable is missing
// (`ENOENT: Executable not found in $PATH`); it does not return a non-zero
// `exitCode`. So the idiomatic-looking guard
//
//     const hasTmux = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;   // WRONG
//
// blows up during module collection on a machine without tmux, killing the whole
// test file — including every test in it that has nothing to do with tmux. The
// guard ends up deleting the tests it was written to protect. Probe through
// `commandAvailable()` instead, which reports "unavailable" for any failure mode
// (missing binary, permission denied, killed by signal, non-zero exit).

/**
 * True only if `cmd` could actually be executed and exited 0.
 * Never throws: any spawn failure is reported as `false`.
 */
export function commandAvailable(cmd: string, args: string[] = []): boolean {
  try {
    const r = Bun.spawnSync([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/** True if a usable `tmux` is on PATH — the guard for tmux integration tests. */
export function hasTmux(): boolean {
  return commandAvailable("tmux", ["-V"]);
}

// ---------------------------------------------------------------------------
// tmux integration-test scaffolding
// ---------------------------------------------------------------------------
// tmux sessions are a MACHINE-GLOBAL namespace, not a per-process one. Every
// test that hardcoded the same literal name (`pocketshell_test`) was therefore
// sharing one mutable object with:
//
//   - the other tests in its own file (a failed test returns before its
//     `kill()`, leaving a live session — and a stale scrollback — behind for
//     whichever test runs next),
//   - any concurrently running `bun test` process (measured: two concurrent
//     runs of terminal.test.ts produce 2 and 4 failures respectively, versus 0
//     when run alone),
//   - the developer's own long-lived sessions.
//
// The observed failure signature proved the pollution rather than merely
// suggesting it: the FIRST test in the file ("ensure creates a session and
// streams echoed output") failed while receiving a pane that already contained
// `REATTACH_OK` — a string only the LAST test in the file ever writes —
// followed by tmux's `[exited]`, i.e. someone else killed the session mid-test.
//
// `uniqueSessionName()` moves each test into its own namespace, which removes
// the shared-object race outright instead of papering over it with longer
// timeouts.

/**
 * A tmux session name unique to this process AND this call.
 *
 * Includes the pid so concurrent `bun test` processes cannot collide, and a
 * monotonic counter so two tests in the same file never share one. The
 * `pocketshell_test_` prefix is kept so the sessions stay recognisable (and
 * greppable) if a hard crash ever leaks one.
 */
let sessionSeq = 0;
export function uniqueSessionName(tag = "s"): string {
  return `pocketshell_test_${process.pid}_${tag}_${++sessionSeq}`;
}

/**
 * Kill a tmux session, ignoring "no such session".
 *
 * Teardown must never throw: it runs in `finally` blocks whose job is to clean
 * up AFTER a failed assertion, and an exception there would replace the real
 * failure with a misleading one.
 */
export function killSession(name: string): void {
  try {
    Bun.spawnSync(["tmux", "kill-session", "-t", name], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // tmux missing or session already gone — nothing to clean up.
  }
}

/**
 * Poll `cond` until it holds, then return true; return false on timeout.
 *
 * Wall-clock waiting is unavoidable for the tmux integration tests — the thing
 * being awaited is a real shell in a real PTY on another process — but a fixed
 * `Bun.sleep(600)` bakes in a guess about how fast the machine is. This waits
 * for the CONDITION instead, so it returns as soon as the event happens (fast
 * on an idle machine) and still tolerates a loaded one.
 *
 * The default budget is deliberately generous relative to the ~600ms a shell
 * prompt actually takes: it is a ceiling for a pathologically loaded machine,
 * not an expected duration, and a passing test never spends it. It stays under
 * Bun's 5s per-test timeout so a genuine failure surfaces as a readable
 * assertion rather than an opaque "test timed out".
 */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const intervalMs = opts.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(intervalMs);
  }
}

/**
 * Resolve once the session's shell has actually printed its prompt.
 *
 * Replaces the `await Bun.sleep(400)  // let attach settle` idiom. 400ms was
 * simply wrong: measured on an idle machine, the pane first shows content at
 * ~580-680ms, so the sleep was under the real cost even with NO load and the
 * tests were passing on the slack in the following sleep. Input written before
 * the shell is ready is swallowed by the PTY and the echo never arrives —
 * exactly the "expected to contain TERM_OK" failure.
 *
 * Readiness is read from tmux (`capture-pane`) rather than from the service's
 * own output stream, because a re-attach replays the pane and would make an
 * output-based signal fire for the previous test's bytes.
 */
export async function waitForPrompt(name: string, timeoutMs = 4000): Promise<boolean> {
  return waitFor(
    () => {
      try {
        const r = Bun.spawnSync(["tmux", "capture-pane", "-p", "-t", name]);
        return r.exitCode === 0 && new TextDecoder().decode(r.stdout).trim().length > 0;
      } catch {
        return false;
      }
    },
    { timeoutMs },
  );
}
