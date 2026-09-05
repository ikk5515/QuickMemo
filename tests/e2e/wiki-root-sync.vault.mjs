/* global window, Event, URL, URLSearchParams */
import { expect, test } from "@playwright/test";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors, expectCleanRuntime,
  loginDirectly, navigateWithinApp, observePage, openVaultMoreTool, seedScenario
} from "./helpers.mjs";
import { readVaultEditorSource, saveVaultDocument } from "./vault-editor-helpers.mjs";
import { expectVisibleWikiMotionFinished } from "./wiki-motion-helpers.mjs";

async function explorer(page) {
  const panel = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  const toggle = page.locator('.vault-ribbon button[aria-controls="vault-left-panel"][aria-expanded]');
  // Wait for the unlocked workspace and restored layout before reading drawer state.
  // An open phone drawer makes the ribbon inert; absence during loading is not closed.
  await expect(toggle).toBeAttached();
  await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", /^(?:saved|pending|conflict)$/);
  if (await toggle.getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "파일", exact: true }).click();
  await expect(panel).toBeVisible(); return panel;
}
async function createNote(page, title, body) {
  const panel = await explorer(page);
  const create = panel.getByRole("button", { name: "새 노트", exact: true });
  await expect(create).toBeEnabled({ timeout: 30_000 }); await create.click();
  await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "노트 이름", exact: true }).fill(title);
  const editor = page.getByRole("textbox", { name: "Markdown 편집기", exact: true });
  await expect(editor).toBeEditable(); await editor.fill(body);
  await expect.poll(() => readVaultEditorSource(editor)).toBe(body);
  await saveVaultDocument(page, { allowClean: true });
}
async function settings(page) {
  await page.bringToFront(); await openVaultMoreTool(page, "위키 공개 설정");
  const dialog = page.getByRole("dialog", { name: "위키 공개 설정", exact: true });
  await expect(dialog.getByRole("textbox", { name: "위키 주소", exact: true })).toBeEnabled();
  return dialog;
}
async function closeSettings(dialog) { await dialog.getByRole("button", { name: "공개 설정 닫기", exact: true }).click(); }
async function search(reader) {
  await expect(reader.getByRole("main", { name: "위키 읽기 패널", exact: true })).toBeVisible();
  const input = reader.getByRole("searchbox", { name: "위키 검색", exact: true });
  const toggle = reader.getByRole("button", { name: /^위키 목록 (열기|닫기)$/ });
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await expect(input).toBeVisible(); return input;
}
async function expectPublicEntry(reader, title, body) {
  await (await search(reader)).fill(title);
  await reader.getByRole("navigation", { name: "위키 검색 결과", exact: true }).getByRole("link", { name: new RegExp(`^${title}`) }).click();
  await expect(reader.locator('.wiki-panel[data-active="true"] .wiki-body')).toContainText(body);
}
function manifestResponse(reader, slug, status) {
  return reader.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/published-wikis" && url.searchParams.get("action") === "manifest"
      && url.searchParams.get("slug") === slug && response.status() === status;
  }, { timeout: 30_000 });
}
async function consentAndPublish(dialog, button) {
  await dialog.getByRole("checkbox", { name: "선택한 범위와 이후 저장되는 변경 사항을 누구나 볼 수 있도록 공개합니다.", exact: true }).check();
  const save = dialog.getByRole("button", { name: button, exact: true });
  await expect(save).toBeEnabled(); await save.click();
  await expect(dialog.getByText("공개했습니다. 선택한 범위의 변경 사항은 저장 후 자동 반영됩니다.", { exact: true })).toBeVisible({ timeout: 30_000 });
}

test("keeps one custom Wiki root while folder descendants sync, explicit grants expand scope, and renamed or revoked URLs close", async ({ page, browser, request }, testInfo) => {
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  await loginDirectly(page, fixture.viewerAuth, diagnostics); await navigateWithinApp(page, "/app");
  await createNote(page, "공개 금지 기록", "권한밖의본문은끝까지비공개");
  const privateTabId = await page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]').getAttribute("id");
  expect(privateTabId).toMatch(/^entry:/u);
  const privateNoteId = privateTabId.slice("entry:".length);
  await createNote(page, "개별 공유 항목", "명시적으로선택하기전에는비공개");
  const panel = await explorer(page);
  page.once("dialog", (dialog) => dialog.accept("동기화 지식"));
  await panel.getByRole("button", { name: "새 폴더", exact: true }).click();
  const rootFolder = panel.getByRole("treeitem", { name: "동기화 지식", exact: true });
  await expect(rootFolder).toBeVisible(); await rootFolder.click();
  await createNote(page, "처음 공개 문서", "# 처음 공개 문서\n\n기존폴더범위유지확인\n\n[[공개 금지 기록]]");
  const publishedTabId = await page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]').getAttribute("id");
  expect(publishedTabId).toMatch(/^entry:/u);
  const publishedSourceNoteId = publishedTabId.slice("entry:".length);

  const slug = `root-${fixture.viewerAuth.uid.replace(/[^a-z0-9]/giu, "").toLowerCase().slice(0, 18)}-${Date.now().toString(36)}`;
  const renamedSlug = `${slug}-v2`;
  let dialog = await settings(page);
  await dialog.getByRole("textbox", { name: "위키 주소", exact: true }).fill(slug);
  await expect(dialog.getByText("사용할 수 있는 주소입니다.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "주소 저장", exact: true }).click();
  await expect(dialog.getByText("주소 등록됨 · 비공개", { exact: true })).toBeVisible();
  const publicUrl = await dialog.getByRole("region", { name: "공개 링크", exact: true }).getByRole("link").getAttribute("href");
  expect(new URL(publicUrl).pathname).toBe(`/wiki/${slug}`);
  expect(new URL(publicUrl).search).toBe(""); expect(publicUrl).not.toContain("pw1_");
  await dialog.getByRole("searchbox", { name: "공개 범위 검색", exact: true }).fill("동기화 지식");
  await dialog.getByRole("checkbox", { name: "동기화 지식", exact: true }).check();
  const preview = dialog.getByRole("region", { name: "공개할 내용", exact: true });
  await expect(preview.getByRole("list")).toContainText("처음 공개 문서");
  await expect(preview.getByRole("list")).not.toContainText("개별 공유 항목");
  await expect(preview.getByRole("list")).not.toContainText("공개 금지 기록");
  await consentAndPublish(dialog, "위키 게시"); await closeSettings(dialog);

  const anonymous = await browser.newContext({ viewport: testInfo.project.use.viewport, locale: "ko-KR", baseURL: "http://127.0.0.1:4174" });
  try {
    const reader = await anonymous.newPage();
    const initialManifest = manifestResponse(reader, slug, 200);
    await reader.goto(publicUrl);
    const publishedManifest = await (await initialManifest).json();
    const publishedNoteId = publishedManifest.entries.find((entry) => entry.title === "처음 공개 문서" && entry.kind === "markdown")?.id;
    expect(publishedNoteId).toMatch(/^e_[0-9a-f]{32}$/u);
    await expectPublicEntry(reader, "처음 공개 문서", "기존폴더범위유지확인");
    await expect(reader.locator("body")).not.toContainText("공개 금지 기록");
    await expect(reader.locator("body")).not.toContainText("개별 공유 항목");
    await expect(reader.locator("body")).not.toContainText("권한밖의본문은끝까지비공개");

    // Canonical custom-slug URLs enforce the same explicit-target boundary as
    // legacy publication URLs, without silently opening an unrelated document.
    const directLink = await anonymous.newPage();
    try {
      for (const query of [new URLSearchParams({ page: "missing-private-path" }), new URLSearchParams({ note: privateNoteId }), new URLSearchParams({ note: publishedSourceNoteId })]) {
        await directLink.goto(`${publicUrl}?${query}`);
        await expect(directLink.getByRole("heading", { name: "위키를 열 수 없습니다", exact: true })).toBeVisible();
        await expect(directLink.locator("body")).toHaveText("위키를 열 수 없습니다");
        // The test build injects one hidden navigation bridge outside the app.
        await expect(directLink.locator(".wiki-panel, .wiki-sidebar, [contenteditable], button:not([data-quickmemo-e2e-navigation]), a")).toHaveCount(0);
        await expect(directLink.getByRole("button")).toHaveCount(0);
      }
      await directLink.goto(`${publicUrl}?${new URLSearchParams({ note: publishedNoteId })}`);
      await expect(directLink).toHaveURL((url) => url.pathname === `/wiki/${slug}`
        && Boolean(url.searchParams.get("page")) && !url.searchParams.has("note"));
      await expect(directLink.locator('.wiki-panel[data-active="true"] .wiki-body')).toContainText("기존폴더범위유지확인");
      expect(directLink.url()).not.toContain(publishedNoteId);
    } finally { await directLink.close(); }

    // Add a descendant through the encrypted editor UI after the folder grant.
    await page.bringToFront(); await (await explorer(page)).getByRole("treeitem", { name: "동기화 지식", exact: true }).click({ button: "right" });
    page.once("dialog", (prompt) => prompt.accept("나중에 만든 하위 폴더"));
    await page.getByRole("menuitem", { name: "하위 폴더 만들기", exact: true }).click();
    const freshPanel = await explorer(page);
    const parent = freshPanel.getByRole("treeitem", { name: "동기화 지식", exact: true });
    if (await parent.getAttribute("aria-expanded") !== "true") await parent.click();
    const child = freshPanel.getByRole("treeitem", { name: "나중에 만든 하위 폴더", exact: true });
    await expect(child).toBeVisible(); await child.click();
    await createNote(page, "자동 반영 문서", "# 자동 반영 문서\n\n새하위폴더본문자동반영확인");
    await reader.bringToFront();
    await (await search(reader)).fill("");
    await expect.poll(async () => {
      await reader.evaluate(() => window.dispatchEvent(new Event("focus")));
      return reader.getByRole("navigation", { name: "위키 폴더와 메모", exact: true }).getByRole("link", { name: "자동 반영 문서", exact: true }).count();
    }, { timeout: 30_000, intervals: [1500, 2500, 5000], message: "saved descendants appear without republishing or changing the Wiki root URL" }).toBe(1);
    expect(new URL(reader.url()).pathname).toBe(`/wiki/${slug}`);
    await expectPublicEntry(reader, "자동 반영 문서", "새하위폴더본문자동반영확인");
    await expect(reader.locator("body")).not.toContainText("권한밖의본문은끝까지비공개");

    // Expanding the explicit note grant must retain the existing folder grant.
    dialog = await settings(page);
    await expect(dialog.getByRole("checkbox", { name: "동기화 지식", exact: true })).toBeChecked();
    await expect(dialog.getByRole("region", { name: "공개 링크", exact: true }).getByRole("link")).toHaveAttribute("href", publicUrl);
    await dialog.getByRole("searchbox", { name: "공개 범위 검색", exact: true }).fill("개별 공유 항목");
    await dialog.locator("summary").filter({ hasText: /^개별 메모·이미지$/u }).click();
    await dialog.getByRole("checkbox", { name: /개별 공유 항목/u }).check();
    const expandedPreview = dialog.getByRole("region", { name: "공개할 내용", exact: true });
    await expect(expandedPreview.getByRole("list")).toContainText("처음 공개 문서");
    await expect(expandedPreview.getByRole("list")).toContainText("자동 반영 문서");
    await expect(expandedPreview.getByRole("list")).toContainText("개별 공유 항목");
    await expect(expandedPreview.getByRole("list")).not.toContainText("공개 금지 기록");
    await consentAndPublish(dialog, "공개 범위 저장"); await closeSettings(dialog);
    await reader.bringToFront(); await reader.reload();
    await expectPublicEntry(reader, "개별 공유 항목", "명시적으로선택하기전에는비공개");
    await expectPublicEntry(reader, "처음 공개 문서", "기존폴더범위유지확인");
    await expectPublicEntry(reader, "자동 반영 문서", "새하위폴더본문자동반영확인");
    await expect(reader.locator("body")).not.toContainText("공개 금지 기록");

    dialog = await settings(page);
    await dialog.getByRole("textbox", { name: "위키 주소", exact: true }).fill(renamedSlug);
    await expect(dialog.getByText("사용할 수 있는 주소입니다.", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "주소 저장", exact: true }).click();
    await expect(dialog.getByText("위키 주소를 저장했습니다.", { exact: true })).toBeVisible();
    const renamedUrl = await dialog.getByRole("region", { name: "공개 링크", exact: true }).getByRole("link").getAttribute("href");
    expect(new URL(renamedUrl).pathname).toBe(`/wiki/${renamedSlug}`);
    const oldClosed = manifestResponse(reader, slug, 404);
    await reader.goto(publicUrl); await oldClosed;
    await expect(reader.getByRole("heading", { name: "위키를 열 수 없습니다", exact: true })).toBeVisible();
    await expect(reader.locator(".wiki-panel")).toHaveCount(0);
    await reader.goto(renamedUrl);
    await expectPublicEntry(reader, "처음 공개 문서", "기존폴더범위유지확인");
    await expectPublicEntry(reader, "자동 반영 문서", "새하위폴더본문자동반영확인");
    await expectPublicEntry(reader, "개별 공유 항목", "명시적으로선택하기전에는비공개");
    await expect(reader.locator("body")).not.toContainText("권한밖의본문은끝까지비공개");
    await expectVisibleWikiMotionFinished(reader);
    const panelGeometry = await reader.locator(".wiki-panel-stack").evaluate((stack) => {
      const active = stack.querySelector('.wiki-panel[data-active="true"]')?.closest(".wiki-document-slot");
      const otherWidth = stack.dataset.compact === "true" ? 0 : [...stack.querySelectorAll(".wiki-document-slot")]
        .filter((slot) => slot !== active && slot.dataset.exiting !== "true")
        .reduce((total, slot) => total + slot.getBoundingClientRect().width, 0);
      return { available: stack.clientWidth - otherWidth, active: active?.getBoundingClientRect().width ?? 0 };
    });
    expect(panelGeometry.active, "the active document uses the remaining width after transitions finish").toBeGreaterThan(0);
    expect(Math.abs(panelGeometry.active - panelGeometry.available)).toBeLessThanOrEqual(2);
    await reader.screenshot({ path: testInfo.outputPath("wiki-root-expanded-scope.png"), fullPage: true });

    await page.bringToFront(); await dialog.getByRole("button", { name: "공개 중지", exact: true }).click();
    await expect(dialog.getByText("공개를 중지했습니다. 기존 링크로 내용을 볼 수 없습니다.", { exact: true })).toBeVisible();
    const revoked = manifestResponse(reader, renamedSlug, 404);
    await reader.bringToFront(); await reader.evaluate(() => window.dispatchEvent(new Event("focus"))); await revoked;
    await expect(reader.getByRole("heading", { name: "위키를 열 수 없습니다", exact: true })).toBeVisible();
    await expect(reader.locator(".wiki-panel")).toHaveCount(0);
    await testInfo.attach("wiki-root-transition", { body: JSON.stringify({ initial: publicUrl, renamed: renamedUrl, oldStatus: 404, revokedStatus: 404 }), contentType: "application/json" });
  } finally { await anonymous.close(); }
  allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics); await expectCleanRuntime(diagnostics, fixture);
});
