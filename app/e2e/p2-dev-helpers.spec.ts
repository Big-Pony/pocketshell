import { test, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

interface AgentInfo {
  keyDir: string;
  port: number;
  agentPubKey: string;
  browserIdentity: { publicKey: string; secretKey: string };
}

let agent: ReturnType<typeof spawn> | null = null;
let agentInfo: AgentInfo | null = null;

async function seedLocalStorage(page: Page, info: AgentInfo) {
  await page.addInitScript((payload: string) => {
    const info = JSON.parse(payload) as AgentInfo;
    localStorage.setItem("pocketshell.agentPubKey", info.agentPubKey);
    localStorage.setItem("pocketshell.agentAddr", `ws://127.0.0.1:${info.port}`);
    localStorage.setItem("pocketshell.identity", JSON.stringify(info.browserIdentity));
  }, JSON.stringify(info));
}

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test.beforeAll(async () => {
  const setup = spawn("bun", ["run", join(__dirname, "setup-agent.ts")], {
    cwd: join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  agent = setup;
  agentInfo = await new Promise<AgentInfo>((resolve, reject) => {
    let buf = "";
    setup.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        try { resolve(JSON.parse(line)); return; } catch {}
      }
    });
    setup.on("error", reject);
    setTimeout(() => reject(new Error("agent setup timeout")), 10_000);
  });
  await new Promise((r) => setTimeout(r, 300));
});

test.afterAll(() => { if (agent) agent.kill(); });

test.describe("P2 dev helpers", () => {
  test("dev helpers drive sessions and the connection", async ({ page }) => {
    test.setTimeout(120_000);
    expect(agentInfo).not.toBeNull();
    await seedLocalStorage(page, agentInfo!);
    await page.goto("/");
    await expect(page.locator(".conn-online .conn-dot")).toBeVisible({ timeout: 15_000 });

    // 建会话：走 dev helper，不点按钮
    await page.evaluate(() => (window as any).pocketshell.newSession("demo", "tmux"));
    await expect(page.locator(".term:not(.hidden) .xterm")).toBeVisible({ timeout: 15_000 });

    // 会话列表读得到
    const sessions = await page.evaluate(() => (window as any).pocketshell.getSessions());
    expect(sessions.map((s: { name: string }) => s.name)).toContain("demo");

    // 断连：横幅出现，且随后自动重连回 online
    await page.evaluate(() => (window as any).pocketshell.dropConnection());
    await expect(page.locator(".banner")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".conn-online .conn-dot")).toBeVisible({ timeout: 30_000 });
  });
});
