import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Point the suite at an already-running deployment (staging, preview, prod)
// with E2E_BASE_URL; otherwise it starts the app itself on 4314.
const port = Number(process.env.E2E_PORT ?? 4314);
const externalBaseURL = process.env.E2E_BASE_URL?.trim();
const baseURL = externalBaseURL || `http://127.0.0.1:${port}`;

// Images that ship their own Chromium (CI runners, dev containers) can reuse
// it instead of downloading Playwright's bundled build.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim();

export default defineConfig({
  testDir: "./tests/e2e",
  // *.e2e.ts, not *.spec.ts: unit runners (vitest, jest) glob **/*.spec.ts by
  // default and choke on Playwright's test() when they pick these up.
  testMatch: "**/*.e2e.ts",
  outputDir: path.join(os.tmpdir(), "aihealth-imaging-playwright"),
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    launchOptions: executablePath ? { executablePath } : {},
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  ...(externalBaseURL
    ? {}
    : {
        webServer: {
          command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          env: {
            VITE_SUPABASE_URL: "https://placeholder.supabase.co",
            VITE_SUPABASE_ANON_KEY: "placeholder",
          },
        },
      }),
});
