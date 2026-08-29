import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import type { SessionMeta } from "./lib/net/protocol";

const appControl = vi.hoisted(() => ({
  conn: null as any,
  helpers: null as any,
}));

vi.mock("./components/Terminal.svelte", async () => ({
  default: (await import("./test/AppTerminalProbe.svelte")).default,
}));
vi.mock("./components/FilePreview.svelte", async () => ({
  default: (await import("./test/AppFileProbe.svelte")).default,
}));
vi.mock("./components/TermCopyOverlay.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./components/TopTabs.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./components/TaskPanel.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./components/FilePanel.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./components/BottomBar.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./components/StatusBar.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./components/DeviceManager.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./components/Keyboard.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./components/SnippetPanel.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./components/SettingsPanel.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./components/UpdateDialog.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./components/KeyboardTutorial.svelte", async () => ({ default: (await import("./test/AppEmptyProbe.svelte")).default }));
vi.mock("./lib/dev-helpers", () => ({
  registerDevHelpers: (helpers: unknown) => { appControl.helpers = helpers; },
  unregisterDevHelpers: () => { appControl.helpers = null; },
}));
vi.mock("./lib/net/connection", () => {
  class Connection {
    detach = vi.fn();
    newSession = vi.fn();
    renameSession = vi.fn();
    kill = vi.fn();
    listSessions = vi.fn();
    sendInput = vi.fn();
    resize = vi.fn();
    sendPresence = vi.fn();
    dropConnection = vi.fn();
    rpc = vi.fn(async (method: string) => {
      if (method === "git.branches") return {};
      if (method === "git.status") return { files: [] };
      return {};
    });
    private sessionsCb: ((sessions: SessionMeta[]) => void) | null = null;

    constructor() { appControl.conn = this; }
    hasFeature() { return false; }
    listHints() { return Promise.resolve({ items: [] }); }
    agentInfo() { return Promise.resolve({ instanceName: null }); }
    checkUpdate() { return Promise.resolve({ current: "test", latest: "test", hasUpdate: false }); }
    notifyGetConfig() { return Promise.resolve({}); }
    notifySubscribe() { return Promise.resolve({}); }
    onSessions(cb: (sessions: SessionMeta[]) => void) { this.sessionsCb = cb; return () => {}; }
    emitSessions(sessions: SessionMeta[]) { this.sessionsCb?.(sessions); }
    onStatus() { return () => {}; }
    onMetrics() { return () => {}; }
    onUpdate() { return () => {}; }
    onHintsChanged() { return () => {}; }
    onExit() { return () => {}; }
    onInput() { return () => {}; }
    onSeqGap() { return () => {}; }
    onResync() { return () => {}; }
    onError() { return () => {}; }
    onNotification() { return () => {}; }
  }
  return { Connection };
});

import App from "./App.svelte";

const session = (name: string): SessionMeta => ({
  name,
  kind: "tmux",
  state: "run",
  cols: 80,
  rows: 24,
  lastLine: `${name}-output`,
  createdAt: 1,
  attached: true,
});

function saveInitialTabs(backgrounded: string[] = []) {
  localStorage.setItem("ps.openTabs", JSON.stringify({
    tabOrder: ["A", "B", "file:code:/tmp/a.ts"],
    fileTabs: [{
      kind: "file",
      id: "file:code:/tmp/a.ts",
      title: "a.ts",
      path: "/tmp/a.ts",
      mode: "code",
    }],
    activeTop: "",
    activeId: "A",
    backgrounded,
  }));
}

async function mountApp(backgrounded: string[] = []) {
  saveInitialTabs(backgrounded);
  const view = render(App);
  appControl.conn.emitSessions([session("A"), session("B")]);
  await tick();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  localStorage.clear();
  appControl.conn = null;
  appControl.helpers = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  localStorage.clear();
});

test("file-tab grace stays streaming through 1999ms and detaches at 2000ms", async () => {
  const { getByTestId } = await mountApp();
  expect(getByTestId("terminal-A")).toHaveAttribute("data-active", "true");
  expect(getByTestId("terminal-A")).toHaveAttribute("data-streaming", "true");

  appControl.helpers.openFile("/tmp/a.ts", "code");
  await tick();
  expect(getByTestId("file-/tmp/a.ts")).toHaveAttribute("data-active", "true");
  expect(getByTestId("terminal-A")).toHaveAttribute("data-active", "false");
  expect(getByTestId("terminal-A")).toHaveAttribute("data-streaming", "true");

  await vi.advanceTimersByTimeAsync(1999);
  await tick();
  expect(appControl.conn.detach).not.toHaveBeenCalled();
  expect(getByTestId("terminal-A")).toHaveAttribute("data-streaming", "true");

  await vi.advanceTimersByTimeAsync(1);
  await tick();
  expect(appControl.conn.detach).toHaveBeenCalledWith("A");
  expect(getByTestId("terminal-A")).toHaveAttribute("data-streaming", "false");
});

test("entering a background task from a file tab makes that terminal visible and streaming", async () => {
  const { getByTestId } = await mountApp(["B"]);
  appControl.helpers.openFile("/tmp/a.ts", "code");
  await tick();

  appControl.helpers.enterSession("B");
  await tick();

  expect(getByTestId("file-/tmp/a.ts")).toHaveAttribute("data-active", "false");
  expect(getByTestId("terminal-A")).toHaveAttribute("data-active", "false");
  expect(getByTestId("terminal-A")).toHaveAttribute("data-streaming", "false");
  expect(getByTestId("terminal-B")).toHaveAttribute("data-active", "true");
  expect(getByTestId("terminal-B")).toHaveAttribute("data-streaming", "true");
});

test("creating a session from a file tab makes the new terminal visible and streaming", async () => {
  const { getByTestId } = await mountApp();
  appControl.helpers.openFile("/tmp/a.ts", "code");
  await tick();

  appControl.helpers.newSession("C", "tmux");
  appControl.conn.emitSessions([session("A"), session("B"), session("C")]);
  await tick();

  expect(getByTestId("file-/tmp/a.ts")).toHaveAttribute("data-active", "false");
  expect(getByTestId("terminal-A")).toHaveAttribute("data-active", "false");
  expect(getByTestId("terminal-A")).toHaveAttribute("data-streaming", "false");
  expect(getByTestId("terminal-C")).toHaveAttribute("data-active", "true");
  expect(getByTestId("terminal-C")).toHaveAttribute("data-streaming", "true");
});
