/* global getComputedStyle */

import { expect, test } from "@playwright/test";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors,
  expectCleanRuntime,
  expectNoHorizontalOverflow,
  loginDirectly,
  navigateWithinApp,
  observePage,
  seedScenario
} from "./helpers.mjs";

test("the legacy reader remains vertically reachable after leaving the Vault workspace", async ({
  browserName,
  page,
  request
}) => {
  test.setTimeout(90_000);
  const viewportWidth = page.viewportSize()?.width ?? 1280;
  test.skip(viewportWidth > 980, "The legacy reader stacks only at viewport widths of 980px or less.");

  const diagnostics = observePage(page);
  const fixture = await seedScenario(request, "authenticated-verified");

  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  await expect(page.locator(".vault-workspace")).toBeVisible();

  // Enter through the lazy Vault route first so its fixed-height shell CSS is
  // present when the preserved legacy reader replaces the workspace.
  await navigateWithinApp(page, "/app/legacy");
  await expect(page.getByRole("heading", { name: "기존 노트 보관함", exact: true })).toBeVisible();
  await expect(page.getByText(/기존 HTML 노트 \d+개/u)).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  const workspace = page.locator(".legacy-readonly-workspace");
  await expect(workspace).toHaveCSS("overflow-y", "auto");

  const initialMetrics = await workspace.evaluate((element) => {
    const parent = element.parentElement;
    return {
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      parentClassName: parent?.className ?? "",
      parentOverflowY: parent ? getComputedStyle(parent).overflowY : "",
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop
    };
  });
  expect(initialMetrics).toMatchObject({
    overflowY: "auto",
    parentClassName: "vault-main",
    parentOverflowY: "hidden",
    scrollTop: 0
  });
  expect(initialMetrics.clientHeight).toBeGreaterThan(0);
  expect(initialMetrics.scrollHeight).toBeGreaterThanOrEqual(initialMetrics.clientHeight);

  if (initialMetrics.scrollHeight > initialMetrics.clientHeight) {
    if (browserName === "webkit") {
      await workspace.getByRole("button", { name: "Vault로 돌아가기", exact: true }).focus();
      await page.keyboard.press("PageDown");
    } else {
      const workspaceBounds = await workspace.boundingBox();
      expect(workspaceBounds).not.toBeNull();
      await page.mouse.move(
        workspaceBounds.x + workspaceBounds.width / 2,
        workspaceBounds.y + Math.min(80, workspaceBounds.height / 3)
      );
      await page.mouse.wheel(0, 420);
    }
    await expect.poll(() => workspace.evaluate((element) => element.scrollTop), {
      message: "a real scroll input must advance the legacy workspace scroll owner"
    }).toBeGreaterThan(0);

    if (browserName === "webkit") {
      for (let index = 0; index < 6; index += 1) {
        await page.keyboard.press("PageDown");
      }
    } else {
      await page.mouse.wheel(0, 4_000);
    }
  }
  await expect.poll(() => workspace.evaluate((element) => ({
    atBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
    scrollTop: element.scrollTop
  })), {
    message: "the legacy workspace must scroll to its final content"
  }).toMatchObject({ atBottom: true });

  const reachableBottom = await page.locator(".legacy-readonly-document").evaluate((documentElement) => {
    const workspaceElement = documentElement.closest(".legacy-readonly-workspace");
    if (!workspaceElement) return null;
    const documentBounds = documentElement.getBoundingClientRect();
    const workspaceBounds = workspaceElement.getBoundingClientRect();
    return {
      documentBottom: documentBounds.bottom,
      documentTop: documentBounds.top,
      workspaceBottom: workspaceBounds.bottom,
      workspaceTop: workspaceBounds.top
    };
  });
  expect(reachableBottom).not.toBeNull();
  expect(reachableBottom.documentBottom).toBeLessThanOrEqual(reachableBottom.workspaceBottom + 1);
  expect(reachableBottom.documentBottom).toBeGreaterThan(reachableBottom.workspaceTop);
  expect(reachableBottom.documentTop).toBeLessThan(reachableBottom.workspaceBottom);

  await expectNoHorizontalOverflow(page);
  if (browserName === "webkit") {
    allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  }
  await expectCleanRuntime(diagnostics, fixture);
});
