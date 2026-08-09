import { expect, test } from "@playwright/test";
import {
  expectCleanRuntime,
  expectNoHorizontalOverflow,
  loginDirectly,
  navigateWithinApp,
  observePage,
  seedScenario
} from "./helpers.mjs";

const workTitle = "E2E 업무 일정";
const personalTitle = "E2E 개인 일정";

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

async function expectFilterAcrossViews(page, visibleTitle, hiddenTitle) {
  for (const view of ["할 일", "달력", "매트릭스"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(page.getByRole("heading", { name: view, exact: true })).toBeVisible();
    await expectFilteredTasks(page, visibleTitle, hiddenTitle);
    await expectNoHorizontalOverflow(page);
  }
}

async function unlockEncryptionKey(page, password) {
  await expect(page.getByRole("heading", { name: /암호화 키를 열어주세요/u })).toBeVisible();
  await page.getByPlaceholder("비밀번호").fill(password);
  await page.getByRole("button", { name: "열기", exact: true }).click();
}

test("schedule categories filter every primary view and persist the saved default", async ({
  page,
  request
}) => {
  test.setTimeout(90_000);
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);

  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/schedule?view=todo");
  await expect(page.getByRole("heading", { name: "할 일", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "일정 분류" })).toBeVisible();

  await createTask(page, workTitle, "work");
  await createTask(page, personalTitle, "personal");

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
  await expectCleanRuntime(diagnostics, fixture);
});
