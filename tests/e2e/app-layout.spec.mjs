/* global document, getComputedStyle */

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
  const touchLayout = viewportWidth <= 1024;
  const mobileRibbon = viewportWidth <= 760;

  await loginDirectly(page, fixture.viewerAuth);

  await expect(page).toHaveURL((url) => url.pathname === "/app" && url.searchParams.get("panel") === "files");
  const workspaceRibbon = page.getByRole("complementary", { name: "작업공간 리본" });
  await expect(workspaceRibbon).toBeVisible();
  await expect(page.getByRole("link", { name: "파일 탐색기" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".note-drawer")).toBeVisible();
  if (!mobileRibbon) {
    await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);
  if (touchLayout) {
    await expectTopbarControlsDoNotOverlap(page);
    const targetBounds = await workspaceRibbon.locator("a:visible, button:visible").evaluateAll((targets) =>
      targets.map((target) => {
        const rectangle = target.getBoundingClientRect();
        return { height: rectangle.height, label: target.getAttribute("aria-label") ?? "", width: rectangle.width };
      })
    );
    for (const target of targetBounds) {
      expect.soft(target.height, `${target.label} touch height`).toBeGreaterThanOrEqual(44);
      expect.soft(target.width, `${target.label} touch width`).toBeGreaterThanOrEqual(44);
    }
  }

  await page.getByRole("button", { name: "작업공간 메뉴 열기" }).click();
  const workspaceDrawer = page.getByRole("dialog", { name: "QuickMemo 작업공간 메뉴" });
  await expect(workspaceDrawer).toBeVisible();
  await expect(workspaceDrawer.getByRole("button", { name: "로그아웃" })).toBeVisible();
  if (touchLayout) {
    const shellTouchTargets = await page
      .locator('.obsidian-titlebar-brand, .obsidian-workspace-drawer > header .icon-button')
      .evaluateAll((targets) => targets.map((target) => {
        const rectangle = target.getBoundingClientRect();
        return {
          height: rectangle.height,
          label: target.getAttribute("aria-label") ?? "",
          width: rectangle.width
        };
      }));
    for (const target of shellTouchTargets) {
      expect.soft(target.height, `${target.label} touch height`).toBeGreaterThanOrEqual(44);
      expect.soft(target.width, `${target.label} touch width`).toBeGreaterThanOrEqual(44);
    }
  }
  await workspaceDrawer.getByRole("button", { name: "설정", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "설정" });
  await expect(settingsDialog).toBeVisible();
  await expectInside(
    page,
    ".app-settings-modal",
    ".app-settings-modal > .password-change-close",
    "settings close button"
  );
  await settingsDialog.getByRole("button", { name: "설정 닫기" }).click();
  await expect(page.getByRole("button", { name: "작업공간 메뉴 열기" })).toBeFocused();

  await navigateWithinApp(page, "/app?panel=search");
  await expect(page.locator(".rich-editor-toolbar")).toBeVisible();
  await expect(page.getByLabel("노트 제목과 내용 검색")).toBeFocused();
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
  await expect(page.locator('[data-workspace-section="admin"]')).toHaveCount(1);
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
