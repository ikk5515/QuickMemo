/* global window, document, MutationObserver */
import { expect, test } from "@playwright/test";
import { loginDirectly, navigateWithinApp, observePage, seedScenario } from "./helpers.mjs";
import { readVaultEditorSource } from "./vault-editor-helpers.mjs";

test("native keyboard and composition input preserve the live editor source", async ({ page, request }, testInfo) => {
  test.skip(!["vault-firefox-desktop-1280", "vault-chromium-desktop-1280"].includes(testInfo.project.name), "Native input regression in Firefox and Chromium");
  const fixture = await seedScenario(request, "authenticated-verified");
  await loginDirectly(page, fixture.viewerAuth, observePage(page));
  await navigateWithinApp(page, "/app?panel=files");
  const create = page.locator('.vault-panel-toolbar button[aria-label="새 노트"]');
  await expect(create).toBeEnabled({ timeout: 30_000 });
  await create.click();
  await page.getByLabel("노트 이름").fill("Firefox 입력 회귀");
  const editor = page.getByRole("textbox", { name: "Markdown 편집기", exact: true });
  await expect(editor).toBeEditable();
  await editor.evaluate((element) => {
    const view = element.cmTile.root.view;
    const records = [];
    const snapshot = (type, extra = {}) => {
      if (records.length >= 500) return;
      records.push({ type, time: window.performance.now(), domLength: element.textContent.length,
        sourceLength: view.state.doc.length, selection: view.state.selection.toJSON(),
        active: document.activeElement === element, ...extra });
    };
    for (const type of ["keydown", "keyup", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"]) {
      element.addEventListener(type, (event) => {
        snapshot(`${type}:capture`, { inputType: event.inputType, data: event.data, key: event.key, prevented: event.defaultPrevented });
        window.queueMicrotask(() => snapshot(`${type}:microtask`, { prevented: event.defaultPrevented }));
      }, true);
      element.addEventListener(type, (event) => snapshot(`${type}:bubble`, { prevented: event.defaultPrevented }));
    }
    const originalDispatch = view.dispatch;
    view.dispatch = (...transactions) => {
      snapshot("dispatch:before");
      originalDispatch(...transactions);
      snapshot("dispatch:after");
    };
    const observer = new MutationObserver(() => snapshot("mutation"));
    observer.observe(element, { characterData: true, childList: true, subtree: true });
    window.__vaultInputProbe = { records, snapshot };
  });
  const observed = [];
  const sample = async (method, expected, input) => {
    await editor.click();
    await editor.press("ControlOrMeta+a");
    await editor.press("Backspace");
    await expect.poll(() => readVaultEditorSource(editor)).toBe("");
    await page.evaluate((label) => window.__vaultInputProbe.snapshot(`start:${label}`), method);
    await input();
    await page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    observed.push({ method, expected, actual: await readVaultEditorSource(editor) });
  };
  try {
    await sample("keydown", "A", () => editor.press("A"));
    await sample("insertText", "한글 日本語", () => page.keyboard.insertText("한글 日本語"));
    await sample("fill", "# Firefox\n\n한글 日本語", () => editor.fill("# Firefox\n\n한글 日本語"));
  } finally {
    await testInfo.attach("native-input-events", { body: JSON.stringify({ observed, events: await page.evaluate(() => window.__vaultInputProbe.records) }, null, 2), contentType: "application/json" });
  }
  for (const result of observed) expect(result.actual, result.method).toBe(result.expected);
});
