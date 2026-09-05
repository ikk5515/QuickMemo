/* global ResizeObserver, document, getComputedStyle, structuredClone, window */

import { expect, test } from "@playwright/test";
import {
  openVaultMoreTool,
  expectNoHorizontalOverflow,
  loginDirectly,
  navigateWithinApp,
  seedScenario
} from "./helpers.mjs";

async function expectMinimumTouchTargets(scope, selector, label) {
  const undersized = await scope.locator(selector).evaluateAll((elements) => (
    elements.flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        style.display === "none"
        || style.visibility === "hidden"
        || bounds.width === 0
        || bounds.height === 0
      ) {
        return [];
      }
      return bounds.width >= 43.5 && bounds.height >= 43.5 ? [] : [{
        height: Number(bounds.height.toFixed(2)),
        label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
        width: Number(bounds.width.toFixed(2))
      }];
    })
  ));

  expect(undersized, `${label} touch targets must be at least 44x44 CSS pixels`).toEqual([]);
}

async function ensureLeftDrawer(page) {
  const drawer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  if (!(await drawer.isVisible())) {
    await page.getByRole("button", { name: "왼쪽 패널 열기" }).click();
  }
  await expect(drawer).toBeVisible();
  return drawer;
}

test("Playwright WebKit keeps the reduced-motion Vault UI contained and accessible", async ({
  page,
  request
}) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await seedScenario(request, "authenticated-verified");
  const mobileLayout = (page.viewportSize()?.width ?? 1280) <= 760;

  await loginDirectly(page, fixture.viewerAuth);
  await navigateWithinApp(page, "/app");
  await expect(page.locator(".vault-workspace")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const browserCapabilities = await page.evaluate(() => ({
    inert: "inert" in document.createElement("div"),
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    resizeObserver: typeof ResizeObserver === "function",
    structuredClone: typeof structuredClone === "function",
    subtleCrypto: typeof globalThis.crypto?.subtle === "object"
  }));
  expect(browserCapabilities).toEqual({
    inert: true,
    reducedMotion: true,
    resizeObserver: true,
    structuredClone: true,
    subtleCrypto: true
  });

  const reducedMotionDuration = await page.locator(".vault-ribbon button").first().evaluate((button) => (
    getComputedStyle(button).transitionDuration
  ));
  expect(reducedMotionDuration.split(",").every((duration) => parseFloat(duration) <= 0.00001))
    .toBe(true);

  if (mobileLayout) {
    // Encrypted workspace restoration may reopen the initial drawer once.
    await page.waitForTimeout(900);
    let drawer = await ensureLeftDrawer(page);
    await expect(drawer).toHaveAttribute("role", "dialog");
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    await expect(page.locator(".vault-center")).toHaveAttribute("inert", "");
    await expect(page.locator(".vault-center")).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator(".vault-ribbon")).toHaveAttribute("inert", "");
    const drawerBackdrop = page.locator(".vault-mobile-drawer-backdrop");
    await expect(drawerBackdrop).toBeVisible();
    await expect.poll(async () => drawerBackdrop.evaluate((backdrop) => {
      const style = getComputedStyle(backdrop);
      return `${style.backgroundColor}|${style.borderRadius}`;
    })).toBe("rgba(15, 18, 24, 0.38)|0px");
    await expect.poll(async () => page.evaluate(() => getComputedStyle(document.body).overflowY))
      .toBe("hidden");
    await expectMinimumTouchTargets(drawer, "button", "Vault explorer drawer");

    const controls = drawer.locator(
      'summary, a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    );
    await controls.filter({ visible: true }).last().focus();
    await page.keyboard.press("Tab");
    await expect(drawer.getByRole("button", { name: "왼쪽 패널 닫기" })).toBeFocused();
    await page.keyboard.press("Escape");
    const opener = page.getByRole("button", { name: "왼쪽 패널 열기" });
    await expect(drawer).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    drawer = await ensureLeftDrawer(page);
    await page.locator(".vault-mobile-drawer-backdrop").click({ position: { x: 2, y: 2 } });
    await expect(drawer).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expectMinimumTouchTargets(page, ".vault-ribbon button", "Vault mobile ribbon");
  } else {
    await expect(page.getByRole("complementary", { name: "Vault 리본" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Vault 탐색기" })).toBeVisible();
  }

  await openVaultMoreTool(page, "그래프 보기");
  const graph = page.getByRole("region", { name: "전체 그래프" });
  await expect(graph).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "그래프 화면 제어" })).toBeVisible();
  await graph.focus();
  await graph.press("=");
  await expect.poll(async () => Number(await graph.getAttribute("data-graph-zoom"))).toBeGreaterThan(1);
  if (mobileLayout) {
    await expectMinimumTouchTargets(page, ".qm-graph-view button, .qm-graph-view summary", "Vault graph");
  }
  await expectNoHorizontalOverflow(page);
});
