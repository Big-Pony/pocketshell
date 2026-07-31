// Claude Code statusLine 的幂等接线。与 notify-wire.ts 同款契约：只碰我们
// 自己那一项，失败返回结构化 {ok:false, reason, detail}，绝不静默。
//
// 与通知接线的关键差异：hooks.Notification 是数组，追加即可共存；
// statusLine 是单值对象，直接覆盖会毁掉用户已有的状态栏。因此这里做
// 链式包装 —— 把用户原来的配置整条存进 chain 文件，我们的子命令运行时
// 先跑原命令、把它的 stdout 原样打印出去（见 server.ts 的 statusline 分支）。
// 对用户来说 CC 界面零变化。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { WireResult } from "./notify-wire";

const statuslineCmd = (agentBin: string) => `${agentBin} statusline`;

/** 用户原有的 statusLine 配置。command 必有，其余字段原样保留以便还原。 */
export interface ChainRecord {
  command: string;
  type?: string;
  padding?: number;
  [k: string]: unknown;
}

export function readChain(chainPath: string): ChainRecord | null {
  if (!existsSync(chainPath)) return null;
  try {
    const j = JSON.parse(readFileSync(chainPath, "utf8"));
    return typeof j?.command === "string" ? j : null;
  } catch { return null; }
}

export function wireStatusline(settingsPath: string, chainPath: string, agentBin: string): WireResult {
  let root: any = {};
  if (existsSync(settingsPath)) {
    try { root = JSON.parse(readFileSync(settingsPath, "utf8")); }
    catch (e) { return { ok: false, reason: "parse_error", detail: String(e) }; }
  }
  const ours = statuslineCmd(agentBin);
  const cur = root.statusLine;

  // 幂等的要害在这个判断：已经是我们的就绝不再存 chain，否则重复接线会把
  // 我们自己存成「用户原命令」，解除接线时还原出一个指向自己的死循环。
  if (cur && typeof cur.command === "string" && cur.command !== ours) {
    try {
      mkdirSync(dirname(chainPath), { recursive: true });
      writeFileSync(chainPath, JSON.stringify(cur, null, 2), { mode: 0o600 });
    } catch (e) { return { ok: false, reason: "write_error", detail: String(e) }; }
  }

  root.statusLine = { type: "command", command: ours };
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(root, null, 2));
  } catch (e) { return { ok: false, reason: "write_error", detail: String(e) }; }
  return { ok: true };
}

export function unwireStatusline(settingsPath: string, chainPath: string, agentBin: string): WireResult {
  if (!existsSync(settingsPath)) return { ok: true };
  let root: any;
  try { root = JSON.parse(readFileSync(settingsPath, "utf8")); }
  catch (e) { return { ok: false, reason: "parse_error", detail: String(e) }; }

  const ours = statuslineCmd(agentBin);
  // 用户后来自己改成了别的：那是他的选择，不要动。只清理我们的 chain。
  if (root.statusLine?.command === ours) {
    const chain = readChain(chainPath);
    if (chain) root.statusLine = chain;
    else delete root.statusLine;
  }

  try {
    writeFileSync(settingsPath, JSON.stringify(root, null, 2));
    rmSync(chainPath, { force: true });
  } catch (e) { return { ok: false, reason: "write_error", detail: String(e) }; }
  return { ok: true };
}

// chain 文件的位置。刻意不走 loadConfig() —— 它会加载设备注册表甚至铸
// 密钥，而 statusline 子命令是 CC 每次刷新状态栏都要跑的，扛不起那个开销。
// 这里逐字复刻 config.ts 里 keyDir 的解析规则（env 优先，否则 ~/.pocketshell）。
export function chainPathOf(env: Record<string, string | undefined>): string {
  const keyDir = env.POCKETSHELL_KEY_DIR ?? join(homedir(), ".pocketshell");
  return join(keyDir, "statusline-chain.json");
}
