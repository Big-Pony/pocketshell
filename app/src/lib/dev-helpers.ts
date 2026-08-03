// Development-only console helpers for AI/browser automation.
// Mounted on `window.pocketshell` only when DEV_HELPERS_ENABLED is true.
// This is NOT a public API and will be disabled in production builds.
import { parsePairingString } from "./net/pairing";
import {
  applyPairing as applyPairingToStore,
  getAgentAddr,
  getAgentPubKey,
} from "./net/keystore";
import { saveProjectRoot, clearProjectRoot, loadProjectRoot } from "./ui/file-tree";
import { toB64 } from "./bytes";
import type { BottomPanel } from "./ui/shell";

// Switch: off by default so production builds ship no automation surface.
// Set VITE_POCKETSHELL_DEV_HELPERS=1 at build time to opt in — used by e2e
// runs and by anything driving the app programmatically.
export const DEV_HELPERS_ENABLED =
  import.meta.env.VITE_POCKETSHELL_DEV_HELPERS === "1";

export interface DevHelperOpts {
  openFile: (path: string, mode?: "code" | "diff") => void;
  openPanel: (panel: BottomPanel) => void;
  sendInput: (text: string) => void;
  getState: () => {
    status: string;
    projectRoot: string;
    activePanel: BottomPanel;
    fileTabs: string[];
    activeId: string;
  };
  newSession: (name: string, kind?: "tmux" | "shell") => void;
  enterSession: (name: string) => void;
  getSessions: () => Array<{ name: string; state: string }>;
  dropConnection: () => void;
}

let appHelpers: DevHelperOpts | null = null;

function ensureEnabled() {
  if (!DEV_HELPERS_ENABLED) {
    throw new Error("[pocketshell] dev helpers are disabled");
  }
}

function reload(reason: string) {
  console.log(`[pocketshell] ${reason} — reloading…`);
  location.reload();
}

function applyPairing(pairingString: string, deviceName = "AI") {
  ensureEnabled();
  const r = parsePairingString(pairingString);
  if (!r.ok) {
    console.error("[pocketshell] invalid pairing string:", r.error);
    return;
  }
  applyPairingToStore({ ...r.value, deviceName });
  reload("pairing applied");
}

function seedIdentity(opts: {
  agentPubKey: string;
  agentAddr: string;
  browserIdentity: { publicKey: string; secretKey: string };
  projectRoot?: string;
}) {
  ensureEnabled();
  localStorage.setItem("pocketshell.agentPubKey", opts.agentPubKey);
  localStorage.setItem("pocketshell.agentAddr", opts.agentAddr);
  localStorage.setItem("pocketshell.identity", JSON.stringify(opts.browserIdentity));
  if (opts.projectRoot) {
    localStorage.setItem("pocketshell.projectRoot", opts.projectRoot);
  }
  reload("identity seeded");
}

function setProjectRoot(path: string) {
  ensureEnabled();
  saveProjectRoot(path);
  reload("project root set");
}

function unsetProjectRoot() {
  ensureEnabled();
  clearProjectRoot();
  reload("project root cleared");
}

function openFile(path: string, mode: "code" | "diff" = "code") {
  ensureEnabled();
  if (!appHelpers) {
    console.error("[pocketshell] App not mounted yet");
    return;
  }
  appHelpers.openFile(path, mode);
}

function openDiff(path: string) {
  openFile(path, "diff");
}

function openPanel(panel: BottomPanel) {
  ensureEnabled();
  if (!appHelpers) {
    console.error("[pocketshell] App not mounted yet");
    return;
  }
  appHelpers.openPanel(panel);
}

function getState() {
  ensureEnabled();
  if (!appHelpers) {
    console.error("[pocketshell] App not mounted yet");
    return null;
  }
  const agentPubKey = getAgentPubKey();
  return {
    ...appHelpers.getState(),
    agentAddr: getAgentAddr(),
    agentPubKey: agentPubKey ? toB64(agentPubKey) : null,
    devHelpersEnabled: DEV_HELPERS_ENABLED,
  };
}

function newSession(name: string, kind: "tmux" | "shell" = "tmux") {
  ensureEnabled();
  if (!appHelpers) {
    console.error("[pocketshell] App not mounted yet");
    return;
  }
  appHelpers.newSession(name, kind);
}

function enterSession(name: string) {
  ensureEnabled();
  if (!appHelpers) {
    console.error("[pocketshell] App not mounted yet");
    return;
  }
  appHelpers.enterSession(name);
}

function getSessions() {
  ensureEnabled();
  if (!appHelpers) {
    console.error("[pocketshell] App not mounted yet");
    return null;
  }
  return appHelpers.getSessions();
}

function dropConnection() {
  ensureEnabled();
  if (!appHelpers) {
    console.error("[pocketshell] App not mounted yet");
    return;
  }
  appHelpers.dropConnection();
}

export function registerDevHelpers(opts: DevHelperOpts) {
  if (!DEV_HELPERS_ENABLED) return;
  appHelpers = opts;
  const api = {
    applyPairing,
    seedIdentity,
    setProjectRoot,
    unsetProjectRoot,
    openFile,
    openDiff,
    openPanel,
    sendInput: (text: string) => {
      ensureEnabled();
      appHelpers?.sendInput(text);
    },
    getState,
    newSession,
    enterSession,
    getSessions,
    dropConnection,
  };
  (window as any).pocketshell = api;
  console.log(
    "[pocketshell] dev helpers mounted on window.pocketshell:",
    Object.keys(api).join(", ")
  );
}

export function unregisterDevHelpers() {
  appHelpers = null;
  delete (window as any).pocketshell;
}
