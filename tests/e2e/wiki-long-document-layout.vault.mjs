/* global document, window */
import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors, expectCleanRuntime,
  loginDirectly, navigateWithinApp, observePage, seedScenario
} from "./helpers.mjs";
import { readVaultEditorSource, saveVaultDocument } from "./vault-editor-helpers.mjs";
import { expectVisibleWikiMotionFinished } from "./wiki-motion-helpers.mjs";

async function createMemo(page, title, body) {
  const toggle = page.locator('.vault-ribbon button[aria-controls="vault-left-panel"][aria-expanded]');
  await expect(toggle).toBeAttached();
  await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", /^(?:saved|pending)$/);
  if (await toggle.getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "파일", exact: true }).click();
  const create = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]').getByRole("button", { name: "새 노트", exact: true });
  await expect(create).toBeEnabled(); await create.click();
  await page.getByRole("textbox", { name: "노트 이름", exact: true }).fill(title);
  const editor = page.getByRole("textbox", { name: "Markdown 편집기", exact: true });
  await expect(editor).toBeEditable(); await editor.fill(body);
  await saveVaultDocument(page, { allowClean: true });
  await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toHaveValue(title);
  const tab = page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]');
  await expect(tab).toHaveText(title);
  const tabId = await tab.getAttribute("id");
  expect(tabId).toMatch(/^entry:/u);
  return tabId.slice("entry:".length);
}

async function openDocument(page, title) {
  const toggle = page.getByRole("button", { name: /^위키 목록 (열기|닫기)$/ });
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await page.getByRole("searchbox", { name: "위키 검색", exact: true }).fill("");
  await page.getByRole("navigation", { name: "위키 폴더와 메모", exact: true }).getByRole("link", { name: title, exact: true }).click();
  const panel = page.getByRole("article", { name: title, exact: true });
  await expect(panel).toHaveAttribute("data-active", "true");
  await expect(panel.getByRole("textbox", { name: "Markdown 편집기", exact: true })).toBeEditable();
  await expectVisibleWikiMotionFinished(page);
  return panel;
}

async function geometry(page) {
  return page.evaluate(() => {
    const measure = (element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: box.height,
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
    };
    return {
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      workspace: measure(document.querySelector(".vault-workspace--wiki")),
      wiki: measure(document.querySelector(".private-wiki")),
      layout: measure(document.querySelector(".wiki-layout")),
      rowSizes: window.getComputedStyle(document.querySelector(".wiki-layout")).gridTemplateRows,
      sidebar: measure(document.querySelector(".wiki-sidebar")),
      sidebarContent: measure(document.querySelector(".wiki-sidebar-content")),
      context: measure(document.querySelector(".wiki-context")),
      stack: measure(document.querySelector(".wiki-panel-stack")),
      panels: [...document.querySelectorAll(".wiki-panel")].map((panel) => ({
        ...measure(panel), active: panel.dataset.active === "true",
        scroller: measure(panel.querySelector(".cm-scroller"))
      }))
    };
  });
}

function expectBoundedDesktopLayout(measured) {
  expect(measured.stack.height).toBeLessThanOrEqual(measured.layout.height + 1);
  expect(measured.stack.bottom).toBeLessThanOrEqual(measured.workspace.bottom + 1);
  expect(measured.wiki.scrollHeight).toBeLessThanOrEqual(measured.wiki.clientHeight + 1);
  expect(measured.documentHeight).toBeLessThanOrEqual(measured.viewportHeight + 1);
  expect(measured.sidebar.height).toBeLessThanOrEqual(measured.layout.height + 1);
  expect(measured.sidebarContent.scrollHeight).toBeGreaterThan(measured.sidebarContent.clientHeight);
  for (const panel of measured.panels) {
    expect(panel.height).toBeLessThanOrEqual(measured.stack.height + 1);
    expect(panel.scroller.height).toBeLessThanOrEqual(panel.height + 1);
  }
}

test("long retained Wiki documents stay within the desktop workspace and keep independent scrolling", async ({ page, request }, testInfo) => {
  test.skip(page.viewportSize().width < 1200, "The three-column desktop grid owns this regression; compact layouts place context below the editor.");
  await page.setViewportSize({ width: 1512, height: 771 });
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  await loginDirectly(page, fixture.viewerAuth, diagnostics); await navigateWithinApp(page, "/app");
  const longBody = "# 긴 문서 C\n\n" + Array.from({ length: 80 }, (_, index) =>
    `## 항목 ${index + 1}\n\n긴 메모 ${index + 1}: 접힌 문서의 본문과 목차가 바깥 워크스페이스의 높이를 늘리지 않아야 합니다.`
  ).join("\n\n");
  const entries = [];
  for (const letter of ["A", "B", "C", "D"]) {
    const title = letter === "C" ? "긴 문서 C" : `짧은 문서 ${letter}`;
    entries.push({ id: await createMemo(page, title, letter === "C" ? longBody : `# ${title}\n\n독립 문서 ${letter}`), title });
  }
  // A real encrypted import supplies the long sidebar that previously made the
  // auto grid row exceed its fixed-height parent. No test-only DOM/CSS is used.
  const archive = zipSync(Object.fromEntries(Array.from({ length: 56 }, (_, index) => {
    const title = `탐색기 기록 ${String(index + 1).padStart(2, "0")}`;
    return [`${title}.md`, strToU8(`# ${title}\n\n탐색기 높이 회귀 자료입니다.`)];
  })));
  const more = page.locator(".vault-more-tools");
  if (await more.getAttribute("open") === null) await more.locator("summary").click();
  const choosing = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Obsidian ZIP 가져오기", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await (await choosing).setFiles({ name: "long-wiki-sidebar.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
  await expect(page.getByText("56개 항목을 암호화해 가져왔습니다.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await navigateWithinApp(page, `/wiki?note=${entries[0].id}`);
  await expect(page.getByRole("main", { name: "위키 읽기 패널", exact: true })).toBeVisible();
  await expect.poll(() => page.locator(".wiki-navigation .wiki-note-link").count()).toBeGreaterThanOrEqual(60);
  for (const entry of entries) await openDocument(page, entry.title);
  await expect(page.locator(".wiki-panel")).toHaveCount(4);
  await openDocument(page, entries[2].title);
  const longPanel = page.locator(`.wiki-panel[data-note-id="${entries[2].id}"]`);
  await expect(page.getByRole("navigation", { name: "현재 메모 목차", exact: true }).getByRole("button", { name: "항목 80", exact: true })).toBeAttached();
  const samples = [];
  try {
    samples.push({ phase: "long-document-active", ...await geometry(page) });
    expectBoundedDesktopLayout(samples.at(-1));
    const scroller = longPanel.locator(".cm-scroller");
    const editor = longPanel.locator(".cm-content");
    expect(await readVaultEditorSource(editor)).toBe(longBody);
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(500);
    await scroller.evaluate((element) => { element.dataset.retentionMarker = "long-document-c"; element.scrollTop = 500; });
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(500);
    await openDocument(page, entries[0].title);
    await expect(longPanel).toHaveAttribute("inert", "");
    samples.push({ phase: "long-document-collapsed", ...await geometry(page) });
    expectBoundedDesktopLayout(samples.at(-1));
    await expect(scroller).toHaveAttribute("data-retention-marker", "long-document-c");
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(500);
    await page.getByRole("button", { name: `${entries[2].title} 문서 펼치기`, exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get("note") === entries[2].id);
    await expect(longPanel).toHaveAttribute("data-active", "true");
    await expectVisibleWikiMotionFinished(page);
    await expect(scroller).toHaveAttribute("data-retention-marker", "long-document-c");
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(500);
    expect(await readVaultEditorSource(editor)).toBe(longBody);
    samples.push({ phase: "long-document-reactivated", ...await geometry(page) });
    expectBoundedDesktopLayout(samples.at(-1));
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 771 });
      if (width < 768) await expect(page.getByRole("button", { name: "위키 목록 열기", exact: true })).toHaveAttribute("aria-expanded", "false");
      await expectVisibleWikiMotionFinished(page);
      const measured = { phase: `context-below-editor-${width}`, ...await geometry(page) };
      samples.push(measured);
      expect(measured.stack.height).toBeLessThanOrEqual(measured.workspace.height);
      expect(measured.context.top).toBeGreaterThanOrEqual(measured.stack.bottom - 1);
      for (const panel of measured.panels) expect(panel.scroller.height).toBeLessThanOrEqual(measured.stack.height + 1);
      await expect(scroller).toHaveAttribute("data-retention-marker", "long-document-c");
      expect(await readVaultEditorSource(editor)).toBe(longBody);
    }
  } finally {
    const path = testInfo.outputPath("wiki-long-document-geometry.json");
    await writeFile(path, JSON.stringify(samples, null, 2));
    await testInfo.attach("wiki-long-document-geometry", { path, contentType: "application/json" });
  }
  allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics); await expectCleanRuntime(diagnostics, fixture);
});
