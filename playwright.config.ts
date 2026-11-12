import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// Browser tests for the web app. Starts its own API (fresh database in a temp
// folder, PayPal simulator) on 4100 and the web app on 3100.
// Locally they run in the installed Microsoft Edge; in CI in Playwright's Chromium.

const API_PORT = 4100;
const WEB_PORT = 3100;
// Kept in the environment so test workers can read the emails the API writes to DATA_DIR/outbox.
const dataDir = (process.env.MG_E2E_DATA_DIR ??= path.join(os.tmpdir(), `makegood-e2e-${process.pid}`));

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    channel: process.env.CI ? undefined : "msedge",
  },
  webServer: [
    {
      command: "node apps/api/src/server.ts",
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      // GEMINI_API_KEY is blanked so the tests never call the real AI.
      env: {
        PORT: String(API_PORT),
        DATA_DIR: dataDir,
        NODE_ENV: "development",
        LOG_LEVEL: "warn",
        PUBLIC_URL: `http://localhost:${WEB_PORT}`,
        GEMINI_API_KEY: "",
      },
    },
    {
      command: `npm run dev -w @makegood/web -- -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
