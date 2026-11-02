import { defineConfig, devices } from "@playwright/test";

// E2E テストは wrangler dev（開発用ログインが有効な環境）に対して実行する。
const PORT = Number(process.env["E2E_PORT"] ?? "8788");
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

export default defineConfig({
  testDir: ".",
  outputDir: "../../test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never", outputFolder: "../../playwright-report" }]]
    : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // 倉庫のタブレット（横向き）
    {
      name: "tablet",
      use: {
        ...devices["Galaxy Tab S9"],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
      grep: /@tablet/,
    },
  ],
  webServer: {
    command: `bunx wrangler d1 migrations apply AUTH_DB --local --persist-to .wrangler/e2e && bunx wrangler dev --port ${PORT} --local --persist-to .wrangler/e2e --var ENVIRONMENT:development --var APP_ORIGIN:http://localhost:${PORT} --var BETTER_AUTH_SECRET:e2e-secret-e2e-secret-e2e-secret-0000 --var GOOGLE_CLIENT_ID:e2e --var GOOGLE_CLIENT_SECRET:e2e`,
    url: `http://localhost:${PORT}/login`,
    cwd: "../..",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
