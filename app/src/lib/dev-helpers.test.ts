import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The switch is read at module-eval time from import.meta.env, so each case
// needs a fresh module instance with the env stubbed beforehand.
async function loadWith(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) {
    vi.unstubAllEnvs();
  } else {
    vi.stubEnv("VITE_POCKETSHELL_DEV_HELPERS", value);
  }
  return await import("./dev-helpers");
}

describe("DEV_HELPERS_ENABLED", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is off when the env var is absent", async () => {
    const m = await loadWith(undefined);
    expect(m.DEV_HELPERS_ENABLED).toBe(false);
  });

  it("is off when the env var is 0", async () => {
    const m = await loadWith("0");
    expect(m.DEV_HELPERS_ENABLED).toBe(false);
  });

  it("is on only when the env var is exactly 1", async () => {
    const m = await loadWith("1");
    expect(m.DEV_HELPERS_ENABLED).toBe(true);
  });

  it("is off for any other value", async () => {
    const m = await loadWith("true");
    expect(m.DEV_HELPERS_ENABLED).toBe(false);
  });

  it("registerDevHelpers does not touch window when disabled", async () => {
    const m = await loadWith("0");
    m.registerDevHelpers({
      openFile: () => {},
      openPanel: () => {},
      sendInput: () => {},
      getState: () => ({
        status: "online",
        projectRoot: "",
        activePanel: "snip" as never,
        fileTabs: [],
        activeId: "",
      }),
      newSession: () => {},
      enterSession: () => {},
      getSessions: () => [],
      dropConnection: () => {},
    });
    expect((window as unknown as { pocketshell?: unknown }).pocketshell).toBeUndefined();
  });
});
