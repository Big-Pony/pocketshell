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

export interface WebglHost {
  // Construct + load a fresh addon. May throw (no WebGL2, blocked context, GPU
  // out of memory) — callers treat a throw as "stay on the DOM renderer".
  create(): WebglAddonLike;
  // Reload the screen's contents from the authoritative source (tmux history).
  // After a context loss the on-screen state is not trustworthy: the frames that
  // were dropped while the context was dead never reach the new renderer, and
  // xterm has no "repaint from the byte stream" primitive.
  reseed(): void;
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
  // Detach for good: no further loss event may rebuild anything. Called on
  // unmount, where rebuilding into a torn-down terminal would be a leak.
  dispose(): void;
}

export function installWebgl(host: WebglHost, maxRebuilds = MAX_WEBGL_REBUILDS): WebglHandle {
  let current: WebglAddonLike | undefined;
  let rebuilds = 0;
  let released = false;
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
      host.reseed();
      return;
    }

    rebuilds++;
    if (attach()) log(`[webgl] context lost, rebuilt renderer (attempt ${rebuilds})`);
    else log(`[webgl] context lost and rebuild failed — DOM renderer from here`);
    // Reseed either way: whatever renders now, it renders a screen whose
    // contents were frozen at the moment the context died.
    host.reseed();
  };

  attach();

  return {
    active: () => current !== undefined,
    rebuilds: () => rebuilds,
    dispose() {
      released = true;
      const addon = current;
      current = undefined;
      try { addon?.dispose(); } catch { /* teardown is best-effort */ }
    },
  };
}
