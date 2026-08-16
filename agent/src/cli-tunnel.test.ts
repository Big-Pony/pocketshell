import { test, expect } from "bun:test";
import {
  parseTunnelArgv, dnsNameFromStatus, advertiseFromDnsName,
  funnelState, originFromEnv, TUNNEL_USAGE,
} from "./cli-tunnel";

test("parseTunnelArgv accepts `tunnel setup`", () => {
  expect(parseTunnelArgv(["tunnel", "setup"])).toEqual({ cmd: "setup" });
});

test("parseTunnelArgv rejects unknown subcommands and bare `tunnel`", () => {
  const bare = parseTunnelArgv(["tunnel"]);
  expect(bare.cmd).toBe("error");
  expect((bare as { message: string }).message).toBe(TUNNEL_USAGE);
  const bogus = parseTunnelArgv(["tunnel", "teardown"]);
  expect(bogus.cmd).toBe("error");
  expect((bogus as { message: string }).message).toContain("teardown");
});

test("parseTunnelArgv rejects trailing arguments", () => {
  // setup 不接受任何参数：hostname 由 tailnet 决定，端口固定 443。
  const r = parseTunnelArgv(["tunnel", "setup", "--hostname", "x.example"]);
  expect(r.cmd).toBe("error");
  expect((r as { message: string }).message).toContain("--hostname");
});

test("dnsNameFromStatus reads Self.DNSName", () => {
  const json = JSON.stringify({ Self: { DNSName: "box.tailc8ab3b.ts.net." } });
  expect(dnsNameFromStatus(json)).toBe("box.tailc8ab3b.ts.net.");
});

test("dnsNameFromStatus survives every malformed shape", () => {
  expect(dnsNameFromStatus("")).toBeNull();
  expect(dnsNameFromStatus("not json")).toBeNull();
  expect(dnsNameFromStatus("{}")).toBeNull();
  expect(dnsNameFromStatus(JSON.stringify({ Self: null }))).toBeNull();
  expect(dnsNameFromStatus(JSON.stringify({ Self: {} }))).toBeNull();
  // 未登录时 tailscale 会给出一个 DNSName 为空串的 Self。
  expect(dnsNameFromStatus(JSON.stringify({ Self: { DNSName: "" } }))).toBeNull();
  expect(dnsNameFromStatus(JSON.stringify({ Self: { DNSName: "." } }))).toBeNull();
  expect(dnsNameFromStatus(JSON.stringify({ Self: { DNSName: 42 } }))).toBeNull();
});

test("advertiseFromDnsName strips the trailing dot and yields wss://", () => {
  expect(advertiseFromDnsName("box.tailc8ab3b.ts.net.")).toBe("wss://box.tailc8ab3b.ts.net");
  expect(advertiseFromDnsName("box.tailc8ab3b.ts.net")).toBe("wss://box.tailc8ab3b.ts.net");
});

test("advertiseFromDnsName refuses empty or dot-only input", () => {
  expect(advertiseFromDnsName("")).toBeNull();
  expect(advertiseFromDnsName(".")).toBeNull();
  expect(advertiseFromDnsName("  ")).toBeNull();
});

const ORIGIN = "http://127.0.0.1:8722";

test("funnelState reports none when tailscale has no serve config", () => {
  expect(funnelState("No serve config\n", ORIGIN)).toBe("none");
  expect(funnelState("", ORIGIN)).toBe("none");
  expect(funnelState("   \n", ORIGIN)).toBe("none");
});

test("funnelState reports ours only when the config points at our origin", () => {
  const out = "https://box.tailc8ab3b.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:8722\n";
  expect(funnelState(out, ORIGIN)).toBe("ours");
  expect(funnelState(out, "http://127.0.0.1:9000")).toBe("elsewhere");
});

test("funnelState does not confuse 8722 with 18722", () => {
  // 子串匹配的经典陷阱：端口 8722 不能匹配到 18722 上。
  const out = "|-- / proxy http://127.0.0.1:18722\n";
  expect(funnelState(out, ORIGIN)).toBe("elsewhere");
});

test("funnelState matches a non-loopback bind (matching on port alone would not)", () => {
  // 回归：早先版本只匹配 127.0.0.1:<port>，用户若 --host 192.168.1.5，
  // funnel 明明已配好却被判成 elsewhere，setup 轮询到超时后误报失败。
  const out = "|-- / proxy http://192.168.1.5:8722\n";
  expect(funnelState(out, "http://192.168.1.5:8722")).toBe("ours");
  expect(funnelState(out, ORIGIN)).toBe("elsewhere");
});

test("originFromEnv builds the loopback origin from the unit's env", () => {
  const r = originFromEnv({ POCKETSHELL_HOST: "127.0.0.1", POCKETSHELL_PORT: "8722" });
  expect(r).toEqual({ ok: true, url: "http://127.0.0.1:8722", port: 8722 });
});

test("originFromEnv defaults to 127.0.0.1:8722 when the unit says nothing", () => {
  expect(originFromEnv({})).toEqual({ ok: true, url: "http://127.0.0.1:8722", port: 8722 });
});

test("originFromEnv honours a non-default port (v1 hardcoded 8722 and pointed the tunnel at nothing)", () => {
  const r = originFromEnv({ POCKETSHELL_PORT: "9000" });
  expect(r).toEqual({ ok: true, url: "http://127.0.0.1:9000", port: 9000 });
});

test("originFromEnv rewrites wildcard binds to a connectable address", () => {
  expect(originFromEnv({ POCKETSHELL_HOST: "0.0.0.0" })).toEqual({ ok: true, url: "http://127.0.0.1:8722", port: 8722 });
  expect(originFromEnv({ POCKETSHELL_HOST: "::" })).toEqual({ ok: true, url: "http://127.0.0.1:8722", port: 8722 });
});

test("originFromEnv refuses POCKETSHELL_TLS=1", () => {
  const r = originFromEnv({ POCKETSHELL_TLS: "1" });
  expect(r.ok).toBe(false);
  expect((r as { message: string }).message).toContain("POCKETSHELL_TLS");
});

test("originFromEnv rejects a nonsense port", () => {
  for (const port of ["0", "70000", "abc", "-1", "80.5"]) {
    const r = originFromEnv({ POCKETSHELL_PORT: port });
    expect(r.ok).toBe(false);
  }
});

import { renderUnitFor, planFromUnit, planWithAdvertise, canSafelyRewrite } from "./cli-tunnel";
import { renderSystemdUnit, renderLaunchdPlist, type InstallPlan } from "./cli-install";

function linuxPlan(): InstallPlan {
  return {
    platform: "linux",
    user: "myt",
    home: "/home/myt",
    keyDir: "/home/myt/.pocketshell",
    binPath: "/opt/pocketshell/pocketshell-agent",
    binOwner: "myt",
    symlinkPath: "/usr/local/bin/pocketshell-agent",
    unitPath: "/etc/systemd/system/pocketshell.service",
    label: "pocketshell",
    env: {
      POCKETSHELL_HOST: "127.0.0.1",
      POCKETSHELL_PORT: "8722",
      POCKETSHELL_ADVERTISE: "ws://127.0.0.1:8722",
      POCKETSHELL_KEY_DIR: "/home/myt/.pocketshell",
    },
  };
}

function darwinPlan(): InstallPlan {
  return {
    platform: "darwin",
    user: "myt",
    home: "/Users/myt",
    keyDir: "/Users/myt/.pocketshell",
    binPath: "/Users/myt/.local/bin/pocketshell-agent",
    unitPath: "/Users/myt/Library/LaunchAgents/com.pocketshell.agent.plist",
    label: "com.pocketshell.agent",
    logPath: "/Users/myt/Library/Logs/pocketshell.out.log",
    tmuxDir: "/opt/homebrew/bin",
    env: {
      POCKETSHELL_HOST: "127.0.0.1",
      POCKETSHELL_PORT: "8722",
      POCKETSHELL_ADVERTISE: "ws://127.0.0.1:8722",
      POCKETSHELL_KEY_DIR: "/Users/myt/.pocketshell",
    },
  };
}

test("renderUnitFor dispatches on platform", () => {
  expect(renderUnitFor(linuxPlan())).toBe(renderSystemdUnit(linuxPlan()));
  expect(renderUnitFor(darwinPlan())).toBe(renderLaunchdPlist(darwinPlan()));
});

test("systemd unit round-trips byte-for-byte", () => {
  const plan = linuxPlan();
  const text = renderUnitFor(plan);
  const back = planFromUnit(text, plan.unitPath, "linux");
  expect(back).not.toBeNull();
  expect(renderUnitFor(back!)).toBe(text);
});

test("launchd plist round-trips byte-for-byte", () => {
  const plan = darwinPlan();
  const text = renderUnitFor(plan);
  const back = planFromUnit(text, plan.unitPath, "darwin");
  expect(back).not.toBeNull();
  expect(renderUnitFor(back!)).toBe(text);
});

test("round-trip survives an instance name with CJK and XML-hostile characters", () => {
  // 中文实例名是既有能力（cli-install.test.ts 用 --name 开发 覆盖过）；
  // & < > 会被 xmlEscape 改写，反解必须还原回来。
  const plan = darwinPlan();
  plan.env.POCKETSHELL_INSTANCE_NAME = "开发 & <家里>";
  const text = renderUnitFor(plan);
  const back = planFromUnit(text, plan.unitPath, "darwin");
  expect(back!.env.POCKETSHELL_INSTANCE_NAME).toBe("开发 & <家里>");
  expect(renderUnitFor(back!)).toBe(text);
});

test("planFromUnit recovers the fields the renderers actually consume", () => {
  const plan = linuxPlan();
  const back = planFromUnit(renderUnitFor(plan), plan.unitPath, "linux")!;
  expect(back.user).toBe("myt");
  expect(back.home).toBe("/home/myt");
  expect(back.binPath).toBe("/opt/pocketshell/pocketshell-agent");
  expect(back.env.POCKETSHELL_PORT).toBe("8722");
});

test("planFromUnit recovers tmuxDir out of the plist PATH", () => {
  const plan = darwinPlan();
  const back = planFromUnit(renderUnitFor(plan), plan.unitPath, "darwin")!;
  expect(back.tmuxDir).toBe("/opt/homebrew/bin");
  expect(back.logPath).toBe("/Users/myt/Library/Logs/pocketshell.out.log");
  // PATH 由渲染器从 tmuxDir 合成，不能混进 env，否则会被渲染成一条 Environment= 行。
  expect(back.env.PATH).toBeUndefined();
});

test("planFromUnit returns null on junk", () => {
  expect(planFromUnit("", "/x", "linux")).toBeNull();
  expect(planFromUnit("[Unit]\nDescription=nope\n", "/x", "linux")).toBeNull();
  expect(planFromUnit("<plist></plist>", "/x", "darwin")).toBeNull();
});

test("planWithAdvertise replaces only POCKETSHELL_ADVERTISE", () => {
  const next = planWithAdvertise(linuxPlan(), "wss://box.tailc8ab3b.ts.net");
  expect(next.env.POCKETSHELL_ADVERTISE).toBe("wss://box.tailc8ab3b.ts.net");
  expect(next.env.POCKETSHELL_PORT).toBe("8722");
  expect(next.env.POCKETSHELL_KEY_DIR).toBe("/home/myt/.pocketshell");
  // 不可变：原 plan 不受影响。
  expect(linuxPlan().env.POCKETSHELL_ADVERTISE).toBe("ws://127.0.0.1:8722");
});

test("canSafelyRewrite says yes for a unit we wrote", () => {
  const plan = linuxPlan();
  expect(canSafelyRewrite(renderUnitFor(plan), plan)).toBe(true);
});

test("canSafelyRewrite says no for a hand-edited unit", () => {
  // 有人加了一行 KillMode=process：我们的渲染器复现不出这一行，重写会把它抹掉。
  // 宁可拒绝改写并给手工指引，也不悄悄吃掉别人的编辑。
  const plan = linuxPlan();
  const edited = renderUnitFor(plan).replace("Restart=always", "KillMode=process\nRestart=always");
  expect(canSafelyRewrite(edited, plan)).toBe(false);
});
