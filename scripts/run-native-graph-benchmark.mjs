#!/usr/bin/env node
/* global fetch, process, setTimeout */

import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "@playwright/test";
import {
  collectGraphPerformanceMetrics,
  evaluateGraphPerformanceBudget,
  waitForGraphPerformanceReady
} from "../tests/e2e/graph-performance-measure.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const repeats = Number(argument("--repeats") ?? 5);
const outputPath = argument("--output");
const headless = args.includes("--headless");
const evidenceOnly = args.includes("--evidence-only");

function argument(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

if (!Number.isInteger(repeats) || repeats < 3 || repeats > 20) {
  throw new Error("--repeats must be an integer from 3 through 20.");
}

function command(commandName, commandArgs) {
  const result = spawnSync(commandName, commandArgs, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function plistValue(appPath, key) {
  return command("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    join(appPath, "Contents", "Info.plist")
  ]);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port."));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForUrl(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError ?? "unavailable"}`);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

function summarizeRuns(runs) {
  if (runs.length === 0) return null;
  return {
    acceptedRuns: runs.filter((run) => run.budget.accepted).length,
    endToEndDisplayMs: {
      p50: percentile(runs.map((run) => run.metrics.display.endToEndDisplayMs), 0.5),
      p95: percentile(runs.map((run) => run.metrics.display.endToEndDisplayMs), 0.95)
    },
    filterGroupP95Ms: {
      p50: percentile(runs.map((run) => run.metrics.display.filterGroupP95Ms), 0.5),
      worst: Math.max(...runs.map((run) => run.metrics.display.filterGroupP95Ms))
    },
    fps: {
      minimum: Math.min(...runs.map((run) => run.metrics.interaction.fps)),
      p50: percentile(runs.map((run) => run.metrics.interaction.fps), 0.5)
    },
    frameIntervalP95Ms: {
      p50: percentile(runs.map((run) => run.metrics.interaction.p95FrameIntervalMs), 0.5),
      worst: Math.max(...runs.map((run) => run.metrics.interaction.p95FrameIntervalMs))
    },
    runs: runs.length
  };
}

async function measurePlaywrightBrowser({ browserType, executablePath, kind, label }) {
  const browser = await browserType.launch({
    executablePath,
    headless
  });
  const runs = [];
  let detectedVersion = "";
  try {
    detectedVersion = browser.version();
    for (let run = 1; run <= repeats; run += 1) {
      const context = await browser.newContext({ locale: "ko-KR", viewport: null });
      const page = await context.newPage();
      const runtimeErrors = [];
      page.on("pageerror", (error) => runtimeErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") runtimeErrors.push(message.text());
      });
      await page.goto(`${benchmarkUrl}?engine=${encodeURIComponent(label)}&run=${run}`, {
        waitUntil: "domcontentloaded"
      });
      await waitForGraphPerformanceReady(page);
      const metrics = await collectGraphPerformanceMetrics(page);
      const budget = evaluateGraphPerformanceBudget(metrics);
      runs.push({
        budget: {
          accepted: budget.accepted && runtimeErrors.length === 0,
          checks: budget.checks,
          runtimeErrors
        },
        metrics,
        run
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const summary = summarizeRuns(runs);
  return {
    accepted: Boolean(summary && summary.acceptedRuns === repeats),
    binary: executablePath ?? browserType.executablePath(),
    browserVersion: detectedVersion,
    headless,
    kind,
    label,
    runs,
    summary,
    usesOperatingSystemWindowSize: true
  };
}

async function webdriverRequest(port, path, method = "GET", body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (payload?.value?.error) {
    const error = new Error(payload.value.message || payload.value.error);
    error.webdriverError = payload.value.error;
    throw error;
  }
  return payload.value;
}

async function webdriverExecute(port, sessionId, script, asynchronous = false) {
  return webdriverRequest(
    port,
    `/session/${sessionId}/execute/${asynchronous ? "async" : "sync"}`,
    "POST",
    { args: [], script }
  );
}

async function waitForSafariGraph(port, sessionId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await webdriverExecute(port, sessionId, `
      const root = document.querySelector("#root");
      const canvas = document.querySelector(".qm-graph-renderer canvas");
      const zoomButton = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.getAttribute("aria-label") === "확대");
      return root?.getAttribute("data-node-count") === "5000"
        && root?.getAttribute("data-edge-count") === "10000"
        && canvas instanceof HTMLElement
        && zoomButton instanceof HTMLElement
        && !zoomButton.hasAttribute("disabled")
        && Boolean(window.__QUICKMEMO_GRAPH_PERFORMANCE__);
    `);
    if (ready) {
      await webdriverExecute(port, sessionId, `
        const done = arguments[arguments.length - 1];
        requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
      `, true);
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for the graph harness in system Safari.");
}

async function collectSafariGraphMetrics(port, sessionId) {
  const display = await webdriverExecute(port, sessionId, `
    const state = window.__QUICKMEMO_GRAPH_PERFORMANCE__;
    if (!state) throw new Error("Graph performance state is unavailable.");
    const sortedDurations = state.filterGroupDurationsMs.slice().sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1);
    return {
      edgeCount: state.edgeCount,
      endToEndDisplayMs: performance.now() - state.endToEndStartedAt,
      filterGroupDurationsMs: state.filterGroupDurationsMs,
      filterGroupP95Ms: sortedDurations[p95Index] ?? Number.POSITIVE_INFINITY,
      firstDisplayMs: performance.now() - state.renderStartedAt,
      fixtureBuildMs: state.fixtureBuildMs,
      nodeCount: state.nodeCount,
      workerBuildMs: state.workerBuildMs
    };
  `);
  const interaction = await webdriverExecute(port, sessionId, `
    const done = arguments[arguments.length - 1];
    const target = document.querySelector(".qm-graph-canvas");
    if (!(target instanceof HTMLElement)) {
      done({ error: "Graph keyboard target is unavailable." });
      return;
    }
    target.focus();
    const frameIntervals = [];
    const durationMs = 2000;
    const actionIntervalMs = 80;
    const expectedActionCount = Math.floor(durationMs / actionIntervalMs);
    const startedAt = performance.now();
    let lastFrameAt = startedAt;
    let actionIndex = 0;
    const dispatchAction = () => {
      const key = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "=", "-"][actionIndex % 6];
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
      actionIndex += 1;
    };
    const sample = (now) => {
      frameIntervals.push(now - lastFrameAt);
      lastFrameAt = now;
      const dueActionCount = Math.min(
        expectedActionCount,
        Math.floor((now - startedAt) / actionIntervalMs) + 1
      );
      while (actionIndex < dueActionCount) dispatchAction();
      if (now - startedAt < durationMs) {
        requestAnimationFrame(sample);
        return;
      }
      const elapsedMs = performance.now() - startedAt;
      const sortedIntervals = frameIntervals.slice().sort((a, b) => a - b);
      const p95Index = Math.max(0, Math.ceil(sortedIntervals.length * 0.95) - 1);
      done({
        actions: actionIndex,
        expectedActions: expectedActionCount,
        elapsedMs,
        fps: frameIntervals.length / (elapsedMs / 1000),
        p95FrameIntervalMs: sortedIntervals[p95Index] ?? Number.POSITIVE_INFINITY,
        viewport: window.__QUICKMEMO_GRAPH_PERFORMANCE__?.lastViewport,
        window: {
          devicePixelRatio: window.devicePixelRatio,
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
          screenHeight: window.screen.height,
          screenWidth: window.screen.width
        }
      });
    };
    requestAnimationFrame(sample);
  `, true);
  if (interaction?.error) throw new Error(interaction.error);
  return { display, interaction };
}

async function measureSystemSafari() {
  const safariApp = ["/Applications/Safari.app", "/System/Applications/Safari.app"]
    .find((candidate) => existsSync(candidate));
  if (!safariApp) return { accepted: false, available: false, reason: "Safari.app is absent." };

  const port = await freePort();
  const driver = spawn("xcrun", ["safaridriver", "-p", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let driverError = "";
  driver.stderr.on("data", (chunk) => { driverError += chunk.toString(); });
  try {
    await waitForUrl(`http://127.0.0.1:${port}/status`, 10_000);
    let session;
    try {
      session = await webdriverRequest(port, "/session", "POST", {
        capabilities: { alwaysMatch: { browserName: "safari" } }
      });
    } catch (error) {
      return {
        accepted: false,
        appVersion: plistValue(safariApp, "CFBundleShortVersionString"),
        available: true,
        automationAvailable: false,
        kind: "system-safari",
        label: "System Safari",
        reason: error instanceof Error ? error.message : String(error)
      };
    }

    const sessionId = session.sessionId;
    const runs = [];
    try {
      await webdriverRequest(port, `/session/${sessionId}/timeouts`, "POST", { script: 15_000 });
      for (let run = 1; run <= repeats; run += 1) {
        await webdriverRequest(port, `/session/${sessionId}/url`, "POST", {
          url: `${benchmarkUrl}?engine=system-safari&run=${run}`
        });
        await waitForSafariGraph(port, sessionId);
        const metrics = await collectSafariGraphMetrics(port, sessionId);
        const budget = evaluateGraphPerformanceBudget(metrics);
        runs.push({ budget, metrics, run });
      }
    } finally {
      await webdriverRequest(port, `/session/${sessionId}`, "DELETE").catch(() => undefined);
    }
    const summary = summarizeRuns(runs);
    return {
      accepted: Boolean(summary && summary.acceptedRuns === repeats),
      appVersion: plistValue(safariApp, "CFBundleShortVersionString"),
      available: true,
      automationAvailable: true,
      headless: false,
      kind: "system-safari",
      label: "System Safari",
      runs,
      summary,
      usesOperatingSystemWindowSize: true
    };
  } finally {
    driver.kill("SIGTERM");
    await new Promise((resolveWait) => {
      if (driver.exitCode !== null) resolveWait();
      else {
        driver.once("exit", resolveWait);
        setTimeout(resolveWait, 2_000);
      }
    });
    if (driver.exitCode === null) driver.kill("SIGKILL");
    void driverError;
  }
}

const vitePort = await freePort();
const baseUrl = `http://127.0.0.1:${vitePort}`;
const benchmarkUrl = `${baseUrl}/tests/e2e/graph-performance-harness.html`;
const vite = spawn(join(repoRoot, "node_modules", ".bin", "vite"), [
  "--host",
  "127.0.0.1",
  "--port",
  String(vitePort),
  "--strictPort",
  "--mode",
  "test"
], {
  cwd: repoRoot,
  env: { ...process.env, BROWSER: "none" },
  stdio: ["ignore", "pipe", "pipe"]
});
let viteError = "";
vite.stderr.on("data", (chunk) => { viteError += chunk.toString(); });

let result;
try {
  await waitForUrl(benchmarkUrl);
  const chromeApp = "/Applications/Google Chrome.app";
  const chromeExecutable = join(chromeApp, "Contents", "MacOS", "Google Chrome");
  const engines = [];

  if (existsSync(chromeExecutable)) {
    engines.push(await measurePlaywrightBrowser({
      browserType: chromium,
      executablePath: chromeExecutable,
      kind: "system-chrome",
      label: "Google Chrome"
    }));
  } else {
    engines.push({
      accepted: false,
      available: false,
      kind: "system-chrome",
      label: "Google Chrome",
      reason: "Google Chrome.app is absent."
    });
  }

  if (existsSync(webkit.executablePath())) {
    engines.push(await measurePlaywrightBrowser({
      browserType: webkit,
      kind: "playwright-webkit",
      label: "Playwright WebKit"
    }));
  } else {
    engines.push({
      accepted: false,
      available: false,
      kind: "playwright-webkit",
      label: "Playwright WebKit",
      reason: "The pinned Playwright WebKit binary is absent."
    });
  }

  engines.push(await measureSystemSafari());
  const measuredDesktopBudgetsAccepted = engines
    .filter((engine) => engine.kind === "system-chrome" || engine.kind === "playwright-webkit")
    .every((engine) => engine.accepted);
  const actualSafariAccepted = engines.some((engine) => (
    engine.kind === "system-safari" && engine.accepted
  ));
  const representativePhysicalMobileMeasured = false;

  result = {
    accepted: measuredDesktopBudgetsAccepted
      && actualSafariAccepted
      && representativePhysicalMobileMeasured,
    benchmark: { edges: 10_000, nodes: 5_000, repeats },
    capturedAt: new Date().toISOString(),
    engines,
    evidenceLimits: [
      "Google Chrome is the installed production browser binary in an isolated Playwright profile and an operating-system-sized desktop window.",
      "Playwright WebKit is a pinned WebKit test binary; it is not Apple Safari.",
      "No physical phone or tablet was connected, so representative mobile hardware performance is not measured.",
      "A single Mac/display cannot guarantee frame rate on every production device."
    ],
    host: {
      architecture: process.arch,
      chip: command("sysctl", ["-n", "machdep.cpu.brand_string"])
        || command("system_profiler", ["SPHardwareDataType"]).split("\n")
          .find((line) => line.includes("Chip:"))?.split(":").slice(1).join(":").trim()
        || "unknown",
      chromeBundleVersion: existsSync("/Applications/Google Chrome.app")
        ? plistValue("/Applications/Google Chrome.app", "CFBundleShortVersionString")
        : null,
      macOS: command("sw_vers", ["-productVersion"]),
      safariBundleVersion: existsSync("/Applications/Safari.app")
        ? plistValue("/Applications/Safari.app", "CFBundleShortVersionString")
        : null
    },
    releaseGate: {
      actualSafariAccepted,
      measuredDesktopBudgetsAccepted,
      representativePhysicalMobileMeasured
    },
    schemaVersion: 1
  };
} finally {
  vite.kill("SIGTERM");
  await new Promise((resolveWait) => {
    if (vite.exitCode !== null) resolveWait();
    else {
      vite.once("exit", resolveWait);
      setTimeout(resolveWait, 5_000);
    }
  });
  if (vite.exitCode === null) vite.kill("SIGKILL");
}

if (!result) throw new Error(`Native benchmark did not produce a result. ${viteError}`);
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) await writeFile(resolve(outputPath), serialized, { mode: 0o600 });
process.stdout.write(serialized);
if (!result.accepted && !evidenceOnly) process.exitCode = 1;
