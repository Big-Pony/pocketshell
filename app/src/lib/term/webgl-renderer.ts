// WebGL renderer lifecycle for the terminal, incl. GPU context-loss recovery.
//
// Why this exists as its own module: the recovery rules are the interesting
// part (rebuild vs. give up, how many times, what to redraw) and they are
// impossible to exercise in jsdom, which has no WebGL at all. Everything here
// is driven through the injected `host`, so the rules get unit tests and
// Terminal.svelte keeps only the wiring.
//
// Background — what actually happens on a phone when the GPU context is lost:
//   1. The canvas fires `webglcontextlost`. xterm's WebglRenderer preventDefaults
//      it (enabling restoration) and waits 3s for `webglcontextrestored`.
//   2. If restoration lands inside those 3s, xterm heals itself: it drops the
//      terminal from the shared texture-atlas cache and re-initialises its GL
//      state. Nothing here runs — that is the good path.
//   3. Only if 3s pass with no restoration does the addon fire onContextLoss.
//      That is where this module takes over, and by then the renderer is dead:
//      the terminal shows a frozen or black screen until something replaces it.
//
// The old handler was `webgl.onContextLoss(() => webgl.dispose())`. Disposing is
// necessary but not obviously sufficient, and it gives up GPU rendering forever
// after a single transient loss. This module instead rebuilds the addon (a fresh
// WebglAddon takes a fresh GL context and a fresh atlas), bounded by a rebuild
// budget so a device whose GPU keeps dying settles on the DOM renderer instead
// of thrashing in a rebuild loop.
export const MAX_WEBGL_REBUILDS = 2;

// The slice of WebglAddon this module needs. Narrow on purpose: it keeps the
// unit tests free of any real WebGL.
export interface WebglAddonLike {
  onContextLoss(cb: () => void): unknown;
  dispose(): void;
}

/**
 * Force a WebGL context to be released now instead of whenever GC runs.
 *
 * WebglAddon.dispose() detaches the canvas but never calls loseContext (the
 * string does not appear anywhere in the addon source), so the context lingers.
 * Measured in Chrome: switching tabs leaked one live context per switch even
 * though every addon had been disposed. Since contexts are the capped resource,
 * "eventually" is not good enough — the cap is what breaks rendering.
 *
 * There is no public API for this, so it reaches through the addon's internals
 * and tolerates every step being absent: a browser without WEBGL_lose_context
 * just falls back to GC timing, which is the behaviour we already had.
 */
function releaseContext(addon: WebglAddonLike, log: (m: string) => void): void {
  try {
    const gl = (addon as { _renderer?: { _gl?: { getExtension(n: string): unknown } } })._renderer?._gl;
    const ext = gl?.getExtension("WEBGL_lose_context") as { loseContext?(): void } | null | undefined;
    ext?.loseContext?.();
  } catch (e) {
    log(`[webgl] loseContext threw: ${String(e)}`);
  }
}

export interface WebglHost {
  // Construct + load a fresh addon. May throw (no WebGL2, blocked context, GPU
  // out of memory) — callers treat a throw as "stay on the DOM renderer".
  create(): WebglAddonLike;
  // 这里曾有一个 `reseed(): void` 钩子，2026-08-08 删除。它的说明词（「上下文
  // 丢失后屏上状态不可信，掉的帧永远到不了新渲染器」）是错的：xterm 的解析与
  // 渲染完全解耦，上下文死掉的只是渲染器，字节照常进 core buffer；而
  // WebglAddon.dispose() 内部会 setRenderer(_createRenderer())，xterm 的
  // setRenderer 末尾就是 _fullRefresh() —— 从 buffer 出发的全量重画已经做完了。
  // Diagnostics. Real losses are rare and only observable on a phone, so the
  // console trail is the only forensic evidence we get.
  log?(message: string): void;
}

export interface WebglHandle {
  // Whether a WebGL addon is currently driving the terminal. False means the
  // DOM renderer is in charge (either it never started, or the budget ran out).
  active(): boolean;
  // Rebuilds performed so far — asserted in tests, useful in the console.
  rebuilds(): number;
  // Release the GL context while this terminal is off-screen; take a fresh one
  // when it comes back. Both are safe to call repeatedly.
  //
  // Why this exists (docs/bug/终端显示异常2) — MEASURED, not theorised:
  // browsers cap the number of live WebGL contexts per page and force-lose the
  // OLDEST once the cap is passed. Reproduced in Chrome: terminals 1..16 all
  // stayed alive, then from the 17th onward exactly one older context died per
  // additional terminal, pinned at 16 alive. Phones cap far lower.
  //
  // App.svelte mounts a live <TerminalView> per tab, so N tabs meant N live
  // contexts and the browser silently killed the older tabs' renderers. That is
  // why the corruption needed several tabs to appear, why some tabs stayed
  // correct while others froze mid-frame, and why closing ALL tabs was the only
  // cure. A hidden terminal draws nothing, so holding its context buys nothing
  // and costs the one resource that is actually scarce.
  suspend(): void;
  resume(): void;
  // Detach for good: no further loss event may rebuild anything. Called on
  // unmount, where rebuilding into a torn-down terminal would be a leak.
  dispose(): void;
}

/**
 * `startSuspended` skips the initial context creation entirely — for a terminal
 * that mounts off-screen. Opening a session while several tabs are already open
 * would otherwise create N contexts in one go and blow straight past the cap,
 * which is precisely the failure this module now exists to prevent.
 */
export function installWebgl(
  host: WebglHost,
  maxRebuilds = MAX_WEBGL_REBUILDS,
  startSuspended = false,
): WebglHandle {
  let current: WebglAddonLike | undefined;
  let rebuilds = 0;
  let released = false;
  // Deliberately off-screen, as opposed to "never had a context" or "the GPU
  // took it away". Only a suspend may be resumed.
  let suspended = false;
  const log = (m: string) => host.log?.(m);

  // Attach a fresh addon and subscribe to ITS loss event. Each addon has its own
  // emitter, so the handler must be re-registered on every rebuild — this is
  // also why the subscription lives here rather than at the call site.
  const attach = (): boolean => {
    try {
      const addon = host.create();
      current = addon;
      addon.onContextLoss(() => {
        // Ignore a loss reported by an addon we already replaced or released:
        // the dead addon's emitter can still fire, and acting on it would burn
        // budget (or resurrect a renderer on an unmounted terminal).
        if (released || current !== addon) return;
        onLoss();
      });
      return true;
    } catch (e) {
      current = undefined;
      log(`[webgl] create failed, staying on DOM renderer: ${String(e)}`);
      return false;
    }
  };

  const onLoss = () => {
    const dead = current;
    current = undefined;
    // Dispose first, always. Besides freeing the dead GL resources this is what
    // releases the terminal's claim on the SHARED texture atlas: xterm caches
    // one atlas per identical config (same font size, same DPR), so several
    // terminals hold the very same atlas object, and a half-released entry is
    // how one dead context ends up corrupting the others.
    try { dead?.dispose(); } catch (e) { log(`[webgl] dispose after loss threw: ${String(e)}`); }

    if (rebuilds >= maxRebuilds) {
      // Budget spent: this device's GPU context is not staying up. Stop
      // rebuilding and let the DOM renderer (slower, but it cannot lose a
      // context) carry the session.
      log(`[webgl] context lost ${rebuilds + 1}x, giving up on WebGL — DOM renderer from here`);
      return;
    }

    rebuilds++;
    if (attach()) log(`[webgl] context lost, rebuilt renderer (attempt ${rebuilds})`);
    else log(`[webgl] context lost and rebuild failed — DOM renderer from here`);
    // 这里**不**重灌历史（2026-08-08 订正）。曾经的注释说「现在渲染的是一块在
    // 上下文死亡那一刻就冻结的画面」——那是错的：xterm 的解析与渲染完全解耦，
    // 上下文死掉的只是渲染器，字节照常进 core buffer。而 WebglAddon.dispose()
    // 内部会 setRenderer(_createRenderer())，xterm 的 setRenderer 末尾就是
    // _fullRefresh() —— 上面那句 dispose 已经完成了从 buffer 出发的全量重画。
    //
    // 换言之，之前这里是拿一次跨网络的破坏性重灌，去修一个纯本地的 GPU 问题。
    // 同文件 resume() 的注释（"The buffer lives in xterm's core, not in the
    // renderer"）说的才是对的，两处此前自相矛盾。
  };

  // A terminal that mounts hidden marks itself suspended without ever taking a
  // context, so the later resume() on activation is the first one created.
  if (startSuspended) suspended = true;
  else attach();

  return {
    active: () => current !== undefined,
    rebuilds: () => rebuilds,
    suspend() {
      // Released → already torn down. No addon → the DOM renderer is drawing,
      // which holds no GL context and so has nothing to give back.
      if (released || !current) return;
      const addon = current;
      // Clear `current` FIRST: dispose can fire the addon's loss emitter, and
      // onLoss checks `current !== addon` to ignore stale events. Leaving it set
      // would let a deliberate suspend masquerade as a GPU failure and burn the
      // rebuild budget.
      current = undefined;
      // Release the context BEFORE dispose: dispose detaches the canvas, and
      // reaching the GL handle through the addon afterwards is not guaranteed.
      releaseContext(addon, log);
      try { addon.dispose(); } catch (e) { log(`[webgl] dispose on suspend threw: ${String(e)}`); }
      suspended = true;
    },
    resume() {
      // Only a suspend may be undone. Without this guard a resume racing an
      // unmount — or arriving for a terminal that never had WebGL at all —
      // would create a context nothing owns.
      if (released || !suspended || current) return;
      suspended = false;
      // Deliberately NO reseed, unlike the context-loss path. The buffer lives
      // in xterm's core, not in the renderer, so it survives an addon swap
      // untouched, and attaching a renderer triggers a full repaint from it.
      // Nothing was dropped either: while suspended the DOM renderer was in
      // charge, and hidden terminals stash their output separately (R1).
      // Reseeding here would mean a tmux round-trip on every single tab switch.
      if (!attach()) log("[webgl] resume failed to create a context — DOM renderer for this tab");
    },
    dispose() {
      released = true;
      suspended = false;
      const addon = current;
      current = undefined;
      // Same reason as suspend: closing a tab must give the context back now,
      // not whenever GC gets around to it.
      if (addon) releaseContext(addon, log);
      try { addon?.dispose(); } catch { /* teardown is best-effort */ }
    },
  };
}
