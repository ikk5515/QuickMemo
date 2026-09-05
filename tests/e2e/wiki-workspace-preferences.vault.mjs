/* global window, CompositionEvent, InputEvent, URL */
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors, expectCleanRuntime, expectNoHorizontalOverflow,
  loginDirectly, navigateWithinApp, observePage, seedScenario, unlockEncryptedVault
} from "./helpers.mjs";
import { readVaultEditorSource, saveVaultDocument } from "./vault-editor-helpers.mjs";
import { expectVisibleWikiMotionFinished } from "./wiki-motion-helpers.mjs";

async function memoExplorer(page) {
  const panel = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "파일", exact: true }).click();
  await expect(panel).toBeVisible(); return panel;
}
async function createMemo(page, title, body) {
  const create = (await memoExplorer(page)).getByRole("button", { name: "새 노트", exact: true });
  await expect(create).toBeEnabled({ timeout: 30_000 }); await create.click();
  await page.getByRole("textbox", { name: "노트 이름", exact: true }).fill(title);
  const editor = page.getByRole("textbox", { name: "Markdown 편집기", exact: true });
  await expect(editor).toBeEditable(); await editor.fill(body); await saveVaultDocument(page, { allowClean: true });
  const tabId = await page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]').getAttribute("id");
  expect(tabId).toMatch(/^entry:/u); return tabId.slice("entry:".length);
}
function preferenceSaved(page, kind, matches) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    if (url.pathname !== "/api/vault-integrity" || url.searchParams.get("resource") !== "workspace-preferences" || response.request().method() !== "POST" || response.status() !== 200) return false;
    const payload = response.request().postDataJSON();
    return payload?.action === "set" && payload.kind === kind && matches(payload.value);
  }, { timeout: 30_000 });
}
async function resizeSidebar(page, kind, label) {
  const separator = page.getByRole("separator", { name: label, exact: true });
  await expect(separator).toBeVisible();
  // Reopening the phone drawer after a viewport change slides this divider.
  // Locator hover waits for stable geometry before the raw pointer drag.
  await separator.hover();
  const before = Number(await separator.getAttribute("aria-valuenow"));
  const maximum = Number(await separator.getAttribute("aria-valuemax"));
  const target = Math.min(maximum, before + 48);
  expect(target).toBeGreaterThan(before);
  const saved = preferenceSaved(page, kind, (value) => value.width === target && !value.collapsed);
  const bounds = await separator.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds.x + bounds.width / 2, y = bounds.y + Math.min(80, bounds.height / 2);
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + target - before, y, { steps: 4 }); await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", String(target)); await saved;
  return target;
}
async function wikiSearch(page) {
  await expect(page.getByRole("main", { name: "위키 읽기 패널", exact: true })).toBeVisible();
  const input = page.getByRole("searchbox", { name: "위키 검색", exact: true });
  const toggle = page.getByRole("button", { name: /^위키 목록 (열기|닫기)$/ });
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await expect(input).toBeVisible(); return input;
}
async function openWikiDocument(page, title) {
  await (await wikiSearch(page)).fill("");
  await page.getByRole("navigation", { name: "위키 폴더와 메모", exact: true }).getByRole("link", { name: title, exact: true }).click();
  const panel = page.getByRole("article", { name: title, exact: true });
  await expect(panel).toHaveAttribute("data-active", "true");
  await expect(panel.getByRole("textbox", { name: "Markdown 편집기", exact: true })).toBeEditable();
  return panel;
}
async function saveWikiEditor(page, editor) {
  await editor.press("ControlOrMeta+s");
  await expect(page.locator(".wiki-save-state").first()).toHaveText("저장됨", { timeout: 30_000 });
}

async function beginFrameSample(page) {
  await page.bringToFront();
  await page.evaluate(() => {
    const sample = { started: window.performance.now(), last: null, frames: [], tasks: [], frame: 0, observer: null };
    const tick = (time) => { if (sample.last !== null) sample.frames.push(time - sample.last); sample.last = time; sample.frame = window.requestAnimationFrame(tick); };
    sample.frame = window.requestAnimationFrame(tick);
    if (window.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
      sample.observer = new window.PerformanceObserver((list) => { for (const entry of list.getEntries()) sample.tasks.push(entry.duration); });
      sample.observer.observe({ type: "longtask" });
    }
    window.__quickMemoFrameSample = sample;
  });
}
async function endFrameSample(page, label) {
  return page.evaluate((name) => {
    const sample = window.__quickMemoFrameSample;
    if (!sample) throw new Error("Frame sample is unavailable");
    window.cancelAnimationFrame(sample.frame); sample.observer?.disconnect(); delete window.__quickMemoFrameSample;
    const frames = [...sample.frames].sort((left, right) => left - right);
    const rounded = (value) => Math.round(value * 100) / 100;
    return { label: name, durationMs: rounded(window.performance.now() - sample.started), frameCount: frames.length,
      frameIntervalP95Ms: frames.length ? rounded(frames[Math.min(frames.length - 1, Math.floor(frames.length * .95))]) : null,
      frameIntervalMaxMs: frames.length ? rounded(frames.at(-1)) : null,
      longTaskCount: sample.observer ? sample.tasks.length : null,
      longTaskTotalMs: sample.observer ? rounded(sample.tasks.reduce((total, value) => total + value, 0)) : null };
  }, label);
}

test("persists memo and Wiki sidebar preferences while four live editors retain text, scroll, undo and composition", async ({ page, request }, testInfo) => {
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  const originalViewport = page.viewportSize();
  const performanceSamples = [];
  // A phone uses a full-width drawer. Exercise the desktop resize preference,
  // then return to the project's actual phone/tablet viewport for editing.
  const resizedForPreference = originalViewport.width < 1024;
  if (resizedForPreference) await page.setViewportSize({ width: 1024, height: originalViewport.height });
  await loginDirectly(page, fixture.viewerAuth, diagnostics); await navigateWithinApp(page, "/app");
  const documents = [];
  for (const letter of ["A", "B", "C", "D"]) {
    const title = `문서 ${letter}`;
    const body = `# ${title}\n\n` + Array.from({ length: 42 }, (_, index) => `문단 ${index + 1}: ${letter} 기록`).join("\n\n");
    const id = await createMemo(page, title, body); documents.push({ id, letter, title, body, edited: body + `\n\n편집-${letter}` });
  }

  const memoWidth = await resizeSidebar(page, "memo", "메모 탐색기 너비");
  let persisted = preferenceSaved(page, "memo", (value) => value.collapsed && value.width === memoWidth);
  await (await memoExplorer(page)).getByRole("button", { name: "왼쪽 패널 접기", exact: true }).click(); await persisted;
  await page.reload(); await unlockEncryptedVault(page, fixture.viewerAuth.password);
  await expect(page.locator('.vault-left-panel[aria-label="Vault 탐색기"]')).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "왼쪽 패널 열기", exact: true }).click();
  await expect(page.getByRole("separator", { name: "메모 탐색기 너비", exact: true })).toHaveAttribute("aria-valuenow", String(memoWidth));

  await navigateWithinApp(page, `/wiki?note=${documents[0].id}`);
  await wikiSearch(page);
  const wikiWidth = await resizeSidebar(page, "wiki", "위키 목록 너비 조절");
  persisted = preferenceSaved(page, "wiki", (value) => value.collapsed && value.width === wikiWidth);
  await page.getByRole("button", { name: "위키 목록 닫기", exact: true }).click(); await persisted;
  await page.reload(); await unlockEncryptedVault(page, fixture.viewerAuth.password);
  await expect(page.locator(".wiki-sidebar")).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "위키 목록 열기", exact: true }).click();
  await expect(page.getByRole("separator", { name: "위키 목록 너비 조절", exact: true })).toHaveAttribute("aria-valuenow", String(wikiWidth));
  if (resizedForPreference) await page.setViewportSize(originalViewport);

  await beginFrameSample(page);
  for (const document of documents) await openWikiDocument(page, document.title);
  await expect(page.locator(".wiki-panel")).toHaveCount(4);
  await expectVisibleWikiMotionFinished(page);
  performanceSamples.push(await endFrameSample(page, "open-four-documents"));
  const scrollPositions = new Map();
  for (const document of documents) {
    const panel = await openWikiDocument(page, document.title);
    const editor = panel.getByRole("textbox", { name: "Markdown 편집기", exact: true });
    await editor.press("ControlOrMeta+End"); await page.keyboard.insertText(`\n\n편집-${document.letter}`);
    await expect.poll(() => readVaultEditorSource(editor)).toBe(document.edited);
    await saveWikiEditor(page, editor);
    const scroller = panel.locator(".cm-scroller");
    await scroller.evaluate((element, marker) => { element.dataset.lifetimeMarker = marker; element.scrollTop = 180; }, document.id);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(180);
    scrollPositions.set(document.id, 180);
    await editor.evaluate((element, marker) => { element.dataset.editorMarker = marker; }, document.id);
  }
  for (const document of documents) {
    const panel = await openWikiDocument(page, document.title);
    await expect(panel.locator(".cm-scroller")).toHaveAttribute("data-lifetime-marker", document.id);
    await expect(panel.getByRole("textbox", { name: "Markdown 편집기", exact: true })).toHaveAttribute("data-editor-marker", document.id);
    expect(await panel.locator(".cm-scroller").evaluate((element) => element.scrollTop)).toBe(scrollPositions.get(document.id));
  }

  const second = documents[1];
  const secondPanel = await openWikiDocument(page, second.title);
  const secondEditor = secondPanel.getByRole("textbox", { name: "Markdown 편집기", exact: true });
  await secondEditor.press("ControlOrMeta+z"); await expect.poll(() => readVaultEditorSource(secondEditor)).toBe(second.body);
  await secondEditor.press("ControlOrMeta+Shift+z"); await expect.poll(() => readVaultEditorSource(secondEditor)).toBe(second.edited);
  await saveWikiEditor(page, secondEditor);
  for (const other of documents.filter((document) => document.id !== second.id)) {
    const editor = page.locator(`.wiki-panel[data-note-id="${other.id}"] .cm-content`);
    expect(await readVaultEditorSource(editor)).toBe(other.edited);
  }

  const third = documents[2];
  const compositionPanel = await openWikiDocument(page, third.title);
  const compositionEditor = compositionPanel.getByRole("textbox", { name: "Markdown 편집기", exact: true });
  await compositionEditor.press("ControlOrMeta+End");
  let noteWrites = 0;
  const countWrites = (outgoing) => { if (outgoing.method() === "POST" && new URL(outgoing.url()).pathname === "/api/vault-notes") noteWrites += 1; };
  page.on("request", countWrites);
  try {
    await compositionEditor.evaluate((element) => {
      // Firefox's native insertText performs an entire IME session, including
      // compositionend. This test deliberately holds one synthetic session
      // open; mutate the selected DOM range as an IME does, letting CM's real
      // DOMObserver consume input without dispatching editor transactions.
      element.dataset.pendingCompositionEnds = "0";
      element.addEventListener("compositionend", () => {
        element.dataset.pendingCompositionEnds = String(Number(element.dataset.pendingCompositionEnds) + 1);
      }, { once: true });
      element.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      const selection = element.ownerDocument.defaultView.getSelection();
      if (!selection?.rangeCount) throw new Error("The editor's composition range is missing");
      const range = selection.getRangeAt(0);
      if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
        throw new Error("The composition range must stay inside the active editor");
      }
      const text = " 조합입력완료";
      element.dispatchEvent(new CompositionEvent("compositionupdate", { data: text, bubbles: true }));
      element.dispatchEvent(new InputEvent("beforeinput", { data: text, inputType: "insertCompositionText", isComposing: true, bubbles: true }));
      const node = element.ownerDocument.createTextNode(text);
      range.deleteContents();
      range.insertNode(node);
      selection.collapse(node, text.length);
      element.dispatchEvent(new InputEvent("input", { data: text, inputType: "insertCompositionText", isComposing: true, bubbles: true }));
    });
    await expect.poll(() => readVaultEditorSource(compositionEditor)).toBe(third.edited + " 조합입력완료");
    await expect(compositionEditor).toHaveAttribute("data-pending-composition-ends", "0");
    await compositionEditor.press("ControlOrMeta+s");
    await compositionEditor.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    expect(noteWrites, "saving waits until the synthetic composition ends").toBe(0);
    await compositionEditor.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { data: "조합입력완료", bubbles: true })));
    await expect(compositionEditor).toHaveAttribute("data-pending-composition-ends", "1");
    third.edited += " 조합입력완료";
    await expect.poll(() => readVaultEditorSource(compositionEditor)).toBe(third.edited);
    await expect.poll(() => noteWrites).toBeGreaterThan(0);
    await expect(page.locator(".wiki-save-state").first()).toHaveText("저장됨", { timeout: 30_000 });
  } finally { page.off("request", countWrites); }

  // A second resize must keep every mounted editor instance and its contents.
  if (resizedForPreference) await page.setViewportSize({ width: 1024, height: originalViewport.height });
  await wikiSearch(page); await beginFrameSample(page);
  const finalWikiWidth = await resizeSidebar(page, "wiki", "위키 목록 너비 조절");
  await expectVisibleWikiMotionFinished(page);
  performanceSamples.push(await endFrameSample(page, "resize-with-four-editors-including-preference-ack"));
  for (const document of documents) {
    const editor = page.locator(`.wiki-panel[data-note-id="${document.id}"] .cm-content`);
    await expect(editor).toHaveAttribute("data-editor-marker", document.id);
    expect(await readVaultEditorSource(editor)).toBe(document.edited);
  }
  await page.reload(); await unlockEncryptedVault(page, fixture.viewerAuth.password);
  await expect(page.locator(".wiki-panel")).toHaveCount(4);
  await expect(page.getByRole("separator", { name: "위키 목록 너비 조절", exact: true })).toHaveAttribute("aria-valuenow", String(finalWikiWidth));
  if (resizedForPreference) await page.setViewportSize(originalViewport);
  for (const document of documents) {
    const panel = await openWikiDocument(page, document.title);
    expect(await readVaultEditorSource(panel.getByRole("textbox", { name: "Markdown 편집기", exact: true }))).toBe(document.edited);
  }
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { window.document.documentElement.dataset.theme = value; }, theme);
    await expectVisibleWikiMotionFinished(page); await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`wiki-workspace-${theme}.png`), fullPage: true });
  }
  const performancePath = testInfo.outputPath("wiki-interaction-performance.json");
  await writeFile(performancePath, JSON.stringify({ viewport: originalViewport, samples: performanceSamples }, null, 2));
  await testInfo.attach("wiki-interaction-performance", { path: performancePath, contentType: "application/json" });
  await testInfo.attach("sidebar-preferences", { body: JSON.stringify({ memoWidth, wikiWidth, finalWikiWidth, documents: documents.length, viewport: originalViewport }), contentType: "application/json" });
  allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics); await expectCleanRuntime(diagnostics, fixture);
});
