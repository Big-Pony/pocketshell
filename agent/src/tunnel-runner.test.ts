import { test, expect } from "bun:test";
import { runTunnelSetup, unitPathFor, type TunnelDeps } from "./tunnel-runner";
import { renderUnitFor } from "./cli-tunnel";
import type { InstallPlan } from "./cli-install";

const PLAN: InstallPlan = {
  platform: "linux", user: "myt", home: "/home/myt",
  keyDir: "/home/myt/.pocketshell",
  binPath: "/opt/pocketshell/pocketshell-agent",
  binOwner: "myt", symlinkPath: "/usr/local/bin/pocketshell-agent",
  unitPath: "/etc/systemd/system/pocketshell.service",
  label: "pocketshell",
  env: {
    POCKETSHELL_HOST: "127.0.0.1", POCKETSHELL_PORT: "8722",
    POCKETSHELL_ADVERTISE: "ws://127.0.0.1:8722",
    POCKETSHELL_KEY_DIR: "/home/myt/.pocketshell",
  },
};

const STATUS_UP = JSON.stringify({ Self: { DNSName: "box.tailc8ab3b.ts.net." } });
const STATUS_DOWN = JSON.stringify({ Self: { DNSName: "" } });
const FUNNEL_ON = "https://box.tailc8ab3b.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:8722\n";

interface Harness {
  deps: TunnelDeps;
  ran: string[][];
  interactive: string[][];
  written: Array<{ path: string; text: string }>;
  out: string[];
}

/** 假 spawn：按 argv 前缀查表；每个键可给一串响应，按调用次序消费，用尽则重复最后一个。 */
function harness(over: {
  unit?: string | null;
  responses?: Record<string, Array<{ code?: number; stdout?: string }>>;
  publicStatus?: Array<number | null>;
  platform?: string;
  euid?: number;
  isTTY?: boolean;
} = {}): Harness {
  const ran: string[][] = [];
  const interactive: string[][] = [];
  const written: Array<{ path: string; text: string }> = [];
  const out: string[] = [];
  const counters: Record<string, number> = {};
  const responses = over.responses ?? {};
  const publicStatus = over.publicStatus ?? [200];
  let publicCalls = 0;

  const lookup = (argv: string[]) => {
    const key = argv.slice(0, 3).join(" ");
    for (const k of Object.keys(responses)) {
      if (key.startsWith(k)) {
        const list = responses[k];
        const n = counters[k] ?? 0;
        counters[k] = n + 1;
        return list[Math.min(n, list.length - 1)];
      }
    }
    return undefined;
  };

  const deps: TunnelDeps = {
    platform: over.platform ?? "linux",
    euid: over.euid ?? 0,
    isTTY: over.isTTY ?? true,
    env: { HOME: "/home/myt" },
    async run(argv) {
      ran.push(argv);
      const r = lookup(argv) ?? { code: 0, stdout: "" };
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: "" };
    },
    async runInteractive(argv) {
      interactive.push(argv);
      const r = lookup(argv) ?? { code: 0 };
      return { code: r.code ?? 0 };
    },
    readFile: (p) => (p.endsWith(".service") ? (over.unit === undefined ? renderUnitFor(PLAN) : over.unit) : null),
    writeFile: (path, text) => { written.push({ path, text }); },
    copyFile: () => {},
    async fetchStatus() { return publicStatus[Math.min(publicCalls++, publicStatus.length - 1)]; },
    async sleep() {},
    now: () => 1_755_300_000_000,
    log: (l) => out.push(l),
    error: (l) => out.push(l),
  };
  return { deps, ran, interactive, written, out };
}

const names = (calls: string[][]) => calls.map((c) => c.join(" "));

test("unitPathFor knows both service managers", () => {
  expect(unitPathFor("linux", "/home/myt")).toBe("/etc/systemd/system/pocketshell.service");
  expect(unitPathFor("darwin", "/Users/myt"))
    .toBe("/Users/myt/Library/LaunchAgents/com.pocketshell.agent.plist");
  expect(unitPathFor("freebsd", "/home/myt")).toBeNull();
});

test("happy path: probes, enables funnel against the real port, verifies publicly", async () => {
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: "No serve config" }, { stdout: FUNNEL_ON }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(0);
  expect(names(h.interactive).some((c) => c.includes("funnel --bg"))).toBe(true);
  expect(names(h.interactive).some((c) => c.includes("http://127.0.0.1:8722"))).toBe(true);
});

test("no unit installed -> tells the user to run install first, touches nothing", async () => {
  const h = harness({ unit: null });
  expect(await runTunnelSetup(h.deps)).toBe(1);
  expect(h.out.join("\n")).toContain("install");
  expect(h.ran).toEqual([]);
  expect(h.interactive).toEqual([]);
});

test("linux without root -> refuses before doing anything", async () => {
  const h = harness({ euid: 1000 });
  expect(await runTunnelSetup(h.deps)).toBe(1);
  expect(h.out.join("\n")).toContain("sudo");
  expect(h.ran).toEqual([]);
});

test("POCKETSHELL_TLS=1 -> aborts before any spawn", async () => {
  const tlsPlan = { ...PLAN, env: { ...PLAN.env, POCKETSHELL_TLS: "1" } };
  const h = harness({ unit: renderUnitFor(tlsPlan) });
  expect(await runTunnelSetup(h.deps)).toBe(1);
  expect(h.out.join("\n")).toContain("POCKETSHELL_TLS");
  expect(h.ran).toEqual([]);
});

test("missing tmux -> points at install, never reaches tailscale", async () => {
  const h = harness({ responses: { "tmux -V": [{ code: 1 }] } });
  expect(await runTunnelSetup(h.deps)).toBe(1);
  expect(names(h.ran).some((c) => c.startsWith("tailscale"))).toBe(false);
});

test("no TTY -> never spawns an installer", async () => {
  const h = harness({ isTTY: false, responses: { "tailscale version": [{ code: 1 }] } });
  expect(await runTunnelSetup(h.deps)).toBe(1);
  expect(names(h.ran).some((c) => c.startsWith("curl") || c.startsWith("sh "))).toBe(false);
});

test("tailscale up exits 0 but DNSName stays empty -> does NOT proceed to funnel", async () => {
  // spec §5 的核心：退出码不作数，只看探测到的状态。
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_DOWN }],
      "tailscale up": [{ code: 0 }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(1);
  expect(names(h.interactive).some((c) => c.includes("funnel"))).toBe(false);
});

test("funnel exits 0 but the config never appears -> stops, prints the raw output", async () => {
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: "No serve config" }],
      "tailscale funnel --bg": [{ code: 0 }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(1);
  expect(h.out.join("\n")).toContain("No serve config");
});

test("funnel already points at our port -> skips the interactive enable step", async () => {
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(0);
  expect(names(h.interactive).some((c) => c.includes("funnel --bg"))).toBe(false);
});

test("public self-check never returns 200 -> fails instead of claiming success", async () => {
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
    },
    publicStatus: [null],
  });
  expect(await runTunnelSetup(h.deps)).toBe(1);
});

test("public self-check tolerates a slow certificate, then succeeds", async () => {
  // 首次签发实测 60s+，前几次拿不到不算失败。
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
    },
    publicStatus: [null, null, 200],
  });
  expect(await runTunnelSetup(h.deps)).toBe(0);
});

test("authorization steps go through runInteractive, never the capturing runner", async () => {
  // 授权 URL 必须实时透传：缓冲到子进程结束等于让用户对着黑屏等一个
  // 正在等他点链接的进程（2026-08-16 实测踩中三次）。
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_DOWN }, { stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: "No serve config" }, { stdout: FUNNEL_ON }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(0);
  expect(names(h.interactive)).toContain("tailscale up");
  expect(names(h.ran)).not.toContain("tailscale up");
});
