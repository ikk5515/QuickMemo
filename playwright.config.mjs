/* global process */

import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";
const firebaseEmulatorHubUrl = "http://127.0.0.1:4400/emulators";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  reporter: [["line"]],
  use: {
    baseURL,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  },
  webServer: [
    {
      command:
        "npx --yes firebase-tools@15.24.0 emulators:start --project quickmemo-share-api-test --only auth,firestore",
      url: firebaseEmulatorHubUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      gracefulShutdown: {
        signal: "SIGINT",
        timeout: 15_000
      },
      stdout: "pipe",
      stderr: "pipe"
    },
    {
      command: "node tests/e2e/server.mjs",
      url: `${baseURL}/__e2e__/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      gracefulShutdown: {
        signal: "SIGTERM",
        timeout: 5_000
      },
      stdout: "pipe",
      stderr: "pipe"
    }
  ],
  projects: [
    {
      name: "chromium-desktop",
      testMatch: ["**/*.spec.mjs"],
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: "chromium-mobile-390",
      testMatch: [
        "**/app-layout.spec.mjs",
        "**/attachment.spec.mjs",
        "**/responsive.spec.mjs",
        "**/schedule-category.spec.mjs"
      ],
      use: {
        ...devices["Pixel 5"],
        browserName: "chromium"
      }
    },
    {
      name: "chromium-mobile-320",
      testMatch: [
        "**/app-layout.spec.mjs",
        "**/attachment.spec.mjs",
        "**/responsive.spec.mjs",
        "**/schedule-category.spec.mjs"
      ],
      use: {
        ...devices["Pixel 5"],
        browserName: "chromium",
        screen: { width: 320, height: 568 },
        viewport: { width: 320, height: 568 }
      }
    },
    {
      name: "chromium-tablet-768",
      testMatch: [
        "**/app-layout.spec.mjs",
        "**/attachment.spec.mjs",
        "**/responsive.spec.mjs",
        "**/schedule-category.spec.mjs"
      ],
      use: {
        ...devices["Galaxy Tab S9"],
        browserName: "chromium",
        screen: { width: 768, height: 1024 },
        viewport: { width: 768, height: 1024 }
      }
    },
    {
      name: "chromium-tablet-1024-landscape",
      testMatch: [
        "**/app-layout.spec.mjs",
        "**/attachment.spec.mjs",
        "**/responsive.spec.mjs",
        "**/schedule-category.spec.mjs"
      ],
      use: {
        ...devices["Galaxy Tab S9 landscape"],
        browserName: "chromium",
        screen: { width: 1024, height: 768 },
        viewport: { width: 1024, height: 768 }
      }
    },
    {
      name: "webkit-desktop",
      testMatch: ["**/*.spec.mjs"],
      use: {
        browserName: "webkit",
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: "webkit-mobile-390",
      testMatch: [
        "**/app-layout.spec.mjs",
        "**/attachment.spec.mjs",
        "**/responsive.spec.mjs",
        "**/schedule-category.spec.mjs"
      ],
      use: {
        ...devices["iPhone 13"],
        browserName: "webkit"
      }
    },
    {
      name: "webkit-mobile-320",
      testMatch: [
        "**/app-layout.spec.mjs",
        "**/attachment.spec.mjs",
        "**/responsive.spec.mjs",
        "**/schedule-category.spec.mjs"
      ],
      use: {
        ...devices["iPhone SE"],
        browserName: "webkit"
      }
    },
    {
      name: "webkit-tablet-768",
      testMatch: [
        "**/app-layout.spec.mjs",
        "**/attachment.spec.mjs",
        "**/responsive.spec.mjs",
        "**/schedule-category.spec.mjs"
      ],
      use: {
        ...devices["iPad Mini"],
        browserName: "webkit"
      }
    },
    {
      name: "webkit-tablet-1024-landscape",
      testMatch: [
        "**/app-layout.spec.mjs",
        "**/attachment.spec.mjs",
        "**/responsive.spec.mjs",
        "**/schedule-category.spec.mjs"
      ],
      use: {
        ...devices["iPad Mini landscape"],
        browserName: "webkit"
      }
    }
  ]
});
