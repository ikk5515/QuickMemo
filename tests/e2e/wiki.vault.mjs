/* global document, window, console */
import { expect, test } from "@playwright/test";
import { pressVaultEditorModKey } from "./vault-editor-helpers.mjs";
import { expectVisibleWikiMotionFinished } from "./wiki-motion-helpers.mjs";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors, expectCleanRuntime, expectNoHorizontalOverflow,
  loginDirectly, navigateWithinApp, observePage, openVaultMoreTool, ownedVaultNotesState,
  seedScenario, unlockEncryptedVault
} from "./helpers.mjs";

async function createMemo(page, title, body) {
  const explorer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  const toggle = page.locator('.vault-ribbon button[aria-controls="vault-left-panel"][aria-expanded]');
  // Wait for the unlocked workspace and restored layout before reading drawer state.
  // An open phone drawer makes the ribbon inert; absence during loading is not closed.
  await expect(toggle).toBeAttached();
  await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", /^(?:saved|pending|conflict)$/);
  if (await toggle.getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "파일", exact: true }).click();
  await expect(explorer).toBeVisible();
  const create = explorer.getByRole("button", { name: "새 노트", exact: true });
  await expect(create).toBeEnabled({ timeout: 30_000 });
  const start = Date.now(); await create.click();
  await expect(page.getByLabel("노트 이름")).toBeEnabled();
  const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
  await expect(editor).toBeEditable(); const readyMs = Date.now() - start;
  await page.getByLabel("노트 이름").fill(title); await editor.fill(body);
  await pressVaultEditorModKey(editor, "s");
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨");
  const tab = await page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]').getAttribute("id");
  expect(tab).toMatch(/^entry:/u);
  return { id: tab.slice("entry:".length), readyMs };
}
async function revealWikiSearch(page) {
  await expect(page.getByRole("main", { name: "위키 읽기 패널" })).toBeVisible();
  const search = page.getByRole("searchbox", { name: "위키 검색" });
  const toggle = page.getByRole("button", { name: /^위키 목록 (열기|닫기)$/ });
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await expect(search).toBeVisible(); return search;
}
async function openFromTree(page, title) {
  const search = await revealWikiSearch(page); await search.fill("");
  await page.getByRole("navigation", { name: "위키 폴더와 메모" }).getByRole("link", { name: title, exact: true }).click();
}
async function closeDocument(page, title) {
  // Compact view retains all documents in a keyboard/touch-accessible chooser.
  const direct = page.getByRole("button", { name: `${title} 문서 닫기`, exact: true });
  if (!(await direct.first().isVisible())) await page.locator(".wiki-open-documents summary").click();
  await page.getByRole("button", { name: `${title} 문서 닫기`, exact: true }).filter({ visible: true }).click();
}

test("encrypted memos share an editable Wiki workspace with independent documents, headings and isolated browser tabs", async ({ page, request, context }, testInfo) => {
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  await loginDirectly(page, fixture.viewerAuth, diagnostics); await navigateWithinApp(page, "/app");
  const target = await createMemo(page, "연결 지식", "# 연결 지식\n\n## 핵심 개념\n\n위키검색확인용본문\n");
  const third = await createMemo(page, "세 번째 지식", "# 세 번째 지식\n\n독립 문서 C");
  const fourth = await createMemo(page, "네 번째 지식", "# 네 번째 지식\n\n독립 문서 D");
  const paragraphs = Array.from({ length: 26 }, (_, index) => `문단 ${index + 1}. 암호화된 메모를 읽고 연결한 자료를 함께 살펴봅니다.`).join("\n\n");
  const source = await createMemo(page, "위키 시작", `# 나의 지식 노트\n\n## 개요\n\n정리한 메모를 읽는 공간입니다.\n\n${paragraphs}\n\n[[연결 지식]]\n\n## 실천\n\n- 기록하기\n- 연결하기\n`);
  const beforeWiki = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  const popupPromise = context.waitForEvent("page");
  await openVaultMoreTool(page, "위키 새 탭에서 읽기");
  const reader = await popupPromise;
  await expect(reader).toHaveURL((url) => url.pathname === "/wiki" && url.searchParams.get("note") === source.id);
  expect(await reader.evaluate(() => window.opener === null)).toBe(true);
  await unlockEncryptedVault(reader, fixture.viewerAuth.password);
  await expect(reader.locator('.wiki-panel[data-active="true"] .cm-content')).toBeEditable();
  await reader.close();

  await navigateWithinApp(page, `/wiki?note=${source.id}`);
  await expect(page.locator(".unlock-panel")).toHaveCount(0);
  const sourcePanel = page.locator(`.wiki-panel[data-note-id="${source.id}"]`);
  const sourceEditor = sourcePanel.getByRole("textbox", { name: "Markdown 편집기" });
  await expect(sourceEditor).toBeEditable();
  const toc = page.getByRole("navigation", { name: "현재 메모 목차" });
  await expect(toc.getByRole("button", { name: "개요", exact: true })).toBeVisible();
  if (page.viewportSize().width < 1200) {
    const layout = await page.evaluate(() => ({ contextTop: document.querySelector(".wiki-context").getBoundingClientRect().top,
      panelsBottom: document.querySelector(".wiki-panel-stack").getBoundingClientRect().bottom }));
    expect(layout.contextTop).toBeGreaterThanOrEqual(layout.panelsBottom - 1);
  }
  await toc.getByRole("button", { name: "실천", exact: true }).click();
  await expect(sourceEditor).toBeFocused();
  await expect(toc.getByRole("button", { name: "실천", exact: true })).toHaveAttribute("aria-current", "location");
  const sourceLink = sourcePanel.locator('[data-live-preview-target="연결 지식"]');
  await expect(sourceLink).toBeVisible();
  const sourceScroll = await sourcePanel.locator(".cm-scroller").evaluate((element) => {
    element.dataset.preservationMarker = "original-source-editor"; return element.scrollTop;
  });
  expect(sourceScroll).toBeGreaterThan(0);
  // The editor uses Ctrl/Meta to follow a link without moving the caret.
  await sourceLink.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL((url) => url.searchParams.get("note") === target.id);
  await expect(page.locator(".wiki-panel")).toHaveCount(2);
  await expect(sourcePanel).toHaveAttribute("inert", "");
  await expect(sourcePanel.locator(".cm-scroller")).toHaveAttribute("data-preservation-marker", "original-source-editor");
  expect(await sourcePanel.locator(".cm-scroller").evaluate((element) => element.scrollTop)).toBe(sourceScroll);
  await expect(toc.getByRole("button", { name: "핵심 개념", exact: true })).toBeVisible();
  await expect(page.locator(".wiki-local-graph canvas")).toBeVisible();

  await openFromTree(page, "세 번째 지식"); await openFromTree(page, "네 번째 지식");
  await expect(page.locator(".wiki-panel")).toHaveCount(4);
  await expect(page.locator('.wiki-panel[data-active="true"]')).toHaveAttribute("data-note-id", fourth.id);
  await closeDocument(page, "연결 지식");
  await expect(page.locator(".wiki-panel")).toHaveCount(3);
  await expect(page.locator(`.wiki-panel[data-note-id="${target.id}"]`)).toHaveCount(0);
  await expect(page.locator(`.wiki-panel[data-note-id="${third.id}"]`)).toHaveCount(1);
  await expect(sourcePanel.locator(".cm-scroller")).toHaveAttribute("data-preservation-marker", "original-source-editor");
  await openFromTree(page, "위키 시작");
  expect(await sourcePanel.locator(".cm-scroller").evaluate((element) => element.scrollTop)).toBe(sourceScroll);
  await closeDocument(page, "네 번째 지식"); await expect(page.locator(".wiki-panel")).toHaveCount(2);
  await closeDocument(page, "위키 시작"); await expect(page.locator(".wiki-panel")).toHaveCount(1);
  await expect(page.locator('.wiki-panel[data-active="true"]')).toHaveAttribute("data-note-id", third.id);
  await page.goBack(); await expect(page.locator(".wiki-panel")).toHaveCount(2);

  const search = await revealWikiSearch(page); await search.fill("위키검색확인용본문");
  const results = page.getByRole("navigation", { name: "위키 검색 결과" });
  await expect(results.getByRole("link", { name: /연결 지식/u })).toBeVisible();
  await expect(results.getByRole("link", { name: /위키 시작/u })).toHaveCount(0);
  await results.getByRole("link", { name: /연결 지식/u }).click();
  await expect(page.locator(".wiki-panel")).toHaveCount(3);
  await expect(page.locator('.wiki-panel[data-active="true"]')).toHaveAttribute("data-note-id", target.id);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await expectVisibleWikiMotionFinished(page);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`wiki-${theme}.png`), fullPage: true });
  }
  const openedBeforeReload = await page.locator(".wiki-panel").evaluateAll((panels) => panels.map((panel) => panel.dataset.noteId));
  await page.reload(); await unlockEncryptedVault(page, fixture.viewerAuth.password);
  await expect(page.locator(".wiki-panel")).toHaveCount(3);
  expect(await page.locator(".wiki-panel").evaluateAll((panels) => panels.map((panel) => panel.dataset.noteId))).toEqual(openedBeforeReload);
  await expect(page.locator('.wiki-panel[data-active="true"]')).toHaveAttribute("data-note-id", target.id);
  // Navigating/closing documents must never create ciphertext writes or versions.
  expect(await ownedVaultNotesState(request, fixture.viewerAuth.uid)).toEqual(beforeWiki);
  await testInfo.attach("local-create-timing", { body: JSON.stringify({ firstMs: target.readyMs, secondMs: source.readyMs }), contentType: "application/json" });
  console.log(JSON.stringify({ benchmark: "encrypted-memo-editor-ready", project: testInfo.project.name, firstMs: target.readyMs, secondMs: source.readyMs }));
  allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics); await expectCleanRuntime(diagnostics, fixture);
});

test("wiki deep links require authentication", async ({ page }) => {
  await page.goto("/wiki?note=untrusted-note-id");
  await expect(page).toHaveURL((url) => url.pathname === "/login");
  await expect(page.locator(".wiki-body, .wiki-document-editor")).toHaveCount(0);
});
