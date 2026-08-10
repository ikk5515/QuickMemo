/* global Node, document, getComputedStyle */

import { expect, test } from "@playwright/test";
import {
  loginDirectly,
  navigateWithinApp,
  resetEmulators,
  seedScenario
} from "./helpers.mjs";

const boundsTolerance = 1.5;

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;

    return {
      body: Math.max(0, body.scrollWidth - body.clientWidth),
      root: Math.max(0, root.scrollWidth - root.clientWidth)
    };
  });

  expect.soft(overflow, "page must not overflow horizontally").toEqual({
    body: 0,
    root: 0
  });
}

async function expectInside(page, containerSelector, childSelector, label) {
  const bounds = await page.evaluate(
    ({ childSelector: child, containerSelector: container }) => {
      const containerElement = document.querySelector(container);
      const childElement = document.querySelector(child);

      if (!containerElement || !childElement) {
        return {
          childFound: Boolean(childElement),
          containerFound: Boolean(containerElement)
        };
      }

      const containerRect = containerElement.getBoundingClientRect();
      const childRect = childElement.getBoundingClientRect();

      return {
        childBottom: childRect.bottom,
        childFound: true,
        childLeft: childRect.left,
        childRight: childRect.right,
        childTop: childRect.top,
        containerBottom: containerRect.bottom,
        containerFound: true,
        containerLeft: containerRect.left,
        containerRight: containerRect.right,
        containerTop: containerRect.top
      };
    },
    { childSelector, containerSelector }
  );

  expect.soft(bounds, `${label}: required elements must exist`).toMatchObject({
    childFound: true,
    containerFound: true
  });
  if (!bounds.childFound || !bounds.containerFound) {
    return;
  }

  expect.soft(bounds.childLeft, `${label}: left edge`).toBeGreaterThanOrEqual(
    bounds.containerLeft - boundsTolerance
  );
  expect.soft(bounds.childRight, `${label}: right edge`).toBeLessThanOrEqual(
    bounds.containerRight + boundsTolerance
  );
  expect.soft(bounds.childTop, `${label}: top edge`).toBeGreaterThanOrEqual(
    bounds.containerTop - boundsTolerance
  );
  expect.soft(bounds.childBottom, `${label}: bottom edge`).toBeLessThanOrEqual(
    bounds.containerBottom + boundsTolerance
  );
}

async function expectNavigationLabelsOnOneLine(page) {
  const renderedLines = await page.locator(".nav-links a").evaluateAll((links) =>
    links.map((link) => {
      const linePositions = new Set();

      for (const child of link.childNodes) {
        if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) {
          continue;
        }

        const range = document.createRange();
        range.selectNodeContents(child);
        for (const rectangle of range.getClientRects()) {
          linePositions.add(Math.round(rectangle.top * 2) / 2);
        }
      }

      return {
        label: link.textContent?.trim() ?? "",
        lines: linePositions.size
      };
    })
  );

  expect(renderedLines.length, "primary navigation must be rendered").toBeGreaterThan(0);
  for (const { label, lines } of renderedLines) {
    expect.soft(lines, `${label} navigation label must stay on one line`).toBe(1);
  }
}

async function expectTopbarControlsDoNotOverlap(page) {
  const bounds = await page.evaluate(() => {
    const brand = document.querySelector(".topbar > .brand");
    const controls = document.querySelector(".topbar-user");

    if (!brand || !controls) {
      return null;
    }

    const brandRect = brand.getBoundingClientRect();
    const controlsRect = controls.getBoundingClientRect();

    return {
      brandRight: brandRect.right,
      controlsLeft: controlsRect.left,
      rowsOverlap: brandRect.bottom > controlsRect.top && controlsRect.bottom > brandRect.top
    };
  });

  expect(bounds, "topbar brand and controls must exist").not.toBeNull();
  if (bounds?.rowsOverlap) {
    expect.soft(bounds.brandRight, "topbar brand must not overlap user controls")
      .toBeLessThanOrEqual(bounds.controlsLeft + boundsTolerance);
  }
}

async function expectScheduleActionsOnOneRow(page) {
  const actionRows = await page.locator(".schedule-header-actions").evaluate((container) => {
    const rectangles = Array.from(container.children)
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && element.getClientRects().length > 0;
      })
      .map((element) => element.getBoundingClientRect());

    return {
      actionCount: rectangles.length,
      lowestBottom: Math.min(...rectangles.map(({ bottom }) => bottom)),
      highestTop: Math.max(...rectangles.map(({ top }) => top))
    };
  });

  expect(actionRows.actionCount, "schedule header actions must be rendered").toBeGreaterThanOrEqual(4);
  expect.soft(
    actionRows.highestTop,
    "schedule header actions must share one vertically overlapping row"
  ).toBeLessThan(actionRows.lowestBottom);
}

test("authenticated app layouts keep controls contained across primary routes", async ({
  page,
  request
}) => {
  test.setTimeout(90_000);
  const fixture = await seedScenario(request, "authenticated-verified");
  const viewportWidth = page.viewportSize()?.width ?? 1280;
  const mobileLayout = viewportWidth <= 520;
  const touchLayout = viewportWidth <= 1024;

  await loginDirectly(page, fixture.viewerAuth);

  await navigateWithinApp(page, "/home");
  await expect(page.getByRole("region", { name: "QuickMemo 홈" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInside(page, ".home-dashboard", ".home-hero", "home hero");
  if (mobileLayout) {
    await expectNavigationLabelsOnOneLine(page);
  }
  if (touchLayout) {
    await expectTopbarControlsDoNotOverlap(page);
  }

  await page.getByRole("button", { name: "설정", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "설정" });
  await expect(settingsDialog).toBeVisible();
  await expectInside(
    page,
    ".app-settings-modal",
    ".app-settings-modal > .password-change-close",
    "settings close button"
  );
  await settingsDialog.getByRole("button", { name: "설정 닫기" }).click();

  await navigateWithinApp(page, "/app");
  await expect(page.locator(".rich-editor-toolbar")).toBeVisible();
  await expect(page.locator(".text-color-palette")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInside(
    page,
    ".rich-editor-toolbar",
    ".rich-editor-toolbar .text-color-palette",
    "note text color palette"
  );

  await navigateWithinApp(page, "/library");
  await expect(page.getByRole("heading", { name: "전체 자료", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInside(page, ".library-workspace", ".library-header", "library header");
  await expectInside(
    page,
    ".library-results-panel",
    ".library-results-header",
    "library results header"
  );
  await expectInside(
    page,
    ".library-results-header",
    ".library-sort-control",
    "library sort control"
  );

  await navigateWithinApp(page, "/schedule?view=todo");
  await expect(
    page.getByRole("heading", { name: "할 일", exact: true, level: 1 })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInside(page, ".schedule-workspace", ".schedule-header", "schedule header");
  await expectInside(
    page,
    ".schedule-category-toolbar",
    ".schedule-category-filter",
    "schedule category filter"
  );
  if (touchLayout) {
    await expectScheduleActionsOnOneRow(page);
  }

  await page.getByRole("button", { name: "달력", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "달력", exact: true, level: 1 })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInside(page, ".calendar-panel", ".calendar-grid", "calendar grid");

  await page.getByRole("button", { name: "매트릭스", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "매트릭스", exact: true, level: 1 })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInside(page, ".matrix-layout", ".matrix-grid", "matrix grid");

  await page.getByRole("button", { name: "반복 업무", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "반복 업무", exact: true, level: 1 })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInside(
    page,
    ".recurring-main-panel",
    ".recurring-date-strip",
    "recurring date strip"
  );
});

test("setup, login, and admin layouts stay contained across responsive widths", async ({
  page,
  request
}) => {
  test.setTimeout(90_000);
  await resetEmulators(request);
  const setupPage = await page.context().newPage();

  await setupPage.goto("/setup");
  await expect(
    setupPage.getByRole("heading", { name: "초기 설정 상태 확인", exact: true })
  ).toBeVisible();
  await expect(setupPage.getByRole("button", { name: "다시 확인", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(setupPage);
  await expectInside(setupPage, ".auth-page", ".setup-panel", "setup panel");
  await setupPage.close();

  const fixture = await seedScenario(request, "admin-layout");
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: /사용자를 선택하고/u })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInside(page, ".login-layout", ".login-copy", "login copy");
  await expectInside(page, ".login-layout", ".roster-panel", "login roster");

  await loginDirectly(page, fixture.viewerAuth);
  await navigateWithinApp(page, "/admin");
  await expect(
    page.getByRole("heading", { name: "사용자, 공유 권한, 노트를 관리합니다", exact: true })
  ).toBeVisible();
  await expect(page.getByRole("tablist", { name: "관리자 기능" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInside(page, ".admin-workspace", ".workspace-heading", "admin heading");
  await expectInside(page, ".admin-workspace", ".admin-stats-grid", "admin stats");
  await expect(
    page.getByRole("heading", { name: fixture.viewerAuth.displayName, exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("사용자 목록을 불러오지 못했습니다.", { exact: true })
  ).toHaveCount(0);
});
