import { describe, it, expect, vi } from "vitest";
import { installWebgl, MAX_WEBGL_REBUILDS, type WebglAddonLike, type WebglHost } from "./webgl-renderer";

// Fake addon + host. Each create() hands back a fresh addon carrying its own
// loss emitter, exactly like the real WebglAddon — the recovery code must
// re-subscribe on every rebuild or the second loss goes unheard.
function harness(opts: { failCreateFrom?: number; noLoseExtension?: boolean } = {}) {
  const addons: Array<WebglAddonLike & { lose(): void; disposed: boolean; contextLost: boolean }> = [];
  const logs: string[] = [];
  const reseed = vi.fn();
  const host: WebglHost = {
    create() {
      if (opts.failCreateFrom !== undefined && addons.length >= opts.failCreateFrom) {
        throw new Error("WebGL2 not supported");
      }
      let cb: (() => void) | undefined;
      // Mirrors the real addon closely enough to matter: `_renderer._gl` is the
      // private path installWebgl must walk to reach WEBGL_lose_context, since
      // the addon exposes no public way to give the context back.
      const addon = {
        disposed: false,
        contextLost: false,
        _renderer: {
          _gl: {
            getExtension: (name: string) => {
              if (opts.noLoseExtension || name !== "WEBGL_lose_context") return null;
              return { loseContext: () => { addon.contextLost = true; } };
            },
          },
        },
        onContextLoss(f: () => void) { cb = f; return undefined; },
        dispose() { this.disposed = true; },
        lose() { cb?.(); },
      };
      addons.push(addon);
      return addon;
    },
    reseed,
    log: (m) => logs.push(m),
  };
  return { host, addons, logs, reseed };
}

describe("installWebgl", () => {
  it("loads a WebGL addon on install", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    expect(h.addons).toHaveLength(1);
    expect(handle.active()).toBe(true);
    expect(handle.rebuilds()).toBe(0);
  });

  it("stays on the DOM renderer when WebGL is unavailable (create throws)", () => {
    const h = harness({ failCreateFrom: 0 });
    const handle = installWebgl(h.host);
    expect(handle.active()).toBe(false);
    expect(h.reseed).not.toHaveBeenCalled(); // nothing was ever rendered by us
  });

  // The regression this module exists for: the old handler was
  // `onContextLoss(() => webgl.dispose())`, which left NO renderer attached —
  // the phone showed an all-black terminal until every tab was closed.
  it("rebuilds the renderer after a context loss instead of leaving none", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    h.addons[0].lose();
    expect(h.addons[0].disposed).toBe(true); // dead addon released...
    expect(h.addons).toHaveLength(2); // ...and a fresh one took over
    expect(handle.active()).toBe(true);
    expect(handle.rebuilds()).toBe(1);
  });

  it("reseeds history after a loss — the on-screen state is not trustworthy", () => {
    const h = harness();
    installWebgl(h.host);
    h.addons[0].lose();
    expect(h.reseed).toHaveBeenCalledTimes(1);
  });

  it("disposes the dead addon before rebuilding (releases the shared atlas)", () => {
    const h = harness();
    installWebgl(h.host);
    const order: string[] = [];
    h.addons[0].dispose = () => order.push("dispose");
    const create = h.host.create;
    h.host.create = () => { order.push("create"); return create.call(h.host); };
    h.addons[0].lose();
    expect(order).toEqual(["dispose", "create"]);
  });

  it("recovers from a SECOND loss on the rebuilt addon (re-subscribes each time)", () => {
    const h = harness();
    const handle = installWebgl(h.host, 5);
    h.addons[0].lose();
    h.addons[1].lose();
    expect(handle.rebuilds()).toBe(2);
    expect(h.addons).toHaveLength(3);
  });

  it("gives up after the rebuild budget — no infinite rebuild loop", () => {
    const h = harness();
    const handle = installWebgl(h.host, 2);
    h.addons[0].lose();
    h.addons[1].lose();
    h.addons[2].lose(); // budget spent
    expect(handle.rebuilds()).toBe(2);
    expect(h.addons).toHaveLength(3); // no 4th addon
    expect(handle.active()).toBe(false); // DOM renderer from here
    expect(h.addons[2].disposed).toBe(true);
    expect(h.reseed).toHaveBeenCalledTimes(3); // still repainted on the way down
  });

  it("falls back to the DOM renderer when the REBUILD itself throws", () => {
    const h = harness({ failCreateFrom: 1 });
    const handle = installWebgl(h.host);
    h.addons[0].lose();
    expect(handle.active()).toBe(false);
    expect(h.reseed).toHaveBeenCalledTimes(1); // repaint under the DOM renderer
    expect(h.logs.join("\n")).toContain("DOM renderer");
  });

  it("ignores a loss fired by a stale addon (no budget burn, no double rebuild)", () => {
    const h = harness();
    const handle = installWebgl(h.host, 5);
    h.addons[0].lose();
    h.addons[0].lose(); // dead addon's emitter fires again
    expect(handle.rebuilds()).toBe(1);
    expect(h.addons).toHaveLength(2);
  });

  it("ignores a loss after dispose() — never resurrects an unmounted terminal", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    handle.dispose();
    expect(h.addons[0].disposed).toBe(true);
    h.addons[0].lose();
    expect(h.addons).toHaveLength(1);
    expect(h.reseed).not.toHaveBeenCalled();
  });

  it("survives an addon whose dispose() throws", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    h.addons[0].dispose = () => { throw new Error("gl gone"); };
    expect(() => h.addons[0].lose()).not.toThrow();
    expect(handle.active()).toBe(true); // rebuild still happened
  });

  it("defaults to a small rebuild budget", () => {
    expect(MAX_WEBGL_REBUILDS).toBe(2);
  });
});

// Only the visible terminal may hold a WebGL context (docs/bug/终端显示异常2).
//
// MEASURED ROOT CAUSE, not a theory: browsers cap live WebGL contexts per page
// and force-lose the OLDEST one past the cap. Reproduced in Chrome — terminals
// 1..16 all stayed alive, and from the 17th onward exactly one older context
// died per new terminal, holding steady at 16 alive. Phones cap much lower.
//
// App.svelte mounts a live <TerminalView> per tab, so N tabs meant N live
// contexts. Past the cap the browser killed older tabs' renderers, which is why
// the corruption only ever appeared with several tabs open, why some tabs stayed
// correct while others froze mid-frame, and why closing ALL tabs was the only
// cure (it dropped the count back under the cap).
//
// It also explains why the previous fix (clearTextureAtlas on resume) did
// nothing: clearing an atlas cannot help a renderer whose GL context is already
// dead. Suspending hidden terminals keeps the live count at 1, so the cap is
// never approached and the failure cannot occur.
describe("suspend/resume for background tabs", () => {
  it("releases the GL context when the terminal is hidden", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    const addon = h.addons[0];

    handle.suspend();

    expect(addon.disposed).toBe(true);
    expect(handle.active()).toBe(false);
  });

  // Measured in Chrome against the real addon: dispose() removes the canvas but
  // NEVER calls loseContext() — `loseContext` appears nowhere in the addon
  // source — so the context survives until GC decides to run. Switching tabs
  // then leaked one live context per switch (observed climbing 1→7 across seven
  // switches) and would still reach the cap, just more slowly. The context has
  // to be given back explicitly.
  it("forcibly loses the GL context on suspend rather than waiting for GC", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    const addon = h.addons[0];

    handle.suspend();

    expect(addon.contextLost).toBe(true);
  });

  it("also releases the context when the terminal is unmounted", () => {
    // Closing a tab is the other path that must return a context immediately.
    const h = harness();
    const handle = installWebgl(h.host);
    const addon = h.addons[0];

    handle.dispose();

    expect(addon.contextLost).toBe(true);
    expect(addon.disposed).toBe(true);
  });

  it("still suspends cleanly when the lose-context extension is unavailable", () => {
    // WEBGL_lose_context is optional; a browser without it must not break tab
    // switching, it just falls back to GC timing.
    const h = harness({ noLoseExtension: true });
    const handle = installWebgl(h.host);

    expect(() => handle.suspend()).not.toThrow();
    expect(handle.active()).toBe(false);
  });

  it("takes a fresh context when the terminal is shown again", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    handle.suspend();

    handle.resume();

    expect(h.addons).toHaveLength(2);
    expect(h.addons[1].disposed).toBe(false);
    expect(handle.active()).toBe(true);
    // Must NOT reseed: the buffer lives in xterm's core and survives the addon
    // swap, so attaching repaints from it. A tmux round-trip on every tab
    // switch would be pure cost — and it would clobber the R1 stash flush,
    // which is exactly what test/terminal.test.ts caught.
    expect(h.reseed).not.toHaveBeenCalled();
  });

  // The whole point of the fix: flipping between tabs must not accumulate
  // contexts. This is the assertion that would have caught the original bug.
  it("never holds more than one context across many tab switches", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    for (let i = 0; i < 30; i++) {
      handle.suspend();
      handle.resume();
    }
    const live = h.addons.filter((a) => !a.disposed);
    expect(live).toHaveLength(1);
    expect(handle.active()).toBe(true);
  });

  it("does not burn the rebuild budget — suspending is not a failure", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    handle.suspend();
    handle.resume();
    // Budget exists to stop thrashing on a broken GPU. A deliberate suspend must
    // not consume it, or a user who switches tabs a few times would be dropped
    // onto the DOM renderer for good.
    expect(handle.rebuilds()).toBe(0);
  });

  it("is idempotent: repeated suspend/resume calls change nothing", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    handle.suspend();
    handle.suspend();
    expect(handle.active()).toBe(false);
    handle.resume();
    handle.resume();
    expect(h.addons.filter((a) => !a.disposed)).toHaveLength(1);
  });

  it("stays released after dispose, even if a late resume arrives", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    handle.dispose();

    handle.resume();

    // Resurrecting a renderer on an unmounted terminal leaks a context — the
    // exact thing this fix exists to prevent.
    expect(handle.active()).toBe(false);
    expect(h.addons.filter((a) => !a.disposed)).toHaveLength(0);
  });

  it("resume falls back to the DOM renderer when the context cannot be created", () => {
    const h = harness({ failCreateFrom: 1 });
    const handle = installWebgl(h.host);
    handle.suspend();

    handle.resume();

    // A phone under GPU pressure can refuse a new context. That must degrade to
    // the DOM renderer, not throw into the caller. No reseed here either — the
    // DOM renderer paints from the same core buffer.
    expect(handle.active()).toBe(false);
    expect(h.reseed).not.toHaveBeenCalled();
  });

  // Opening a session while several tabs are already open mounts the new
  // terminal hidden. If a hidden mount still took a context, opening a handful
  // of tabs would blow past the cap in one go — the original bug.
  it("takes no context when it starts suspended", () => {
    const h = harness();
    const handle = installWebgl(h.host, undefined, true);
    expect(h.addons).toHaveLength(0);
    expect(handle.active()).toBe(false);
  });

  it("a terminal that started suspended takes its first context on resume", () => {
    const h = harness();
    const handle = installWebgl(h.host, undefined, true);
    handle.resume();
    expect(h.addons).toHaveLength(1);
    expect(handle.active()).toBe(true);
  });

  it("a context loss while suspended does not rebuild anything", () => {
    const h = harness();
    const handle = installWebgl(h.host);
    const addon = h.addons[0];
    handle.suspend();

    addon.lose(); // dead addon's emitter can still fire

    expect(h.addons).toHaveLength(1);
    expect(handle.active()).toBe(false);
  });
});
