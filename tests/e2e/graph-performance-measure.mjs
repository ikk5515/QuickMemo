/* global document, HTMLElement, KeyboardEvent, performance, requestAnimationFrame, window */

export const GRAPH_PERFORMANCE_DEFAULT_BUDGETS = Object.freeze({
  firstDisplayMs: 3_000,
  filterGroupP95Ms: 250,
  minimumInteractionFps: 45,
  maximumP95FrameIntervalMs: (1_000 / 30) + 1
});

export async function waitForGraphPerformanceReady(page, timeoutMs = 15_000) {
  await page.waitForFunction(() => {
    const root = document.querySelector("#root");
    const canvas = document.querySelector(".qm-graph-renderer canvas");
    const zoomButton = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.getAttribute("aria-label") === "확대");
    return root?.getAttribute("data-node-count") === "5000"
      && root?.getAttribute("data-edge-count") === "10000"
      && canvas instanceof HTMLElement
      && zoomButton instanceof HTMLElement
      && !zoomButton.hasAttribute("disabled")
      && Boolean(window.__QUICKMEMO_GRAPH_PERFORMANCE__);
  }, undefined, { timeout: timeoutMs });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

export async function collectGraphPerformanceMetrics(page) {
  const display = await page.evaluate(() => {
    const state = window.__QUICKMEMO_GRAPH_PERFORMANCE__;
    if (!state) throw new Error("Graph performance state is unavailable.");
    const sortedDurations = state.filterGroupDurationsMs.slice().sort((left, right) => left - right);
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
  });

  const interaction = await page.evaluate(async () => {
    const target = document.querySelector(".qm-graph-canvas");
    if (!(target instanceof HTMLElement)) throw new Error("Graph keyboard target is unavailable.");
    target.focus();
    const frameIntervals = [];
    const durationMs = 2_000;
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

    await new Promise((resolve) => {
      const sample = (now) => {
        frameIntervals.push(now - lastFrameAt);
        lastFrameAt = now;
        const dueActionCount = Math.min(
          expectedActionCount,
          Math.floor((now - startedAt) / actionIntervalMs) + 1
        );
        while (actionIndex < dueActionCount) dispatchAction();
        if (now - startedAt < durationMs) requestAnimationFrame(sample);
        else resolve(undefined);
      };
      requestAnimationFrame(sample);
    });

    const elapsedMs = performance.now() - startedAt;
    const sortedIntervals = frameIntervals.slice().sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.ceil(sortedIntervals.length * 0.95) - 1);
    return {
      actions: actionIndex,
      expectedActions: expectedActionCount,
      elapsedMs,
      fps: frameIntervals.length / (elapsedMs / 1_000),
      p95FrameIntervalMs: sortedIntervals[p95Index] ?? Number.POSITIVE_INFINITY,
      viewport: window.__QUICKMEMO_GRAPH_PERFORMANCE__?.lastViewport,
      window: {
        devicePixelRatio: window.devicePixelRatio,
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        screenHeight: window.screen.height,
        screenWidth: window.screen.width
      }
    };
  });

  return { display, interaction };
}

export function evaluateGraphPerformanceBudget(
  metrics,
  budgets = GRAPH_PERFORMANCE_DEFAULT_BUDGETS
) {
  const checks = {
    actionCount: metrics.interaction.actions === metrics.interaction.expectedActions,
    edgeCount: metrics.display.edgeCount === 10_000,
    endToEndDisplay: metrics.display.endToEndDisplayMs < budgets.firstDisplayMs,
    filterGroupP95: metrics.display.filterGroupP95Ms <= budgets.filterGroupP95Ms,
    firstDisplay: metrics.display.firstDisplayMs < budgets.firstDisplayMs,
    frameP95: metrics.interaction.p95FrameIntervalMs <= budgets.maximumP95FrameIntervalMs,
    interactionFps: metrics.interaction.fps >= budgets.minimumInteractionFps,
    nodeCount: metrics.display.nodeCount === 5_000,
    viewportUpdated: Boolean(metrics.interaction.viewport)
  };
  return { accepted: Object.values(checks).every(Boolean), checks };
}
