/* global getComputedStyle */

import { expect, test } from "@playwright/test";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors,
  expectCleanRuntime,
  loginDirectly,
  navigateWithinApp,
  observePage,
  seedScenario,
  unlockEncryptedVault
} from "./helpers.mjs";

async function openRightPanel(page) {
  const leftPanel = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  if (await leftPanel.isVisible()) {
    await leftPanel.getByRole("button", { name: "왼쪽 패널 닫기" }).click();
  }
  const panel = page.locator('.vault-right-panel[aria-label="연결 정보"]');
  if (!(await panel.isVisible())) {
    await page.getByRole("button", { name: "오른쪽 패널 열기" }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

async function expectHorizontallyContained(container, target) {
  const [containerBounds, targetBounds] = await Promise.all([
    container.boundingBox(),
    target.boundingBox()
  ]);
  expect(containerBounds).not.toBeNull();
  expect(targetBounds).not.toBeNull();
  if (!containerBounds || !targetBounds) return;
  expect(targetBounds.x).toBeGreaterThanOrEqual(containerBounds.x - 1);
  expect(targetBounds.x + targetBounds.width).toBeLessThanOrEqual(
    containerBounds.x + containerBounds.width + 1
  );
}

test("right-panel tabs, narrow tools, and encrypted resizing stay usable", async ({
  browserName,
  page,
  request
}, testInfo) => {
  test.setTimeout(120_000);
  if (testInfo.project.name.endsWith("desktop-1280")) {
    await page.setViewportSize({ width: 900, height: 720 });
  }
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  const mobileLayout = (page.viewportSize()?.width ?? 1280) <= 760;

  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  const workspace = page.locator(".vault-workspace");
  await expect(page.getByLabel("Vault 이름 무결성 준비")).toHaveCount(0, { timeout: 35_000 });
  await expect(workspace).toHaveAttribute("data-workspace-sync", "saved", { timeout: 35_000 });
  const panel = await openRightPanel(page);
  const tabs = panel.getByRole("tab");
  await expect(tabs).toHaveCount(6);

  const clippedVisibleLabels = await tabs.locator("span").evaluateAll((labels) => labels.flatMap((label) => {
    const style = getComputedStyle(label);
    if (style.display === "none" || style.visibility === "hidden") return [];
    return label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight
      ? [label.textContent ?? ""]
      : [];
  }));
  expect(clippedVisibleLabels).toEqual([]);
  await expect(panel.locator(".vault-right-panel-current-mode")).toHaveText("백링크");
  const panelHeader = panel.locator(":scope > header");
  const coarsePointer = await page.evaluate(() => globalThis.matchMedia("(pointer: coarse)").matches);
  for (const tab of await tabs.all()) {
    if (coarsePointer) await tab.scrollIntoViewIfNeeded();
    await expectHorizontallyContained(panelHeader, tab);
  }
  for (const mode of ["백링크", "나가는 링크", "속성", "목차", "로컬 그래프", "File Recovery"]) {
    await panel.getByRole("tab", { name: mode }).click();
    await expect(panel.locator(".vault-right-panel-current-mode")).toHaveText(mode);
  }

  await panel.getByRole("tab", { name: "속성" }).click();
  await expect(panel.locator(".vault-right-panel-current-mode")).toHaveText("속성");
  const properties = panel.locator(".vault-properties");
  await expect(properties).toBeVisible();
  await expect.poll(() => properties.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), {
    message: "Properties must not overflow the narrow right panel"
  }).toBe(true);
  for (const control of await properties.locator("input, select, button").all()) {
    if (await control.isVisible()) await expectHorizontallyContained(properties, control);
  }

  await panel.getByRole("tab", { name: "로컬 그래프" }).click();
  await expect(panel.locator(".vault-right-panel-current-mode")).toHaveText("로컬 그래프");
  const localGraph = panel.locator(".vault-local-graph-pane");
  const graphToolbar = localGraph.getByRole("toolbar", { name: "그래프 화면 제어" });
  await expect(graphToolbar).toBeVisible();
  await expectHorizontallyContained(localGraph, graphToolbar);
  const pin = localGraph.locator(".vault-local-graph-pin");
  const settingsButton = localGraph.getByRole("button", { name: "그래프 설정 열기" });
  const accessibilitySummary = localGraph.getByText("접근 가능한 그래프 목록", { exact: true });
  const [pinBounds, settingsBounds, accessibilityBounds] = await Promise.all([
    pin.boundingBox(),
    settingsButton.boundingBox(),
    accessibilitySummary.boundingBox()
  ]);
  expect(pinBounds).not.toBeNull();
  expect(settingsBounds).not.toBeNull();
  expect(accessibilityBounds).not.toBeNull();
  if (pinBounds && settingsBounds) {
    const overlaps = pinBounds.x < settingsBounds.x + settingsBounds.width
      && pinBounds.x + pinBounds.width > settingsBounds.x
      && pinBounds.y < settingsBounds.y + settingsBounds.height
      && pinBounds.y + pinBounds.height > settingsBounds.y;
    expect(overlaps, "Local Graph pin must not cover the settings button").toBe(false);
  }
  if (pinBounds && accessibilityBounds) {
    const overlaps = pinBounds.x < accessibilityBounds.x + accessibilityBounds.width
      && pinBounds.x + pinBounds.width > accessibilityBounds.x
      && pinBounds.y < accessibilityBounds.y + accessibilityBounds.height
      && pinBounds.y + pinBounds.height > accessibilityBounds.y;
    expect(overlaps, "Local Graph pin must not cover the accessible graph list").toBe(false);
  }

  const separator = panel.getByRole("separator", { name: "오른쪽 패널 너비 조절" });
  if (mobileLayout) {
    await expect(separator).toHaveCount(0);
  } else {
    await expect(separator).toBeVisible();
    await separator.focus();
    await separator.press("Home");
    await expect(separator).toHaveAttribute("aria-valuenow", "250");
    const maximumWidth = Number(await separator.getAttribute("aria-valuemax"));
    expect(maximumWidth).toBeGreaterThanOrEqual(330);
    expect(maximumWidth).toBeLessThanOrEqual(480);
    await separator.press("End");
    await expect(separator).toHaveAttribute("aria-valuenow", `${maximumWidth}`);
    await separator.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", `${maximumWidth - 10}`);
    await separator.press("Home");
    const bounds = await separator.boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds) {
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 60);
      await page.mouse.down();
      await page.mouse.move(bounds.x - 80, bounds.y + 60, { steps: 4 });
      await page.mouse.up();
    }
    const draggedWidth = Number(await separator.getAttribute("aria-valuenow"));
    expect(draggedWidth).toBeGreaterThan(250);
    expect(draggedWidth).toBeLessThanOrEqual(maximumWidth);
    await page.waitForTimeout(900);
    await expect(workspace).toHaveAttribute("data-workspace-sync", "saved");
    await page.reload();
    await unlockEncryptedVault(page, fixture.viewerAuth.password);
    await expect(page.getByLabel("Vault 이름 무결성 준비")).toHaveCount(0, { timeout: 35_000 });
    await expect(page.locator(".vault-workspace"))
      .toHaveAttribute("data-workspace-sync", "saved", { timeout: 35_000 });
    const restoredPanel = await openRightPanel(page);
    await expect(restoredPanel.getByRole("separator", { name: "오른쪽 패널 너비 조절" }))
      .toHaveAttribute("aria-valuenow", `${draggedWidth}`);
  }

  if (browserName === "webkit") allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  await expectCleanRuntime(diagnostics, fixture);
});
