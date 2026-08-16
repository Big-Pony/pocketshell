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
  /** 每次公网自检的 (url, forceIp)，用来断言自检确实绕开了本机 DNS。 */
  fetched: Array<{ url: string; forceIp?: string }>;
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
  const fetched: Array<{ url: string; forceIp?: string }> = [];
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
    async fetchStatus(url, forceIp) {
      fetched.push({ url, forceIp });
      return publicStatus[Math.min(publicCalls++, publicStatus.length - 1)];
    },
    async sleep() {},
    now: () => 1_755_300_000_000,
    log: (l) => out.push(l),
    error: (l) => out.push(l),
  };
  return { deps, ran, interactive, written, out, fetched };
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

test("backfill rewrites POCKETSHELL_ADVERTISE in the unit and backs the old one up", async () => {
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(0);

  const unitWrite = h.written.find((w) => w.path === PLAN.unitPath);
  expect(unitWrite).toBeDefined();
  expect(unitWrite!.text).toContain("Environment=POCKETSHELL_ADVERTISE=wss://box.tailc8ab3b.ts.net");
  expect(unitWrite!.text).not.toContain("ws://127.0.0.1:8722");
  // 其余配置一字不动。
  expect(unitWrite!.text).toContain("Environment=POCKETSHELL_PORT=8722");
  expect(unitWrite!.text).toContain("Environment=POCKETSHELL_KEY_DIR=/home/myt/.pocketshell");
});

test("backfill reloads and restarts the service", async () => {
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
    },
  });
  await runTunnelSetup(h.deps);
  expect(names(h.ran)).toContain("systemctl daemon-reload");
  expect(names(h.ran)).toContain("systemctl restart pocketshell");
});

test("backfill refuses to touch a hand-edited unit", async () => {
  // 复现不出原文 = 有人加过行 = 重写会抹掉它。宁可给手工指引。
  const edited = renderUnitFor(PLAN).replace("Restart=always", "KillMode=process\nRestart=always");
  const h = harness({
    unit: edited,
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(1);
  expect(h.written).toEqual([]);
  // 必须把该填的值直接给出来，让用户能一行手工改完。
  expect(h.out.join("\n")).toContain("POCKETSHELL_ADVERTISE=wss://box.tailc8ab3b.ts.net");
});

test("backfill does not run when the public self-check failed", async () => {
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
    },
    publicStatus: [null],
  });
  expect(await runTunnelSetup(h.deps)).toBe(1);
  expect(h.written).toEqual([]);
  expect(names(h.ran)).not.toContain("systemctl restart pocketshell");
});

test("a failed restart is reported, not glossed over", async () => {
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
      "systemctl restart": [{ code: 1 }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(1);
  expect(h.out.join("\n")).toContain("restart");
});

test("the final message hands over the public URL and the pairing string", async () => {
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
      "journalctl -u pocketshell": [{ stdout: "blah pocketshell-pair:ABCdef123 blah" }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(0);
  const out = h.out.join("\n");
  expect(out).toContain("https://box.tailc8ab3b.ts.net");
  expect(out).toContain("pocketshell-pair:ABCdef123");
});

// --- 公网自检必须绕开 MagicDNS（2026-08-17 真机回归）------------------------
// 真机上第一次跑 tunnel setup 时，Funnel 明明已经起来（外网 curl 200），自检却
// 判定「两分钟没应答」并中止回填。根因：自检从 agent 本机发起，而那台机器在
// tailnet 里，MagicDNS 把 hostname 解析成它自己的 100.113.189.97，连过去 TLS
// 当场被拒（0.077s 返回 000）。这一组测试锁住修法：先用公共 DNS 拿边缘 IP，
// 再强制连它。

test("self-check resolves through public DNS and forces the edge IP", async () => {
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
      "dig +short": [{ stdout: "208.111.34.11\n208.111.35.209\n" }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(0);
  // 查的是公共解析器，不是本机 DNS。
  const dig = h.ran.find((c) => c[0] === "dig");
  expect(dig).toBeDefined();
  expect(dig!.some((w) => w === "@1.1.1.1")).toBe(true);
  // 自检带上了边缘 IP。
  expect(h.fetched.length).toBeGreaterThan(0);
  expect(h.fetched[0]!.forceIp).toBe("208.111.34.11");
  expect(h.fetched[0]!.url).toBe("https://box.tailc8ab3b.ts.net/");
});

test("self-check discards the tailnet IP MagicDNS would hand back", async () => {
  // 若公共解析器（被劫持时）也回 100.x，那不是公网入口，必须弃用而不是拿去连。
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
      "dig +short": [{ stdout: "100.113.189.97\n" }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(0);
  expect(h.fetched.every((f) => f.forceIp !== "100.113.189.97")).toBe(true);
});

test("self-check falls back to a plain fetch when dig yields nothing", async () => {
  // 没装 dig / 公共 DNS 不可达 / 这台机器根本不在 tailnet 里 —— 都不该判失败。
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
      "dig +short": [{ code: 1, stdout: "" }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(0);
  expect(h.fetched.length).toBeGreaterThan(0);
  expect(h.fetched[0]!.forceIp).toBeUndefined();
});

test("a second edge IP is tried when the first one does not answer", async () => {
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
      "dig +short": [{ stdout: "208.111.34.11\n208.111.35.209\n" }],
    },
    publicStatus: [null, 200],
  });
  expect(await runTunnelSetup(h.deps)).toBe(0);
  expect(h.fetched.map((f) => f.forceIp)).toEqual(["208.111.34.11", "208.111.35.209"]);
});

test("backfill also writes agent.json, or `pair` hands out the wrong address", async () => {
  // 真机回归（2026-08-17）：只改 unit 时，pocketshell-agent pair 吐出的配对串
  // addr 是 ws://127.0.0.1:8722（手机去连它自己），配对必失败。unit 的
  // Environment= 只喂服务进程，pair 是独立进程读不到。
  const h = harness({
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(0);

  const json = h.written.find((w) => w.path === "/home/myt/.pocketshell/agent.json");
  expect(json).toBeDefined();
  expect(JSON.parse(json!.text).advertise).toBe("wss://box.tailc8ab3b.ts.net");

  // 两处写的必须是同一个值，否则服务与 CLI 会各说各话。
  const unit = h.written.find((w) => w.path === PLAN.unitPath)!;
  expect(unit.text).toContain("Environment=POCKETSHELL_ADVERTISE=wss://box.tailc8ab3b.ts.net");
});

test("a refused unit rewrite does not leave agent.json half-updated", async () => {
  // 手工改过的 unit 不予改写；此时 agent.json 也不能动，否则两处不一致。
  const edited = renderUnitFor(PLAN).replace("Restart=always", "KillMode=process\nRestart=always");
  const h = harness({
    unit: edited,
    responses: {
      "tailscale status": [{ stdout: STATUS_UP }],
      "tailscale funnel status": [{ stdout: FUNNEL_ON }],
    },
  });
  expect(await runTunnelSetup(h.deps)).toBe(1);
  expect(h.written).toEqual([]);
});
