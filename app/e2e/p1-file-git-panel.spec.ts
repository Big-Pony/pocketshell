import { test, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

interface AgentInfo {
  keyDir: string;
  port: number;
  agentPubKey: string;
  browserIdentity: { publicKey: string; secretKey: string };
}

let agent: ReturnType<typeof spawn> | null = null;
let agentInfo: AgentInfo | null = null;
let testFsRoot: string;

async function seedLocalStorage(page: Page, info: AgentInfo, projectRoot?: string) {
  await page.addInitScript((payload: string) => {
    const { info, projectRoot } = JSON.parse(payload) as { info: AgentInfo; projectRoot?: string };
    localStorage.setItem("pocketshell.agentPubKey", info.agentPubKey);
    localStorage.setItem("pocketshell.agentAddr", `ws://127.0.0.1:${info.port}`);
    localStorage.setItem("pocketshell.identity", JSON.stringify(info.browserIdentity));
    if (projectRoot) localStorage.setItem("pocketshell.projectRoot", projectRoot);
  }, JSON.stringify({ info, projectRoot }));
}

test.beforeAll(async () => {
  testFsRoot = mkdtempSync(join(tmpdir(), "ps-p1-fs-"));
  const { execSync } = await import("node:child_process");
  execSync("git init -q", { cwd: testFsRoot });
  execSync("git config user.email t@t && git config user.name T", { cwd: testFsRoot });
  mkdirSync(join(testFsRoot, "src"));
  writeFileSync(join(testFsRoot, "src", "app.ts"), "const x = 1;\n");
  writeFileSync(join(testFsRoot, "readme.md"), "# hello\n");
  execSync("git add . && git commit -q -m init", { cwd: testFsRoot });
  writeFileSync(join(testFsRoot, "src", "app.ts"), "const x = 2;\n");
  writeFileSync(join(testFsRoot, "new.txt"), "new\n");

  const setup = spawn("bun", ["run", join(__dirname, "setup-agent.ts")], {
    cwd: join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  agent = setup;
  agentInfo = await new Promise<AgentInfo>((resolve, reject) => {
    let buf = "";
    setup.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      for (const line of lines) {
        try {
          const info = JSON.parse(line);
          resolve(info);
          return;
        } catch {}
      }
    });
    setup.on("error", reject);
    setTimeout(() => reject(new Error("agent setup timeout")), 10_000);
  });
  await new Promise((r) => setTimeout(r, 300));
});

test.afterAll(async () => {
  if (agent) agent.kill();
  if (testFsRoot) rmSync(testFsRoot, { recursive: true, force: true });
});

test.describe("P1 file + git panel", () => {
  test("end-to-end: browse, preview, git diff, rename, delete", async ({ page }) => {
    test.setTimeout(120_000);
    expect(agentInfo).not.toBeNull();
    await seedLocalStorage(page, agentInfo!, testFsRoot);
    await page.goto("/");

    // Wait for online indicator.
    await expect(page.locator(".conn-online .conn-dot")).toBeVisible({ timeout: 15_000 });

    // Open file panel.
    await page.locator('button:has-text("文件")').first().click();
    await expect(page.locator("text=目录")).toBeVisible();

    // Click on src directory to expand.
    await page.locator(".tree .row", { hasText: "src" }).first().click();
    // Click on app.ts to open preview.
    await page.locator(".tree .row", { hasText: "app.ts" }).first().click();
    await expect(page.locator(".preview:not(.hidden)")).toBeVisible();
    await expect(page.locator(".code")).toContainText("const x");

    // Switch to Git tab (project root already seeded for this test).
    await page.locator("button:has-text('Git')").first().click();
    await expect(page.locator("text=工作区改动")).toBeVisible();
    await expect(page.locator(".chg", { hasText: "app.ts" })).toBeVisible();

    // Open diff.
    await page.locator(".chg", { hasText: "app.ts" }).first().click();
    await expect(page.locator(".diff")).toContainText("const x");

    // Switch back to directory tab for write operations.
    await page.locator("button:has-text('目录')").first().click();

    // Rename new.txt -> renamed.txt
    const fileRow = page.locator(".tree .row-wrap", { hasText: "new.txt" }).first();
    await fileRow.locator("button.more").click();
    page.on("dialog", async (dialog) => {
      if (dialog.type() === "prompt") await dialog.accept("renamed.txt");
      else await dialog.accept();
    });
    await page.locator(".ctxmenu button", { hasText: "重命名" }).click();
    await expect(page.locator(".tree .row", { hasText: "renamed.txt" }).first()).toBeVisible({ timeout: 10_000 });

    // Delete renamed.txt with two-tap confirm.
    const renamedRow = page.locator(".tree .row-wrap", { hasText: "renamed.txt" }).first();
    await renamedRow.locator("button.more").click();
    await page.locator(".ctxmenu button", { hasText: "删除" }).click();
    await page.locator("button.danger", { hasText: "确定" }).click();
    await page.locator("button.danger", { hasText: "再点一次删除" }).click();
    await expect(page.locator(".tree .row", { hasText: "renamed.txt" }).first()).not.toBeVisible({ timeout: 10_000 });
  });
});
