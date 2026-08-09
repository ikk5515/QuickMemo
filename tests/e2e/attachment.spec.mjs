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
const pdfAttachmentFileName = "e2e-worker-canvas.pdf";

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

test("PDF attachment renders through the real worker and canvas without runtime errors", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "pdf-attachment");
  const diagnostics = observePage(page);

  await unlockV2Share(page, fixture);
  await expect(page.getByText(pdfAttachmentFileName)).toBeVisible();
  const workerResponse = page.waitForResponse(
    (response) => response.ok() && /pdf(?:js-dist)?.*worker.*\.mjs/iu.test(response.url()),
    { timeout: 30_000 }
  );

  await page.getByRole("button", { name: "미리보기" }).click();

  const previewDialog = page.getByRole("dialog", { name: pdfAttachmentFileName });
  const previewFrame = previewDialog.getByLabel(`${pdfAttachmentFileName} PDF 미리보기`);
  const canvas = previewFrame.locator("canvas.pdf-preview-canvas-page");

  await expect(previewDialog).toBeVisible();
  await workerResponse;
  await expect(canvas).toHaveCount(1, { timeout: 30_000 });
  await expect(previewFrame.getByRole("status")).toHaveCount(0, { timeout: 30_000 });
  await expect(previewFrame.locator(".file-preview-error")).toHaveCount(0);

  const renderedCanvas = await canvas.evaluate((element) => {
    const context = element.getContext("2d");

    if (!context) {
      return { darkPixels: 0, height: element.height, width: element.width };
    }

    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let darkPixels = 0;

    for (let index = 0; index < pixels.length; index += 4) {
      if (
        pixels[index + 3] > 0
        && (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)
      ) {
        darkPixels += 1;
      }
    }

    return { darkPixels, height: element.height, width: element.width };
  });

  expect(renderedCanvas.width).toBeGreaterThan(0);
  expect(renderedCanvas.height).toBeGreaterThan(0);
  expect(renderedCanvas.darkPixels).toBeGreaterThan(0);
  await expectNoHorizontalOverflow(page);

  await previewDialog.getByRole("button", { name: "파일 미리보기 닫기" }).click();
  await expect(previewDialog).toBeHidden();
  await expectCleanRuntime(diagnostics, fixture);
});
