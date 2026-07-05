// Development-only console helpers for AI/browser automation.
// Mounted on `window.pocketshell` only when DEV_HELPERS_ENABLED is true.
// This is NOT a public API and will be disabled in production builds.
import { parsePairingString } from "./pairing";
import {
  applyPairing as applyPairingToStore,
  getAgentAddr,
  getAgentPubKey,
} from "./keystore";
import { saveProjectRoot, clearProjectRoot, loadProjectRoot } from "./file-tree";
import { toB64 } from "./bytes";
import type { BottomPanel } from "./shell";

// Switch: currently default-enabled for the testing phase.
// Set VITE_POCKETSHELL_DEV_HELPERS=0 at build time to strip/disable.
export const DEV_HELPERS_ENABLED =
  import.meta.env.DEV && import.meta.env.VITE_POCKETSHELL_DEV_HELPERS !== "0";

export interface DevHelperOpts {
  openFile: (path: string, mode?: "code" | "diff") => void;
  openPanel: (panel: BottomPanel) => void;
  getState: () => {
    status: string;
    projectRoot: string;
    activePanel: BottomPanel;
    fileTabs: string[];
    activeId: string;
  };
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
    getState,
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
