import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Opt-in performance run of the IOS workbench with GPU rendering (ANGLE /
// D3D11 on Windows) instead of the default software rasteriser, so frame
// times reflect a clinic PC with a GPU:
//   WORKBENCH_PERF=1 npx playwright test -c playwright.perf.config.ts tests/e2e/ios-workbench.e2e.ts -g 2M
export default defineConfig({
  ...base,
  use: {
    ...base.use,
    channel: "chromium",
    launchOptions: { args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] },
  },
});
