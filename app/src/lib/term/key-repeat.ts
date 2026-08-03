// app/src/lib/key-repeat.ts
// Long-press key repeat for the on-screen keyboard: fire once immediately on
// keydown, wait `delayMs`, then repeat every `intervalMs` until stop(). Pure
// timer logic with an injected scheduler so unit tests drive a fake clock.
//
// Scope (六期 req 3): only keys that resolve to PTY bytes get a repeater —
// modifiers (state toggles), app commands (Fn layer / Cmd shortcuts /
// selection-mode arrows) and hint chips keep single-fire semantics. Vibration
// belongs to the first shot only; callers buzz before start(), never in fire.

export interface RepeatScheduler {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

const realScheduler: RepeatScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
  clearInterval: (id) => clearInterval(id),
};

export interface KeyRepeater {
  /** Fire once now, then arm the delay → repeat chain. Idempotent while running. */
  start(): void;
  /** Stop repeating. Safe before start(), after stop(), or twice. */
  stop(): void;
  /** True between start() and stop(). */
  active(): boolean;
}

export interface KeyRepeatOpts {
  delayMs?: number;    // hold time before repeating kicks in (default 400ms)
  intervalMs?: number; // repeat cadence (default 60ms)
  sched?: RepeatScheduler;
}

export function createKeyRepeater(fire: () => void, opts: KeyRepeatOpts = {}): KeyRepeater {
  const delay = opts.delayMs ?? 400;
  const interval = opts.intervalMs ?? 60;
  const sched = opts.sched ?? realScheduler;
  let timeoutId: number | undefined;
  let intervalId: number | undefined;

  const clear = () => {
    if (timeoutId !== undefined) { sched.clearTimeout(timeoutId); timeoutId = undefined; }
    if (intervalId !== undefined) { sched.clearInterval(intervalId); intervalId = undefined; }
  };

  return {
    start() {
      if (timeoutId !== undefined || intervalId !== undefined) return; // already running
      fire(); // first shot lands on keydown, not after the delay
      timeoutId = sched.setTimeout(() => {
        timeoutId = undefined;
        intervalId = sched.setInterval(fire, interval);
      }, delay);
    },
    stop() {
      clear();
    },
    active() {
      return timeoutId !== undefined || intervalId !== undefined;
    },
  };
}
