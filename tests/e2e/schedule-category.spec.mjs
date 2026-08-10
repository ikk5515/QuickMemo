/* global document, getComputedStyle, window */

import { expect, test } from "@playwright/test";
import {
  expectCleanRuntime,
  expectNoHorizontalOverflow,
  loginDirectly,
  navigateWithinApp,
  observePage,
  seedScenario
} from "./helpers.mjs";

test.use({ colorScheme: "light" });

const workTitle = "E2E 업무 일정 - 모바일 매트릭스 겹침 검증용 긴 제목";
const personalTitle = "E2E 개인 일정 - 태블릿 매트릭스 정렬 검증용 긴 제목";
const additionalWorkTitle = "E2E 업무 일정 - 달력 분류 표식 줄바꿈 검증";
const additionalPersonalTitle = "E2E 개인 일정 - 달력 네 건 밀도 검증";

async function createTask(page, title, category) {
  await page.getByRole("button", { name: "새 일정" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("일정 제목").fill(title);
  await dialog.getByLabel("일정 분류").selectOption(category);
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(title, { exact: true }).filter({ visible: true }).first()).toBeVisible();
}

async function expectFilteredTasks(page, visibleTitle, hiddenTitle) {
  await expect(
    page.getByText(visibleTitle, { exact: true }).filter({ visible: true }).first()
  ).toBeVisible();
  await expect(page.getByText(hiddenTitle, { exact: true })).toHaveCount(0);
}

async function expectMatrixTaskLayout(page) {
  const metrics = await page.locator(".matrix-task-row").first().evaluate((row) => {
    const selectors = {
      check: ".task-check",
      drag: ".task-drag-handle",
      flags: ".task-flags",
      main: ".task-main"
    };
    const rowRect = row.getBoundingClientRect();
    const controls = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
      const element = row.querySelector(selector);
      const rect = element?.getBoundingClientRect();

      return [name, rect ? {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width
      } : null];
    }));
    const pairs = [
      ["drag", "check"],
      ["drag", "main"],
      ["check", "main"],
      ["main", "flags"]
    ];
    const overlaps = pairs.filter(([leftName, rightName]) => {
      const left = controls[leftName];
      const right = controls[rightName];

      return left && right
        && left.left < right.right - 1
        && left.right > right.left + 1
        && left.top < right.bottom - 1
        && left.bottom > right.top + 1;
    });
    const section = row.closest(".matrix-section");
    const sectionContent = section?.querySelector(":scope > .matrix-task-list, :scope > .matrix-date-groups");
    const emptySectionHeights = Array.from(document.querySelectorAll(".matrix-section"))
      .filter((candidate) => !candidate.querySelector(".matrix-task-row"))
      .map((candidate) => candidate.getBoundingClientRect().height);
    const visibleEmptyGroupCount = Array.from(document.querySelectorAll(".matrix-date-group.empty"))
      .filter((group) => group.getClientRects().length > 0)
      .length;

    return {
      coarsePointer: window.matchMedia("(pointer: coarse)").matches,
      controls,
      emptySectionHeights,
      overlaps,
      row: {
        bottom: rowRect.bottom,
        clientWidth: row.clientWidth,
        left: rowRect.left,
        right: rowRect.right,
        scrollWidth: row.scrollWidth,
        top: rowRect.top
      },
      sectionContentOverflowY: sectionContent ? getComputedStyle(sectionContent).overflowY : null,
      visibleEmptyGroupCount,
      viewportWidth: window.innerWidth
    };
  });

  expect(metrics.overlaps, "matrix controls must not overlap").toEqual([]);
  expect(metrics.row.scrollWidth - metrics.row.clientWidth, "matrix row must not overflow").toBeLessThanOrEqual(1);
  for (const [name, rect] of Object.entries(metrics.controls)) {
    expect(rect, `${name} matrix control must exist`).not.toBeNull();
    if (!rect) {
      continue;
    }
    expect.soft(rect.left, `${name} left edge`).toBeGreaterThanOrEqual(metrics.row.left - 1);
    expect.soft(rect.right, `${name} right edge`).toBeLessThanOrEqual(metrics.row.right + 1);
    expect.soft(rect.top, `${name} top edge`).toBeGreaterThanOrEqual(metrics.row.top - 1);
    expect.soft(rect.bottom, `${name} bottom edge`).toBeLessThanOrEqual(metrics.row.bottom + 1);
  }
  if (metrics.coarsePointer) {
    for (const name of ["drag", "check"]) {
      expect.soft(metrics.controls[name].width, `${name} touch width`).toBeGreaterThanOrEqual(39);
      expect.soft(metrics.controls[name].height, `${name} touch height`).toBeGreaterThanOrEqual(39);
    }
  }
  if (metrics.viewportWidth <= 1024) {
    expect(metrics.sectionContentOverflowY).toBe("visible");
    expect(metrics.visibleEmptyGroupCount, "touch-width matrix must hide empty date groups").toBe(0);
    if (metrics.viewportWidth <= 640) {
      expect(metrics.emptySectionHeights.length, "matrix must include empty sections").toBeGreaterThan(0);
      for (const height of metrics.emptySectionHeights) {
        expect.soft(height, "mobile empty matrix cards must stay compact").toBeLessThan(160);
      }
    }
  }
}

async function expectCompactCalendarLayout(page, { categoryMarker = false } = {}) {
  const metrics = await page.locator(".calendar-grid").evaluate((grid) => {
    const marker = grid.querySelector(".calendar-task-pill.show-category");
    const pill = marker ?? grid.querySelector(".calendar-task-pill");
    const day = pill?.closest(".calendar-day") ?? grid.querySelector(".calendar-day");
    const count = day?.querySelector(".calendar-task-count");
    const title = day?.querySelector(".calendar-task-title");
    const dayRect = day?.getBoundingClientRect();
    const pillRect = pill?.getBoundingClientRect();

    return {
      countDisplay: count ? getComputedStyle(count).display : null,
      dayClientWidth: day?.clientWidth ?? 0,
      dayScrollWidth: day?.scrollWidth ?? 0,
      dayWidth: dayRect?.width ?? 0,
      pillHeight: pillRect?.height ?? 0,
      pillWidth: pillRect?.width ?? 0,
      showsCategoryMarker: Boolean(marker),
      titleDisplay: title ? getComputedStyle(title).display : null,
      viewportWidth: window.innerWidth
    };
  });

  if (metrics.viewportWidth > 640) {
    return;
  }
  expect(metrics.dayWidth, "compact calendar days must remain tappable").toBeGreaterThanOrEqual(36);
  expect(metrics.dayScrollWidth - metrics.dayClientWidth, "calendar days must not overflow").toBeLessThanOrEqual(1);
  expect(metrics.showsCategoryMarker).toBe(categoryMarker);
  if (categoryMarker) {
    expect(metrics.pillWidth, "compact calendar category width").toBeGreaterThanOrEqual(14);
    expect(metrics.pillWidth, "compact calendar category width").toBeLessThanOrEqual(18);
    expect(metrics.pillHeight, "compact calendar category height").toBeGreaterThanOrEqual(13);
    expect(metrics.pillHeight, "compact calendar category height").toBeLessThanOrEqual(16);
  } else {
    expect(metrics.pillWidth, "compact calendar dot width").toBeGreaterThanOrEqual(7);
    expect(metrics.pillWidth, "compact calendar dot width").toBeLessThanOrEqual(10);
    expect(metrics.pillHeight, "compact calendar dot height").toBeGreaterThanOrEqual(7);
    expect(metrics.pillHeight, "compact calendar dot height").toBeLessThanOrEqual(10);
  }
  expect(metrics.countDisplay).toBe("flex");
  expect(metrics.titleDisplay).toBe("none");
}

async function expectFilterAcrossViews(page, visibleTitle, hiddenTitle) {
  for (const view of ["할 일", "달력", "매트릭스"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(page.getByRole("heading", { name: view, exact: true })).toBeVisible();
    await expectFilteredTasks(page, visibleTitle, hiddenTitle);
    await expect(page.locator(".schedule-category-badge")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    if (view === "달력") {
      await expectCompactCalendarLayout(page);
    }
    if (view === "매트릭스") {
      await expectMatrixTaskLayout(page);
    }
  }
}

async function unlockEncryptionKey(page, password) {
  await expect(page.getByRole("heading", { name: /암호화 키를 열어주세요/u })).toBeVisible();
  await page.getByPlaceholder("비밀번호").fill(password);
  await page.getByRole("button", { name: "열기", exact: true }).click();
}

function allowExpectedScheduleRuntimeErrors(diagnostics) {
  for (const consoleError of diagnostics.consoleErrors) {
    if (
      consoleError.location.endsWith("/api/google-calendar-connection")
      && consoleError.text
        === "Failed to load resource: the server responded with a status of 404 (Not Found)"
    ) {
      diagnostics.expectedConsoleErrors.add(consoleError);
    }
    if (
      consoleError.location.includes("127.0.0.1:8080/google.firestore.v1.Firestore/")
      && consoleError.text === "Failed to load resource: The network connection was lost."
    ) {
      diagnostics.expectedTransientFirestoreTransportErrors.add(consoleError);
    }
  }
  for (const pageError of diagnostics.pageErrors) {
    if (
      /^\/127\.0\.0\.1:8080\/google\.firestore\.v1\.Firestore\/(?:Listen|Write)\/channel\?.+ due to access control checks\.$/u
        .test(pageError)
    ) {
      diagnostics.expectedPageErrors.add(pageError);
    }
  }
}

test("schedule categories filter every primary view and persist the saved default", async ({
  page,
  request
}) => {
  test.setTimeout(90_000);
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);

  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  expect(
    await page.evaluate(() => window.matchMedia("(prefers-color-scheme: dark)").matches)
  ).toBe(false);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await navigateWithinApp(page, "/schedule?view=todo");
  await expect(page.getByRole("heading", { name: "할 일", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "일정 분류" })).toBeVisible();

  await createTask(page, workTitle, "work");
  await createTask(page, personalTitle, "personal");
  await createTask(page, additionalWorkTitle, "work");
  await createTask(page, additionalPersonalTitle, "personal");

  await expect(page.getByRole("button", { name: "전체 일정 보기" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByLabel("분류 업무").first()).toBeVisible();
  await expect(page.getByLabel("분류 개인").first()).toBeVisible();

  await page.getByRole("button", { name: "업무 일정 보기" }).click();
  await expect(page.getByRole("button", { name: "업무 일정 보기" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expectFilterAcrossViews(page, workTitle, personalTitle);

  await page.getByRole("button", { name: "개인 일정 보기" }).click();
  await expect(page.getByRole("button", { name: "개인 일정 보기" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expectFilterAcrossViews(page, personalTitle, workTitle);

  await page.getByRole("button", { name: "전체 일정 보기" }).click();
  await expect(page.getByLabel("분류 업무").first()).toBeVisible();
  await expect(page.getByLabel("분류 개인").first()).toBeVisible();
  await page.getByRole("button", { name: "달력", exact: true }).click();
  await expect(page.locator(".calendar-grid").getByLabel("분류 업무").first()).toBeVisible();
  await expect(page.locator(".calendar-grid").getByLabel("분류 개인").first()).toBeVisible();
  await expectCompactCalendarLayout(page, { categoryMarker: true });
  const populatedDay = page.locator(".calendar-day").filter({ hasText: "4개" }).first();
  await populatedDay.click();
  await expect(page.locator(".calendar-agenda").getByText(workTitle, { exact: true })).toBeVisible();
  await expect(page.locator(".calendar-agenda").getByText(personalTitle, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "개인 일정 보기" }).click();

  await page.getByRole("button", { name: "설정" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "설정" });
  await settingsDialog.getByLabel("일정 기본 분류 보기").selectOption("personal");
  await settingsDialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(settingsDialog.getByText("설정을 저장했습니다.")).toBeVisible();
  await settingsDialog.getByRole("button", { name: "설정 닫기" }).click();

  await page.getByRole("button", { name: "전체 일정 보기" }).click();
  await page.reload();
  await unlockEncryptionKey(page, fixture.viewerAuth.password);
  await expect(page.getByRole("button", { name: "개인 일정 보기" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expectFilteredTasks(page, personalTitle, workTitle);
  await expectNoHorizontalOverflow(page);
  allowExpectedScheduleRuntimeErrors(diagnostics);
  await expectCleanRuntime(diagnostics, fixture);
});

test("schedule category layout remains contained in dark mode", async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);

  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  expect(
    await page.evaluate(() => window.matchMedia("(prefers-color-scheme: dark)").matches)
  ).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement)
      .getPropertyValue("--color-app-bg")
      .trim())
  ).toBe("#09090b");
  await navigateWithinApp(page, "/schedule?view=matrix");
  await expect(page.getByRole("heading", { name: "매트릭스", exact: true })).toBeVisible();

  await createTask(page, workTitle, "work");
  await createTask(page, personalTitle, "personal");
  await expect(page.getByLabel("분류 업무").first()).toBeVisible();
  await expect(page.getByLabel("분류 개인").first()).toBeVisible();
  await expectMatrixTaskLayout(page);
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "업무 일정 보기" }).click();
  await expectFilteredTasks(page, workTitle, personalTitle);
  await expect(page.locator(".schedule-category-badge")).toHaveCount(0);
  await expectMatrixTaskLayout(page);
  await expectNoHorizontalOverflow(page);
  allowExpectedScheduleRuntimeErrors(diagnostics);
  await expectCleanRuntime(diagnostics, fixture);
});
