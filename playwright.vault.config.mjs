/* global process */

import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:4174";
const firebaseEmulatorHubUrl = "http://127.0.0.1:4400/emulators";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results/vault",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 15_000
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
      command:
        "QUICKMEMO_E2E_PORT=4174 VITE_OBSIDIAN_VAULT_ENABLED=true node tests/e2e/server.mjs",
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
    ...(process.env.QUICKMEMO_E2E_EXTRA_BROWSERS === "true" ? [
      {
        name: "vault-firefox-desktop-1280",
        testIgnore: ["**/vault-webkit-ui.vault.mjs"],
        testMatch: ["**/*.vault.mjs"],
        use: { browserName: "firefox", viewport: { width: 1280, height: 720 } }
      },
      {
        name: "vault-chrome-desktop-1440",
        testIgnore: ["**/vault-webkit-ui.vault.mjs"],
        testMatch: ["**/*.vault.mjs"],
        use: { browserName: "chromium", channel: "chrome", viewport: { width: 1440, height: 900 } }
      }
    ] : []),
    {
      name: "vault-chromium-desktop-1440",
      testIgnore: ["**/vault-webkit-ui.vault.mjs"],
      testMatch: ["**/*.vault.mjs"],
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 900 }
      }
    },
    {
      name: "vault-chromium-desktop-1280",
      testIgnore: ["**/vault-webkit-ui.vault.mjs"],
      testMatch: ["**/*.vault.mjs"],
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: "vault-chromium-tablet-1024",
      testIgnore: ["**/vault-webkit-ui.vault.mjs"],
      testMatch: ["**/*.vault.mjs"],
      use: {
        browserName: "chromium",
        deviceScaleFactor: 1,
        hasTouch: true,
        screen: { width: 1024, height: 768 },
        viewport: { width: 1024, height: 768 }
      }
    },
    {
      name: "vault-chromium-tablet-768",
      testIgnore: ["**/vault-webkit-ui.vault.mjs"],
      testMatch: ["**/*.vault.mjs"],
      use: {
        browserName: "chromium",
        deviceScaleFactor: 1,
        hasTouch: true,
        screen: { width: 768, height: 1024 },
        viewport: { width: 768, height: 1024 }
      }
    },
    {
      name: "vault-chromium-mobile-390",
      testIgnore: ["**/vault-webkit-ui.vault.mjs"],
      testMatch: ["**/*.vault.mjs"],
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
      name: "vault-chromium-mobile-320",
      testIgnore: ["**/vault-webkit-ui.vault.mjs"],
      testMatch: ["**/*.vault.mjs"],
      use: {
        browserName: "chromium",
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        screen: { width: 320, height: 568 },
        viewport: { width: 320, height: 568 }
      }
    },
    {
      // Engine-level Safari compatibility gate. This does not replace a real
      // macOS/iOS Safari smoke on production hardware.
      name: "vault-webkit-desktop-1280",
      testMatch: ["**/*.vault.mjs"],
      use: {
        browserName: "webkit",
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: "vault-webkit-mobile-390",
      testMatch: ["**/*.vault.mjs"],
      use: {
        ...devices["iPhone 13"],
        browserName: "webkit"
      }
    },
    {
      name: "vault-webkit-mobile-320",
      testMatch: ["**/*.vault.mjs"],
      use: {
        ...devices["iPhone SE"],
        browserName: "webkit"
      }
    }
  ]
});
