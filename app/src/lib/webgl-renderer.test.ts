import { describe, it, expect, vi } from "vitest";
import { installWebgl, MAX_WEBGL_REBUILDS, type WebglAddonLike, type WebglHost } from "./webgl-renderer";

// Fake addon + host. Each create() hands back a fresh addon carrying its own
// loss emitter, exactly like the real WebglAddon — the recovery code must
// re-subscribe on every rebuild or the second loss goes unheard.
function harness(opts: { failCreateFrom?: number } = {}) {
  const addons: Array<WebglAddonLike & { lose(): void; disposed: boolean }> = [];
  const logs: string[] = [];
  const reseed = vi.fn();
  const host: WebglHost = {
    create() {
      if (opts.failCreateFrom !== undefined && addons.length >= opts.failCreateFrom) {
        throw new Error("WebGL2 not supported");
      }
      let cb: (() => void) | undefined;
      const addon = {
        disposed: false,
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
