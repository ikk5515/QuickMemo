/* global process */

import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:4175";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/graph-performance.perf.mjs",
  outputDir: "test-results/graph-performance",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 15_000
  },
  reporter: [["line"]],
  use: {
    baseURL,
    locale: "ko-KR",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 4175 --strictPort --mode test",
    url: `${baseURL}/tests/e2e/graph-performance-harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    gracefulShutdown: {
      signal: "SIGTERM",
      timeout: 5_000
    },
    stdout: "pipe",
    stderr: "pipe"
  },
  projects: [
    {
      name: "graph-chromium-desktop-1280",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: "graph-chromium-mobile-390",
      use: {
        browserName: "chromium",
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        screen: { width: 390, height: 844 },
        viewport: { width: 390, height: 844 }
      }
    },
    {
      name: "graph-webkit-desktop-1280",
      use: {
        browserName: "webkit",
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: "graph-webkit-mobile-390",
      use: {
        browserName: "webkit",
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        screen: { width: 390, height: 844 },
        viewport: { width: 390, height: 844 }
      }
    }
  ]
});
