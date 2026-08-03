// `pocketshell-agent` command-line entry, lifted verbatim out of the
// `if (import.meta.main)` block at the bottom of server.ts. server.ts now keeps
// only a thin dispatch that hands `process.argv` here.
//
// Every branch body is the original code, unchanged; the only structural change
// is that the default (boot the server) branch takes `startServer` as a
// dependency instead of calling it directly — server.ts imports this module, so
// importing back would close a cycle.
import { loadConfig, buildPairingString, resolveAdvertise, advertiseToHttp, type AgentConfig } from "./config";
import { toB64 } from "./bytes";
import { ensureTmux, realTmuxDeps } from "./ensure-tmux";
import { buildReadiness, isNonLocalBind } from "./readiness";
import { runWarmup } from "./warmup";
import { generatePairingCode, writePendingPairing } from "./pairing";
import { parseArgv, formatDeviceList, matchDevice, fingerprint } from "./cli-devices";
import { AGENT_VERSION } from "./version";
import { ensureLocalIdentity } from "./codesign-provision";
import { parseStatuslinePayload } from "./statusline-payload";
import { chainPathOf, readChain } from "./statusline-wire";

/** Just enough of startServer's shape for the boot branch (avoids an import cycle). */
export type StartServerFn = (deps: { config: AgentConfig }) => unknown;

// req 7-1: `pocketshell-agent devices|pair` CLI subcommands. Pure helpers from
// cli-devices.ts wired to loadConfig()/registry/pairing; never boots the server.
export async function runCliDevices(argv: string[]): Promise<number> {
  const action = parseArgv(argv);
  if (action.cmd === "unknown") { console.error(action.usage); return 1; }
  const cfg = loadConfig();
  if (action.cmd === "devices-list") {
    console.log(formatDeviceList(cfg.registry.list()));
    return 0;
  }
  if (action.cmd === "devices-remove") {
    const m = matchDevice(cfg.registry.list(), action.query);
    if (m.kind === "none") { console.error(`No device matching "${action.query}".`); return 1; }
    if (m.kind === "ambiguous") { console.error(`Ambiguous: ${m.matches.length} devices match "${action.query}". Use a longer fingerprint.`); return 1; }
    cfg.registry.remove(m.record.pubKey);
    console.log(`Removed ${fingerprint(m.record.pubKey)} (${m.record.name}).`);
    return 0;
  }
  // action.cmd === "pair"
  const now = Date.now();
  const code = generatePairingCode();
  writePendingPairing(cfg.keyDir, { code, expiresAt: now + 300_000, maxAttempts: 5, mintedAt: now });
  const advertise = resolveAdvertise(cfg);
  console.log(buildPairingString(cfg.identity.publicKey, advertise, code));
  console.log("\nPairing code valid for 300s. Paste the string above into the app; a running agent picks it up automatically.");
  return 0;
}

// Service install/uninstall never boots the server (same shape as the
// devices/pair branch).
export function runInstallUninstall(cliArgv: string[]): void {
  void (async () => {
    const { runInstall, runUninstall } = await import("./install-runner");
    const code = cliArgv[0] === "install" ? await runInstall(cliArgv) : await runUninstall();
    process.exit(code);
  })();
}

export function runNotifySubcommand(cliArgv: string[]): void {
  void (async () => {
    try {
      const { parseNotifyPayload } = await import("./notify-subcommand");
      let stdin = "";
      if (!process.stdin.isTTY) {
        try { stdin = await Bun.stdin.text(); } catch { /* no stdin */ }
      }
      const p = await parseNotifyPayload(process.env, cliArgv.slice(1), stdin);
      if (!p) { process.exit(0); return; }      // not a PocketShell session
      const url = process.env.POCKETSHELL_NOTIFY_URL;
      const token = process.env.POCKETSHELL_NOTIFY_TOKEN;
      if (url && token) {
        const ctl = new AbortController();
        const timeoutId = setTimeout(() => ctl.abort(), 3000);
        try {
          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({
              sessionId: p.sessionId,
              title: p.title,
              body: p.body,
              tool: p.tool,
              ctxUsed: p.ctx?.used,
              ctxTotal: p.ctx?.total,
            }),
            signal: ctl.signal,
          }).catch(() => {});
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } catch { /* never disturb the agent's normal run */ }
    process.exit(0);
  })();
}

export function runStatuslineSubcommand(): void {
  void (async () => {
    try {
      let stdin = "";
      if (!process.stdin.isTTY) {
        try { stdin = await Bun.stdin.text(); } catch { /* no stdin */ }
      }
      const payload = parseStatuslinePayload(stdin);
      if (payload) {
        // Claude Code 的 statusLine 是单值字段；我们把用户原命令链式包装后存到
        // chain 文件，运行时先跑原命令并把它的 stdout 原样打印，保证 CC 界面
        // 看起来和接线前一样。超时或失败则打印空行，绝不让状态栏挂掉。
        const chain = readChain(chainPathOf(process.env));
        if (chain?.command) {
          try {
            const proc = Bun.spawn(["/bin/sh", "-c", chain.command], {
              stdin: new TextEncoder().encode(stdin),
              stdout: "pipe",
              stderr: "ignore",
            });
            const timeoutId = setTimeout(() => { try { proc.kill(); } catch {} }, 2000);
            const stdout = await new Response(proc.stdout).text().finally(() => clearTimeout(timeoutId));
            process.stdout.write(stdout);
          } catch {
            process.stdout.write("\n");
          }
        } else {
          process.stdout.write("\n");
        }
        const url = process.env.POCKETSHELL_NOTIFY_URL;
        const token = process.env.POCKETSHELL_NOTIFY_TOKEN;
        // 上报的 sessionId 必须是 PocketShell 的会话名（tmux 会话名），
        // 不是 payload.sessionId —— 后者是 Claude Code 自己的 UUID。
        // ContextStore 按 SessionMeta.name 键控（decorate 用 s.name 查表），
        // 用 CC 的 UUID 存进去永远查不出来，分割条对 claude 恒不显示。
        const psSession = process.env.POCKETSHELL_NOTIFY_SESSION;
        if (url && token && psSession) {
          const ctl = new AbortController();
          const timeoutId = setTimeout(() => ctl.abort(), 3000);
          try {
            await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
              body: JSON.stringify({
                sessionId: psSession,
                tool: "claude",
                ctxUsed: payload.used,
                ctxTotal: payload.total,
                contextOnly: true,
              }),
              signal: ctl.signal,
            }).catch(() => {});
          } finally {
            clearTimeout(timeoutId);
          }
        }
      }
    } catch { /* never disturb the agent's normal run */ }
    process.exit(0);
  })();
}

// `pocketshell-agent --warmup`: foreground TCC warmup, then exit. TCC
// prompts from a launchd background process are not always reliable, so
// running this once in a real terminal is the dependable fallback (and the
// only way to batch the prompts ahead of first use). See warmup.ts.
export function runWarmupSubcommand(): void {
  const lines = runWarmup();
  for (const l of lines) console.log(l);
  if (lines.length === 0) console.log("[pocketshell] warmup done — no manual steps needed.");
  // Foreground-only: provisioning a self-signed codesign identity needs an
  // operator present for the Keychain trust/auth prompts (see
  // codesign-provision.ts) — never call this from the background startup
  // path. Note this exit is async (post-await), so the boot branch must live
  // in an `else` off this branch rather than falling through after it, or the
  // background agent would also boot in the same process while this awaits.
  void (async () => {
    const ok = await ensureLocalIdentity();
    console.log(ok ? "[pocketshell] signing identity present — OTA re-signs will run." : "[pocketshell] no signing identity — OTA updates will apply unsigned (see Keychain guidance above).");
    process.exit(0);
  })();
}

export function runBoot(startServer: StartServerFn): void {
  const cfg = loadConfig();
  ensureTmux(realTmuxDeps());
  const advertise = resolveAdvertise(cfg);
  const appUrl = advertiseToHttp(advertise);
  startServer({ config: cfg });
  const pairingString =
    cfg.pairingMode && cfg.pairing
      ? buildPairingString(cfg.identity.publicKey, advertise, cfg.pairing.code)
      : undefined;
  const lines = buildReadiness({
    advertise,
    appUrl,
    pubKeyB64: toB64(cfg.identity.publicKey),
    pairingString,
    pairingTtlSec: 300,
    advertiseExplicit: !!cfg.advertise,
    bindNonLocal: isNonLocalBind(cfg.listen.host),
  });
  console.log(`[pocketshell] listening on ${cfg.listen.host}:${cfg.listen.port} (TLS ${cfg.tls.enabled ? "on" : "off"})`);
  for (const l of lines) console.log(l);
  // macOS TCC warmup after boot: batch any permission prompts at startup.
  // Async + silent on failure; prints FDA guidance lines when FDA is missing.
  // Full no-op on non-darwin (see warmup.ts).
  setTimeout(() => {
    try { for (const l of runWarmup()) console.log(l); } catch { /* probes must never crash the agent */ }
  }, 0);
}

/**
 * Dispatch one CLI invocation. `argv` is the raw process.argv; subcommands are
 * matched on argv[2] and flags are searched across the whole vector, exactly as
 * the original inline block did.
 *
 * The `--warmup` branch's process.exit sits behind an await, so everything
 * after it MUST stay in the `else` chain — falling through would boot the
 * background agent inside the same process while the warmup awaits.
 */
export function runCli(argv: string[], startServer: StartServerFn): void {
  const cliArgv = argv.slice(2);
  if (cliArgv[0] === "install" || cliArgv[0] === "uninstall") {
    runInstallUninstall(cliArgv);
  } else if (cliArgv[0] === "notify") {
    runNotifySubcommand(cliArgv);
  } else if (cliArgv[0] === "statusline") {
    runStatuslineSubcommand();
  } else if (cliArgv[0] === "devices" || cliArgv[0] === "pair") {
    // CLI subcommand path never boots the server.
    void runCliDevices(cliArgv).then((code) => process.exit(code));
  } else if (argv.includes("--version")) {
    console.log(AGENT_VERSION);
    process.exit(0);
  } else if (argv.includes("--warmup")) {
    runWarmupSubcommand();
  } else {
    runBoot(startServer);
  }
}
