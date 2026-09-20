import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 2,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: "html",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    actionTimeout: 10000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], channel: "chrome" },
    },
  ],
  webServer: [
    {
      command: "npm run dev:server",
      port: 3001,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: "3001",
        MOCK_MODE: "true",
        // Platform integration ON with no service token → shared mock Platform
        // client (mock vision + mock wallet, zero quota, per-test isolation via
        // POST /api/platform/dev/reset).
        PLATFORM_INTEGRATION_ENABLED: "true",
      },
    },
    {
      command: "npm run dev:client",
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
