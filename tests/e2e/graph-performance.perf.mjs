/* global console, process */

import { expect, test } from "@playwright/test";
import {
  collectGraphPerformanceMetrics,
  evaluateGraphPerformanceBudget,
  waitForGraphPerformanceReady
} from "./graph-performance-measure.mjs";

const firstDisplayBudgetMs = Number(process.env.GRAPH_FIRST_DISPLAY_MS ?? 3_000);
const filterGroupP95BudgetMs = Number(process.env.GRAPH_FILTER_GROUP_P95_MS ?? 250);
const minimumInteractionFps = Number(process.env.GRAPH_MIN_INTERACTION_FPS ?? 45);
const maximumP95FrameIntervalMs = Number(process.env.GRAPH_MAX_P95_FRAME_INTERVAL_MS ?? (1_000 / 30));
const frameIntervalSchedulingToleranceMs = Number(
  process.env.GRAPH_FRAME_INTERVAL_TOLERANCE_MS ?? 1
);

test("5k nodes and 10k edges meet the browser render and interaction budget", async ({ page }) => {
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  await page.goto("/tests/e2e/graph-performance-harness.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#root")).toHaveAttribute("data-node-count", "5000");
  await expect(page.locator("#root")).toHaveAttribute("data-edge-count", "10000");
  await expect(page.locator(".qm-graph-renderer canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "확대" })).toBeEnabled({ timeout: 15_000 });
  await waitForGraphPerformanceReady(page);
  const metrics = await collectGraphPerformanceMetrics(page);
  const displayMetrics = metrics.display;

  expect(displayMetrics.nodeCount).toBe(5_000);
  expect(displayMetrics.edgeCount).toBe(10_000);
  expect(displayMetrics.firstDisplayMs).toBeLessThan(firstDisplayBudgetMs);
  expect(displayMetrics.endToEndDisplayMs).toBeLessThan(firstDisplayBudgetMs);
  expect(displayMetrics.filterGroupDurationsMs).toHaveLength(8);
  const filterGroupP95Ms = displayMetrics.filterGroupP95Ms;
  expect(filterGroupP95Ms).toBeLessThanOrEqual(filterGroupP95BudgetMs);
  const interactionMetrics = metrics.interaction;

  console.log(JSON.stringify({
    display: displayMetrics,
    filterGroupP95Ms,
    interaction: interactionMetrics,
    viewport: test.info().project.name
  }));

  expect(interactionMetrics.actions).toBe(interactionMetrics.expectedActions);
  expect(interactionMetrics.viewport).toBeTruthy();
  expect(interactionMetrics.fps).toBeGreaterThanOrEqual(minimumInteractionFps);
  // Browser timer quantization can report a nominal 30 fps interval a fraction
  // above 33.333 ms. Keep a one-millisecond measurement tolerance while the
  // independent average-FPS gate remains at 45 and real long frames still fail.
  expect(interactionMetrics.p95FrameIntervalMs).toBeLessThanOrEqual(
    maximumP95FrameIntervalMs + frameIntervalSchedulingToleranceMs
  );
  expect(evaluateGraphPerformanceBudget(metrics, {
    firstDisplayMs: firstDisplayBudgetMs,
    filterGroupP95Ms: filterGroupP95BudgetMs,
    minimumInteractionFps,
    maximumP95FrameIntervalMs: maximumP95FrameIntervalMs
      + frameIntervalSchedulingToleranceMs
  }).accepted).toBe(true);
  expect(runtimeErrors).toEqual([]);
});
