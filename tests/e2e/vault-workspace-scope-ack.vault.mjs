/* global process, window, URL */

import { expect, test } from "@playwright/test";
import { patchEmulatorDocuments, readEmulatorDocument } from "../helpers/secureShareApiEmulator.ts";
import { expectCleanRuntime, loginDirectly, navigateWithinApp, observePage, ownedVaultNotesState, seedScenario, unlockEncryptedVault } from "./helpers.mjs";
import { readVaultEditorSource, saveVaultDocument } from "./vault-editor-helpers.mjs";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

async function createSavedNote(page, title, body) {
  await page.locator('.vault-panel-toolbar button[aria-label="새 노트"]').click();
  await page.getByLabel("노트 이름").fill(title);
  await page.getByRole("textbox", { name: "Markdown 편집기" }).fill(body);
  await saveVaultDocument(page);
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨");
  await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", "saved");
  const tabId = await page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]').getAttribute("id");
  expect(tabId).toMatch(/^entry:/u);
  return tabId.slice("entry:".length);
}

test("a committed workspace acknowledgement survives a same-session folder scope cleanup", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "vault-chromium-desktop-1280", "The controlled workspace acknowledgement race runs once on desktop Chromium.");
  const fixture = await seedScenario(request, "authenticated-verified");
  const uid = fixture.viewerAuth.uid;
  await page.addInitScript(() => {
    window.__qmWorkspaceAckGate = { armed: false, held: false, revision: null, count: 0, release: null };
  });
  // Only the loopback test module is wrapped. Every call still uses the real
  // service and Firestore transaction; the gate delays one successful return.
  const moduleUrl = /^http:\/\/127\.0\.0\.1:4174\/src\/services\/vaultWorkspace\.ts(?:\?[^#]*)?$/u;
  await page.route(moduleUrl, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("qm-ack-original")) {
      await route.continue();
      return;
    }
    const original = "/src/services/vaultWorkspace.ts?qm-ack-original=1";
    await route.fulfill({ contentType: "application/javascript", body: `
      export * from ${JSON.stringify(original)};
      import { saveVaultWorkspace as saveOriginalWorkspace } from ${JSON.stringify(original)};
      export async function saveVaultWorkspace(...args) {
        const result = await saveOriginalWorkspace(...args);
        const gate = window.__qmWorkspaceAckGate;
        if (gate?.armed && args[0]?.uid === ${JSON.stringify(uid)}) {
          gate.armed = false;
          gate.held = true;
          gate.count += 1;
          gate.revision = result.revision;
          await new Promise((resolve) => { gate.release = resolve; });
        }
        return result;
      }
    ` });
  });
  const diagnostics = observePage(page);
  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  await expect(page.locator('.vault-panel-toolbar button[aria-label="새 노트"]')).toBeEnabled({ timeout: 30_000 });
  const keptId = await createSavedNote(page, "ACK 유지할 메모", "처음 저장한 본문");
  page.once("dialog", (dialog) => dialog.accept("ACK 원격 삭제 폴더"));
  await page.getByRole("button", { name: "새 폴더", exact: true }).click();
  const folder = page.getByRole("treeitem", { name: "ACK 원격 삭제 폴더", exact: true });
  await expect(folder).toBeVisible();
  await folder.click();
  const hiddenId = await createSavedNote(page, "ACK 숨겨질 메모", "삭제 대상 폴더의 본문");
  const rows = await ownedVaultNotesState(request, uid);
  const folderId = rows.find((note) => note.id === hiddenId)?.folderId;
  expect(folderId).toBeTruthy();
  expect(rows.find((note) => note.id === keptId)?.folderId ?? null).toBeNull();
  const storedFolder = await readEmulatorDocument(`noteFolders/${folderId}`);
  expect(storedFolder?.ownerUid).toBe(uid);
  await page.getByRole("tab", { name: "ACK 유지할 메모", exact: true }).click();
  await expect(page.getByLabel("노트 이름")).toHaveValue("ACK 유지할 메모");
  await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", "saved");
  const workspacePath = `vaultWorkspaces/${uid}`;
  const baseline = await readEmulatorDocument(workspacePath);
  expect(baseline?.revision).toEqual(expect.any(Number));

  let releaseNoteSave;
  let noteSaveObserved;
  const noteReleased = new Promise((resolve) => { releaseNoteSave = resolve; });
  const noteHeld = new Promise((resolve) => { noteSaveObserved = resolve; });
  const evidence = { baselineRevision: baseline.revision, committedRevision: null, commitStatus: null, heldCount: 0, postCleanupRevision: null, workspaceSyncAfterCleanup: null };
  const commitUrl = /^http:\/\/127\.0\.0\.1:8080\/v1\/projects\/quickmemo-share-api-test\/databases\/\(default\)\/documents:commit(?:\?[^#]*)?$/u;
  page.on("response", (response) => {
    if (!commitUrl.test(response.url()) || response.request().method() !== "POST") return;
    const writes = response.request().postDataJSON()?.writes;
    if (writes?.length === 1 && writes[0]?.update?.name === `projects/quickmemo-share-api-test/databases/(default)/documents/${workspacePath}`) {
      evidence.commitStatus = response.status();
    }
  });
  const holdNote = async (route) => {
    const mutation = route.request().postDataJSON();
    if (route.request().method() === "POST" && mutation?.action === "update" && mutation.noteId === keptId) {
      noteSaveObserved();
      await noteReleased;
    }
    await route.continue();
  };
  await page.route("**/api/vault-notes", holdNote);
  const draft = "# ACK 정리 중 편집\n\n한국어와 日本語 본문을 보존합니다.";
  try {
    await page.getByRole("textbox", { name: "Markdown 편집기" }).fill(draft);
    await noteHeld;
    await page.evaluate(() => { window.__qmWorkspaceAckGate.armed = true; });
    await page.locator(".vault-right-toggle").click();
    await expect.poll(() => page.evaluate(() => window.__qmWorkspaceAckGate.held)).toBe(true);
    expect(evidence.commitStatus).toBe(200);
    const committed = await readEmulatorDocument(workspacePath);
    evidence.committedRevision = committed?.revision;
    expect(committed?.revision).toBe(baseline.revision + 1);
    await patchEmulatorDocuments([{ path: `noteFolders/${folderId}`, fields: {
      isDeleted: true, deletedAt: new Date().toISOString(), deletedBy: uid,
      revision: (storedFolder.revision ?? 0) + 1
    } }]);
    await expect(folder).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /ACK 숨겨질 메모/u })).toHaveCount(0);
    await expect(page.getByLabel("노트 이름")).toHaveValue("ACK 유지할 메모");
    const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
    await expect.poll(() => readVaultEditorSource(editor)).toBe(draft);
    // The only workspace mutation was this page's already committed request.
    expect((await readEmulatorDocument(workspacePath))?.revision).toBe(baseline.revision + 1);
    evidence.heldCount = await page.evaluate(() => window.__qmWorkspaceAckGate.count);
    expect(evidence.heldCount).toBe(1);
    await page.evaluate(() => window.__qmWorkspaceAckGate.release());
    releaseNoteSave();
    await expect(page.locator(".vault-save-state")).toHaveText("저장됨", { timeout: 30_000 });
    await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", "saved");
    evidence.postCleanupRevision = (await readEmulatorDocument(workspacePath))?.revision;
    expect(evidence.postCleanupRevision).toBeGreaterThan(evidence.committedRevision);
    await expect(folder).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /ACK 숨겨질 메모/u })).toHaveCount(0);
    await expect.poll(() => readVaultEditorSource(editor)).toBe(draft);
    await expect(page.getByRole("alert", { name: "워크스페이스 배치 충돌" })).toHaveCount(0);
    await page.reload();
    await unlockEncryptedVault(page, fixture.viewerAuth.password);
    await expect.poll(() => readVaultEditorSource(page.getByRole("textbox", { name: "Markdown 편집기" }))).toBe(draft);
    await expect(folder).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /ACK 숨겨질 메모/u })).toHaveCount(0);
    await expectCleanRuntime(diagnostics, fixture, [draft]);
  } finally {
    await page.evaluate(() => window.__qmWorkspaceAckGate?.release?.()).catch(() => undefined);
    releaseNoteSave();
    evidence.workspaceSyncAfterCleanup = await page.locator(".vault-workspace").getAttribute("data-workspace-sync").catch(() => null);
    await testInfo.attach("workspace-ack-order", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    await page.unroute("**/api/vault-notes", holdNote);
  }
});
