/* global window */

import { expect, test } from "@playwright/test";
import {
  expectCleanRuntime,
  expectNoHorizontalOverflow,
  observePage,
  openV2Share,
  seedScenario
} from "./helpers.mjs";

test.use({ colorScheme: "dark" });

test("secure share is keyboard-accessible without horizontal overflow in dark mode", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "responsive");
  const diagnostics = observePage(page);
  const popupInfrastructureRequests = [];
  page.on("request", (browserRequest) => {
    if (browserRequest.url().startsWith("https://apis.google.com/js/api.js")) {
      popupInfrastructureRequests.push(browserRequest.url());
    }
  });

  await openV2Share(page, fixture);
  expect(
    await page.evaluate(() => window.matchMedia("(prefers-color-scheme: dark)").matches)
  ).toBe(true);
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
  await expect(page.getByRole("button", { name: "보안 공유 열기" })).toHaveCount(0);
  const renameButton = page.getByRole("button", { name: "이름 변경" });
  await renameButton.focus();
  await expect(renameButton).toBeFocused();
  await page.keyboard.press("Enter");
  const renameInput = page.getByLabel("표시 이름");
  await expect(renameInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(renameButton).toBeFocused();
  await expect(page.getByText("내 댓글 이름")).toBeVisible();
  await expect(page.getByText("guest1, 네트워크 대역 203.226")).toBeVisible();
  await expect(
    page.getByText("전체 IP 주소가 아닌 일부 네트워크 대역만 표시됩니다.")
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("203.226.244.27");
  await expectNoHorizontalOverflow(page);
  expect(
    popupInfrastructureRequests,
    "anonymous comment access must not load Firebase popup infrastructure"
  ).toEqual([]);
  await expectCleanRuntime(diagnostics, fixture);
});
