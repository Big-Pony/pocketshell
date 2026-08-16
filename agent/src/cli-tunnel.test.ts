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

test("funnelState reports none when tailscale has no serve config", () => {
  expect(funnelState("No serve config\n", 8722)).toBe("none");
  expect(funnelState("", 8722)).toBe("none");
  expect(funnelState("   \n", 8722)).toBe("none");
});

test("funnelState reports ours only when the config points at our port", () => {
  const out = "https://box.tailc8ab3b.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:8722\n";
  expect(funnelState(out, 8722)).toBe("ours");
  expect(funnelState(out, 9000)).toBe("elsewhere");
});

test("funnelState does not confuse 8722 with 18722", () => {
  // 子串匹配的经典陷阱：端口 8722 不能匹配到 18722 上。
  const out = "|-- / proxy http://127.0.0.1:18722\n";
  expect(funnelState(out, 8722)).toBe("elsewhere");
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
