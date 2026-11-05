import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/playwright",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  outputDir: ".data/playwright-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    locale: "zh-CN",
    colorScheme: "light",
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
});
