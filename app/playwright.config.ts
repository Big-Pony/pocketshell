import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    // 5173 是 vite 默认端口，别的项目的 dev server 也会占它——reuseExistingServer
    // 一旦探测到 5173 有响应就复用，e2e 会对着别的项目的页面干等（2026-08-28
    // 撞上过 /tmp 下别的 worktree 的 vite）。换非默认端口 + strictPort，撞车即
    // 报错而不是静默跑错页面。
    baseURL: "http://localhost:5273",
    trace: "on-first-retry",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    browserName: "chromium",
    // The app's first-run language follows the browser; pin zh-CN so specs can
    // keep locating UI by Chinese text.
    locale: "zh-CN",
  },
  projects: [
    {
      name: "chromium-mobile",
      use: {},
    },
  ],
  webServer: {
    command: "bun run dev --port 5273 --strictPort",
    url: "http://localhost:5273",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { VITE_POCKETSHELL_DEV_HELPERS: "1" },
  },
});
