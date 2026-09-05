/* global URL, window */

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { readVaultEditorSource } from "./vault-editor-helpers.mjs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  expectCleanRuntime,
  expectNoHorizontalOverflow,
  loginDirectly,
  navigateWithinApp,
  observePage,
  seedScenario
} from "./helpers.mjs";

const focusedProjects = new Set([
  "vault-chromium-desktop-1280",
  "vault-chromium-mobile-390",
  "vault-webkit-desktop-1280",
  "vault-webkit-mobile-390"
]);
const attack = '<img src="/archived-file-must-not-load" onerror="window.__archivedFileExecuted=true">';
const entries = [
  {
    name: "Retained.base",
    label: "Retained.base",
    format: "base-v1",
    source: `# ARCHIVED_BASE_SECRET_83ce\nviews:\n  - type: table\n    name: '${attack}'\n`
  },
  {
    name: "Retained.canvas",
    label: "Retained.canvas",
    format: "json-canvas-v1",
    source: `${JSON.stringify({
      nodes: [{
        id: "retained-node",
        type: "text",
        x: 0,
        y: 0,
        width: 400,
        height: 200,
        text: `ARCHIVED_CANVAS_SECRET_36bd\n${attack}`
      }],
      edges: []
    }, null, 2)}\n`
  },
  {
    name: "Retained board.md",
    label: "Retained board",
    format: "markdown-v1",
    source: "---\nkanban-plugin: board\n---\n\n## 진행 중\n\n- [ ] ARCHIVED_KANBAN_SECRET_f83d\n- [x] 원본 카드 보존\n"
  }
];

async function openExplorer(page) {
  const explorer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  // Route intent and encrypted workspace restoration can settle after login.
  // "파일" is an idempotent open action; a one-shot toggle can close the panel
  // when a restoration update lands between the visibility check and click.
  await expect.poll(async () => {
    if (await explorer.isVisible()) return true;
    const files = page.getByRole("button", { name: "파일", exact: true });
    if (await files.isVisible()) await files.click({ timeout: 500 }).catch(() => undefined);
    return explorer.isVisible();
  }, { message: "Vault file explorer must settle open after session restoration" }).toBe(true);
  await expect(explorer).toBeVisible();
  return explorer;
}

async function openFileTools(explorer) {
  const details = explorer.locator("details.vault-more-tools");
  if (!(await details.evaluate((element) => element.open))) {
    await details.locator("summary").click();
  }
}

async function readDownload(download) {
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path);
}

async function expectEncryptedEntry(request, fixture, page, entry) {
  const tabId = await page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]').getAttribute("id");
  expect(tabId).toMatch(/^entry:/u);
  const noteId = tabId.slice("entry:".length);
  const response = await request.get(
    `http://127.0.0.1:8080/v1/projects/quickmemo-share-api-test/databases/(default)/documents/notes/${encodeURIComponent(noteId)}`,
    { headers: { authorization: `Bearer ${fixture.viewerAuth.idToken}` } }
  );
  expect(response.ok()).toBe(true);
  const document = await response.json();
  expect(document.fields.contentFormat.stringValue).toBe(entry.format);
  expect(document.fields.encryptedBody.mapValue.fields.algorithm.stringValue).toBe("AES-GCM");
  expect(document.fields.encryptedTitle.mapValue.fields.algorithm.stringValue).toBe("AES-GCM");
  expect(document.fields.wrappedKeys.mapValue.fields[fixture.viewerAuth.uid]).toBeDefined();
  const stored = JSON.stringify(document);
  expect(stored).not.toContain("ARCHIVED_");
  expect(stored).not.toContain(entry.name);
  expect(stored).not.toContain(entry.source);
  expect(stored).not.toContain("__archivedFileExecuted");
}

test("retired formats remain encrypted, inert, and exportable after the menu cleanup", async ({ page, request }, testInfo) => {
  test.skip(!focusedProjects.has(testInfo.project.name), "Focused desktop/mobile Chromium and WebKit acceptance.");
  test.setTimeout(120_000);
  const diagnostics = observePage(page);
  const fixture = await seedScenario(request, "authenticated-verified");
  let attemptedMarkupRequest = false;
  page.on("request", (request) => {
    if (request.url().includes("/archived-file-must-not-load")) attemptedMarkupRequest = true;
  });
  // Observe MIME types without changing the real Blob URL or browser download.
  await page.addInitScript(() => {
    window.__archivedFileExecuted = false;
    window.__archivedFileDownloads = [];
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = createObjectURL(blob);
      window.__archivedFileDownloads.push({ url, type: blob.type });
      return url;
    };
  });
  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app?panel=files");
  const explorer = await openExplorer(page);
  await openFileTools(explorer);
  await expect(explorer.getByRole("button", { name: "Obsidian ZIP 가져오기", exact: true }))
    .toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('[aria-label="새 Canvas"], [aria-label="새 Base"], [aria-label="새 Kanban"]'))
    .toHaveCount(0);

  const zip = zipSync(Object.fromEntries(entries.map((entry) => [entry.name, strToU8(entry.source)])));
  const importConfirmation = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("3개 항목");
    await dialog.accept();
  });
  await page.locator('input[type="file"][accept*=".zip"]').setInputFiles({
    name: "retained-formats.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip)
  });
  await importConfirmation;
  await expect(page.getByText("3개 항목을 암호화해 가져왔습니다.", { exact: true }))
    .toBeVisible({ timeout: 45_000 });

  for (const entry of entries) {
    const files = await openExplorer(page);
    await files.getByRole("treeitem", { name: entry.label, exact: true }).click();
    await expect(page.getByRole("tab", { name: entry.label, exact: true })).toHaveAttribute("aria-selected", "true");
    await expectEncryptedEntry(request, fixture, page, entry);

    if (entry.format === "markdown-v1") {
      await expect(page.locator('section[aria-label="보관된 파일"]')).toHaveCount(0);

      const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
      await expect(editor).toBeVisible();
      await expect.poll(async () => await readVaultEditorSource(editor))
        .toBe(entry.source);
      await expect(page.locator(".qm-kanban-board")).toHaveCount(0);
      continue;
    }

    const preview = page.locator('section[aria-label="보관된 파일"]');
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("heading", { name: entry.name, exact: true })).toBeVisible();
    const details = preview.locator("details");
    if (!(await details.evaluate((element) => element.open))) await details.locator("summary").click();
    await expect.poll(() => preview.locator("pre").textContent()).toBe(entry.source);
    await expect(preview.locator("img, script, iframe, object, embed")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Markdown 편집기" })).toHaveCount(0);
    expect(await page.evaluate(() => window.__archivedFileExecuted)).toBe(false);
    expect(attemptedMarkupRequest).toBe(false);

    const downloadPromise = page.waitForEvent("download");
    await preview.getByRole("button", { name: "원본 내려받기", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(entry.name);
    expect(await readDownload(download)).toEqual(Buffer.from(entry.source, "utf8"));
    expect(await page.evaluate((url) => window.__archivedFileDownloads.find((item) => item.url === url)?.type, download.url()))
      .toBe("application/octet-stream");
    await expectNoHorizontalOverflow(page);
  }

  // The regular ZIP backup must retain all three original files too, including
  // Kanban frontmatter and cards now edited through the Markdown editor.
  const files = await openExplorer(page);
  await openFileTools(files);
  const exportPromise = page.waitForEvent("download");
  await files.getByRole("button", { name: "노트와 첨부파일을 복호화해 Obsidian ZIP 내보내기", exact: true }).click();
  const exported = unzipSync(new Uint8Array(await readDownload(await exportPromise)));
  for (const entry of entries) {
    expect(exported[entry.name], `ZIP must retain ${entry.name}`).toBeDefined();
    expect(strFromU8(exported[entry.name])).toBe(entry.source);
  }

  if ((page.viewportSize()?.width ?? 1280) <= 760) {
    await files.getByRole("button", { name: "왼쪽 패널 닫기", exact: true }).click();
  }
  await page.getByRole("button", { name: "명령 팔레트", exact: true }).click();
  const commands = page.getByRole("dialog", { name: "명령 팔레트" });
  await expect(commands).toBeVisible();
  for (const label of ["새 Canvas 만들기", "새 Base 만들기", "새 Kanban 만들기"]) {
    await commands.getByRole("combobox", { name: "명령 검색" }).fill(label);
    await expect(commands.getByRole("option", { name: label, exact: true })).toHaveCount(0);
    await expect(commands.getByText("일치하는 명령이 없습니다.", { exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expectCleanRuntime(diagnostics, fixture, entries.map((entry) => entry.source));
});
