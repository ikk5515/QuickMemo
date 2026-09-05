import { expect, test } from "@playwright/test";
import { allowExpectedWebKitFirestoreEmulatorUnloadErrors, expectCleanRuntime, loginDirectly, navigateWithinApp, observePage, ownedVaultNotesState, seedScenario } from "./helpers.mjs";
import { pressVaultEditorModKey, readVaultEditorSource, saveVaultDocument } from "./vault-editor-helpers.mjs";
import { expectVisibleWikiMotionFinished } from "./wiki-motion-helpers.mjs";

test("owner collapsed strip activates the requested retained editor and saves to that document", async ({ page, request }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "Desktop strip geometry; compact document selection has separate coverage.");
  await page.setViewportSize({ width: 1520, height: 771 });
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  await loginDirectly(page, fixture.viewerAuth, diagnostics); await navigateWithinApp(page, "/app");
  const titles = ["A", "B", "C", "D"].map((letter) => `Strip activation ${letter}`);
  const ids = new Map();
  for (const title of titles) {
    const toggle = page.locator('.vault-ribbon button[aria-controls="vault-left-panel"][aria-expanded]');
    await expect(toggle).toBeAttached();
    await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", /^(?:saved|pending|conflict)$/u);
    if (await toggle.getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "파일", exact: true }).click();
    const create = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]').getByRole("button", { name: "새 노트", exact: true });
    await expect(create).toBeEnabled({ timeout: 30_000 }); await create.click();
    await page.getByRole("textbox", { name: "노트 이름", exact: true }).fill(title);
    const body = title.endsWith("C") ? Array.from({ length: 80 }, (_, index) => `## Long section ${index}\n\nSynthetic long document paragraph ${index}.`).join("\n\n") : `## ${title}\n\n${title} original body`;
    await page.getByRole("textbox", { name: "Markdown 편집기", exact: true }).fill(body);
    await saveVaultDocument(page, { allowClean: true });
    const tabId = await page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]').getAttribute("id");
    expect(tabId).toMatch(/^entry:/u); ids.set(title, tabId.slice("entry:".length));
  }
  expect(new Set(ids.values()).size, "Every created title must have a distinct source note ID").toBe(titles.length);
  await navigateWithinApp(page, `/wiki?note=${ids.get(titles[0])}`);
  await expect(page.locator('.private-wiki[data-mode="private"]')).toBeVisible();
  for (const title of titles.slice(1)) {
    await page.locator(".wiki-navigation").getByRole("link", { name: title, exact: true }).click();
    await expect(page.locator('.wiki-panel[data-active="true"]')).toHaveAttribute("data-note-id", ids.get(title));
  }
  await expectVisibleWikiMotionFinished(page);
  await expect(page.locator(".wiki-panel")).toHaveCount(titles.length);
  const documents = await page.locator(".wiki-panel").elementHandles();
  const cId = ids.get(titles[2]), dId = ids.get(titles[3]);
  let previousNotes = [];
  await expect.poll(async () => {
    previousNotes = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
    return previousNotes.map((note) => note.id).sort();
  }, { message: "All four created owner notes must exist in the server inventory before saving C" }).toEqual([...ids.values()].sort());
  const previousC = previousNotes.find((note) => note.id === cId), previousD = previousNotes.find((note) => note.id === dId);
  expect(previousC, "The server baseline must contain C").toEqual(expect.objectContaining({ id: cId, revision: expect.any(Number) }));
  expect(previousD, "The server baseline must contain D").toEqual(expect.objectContaining({ id: dId, revision: expect.any(Number) }));
  const c = page.locator(`.wiki-panel[data-note-id="${cId}"]`);
  await expect(c).toHaveAttribute("aria-hidden", "true");
  const expand = page.getByRole("button", { name: `${titles[2]} 문서 펼치기`, exact: true });
  await expect(expand).toBeVisible();
  await expand.click();
  await expect(page).toHaveURL((url) => url.pathname === "/wiki" && url.searchParams.get("note") === cId);
  await expect(c).toHaveAttribute("data-active", "true"); await expect(c).not.toHaveAttribute("aria-hidden", "true");
  await expectVisibleWikiMotionFinished(page);
  const editor = c.getByRole("textbox", { name: "Markdown 편집기", exact: true });
  await expect(editor).toBeFocused();
  const original = await readVaultEditorSource(editor);
  const changed = `${original}\n\nC saved after strip activation`;
  await editor.fill(changed);
  await pressVaultEditorModKey(editor, "s");
  await expect(page.locator(".wiki-save-state")).toHaveText("저장됨");
  await expect.poll(async () => {
    const current = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
    return { cRevision: current.find((note) => note.id === cId)?.revision,
      dRevision: current.find((note) => note.id === dId)?.revision };
  }).toEqual({ cRevision: previousC.revision + 1,
    dRevision: previousD.revision });
  await page.getByRole("button", { name: `${titles[3]} 문서 펼치기`, exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("note") === dId);
  await page.getByRole("button", { name: `${titles[2]} 문서 펼치기`, exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("note") === cId);
  await expect.poll(() => readVaultEditorSource(editor)).toBe(changed);
  for (const document of documents) expect(await document.evaluate((element) => element.isConnected)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("owner-strip-active-c.png"), fullPage: true });
  allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  await expectCleanRuntime(diagnostics, fixture);
});
