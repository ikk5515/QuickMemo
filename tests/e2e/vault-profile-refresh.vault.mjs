/* global process */

import { expect, test } from "@playwright/test";
import { patchEmulatorDocuments } from "../helpers/secureShareApiEmulator.ts";
import {
  expectCleanRuntime,
  loginDirectly,
  navigateWithinApp,
  observePage,
  ownedVaultNotesState,
  seedScenario
} from "./helpers.mjs";
import { readVaultEditorSource, saveVaultDocument } from "./vault-editor-helpers.mjs";

// This fixture helper rejects every non-loopback destination. No production
// route or browser credential is added for changing synthetic profile data.
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

test("same-owner profile metadata refresh preserves the mounted editor and pending draft", async ({ page, request }, testInfo) => {
  test.skip(!["vault-chromium-desktop-1280", "vault-webkit-mobile-390"].includes(testInfo.project.name),
    "The metadata refresh acceptance covers desktop Chromium and mobile WebKit.");
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  const toggle = page.locator('.vault-ribbon button[aria-controls="vault-left-panel"][aria-expanded]');
  await expect(toggle).toBeAttached();
  await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", /^(?:saved|pending|conflict)$/u);
  if (await toggle.getAttribute("aria-expanded") === "false") {
    await page.getByRole("button", { name: "파일", exact: true }).click();
  }
  const create = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]')
    .getByRole("button", { name: "새 노트", exact: true });
  await expect(create).toBeEnabled({ timeout: 30_000 });
  await create.click();
  const title = "Profile refresh draft";
  await page.getByRole("textbox", { name: "노트 이름", exact: true }).fill(title);
  const editor = page.getByRole("textbox", { name: "Markdown 편집기", exact: true });
  await expect(editor).toBeEditable();
  await editor.fill("# Saved before profile refresh");
  await saveVaultDocument(page, { allowClean: true });
  const activeTab = page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]');
  const tabId = await activeTab.getAttribute("id");
  expect(tabId).toMatch(/^entry:/u);
  const noteId = tabId.slice("entry:".length);
  const baseline = (await ownedVaultNotesState(request, fixture.viewerAuth.uid)).find((note) => note.id === noteId);
  expect(baseline).toEqual(expect.objectContaining({ revision: expect.any(Number) }));
  const originalEditor = await editor.elementHandle();
  expect(originalEditor).not.toBeNull();
  let releaseSave;
  let observeHeldSave;
  const saveReleased = new Promise((resolve) => { releaseSave = resolve; });
  const saveHeld = new Promise((resolve) => { observeHeldSave = resolve; });
  const holdNoteSave = async (route) => {
    const mutation = route.request().postDataJSON();
    if (route.request().method() === "POST" && mutation?.action === "update" && mutation.noteId === noteId) {
      observeHeldSave();
      await saveReleased;
    }
    await route.continue();
  };
  await page.route("**/api/vault-notes", holdNoteSave);
  const draft = "# Unsaved profile refresh draft\n\n한국어와 日本語 편집은 그대로 남습니다.";
  try {
    await editor.fill(draft);
    await saveHeld;
    for (const displayName of ["E2E Metadata Refresh A", "E2E Metadata Refresh B"]) {
      await patchEmulatorDocuments(["users", "publicLoginRoster"].map((collection) => ({
        path: `${collection}/${fixture.viewerAuth.uid}`,
        fields: { displayName }
      })));
      // This visible account field acknowledges the actual profile listener,
      // rather than assuming the Firestore write has reached React already.
      await expect(page.locator(".topbar-user .mini-avatar")).toHaveAttribute("title", displayName);
      await expect(activeTab).toHaveAttribute("id", tabId);
      await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toHaveValue(title);
      expect(await originalEditor.evaluate((element) => element.isConnected)).toBe(true);
      expect(await editor.evaluate((element, original) => element === original, originalEditor)).toBe(true);
      await expect.poll(() => readVaultEditorSource(editor)).toBe(draft);
      await expect(page.locator(".vault-save-state")).not.toHaveText("저장됨");
    }
    releaseSave();
    await expect(page.locator(".vault-save-state")).toHaveText("저장됨", { timeout: 30_000 });
    await expect.poll(async () => (await ownedVaultNotesState(request, fixture.viewerAuth.uid))
      .find((note) => note.id === noteId)?.revision).toBe(baseline.revision + 1);
    await expect.poll(() => readVaultEditorSource(editor)).toBe(draft);
    expect(await originalEditor.evaluate((element) => element.isConnected)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("profile-refresh-preserved-draft.png"), fullPage: true });
    await expectCleanRuntime(diagnostics, fixture, [draft]);
  } finally {
    releaseSave();
    await page.unroute("**/api/vault-notes", holdNoteSave);
  }
});
