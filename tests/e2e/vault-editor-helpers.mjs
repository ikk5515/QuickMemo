import { expect } from "@playwright/test";

// Playwright's ControlOrMeta follows the test host OS, but CM6 follows the
// browser platform. An emulated iPhone on Linux therefore needs Meta, not Ctrl.
export async function pressVaultEditorModKey(editor, key) {
  const modifier = await editor.evaluate((element) => {
    const browser = element.ownerDocument.defaultView.navigator;
    const appleMobile = /Apple Computer/u.test(browser.vendor)
      && (/Mobile\/\w+/u.test(browser.userAgent) || browser.maxTouchPoints > 2);
    return appleMobile || /Mac/u.test(browser.platform) ? "Meta" : "Control";
  });
  await editor.press(`${modifier}+${key}`);
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
