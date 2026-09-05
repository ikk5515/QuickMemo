/* global document, window, console */
import { expect, test } from "@playwright/test";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors,
  expectCleanRuntime,
  expectNoHorizontalOverflow,
  loginDirectly,
  navigateWithinApp,
  observePage,
  openVaultMoreTool,
  ownedVaultNotesState,
  seedScenario,
  unlockEncryptedVault
} from "./helpers.mjs";

async function createMemo(page, title, body) {
  const explorer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  if (!(await explorer.isVisible())) await page.getByRole("button", { name: "파일", exact: true }).click();
  const create = explorer.getByRole("button", { name: "새 노트", exact: true });
  await expect(create).toBeEnabled({ timeout: 30_000 });
  const start = Date.now();
  await create.click();
  await expect(page.getByLabel("노트 이름")).toBeEnabled();
  await page.getByRole("button", { name: "소스 모드", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
  await expect(editor).toBeEditable();
  const readyMs = Date.now() - start;
  await page.getByLabel("노트 이름").fill(title);
  await editor.fill(body);
  const save = page.getByRole("button", { name: "저장", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨");
  const tab = await page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]').getAttribute("id");
  expect(tab).toMatch(/^entry:/u);
  return { id: tab.slice("entry:".length), readyMs };
}

async function revealWikiSearch(page) {
  const search = page.getByRole("searchbox", { name: "위키 검색" });
  if (!(await search.isVisible())) await page.getByRole("button", { name: "위키 목록 열기" }).click();
  return search;
}

test("encrypted memos become a private searchable wiki with links, headings and isolated browser tabs", async ({ page, request, context }, testInfo) => {
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  const target = await createMemo(page, "연결 지식", "# 연결 지식\n\n## 핵심 개념\n\n위키검색확인용본문\n");
  const readingParagraphs = Array.from({ length: 26 }, (_, index) => `문단 ${index + 1}. 암호화된 메모를 읽고 연결한 자료를 함께 살펴봅니다.`).join("\n\n");
  const source = await createMemo(page, "위키 시작", `# 나의 지식 노트\n\n## 개요\n\n정리한 메모를 읽는 공간입니다.\n\n${readingParagraphs}\n\n[[연결 지식]]\n\n## 실천\n\n- 기록하기\n- 연결하기\n`);
  const beforeWiki = await ownedVaultNotesState(request, fixture.viewerAuth.uid);

  // The explicit new-tab action must flush the active draft without exporting
  // any unlocked key. The new tab must unlock independently.
  const popupPromise = context.waitForEvent("page");
  await openVaultMoreTool(page, "위키 새 탭에서 읽기");
  const reader = await popupPromise;
  await expect(reader).toHaveURL((url) => url.pathname === "/wiki" && url.searchParams.get("note") === source.id);
  expect(await reader.evaluate(() => window.opener === null)).toBe(true);
  await unlockEncryptedVault(reader, fixture.viewerAuth.password);
  await expect(reader.locator(".wiki-title")).toHaveText("나의 지식 노트");
  await reader.close();

  // Same-tab navigation retains the unlocked session and does not prompt again.
  await navigateWithinApp(page, `/wiki?note=${source.id}`);
  await expect(page.locator(".wiki-title")).toHaveText("나의 지식 노트");
  await expect(page.locator(".unlock-panel")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Markdown 편집기" })).toHaveCount(0);
  const sourcePanel = page.locator(`.wiki-panel[data-note-id="${source.id}"]`);
  const toc = page.getByRole("navigation", { name: "현재 메모 목차" });
  await expect(toc.getByRole("button", { name: "개요", exact: true })).toBeVisible();
  if (page.viewportSize().width < 1200) {
    const layout = await page.evaluate(() => ({
      contextTop: document.querySelector(".wiki-context").getBoundingClientRect().top + window.scrollY,
      panelsBottom: document.querySelector(".wiki-panel-stack").getBoundingClientRect().bottom + window.scrollY
    }));
    expect(layout.contextTop).toBeGreaterThanOrEqual(layout.panelsBottom - 1);
  }
  await toc.getByRole("button", { name: "실천", exact: true }).click();
  await expect(sourcePanel.locator(".wiki-body h2", { hasText: "실천" })).toBeFocused();
  await expect(toc.getByRole("button", { name: "실천", exact: true })).toHaveAttribute("aria-current", "location");
  const sourceLink = sourcePanel.locator(".wiki-body").getByRole("button", { name: "연결 지식", exact: true });
  await sourceLink.scrollIntoViewIfNeeded();
  const sourceScroll = await sourcePanel.evaluate((element) => {
    element.dataset.preservationMarker = "original-source-panel";
    return element.scrollTop;
  });
  expect(sourceScroll).toBeGreaterThan(0);
  await sourceLink.click();
  await expect(page).toHaveURL((url) => url.searchParams.get("note") === target.id && url.searchParams.getAll("pane").includes(source.id));
  const targetPanel = page.locator('.wiki-panel[data-active="true"]');
  await expect(targetPanel.locator(".wiki-title")).toHaveText("연결 지식");
  await expect(page.locator(".wiki-panel")).toHaveCount(2);
  await expect(sourcePanel).toHaveAttribute("data-preservation-marker", "original-source-panel");
  expect(await sourcePanel.evaluate((element) => element.scrollTop)).toBe(sourceScroll);
  await expect(targetPanel.getByRole("region", { name: "이 메모를 연결한 메모" }).getByRole("link", { name: /위키 시작/u })).toBeVisible();
  await expect(toc.getByRole("button", { name: "핵심 개념", exact: true })).toBeVisible();
  await expect(page.locator(".wiki-local-graph canvas")).toBeVisible();

  // Closing and browser history retain the original article, including its
  // independently scrolled DOM; the search tree remains outside the stack.
  await targetPanel.getByRole("button", { name: "연결 지식 읽기 패널 닫기", exact: true }).click();
  await expect(page.locator(".wiki-panel")).toHaveCount(1);
  await expect(sourcePanel).toHaveAttribute("data-active", "true");
  expect(await sourcePanel.evaluate((element) => element.scrollTop)).toBe(sourceScroll);
  await sourceLink.click();
  await expect(page.locator(".wiki-panel")).toHaveCount(2);
  await page.goBack();
  await expect(page.locator(".wiki-panel")).toHaveCount(1);
  await expect(sourcePanel).toHaveAttribute("data-preservation-marker", "original-source-panel");
  expect(await sourcePanel.evaluate((element) => element.scrollTop)).toBe(sourceScroll);
  await sourceLink.click();
  await expect(page.locator('.wiki-panel[data-active="true"] .wiki-title')).toHaveText("연결 지식");

  const search = await revealWikiSearch(page);
  await search.fill("위키검색확인용본문");
  const results = page.getByRole("navigation", { name: "위키 검색 결과" });
  await expect(results.getByRole("link", { name: /연결 지식/u })).toBeVisible();
  await expect(results.getByRole("link", { name: /위키 시작/u })).toHaveCount(0);
  await results.getByRole("link", { name: /연결 지식/u }).click();
  await expect(page.locator(".wiki-panel")).toHaveCount(1);
  await expect(page.locator(".wiki-title")).toHaveText("연결 지식");
  await expectNoHorizontalOverflow(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`wiki-${theme}.png`), fullPage: true });
  }
  expect(await ownedVaultNotesState(request, fixture.viewerAuth.uid)).toEqual(beforeWiki);
  await testInfo.attach("local-create-timing", { body: JSON.stringify({ firstMs: target.readyMs, secondMs: source.readyMs }), contentType: "application/json" });
  console.log(JSON.stringify({ benchmark: "encrypted-memo-editor-ready", project: testInfo.project.name, firstMs: target.readyMs, secondMs: source.readyMs }));
  allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  await expectCleanRuntime(diagnostics, fixture);
});

test("wiki deep links require authentication", async ({ page }) => {
  await page.goto("/wiki?note=untrusted-note-id");
  await expect(page).toHaveURL((url) => url.pathname === "/login");
  await expect(page.locator(".wiki-body")).toHaveCount(0);
});
