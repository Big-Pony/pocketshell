// Idempotent auto-wiring of each tool's hook config. Only ever adds/removes our
// own marked entry (command === "<agentBin> notify"); never touches the user's
// other hooks. Every failure returns a structured {ok:false, reason, detail}
// the UI surfaces — no silent failure.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface WireResult { ok: boolean; reason?: string; detail?: string; }
const notifyCmd = (agentBin: string) => `${agentBin} notify`;

export function wireClaude(settingsPath: string, agentBin: string): WireResult {
  let root: any = {};
  if (existsSync(settingsPath)) {
    try { root = JSON.parse(readFileSync(settingsPath, "utf8")); }
    catch (e) { return { ok: false, reason: "parse_error", detail: String(e) }; }
  }
  const cmd = notifyCmd(agentBin);
  root.hooks ??= {};
  const list: any[] = Array.isArray(root.hooks.Notification) ? root.hooks.Notification : (root.hooks.Notification = []);
  const already = list.some((e) => Array.isArray(e.hooks) && e.hooks.some((h: any) => h.command === cmd));
  if (!already) list.push({ matcher: "", hooks: [{ type: "command", command: cmd }] });
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(root, null, 2));
  } catch (e) { return { ok: false, reason: "write_error", detail: String(e) }; }
  return { ok: true };
}

export function unwireClaude(settingsPath: string): WireResult {
  if (!existsSync(settingsPath)) return { ok: true };
  let root: any;
  try { root = JSON.parse(readFileSync(settingsPath, "utf8")); }
  catch (e) { return { ok: false, reason: "parse_error", detail: String(e) }; }
  const list: any[] = root?.hooks?.Notification;
  if (Array.isArray(list)) {
    root.hooks.Notification = list
      .map((e) => (Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter((h: any) => !String(h.command ?? "").endsWith(" notify")) } : e))
      .filter((e) => !Array.isArray(e.hooks) || e.hooks.length > 0);
  }
  try { writeFileSync(settingsPath, JSON.stringify(root, null, 2)); }
  catch (e) { return { ok: false, reason: "write_error", detail: String(e) }; }
  return { ok: true };
}
