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

async function newSession(page: Page, name: string) {
  await page.locator('button:has-text("＋")').first().click();
  const input = page.locator('input[placeholder], .tabs-wrap input').first();
  await input.fill(name);
  await input.press("Enter");
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

test.describe("P1 quick-ops + swipe", () => {
  test("swipe switches top tabs, clamped at edges", async ({ page }) => {
    test.setTimeout(120_000);
    expect(agentInfo).not.toBeNull();
    await seedLocalStorage(page, agentInfo!);
    await page.goto("/");
    await expect(page.locator(".conn-dot.online")).toBeVisible({ timeout: 15_000 });

    await newSession(page, "one");
    await newSession(page, "two");
    // Two sessions exist; "two" is active.
    const top = page.locator(".top");
    const box = (await top.boundingBox())!;
    const midY = box.y + box.height / 2;

    // Swipe right (finger left -> right) -> previous tab ("one").
    await page.mouse.move(box.x + box.width * 0.2, midY);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, midY, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator(".tab.active", { hasText: "one" }).first()).toBeVisible({ timeout: 5_000 });

    // Swipe right again at left edge -> stays on "one" (no wrap).
    await page.mouse.move(box.x + box.width * 0.2, midY);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, midY, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator(".tab.active", { hasText: "one" }).first()).toBeVisible();
  });

  test("ops sub-tab: selection mode lifecycle + highlight", async ({ page }) => {
    test.setTimeout(120_000);
    await seedLocalStorage(page, agentInfo!);
    await page.goto("/");
    await expect(page.locator(".conn-dot.online")).toBeVisible({ timeout: 15_000 });
    await newSession(page, "sel");
    // Wait for terminal to render some content.
    await expect(page.locator(".term:not(.hidden) .xterm")).toBeVisible({ timeout: 10_000 });

    // Use the IME sub-tab to print a line of output, so there is non-empty text to select.
    await page.locator('button:has-text("⌨")').first().click();
    await page.locator('button:has-text("✎ 输入法缓冲")').click();
    await page.locator(".ime textarea").fill("printf 'hello world\\n'");
    await page.locator("button:has-text('发送到终端')").click();
    await expect(page.locator(".term:not(.hidden) .xterm-rows")).toContainText("hello world", { timeout: 10_000 });

    // Open ops sub-tab and start selection.
    await page.locator('button:has-text("✂ 快捷操作")').click();
    await expect(page.locator(".ops-mode")).toContainText("点「选区」");
    await page.getByRole("button", { name: "选区", exact: true }).click();
    await expect(page.locator(".ops-mode")).toContainText("选区中");
    await expect(page.getByRole("button", { name: "取消", exact: true })).toBeVisible();

    // Move the selection focus up onto the output line -> xterm renders selection.
    await page.locator(".dpad .key", { hasText: "↑" }).click();
    await expect(page.locator(".term:not(.hidden) .xterm-selection div").first()).toBeVisible({ timeout: 5_000 });

    // Copy selection (clipboard permission granted; just assert no crash + toast).
    await page.getByRole("button", { name: "复制选区", exact: true }).click();
    // After copy, selection resets back to idle label.
    await expect(page.locator(".ops-mode")).toContainText("点「选区」", { timeout: 5_000 });
  });

  test("ops sub-tab: 上一行 enters line-hop mode and highlights whole lines", async ({ page }) => {
    test.setTimeout(120_000);
    await seedLocalStorage(page, agentInfo!);
    await page.goto("/");
    await expect(page.locator(".conn-dot.online")).toBeVisible({ timeout: 15_000 });
    await newSession(page, "hist");
    await expect(page.locator(".term:not(.hidden) .xterm")).toBeVisible({ timeout: 10_000 });

    // Print a few output lines so there is history to hop through.
    await page.locator('button:has-text("⌨")').first().click();
    await page.locator('button:has-text("✎ 输入法缓冲")').click();
    await page.locator(".ime textarea").fill("seq 40");
    await page.locator("button:has-text('发送到终端')").click();
    await expect(page.locator(".term:not(.hidden) .xterm-rows")).toContainText("40", { timeout: 10_000 });

    // 上一行 enters whole-line ("选行") mode without a prior 选区 toggle.
    await page.locator('button:has-text("✂ 快捷操作")').click();
    await page.getByRole("button", { name: "上一行", exact: true }).click();
    await expect(page.locator(".ops-mode")).toContainText("选行中");
    await expect(page.locator(".term:not(.hidden) .xterm-selection div").first()).toBeVisible({ timeout: 5_000 });

    // A second hop accumulates another line.
    await page.getByRole("button", { name: "上一行", exact: true }).click();
    await expect(page.locator(".ops-mode")).toContainText("2 行");

    // Copy resets back to idle.
    await page.getByRole("button", { name: "复制选区", exact: true }).click();
    await expect(page.locator(".ops-mode")).toContainText("点「选区」", { timeout: 5_000 });
  });
});
