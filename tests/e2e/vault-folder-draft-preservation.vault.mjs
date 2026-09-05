import { expect, test } from "@playwright/test";
import { readVaultEditorSource, saveVaultDocument } from "./vault-editor-helpers.mjs";
import { expectCleanRuntime, loginDirectly, navigateWithinApp, observePage, ownedVaultNotesState, seedScenario, unlockEncryptedVault } from "./helpers.mjs";

async function createSavedNote(page, title, body) {
  await page.locator('.vault-panel-toolbar button[aria-label="새 노트"]').click();
  await page.getByLabel("노트 이름").fill(title);

  await page.getByRole("textbox", { name: "Markdown 편집기" }).fill(body);
  await saveVaultDocument(page);
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨");
  const tabId = await page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]').getAttribute("id");
  expect(tabId).toMatch(/^entry:/u);
  return tabId.slice("entry:".length);
}

test("remote folder trash preserves an unrelated authorized dirty draft", async ({ browser, page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "vault-chromium-desktop-1280", "The cross-context draft preservation acceptance runs once on desktop Chromium.");
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  const create = page.locator('.vault-panel-toolbar button[aria-label="새 노트"]');
  await expect(create).toBeEnabled({ timeout: 30_000 });
  const keptId = await createSavedNote(page, "유지할 메모", "처음 저장한 본문");
  page.once("dialog", (dialog) => dialog.accept("다른 기기에서 삭제할 폴더"));
  await page.getByRole("button", { name: "새 폴더", exact: true }).click();
  const folder = page.getByRole("treeitem", { name: "다른 기기에서 삭제할 폴더", exact: true });
  await expect(folder).toBeVisible();
  await folder.click();
  const hiddenId = await createSavedNote(page, "숨겨질 메모", "삭제 대상 폴더의 본문");
  const savedRows = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  expect(savedRows.find((note) => note.id === keptId)?.folderId ?? null).toBeNull();
  expect(savedRows.find((note) => note.id === hiddenId)?.folderId).toBeTruthy();

  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4174", locale: "ko-KR", viewport: { width: 1280, height: 720 } });
  const editing = await context.newPage();
  const editingDiagnostics = observePage(editing);
  let releaseSaves;
  const savesReleased = new Promise((resolve) => { releaseSaves = resolve; });
  const localBody = "다른 폴더 삭제 후에도 보존되어야 하는 저장 대기 편집";
  try {
    await loginDirectly(editing, fixture.viewerAuth, editingDiagnostics);
    await navigateWithinApp(editing, `/app?entry=${encodeURIComponent(keptId)}`);
    await expect(editing.getByLabel("노트 이름")).toHaveValue("유지할 메모");

    // Hold only this fixture's writes so the remote folder snapshot arrives
    // while its draft is definitely unsaved, independent of CI machine speed.
    await editing.route("**/api/vault-notes", async (route) => {
      if (route.request().method() === "POST") await savesReleased;
      await route.continue();
    });
    await editing.getByRole("textbox", { name: "Markdown 편집기" }).fill(localBody);
    await folder.click({ button: "right" });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("menuitem", { name: "하위 트리 휴지통", exact: true }).click();
    await expect(folder).toHaveCount(0);
    await expect(editing.getByRole("treeitem", { name: "다른 기기에서 삭제할 폴더", exact: true })).toHaveCount(0);
    await expect(editing.getByLabel("노트 이름")).toHaveValue("유지할 메모");
    const source = editing.getByRole("textbox", { name: "Markdown 편집기" });
    await expect.poll(async () => await readVaultEditorSource(source)).toBe(localBody);
    await expect(editing.getByRole("tab", { name: /숨겨질 메모/u })).toHaveCount(0);

    releaseSaves();
    await expect(editing.locator(".vault-save-state")).toHaveText("저장됨", { timeout: 30_000 });
    await expect(editing.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", "saved");
    await editing.reload();
    await unlockEncryptedVault(editing, fixture.viewerAuth.password);

    await expect.poll(async () => await readVaultEditorSource(source)).toBe(localBody);
    await expectCleanRuntime(diagnostics, fixture);
    await expectCleanRuntime(editingDiagnostics, fixture, [localBody]);
  } finally {
    releaseSaves();
    await context.close();
  }
});
