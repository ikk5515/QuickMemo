import { expect } from "@playwright/test";

// Playwright's ControlOrMeta follows the test host OS, but CM6 follows the
// browser platform. An emulated iPhone on Linux therefore needs Meta, not Ctrl.
async function vaultEditorModifier(editor) {
  return editor.evaluate((element) => {
    const browser = element.ownerDocument.defaultView.navigator;
    const appleMobile = /Apple Computer/u.test(browser.vendor)
      && (/Mobile\/\w+/u.test(browser.userAgent) || browser.maxTouchPoints > 2);
    return appleMobile || /Mac/u.test(browser.platform) ? "Meta" : "Control";
  });
}

export async function pressVaultEditorModKey(editor, key) {
  const modifier = await vaultEditorModifier(editor);
  await editor.press(`${modifier}+${key}`);
}

export async function redoVaultEditor(editor) {
  const modifier = await vaultEditorModifier(editor);
  // CM binds Redo to Cmd-Shift-Z on Apple and Ctrl-Y elsewhere. Playwright's
  // lowercase Shift+z can report key="z" on Linux Firefox, which CM handles
  // as Ctrl-Z (Undo) before considering the shifted alternative binding.
  await editor.press(modifier === "Meta" ? "Meta+Shift+Z" : "Control+y");
}

// Match EditorView.findFromDOM's lookup without adding a production test API.
// Live Preview decorates/virtualizes rendered lines; encrypted fidelity checks
// must read the actual CM6 document rather than its visible preview text.
export async function readVaultEditorSource(editor) {
  return editor.evaluate((element) => {
    const view = element.cmTile?.root?.view;
    if (!view || view.contentDOM !== element) throw new Error("Mounted CM6 editor is unavailable");
    return view.state.doc.toString();
  });
}

export async function createDistinctVaultNote(page, create) {
  const tab = page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]');
  const previousId = await tab.count() ? await tab.getAttribute("id") : null;
  await expect(create).toBeEnabled({ timeout: 30_000 });
  await create.click();
  await expect(tab).toHaveAttribute("id", /^entry:/u);
  if (previousId) await expect(tab).not.toHaveAttribute("id", previousId);
  await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Markdown 편집기", exact: true })).toBeEditable();
  return (await tab.getAttribute("id")).slice("entry:".length);
}

export async function createVaultFolderWithPrompt(page, button, name) {
  await Promise.all([
    page.waitForEvent("dialog", { timeout: 15_000 }).then(async (dialog) => {
      let accepted = false;
      try {
        expect(dialog.type()).toBe("prompt");
        expect(dialog.message()).toBe("새 폴더 이름");
        await dialog.accept(name); accepted = true;
      } finally {
        if (!accepted) await dialog.dismiss().catch(() => undefined);
      }
    }),
    button.click()
  ]);
}

export async function openVaultDocumentMenu(page) {
  await page.getByRole("button", { name: "문서 메뉴", exact: true }).click();
  await expect(page.getByRole("menu", { name: "파일 작업", exact: true })).toBeVisible();
}

export async function saveVaultDocument(page, { allowClean = false } = {}) {
  await openVaultDocumentMenu(page);
  const save = page.getByRole("menuitem", { name: "저장", exact: true });
  if (allowClean && !await save.isEnabled()) {
    await page.keyboard.press("Escape");
  } else {
    await expect(save).toBeEnabled();
    await save.click();
  }
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨", { timeout: 30_000 });
  // The command becomes unavailable only after the dirty draft is acknowledged.
  await openVaultDocumentMenu(page);
  await expect(save).toBeDisabled();
  await page.keyboard.press("Escape");
}
