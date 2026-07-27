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

  await openV2Share(page, fixture);
  expect(
    await page.evaluate(() => window.matchMedia("(prefers-color-scheme: dark)").matches)
  ).toBe(true);
  const openButton = page.getByRole("button", { name: "보안 공유 열기" });
  await openButton.focus();
  await expect(openButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectCleanRuntime(diagnostics, fixture);
});
