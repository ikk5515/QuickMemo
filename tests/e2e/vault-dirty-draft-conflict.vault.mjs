/* global document */

import { expect, test } from "@playwright/test";
import {
  expectCleanRuntime,
  loginDirectly,
  navigateWithinApp,
  observePage,
  seedScenario,
  unlockEncryptedVault
} from "./helpers.mjs";

const firestoreProjectId = "quickmemo-share-api-test";
const vaultNoteMutationUrl = "http://127.0.0.1:4174/api/vault-notes";
const expectedRevisionConflictConsoleText =
  "Failed to load resource: the server responded with a status of 409 (Conflict)";

async function activeEntryId(page) {
  const tabId = await page
    .locator('.vault-tab-bar [role="tab"][aria-selected="true"]')
    .getAttribute("id");
  expect(tabId).toMatch(/^entry:/u);
  return tabId.slice("entry:".length);
}

async function expectEditorSource(page, expectedSource) {
  const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
  await expect(editor).toBeVisible();
  await expect.poll(async () => (
    (await editor.locator(".cm-line").allTextContents()).join("\n")
  )).toBe(expectedSource);
}

async function saveActiveEntry(page) {
  const save = page.getByRole("button", { name: "저장", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨");
  await expect(save).toBeDisabled();
}

async function expectVaultNameWritesReady(page) {
  const createBase = page
    .getByRole("complementary", { name: "Vault 리본" })
    .getByRole("button", { name: "새 Base", exact: true });
  await expect(createBase).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole("status", { name: "Vault 이름 무결성 준비" })).toHaveCount(0);
}

async function expectPageViewportContained(page) {
  const overflow = await page.evaluate(() => ({
    body: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
    root: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    workspace: (() => {
      const workspace = document.querySelector(".vault-workspace");
      if (!workspace) return null;
      const bounds = workspace.getBoundingClientRect();
      return {
        left: Math.round(bounds.left * 100) / 100,
        right: Math.round(bounds.right * 100) / 100,
        viewport: document.documentElement.clientWidth
      };
    })()
  }));

  expect(overflow.body, "body must not horizontally overflow").toBe(0);
  expect(overflow.root, "document root must not horizontally overflow").toBe(0);
  expect(overflow.workspace).not.toBeNull();
  expect(overflow.workspace.left).toBeGreaterThanOrEqual(-1);
  expect(overflow.workspace.right).toBeLessThanOrEqual(overflow.workspace.viewport + 1);
}

async function expectEncryptedEntry(request, fixture, entryId, forbiddenPlaintext) {
  let rawDocument = "";
  await expect.poll(async () => {
    const response = await request.get(
      `http://127.0.0.1:8080/v1/projects/${firestoreProjectId}/databases/(default)/documents/notes/${encodeURIComponent(entryId)}`,
      { headers: { authorization: `Bearer ${fixture.viewerAuth.idToken}` } }
    );
    if (!response.ok()) return false;
    rawDocument = await response.text();
    return rawDocument.includes("encryptedTitle") && rawDocument.includes("encryptedBody");
  }, { message: `encrypted Firestore entry ${entryId} must become readable to its owner` }).toBe(true);

  expect(rawDocument).toContain("wrappedKeys");
  expect(rawDocument).toContain("markdown-v1");
  for (const plaintext of forbiddenPlaintext) {
    expect(rawDocument, `Firestore must not contain conflict plaintext: ${plaintext}`).not.toContain(plaintext);
  }
}

async function expectEncryptedHistoryAtRest(
  request,
  fixture,
  entryId,
  minimumEntries,
  forbiddenPlaintext
) {
  let rawCollection = "";
  await expect.poll(async () => {
    const response = await request.get(
      `http://127.0.0.1:8080/v1/projects/${firestoreProjectId}/databases/(default)/documents/notes/${encodeURIComponent(entryId)}/history?pageSize=20`,
      { headers: { authorization: `Bearer ${fixture.viewerAuth.idToken}` } }
    );
    if (!response.ok()) return 0;
    rawCollection = await response.text();
    const payload = rawCollection ? JSON.parse(rawCollection) : {};
    return Array.isArray(payload.documents) ? payload.documents.length : 0;
  }, { message: `encrypted history for ${entryId} must contain ${minimumEntries} revisions` })
    .toBeGreaterThanOrEqual(minimumEntries);

  expect(rawCollection).toContain("encryptedSummary");
  expect(rawCollection).toContain("encryptedSnapshot");
  for (const plaintext of forbiddenPlaintext) {
    expect(rawCollection, `history documents must not contain conflict plaintext: ${plaintext}`).not.toContain(plaintext);
  }
}

test("two authenticated contexts preserve a dirty draft and apply a revision-checked three-way merge", async ({
  browser,
  page,
  request
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "vault-chromium-desktop-1280",
    "The multi-context concurrency acceptance runs once in the bounded desktop Chromium project."
  );
  test.setTimeout(120_000);
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnosticsA = observePage(page);
  const contextB = await browser.newContext({
    baseURL: "http://127.0.0.1:4174",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 720 }
  });
  const pageB = await contextB.newPage();
  const diagnosticsB = observePage(pageB);
  const baseSource = [
    "# E2E Conflict",
    "owner: original",
    "",
    "body",
    "",
    "footer: original"
  ].join("\n");
  const remoteSource = baseSource.replace("owner: original", "owner: server");
  const localSource = baseSource.replace("footer: original", "footer: local");
  const mergedSource = baseSource
    .replace("owner: original", "owner: server")
    .replace("footer: original", "footer: local");

  try {
    await loginDirectly(page, fixture.viewerAuth, diagnosticsA);
    await navigateWithinApp(page, "/app");
    await expectVaultNameWritesReady(page);
    await page.locator('.vault-panel-toolbar button[aria-label="새 노트"]').click();
    await page.getByRole("textbox", { name: "노트 이름", exact: true }).fill("E2E Conflict Note");
    await page.getByRole("button", { name: "소스 모드", exact: true }).click();
    await page.getByRole("textbox", { name: "Markdown 편집기" }).fill(baseSource);
    await saveActiveEntry(page);
    const entryId = await activeEntryId(page);

    await loginDirectly(pageB, fixture.viewerAuth, diagnosticsB);
    await navigateWithinApp(pageB, `/app?entry=${encodeURIComponent(entryId)}`);
    await expect(pageB.getByRole("textbox", { name: "노트 이름", exact: true }))
      .toHaveValue("E2E Conflict Note");
    await expectVaultNameWritesReady(pageB);
    await pageB.getByRole("button", { name: "소스 모드", exact: true }).click();
    const editorB = pageB.getByRole("textbox", { name: "Markdown 편집기" });
    await expectEditorSource(pageB, baseSource);

    // Both contexts start from the same base. B becomes dirty before A commits,
    // so the remote subscription cannot erase B's unsaved footer edit.
    await editorB.fill(localSource);
    const editorA = page.getByRole("textbox", { name: "Markdown 편집기" });
    await editorA.fill(remoteSource);
    await saveActiveEntry(page);
    await expectVaultNameWritesReady(pageB);
    await expectEditorSource(pageB, localSource);
    const conflictConsoleStartIndex = diagnosticsB.consoleErrors.length;
    const conflictResponsePromise = pageB.waitForResponse((response) => (
      response.url() === vaultNoteMutationUrl
      && response.request().method() === "POST"
    ));
    await pageB.getByRole("button", { name: "저장", exact: true }).click();
    const conflictResponse = await conflictResponsePromise;
    expect(conflictResponse.status()).toBe(409);

    const conflict = pageB.locator(".vault-save-conflict");
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText("저장 충돌");
    await expect.poll(() => diagnosticsB.consoleErrors.slice(conflictConsoleStartIndex).filter((entry) => (
      entry.location === vaultNoteMutationUrl
      && entry.text === expectedRevisionConflictConsoleText
    )).length, {
      message: "the proven revision conflict must emit exactly one matching browser resource error"
    }).toBe(1);
    const [expectedConflictConsoleError] = diagnosticsB.consoleErrors
      .slice(conflictConsoleStartIndex)
      .filter((entry) => (
        entry.location === vaultNoteMutationUrl
        && entry.text === expectedRevisionConflictConsoleText
      ));
    diagnosticsB.expectedConsoleErrors.add(expectedConflictConsoleError);
    await expectEditorSource(pageB, localSource);
    await conflict.getByRole("button", { name: "안전 병합" }).click();
    const resolver = pageB.getByRole("dialog", { name: "편집 충돌 안전 병합" });
    await expect(resolver).toContainText("충돌하지 않는 변경을 안전하게 자동 병합했습니다");
    await expectVaultNameWritesReady(pageB);
    await expectEditorSource(pageB, localSource);
    await resolver.getByRole("button", { name: "자동 병합본 적용" }).click();
    await expect(resolver).toHaveCount(0);
    await expectEditorSource(pageB, mergedSource);
    await expect(pageB.locator(".vault-save-state")).toHaveText("저장됨");

    await expectEncryptedEntry(
      request,
      fixture,
      entryId,
      [baseSource, remoteSource, localSource, mergedSource, "owner: server", "footer: local"]
    );
    await expectEncryptedHistoryAtRest(
      request,
      fixture,
      entryId,
      3,
      ["owner: original", "owner: server", "footer: original", "footer: local"]
    );
    await pageB.reload();
    await expect(pageB.locator('input[type="password"][aria-label="비밀번호"]')).toBeVisible();
    await expect(pageB.locator("body")).not.toContainText("owner: server");
    await expect(pageB.locator("body")).not.toContainText("footer: local");
    await unlockEncryptedVault(pageB, fixture.viewerAuth.password);
    await expectEditorSource(pageB, mergedSource);
    await expectPageViewportContained(pageB);
    await expectCleanRuntime(diagnosticsA, fixture, [baseSource, remoteSource, localSource, mergedSource]);
    await expectCleanRuntime(diagnosticsB, fixture, [baseSource, remoteSource, localSource, mergedSource]);
  } finally {
    await contextB.close();
  }
});
