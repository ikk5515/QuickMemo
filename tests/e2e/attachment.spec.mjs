/* global Buffer */

import { expect, test } from "@playwright/test";
import {
  expectCleanRuntime,
  expectNoHorizontalOverflow,
  observePage,
  resetEmulators,
  seedScenario,
  unlockV2Share
} from "./helpers.mjs";

const attachmentFileName = "e2e-attachment.txt";
const attachmentText = "E2E 독립 첨부파일 본문";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await resetEmulators(request);
});

test.afterAll(async ({ request }) => {
  await resetEmulators(request);
});

test("download-enabled TXT attachment previews and downloads exact plaintext", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "save-copy-attachment");
  const diagnostics = observePage(page);

  await unlockV2Share(page, fixture);
  await expect(page.getByText(attachmentFileName)).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const previewButton = page.getByRole("button", { name: "미리보기" });
  await previewButton.click();

  const previewDialog = page.getByRole("dialog", { name: attachmentFileName });
  await expect(previewDialog).toBeVisible();
  await expect(previewDialog).toContainText(attachmentText);
  await expectNoHorizontalOverflow(page);
  await previewDialog.getByRole("button", { name: "파일 미리보기 닫기" }).click();
  await expect(previewDialog).toBeHidden();
  await expect(previewButton).toBeFocused();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "다운로드" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe(attachmentFileName);
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  expect(Buffer.concat(chunks).equals(Buffer.from(attachmentText, "utf8"))).toBe(true);
  await expectNoHorizontalOverflow(page);
  await expectCleanRuntime(diagnostics, fixture);
});
