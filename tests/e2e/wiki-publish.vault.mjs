/* global document, window, Event */
import { expect, test } from "@playwright/test";
import { pressVaultEditorModKey } from "./vault-editor-helpers.mjs";
import { expectVisibleWikiMotionFinished } from "./wiki-motion-helpers.mjs";
import { allowExpectedWebKitFirestoreEmulatorUnloadErrors, expectCleanRuntime, expectNoHorizontalOverflow, loginDirectly, navigateWithinApp, observePage, ownedVaultNotesState, seedScenario } from "./helpers.mjs";
async function explorer(page) {
  const panel = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "파일", exact: true }).click();
  return panel;
}
async function createNote(page, title, body) {
  const panel = await explorer(page);
  const create = panel.getByRole("button", { name: "새 노트", exact: true });
  await expect(create).toBeEnabled({ timeout: 30_000 }); await create.click();
  await expect(page.getByLabel("노트 이름")).toBeEnabled();
  await page.getByLabel("노트 이름").fill(title);
  await page.getByRole("textbox", { name: "Markdown 편집기" }).fill(body);
  await pressVaultEditorModKey(page.getByRole("textbox", { name: "Markdown 편집기" }), "s");
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨");
}
async function publishDialog(page) {
  const panel = await explorer(page);
  const folder = panel.getByRole("treeitem", { name: "공개 지식", exact: true });
  await folder.click({ button: "right" });
  await page.getByRole("menuitem", { name: "폴더 위키 공개…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "위키 공개 설정", exact: true });
  await expect(dialog.getByRole("checkbox", { name: /선택한 범위와 이후/ })).toBeVisible();
  return dialog;
}
async function wikiSearch(page) {
  await expect(page.getByRole("main", { name: "위키 읽기 패널" })).toBeVisible();
  const search = page.getByRole("searchbox", { name: "위키 검색" });
  const toggle = page.getByRole("button", { name: /^위키 목록 (열기|닫기)$/ });
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await expect(search).toBeVisible();
  return search;
}

test("publishes only the selected encrypted folder with stacked public pages and revokes its public URL", async ({ browser, page, request }, testInfo) => {
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  await loginDirectly(page, fixture.viewerAuth, diagnostics); await navigateWithinApp(page, "/app");
  await createNote(page, "개인 보관함", "절대공개되지않는개인본문");
  const panel = await explorer(page);
  page.once("dialog", (dialog) => dialog.accept("공개 지식"));
  await panel.getByRole("button", { name: "새 폴더", exact: true }).click();
  const folder = panel.getByRole("treeitem", { name: "공개 지식", exact: true });
  await expect(folder).toBeVisible(); await folder.click();
  await createNote(page, "연결 문서", "# 연결 문서\n\n## 세부 항목\n\n공개검색테스트본문\n\n[[시작 문서]]");
  await createNote(page, "시작 문서", "# 시작 문서\n\n## 개요\n\n[[연결 문서]]\n\n[[개인 보관함]]\n\n## 체크리스트\n\n- 첫째\n  - 하위 항목\n\n==강조한 문장==");
  const originalNotes = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  await page.screenshot({ path: testInfo.outputPath("memo-workspace.png"), fullPage: true });
  const dialog = await publishDialog(page);
  await expect(dialog.getByRole("list")).toContainText("시작 문서");
  await expect(dialog.getByRole("list")).not.toContainText("개인 보관함");
  const publicationLayout = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      fitsViewport: bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth,
      hasHorizontalScroll: element.scrollWidth > element.clientWidth + 1,
      clippedControls: [...element.querySelectorAll("button, input, a")].filter((control) => control.getClientRects().length).some((control) => {
        const box = control.getBoundingClientRect();
        return box.left < bounds.left - 1 || box.right > bounds.right + 1;
      })
    };
  });
  expect(publicationLayout).toEqual({ fitsViewport: true, hasHorizontalScroll: false, clippedControls: false });
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
  });
  await page.screenshot({ path: testInfo.outputPath("folder-publication.png"), fullPage: true });
  await expect(dialog.getByRole("button", { name: "위키 게시", exact: true })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "위키 주소" }).fill(`e2e-${fixture.viewerAuth.uid.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 32)}`);
  await expect(dialog.getByText("사용할 수 있는 주소입니다.")).toBeVisible();
  await dialog.getByRole("checkbox", { name: /선택한 범위와 이후/ }).check();
  await dialog.getByRole("button", { name: "위키 게시", exact: true }).click();
  const publicLink = dialog.locator('a[target="_blank"]');
  await expect(publicLink).toBeVisible({ timeout: 30_000 });
  const publicUrl = await publicLink.getAttribute("href");
  expect(publicUrl).toMatch(/\/wiki\/e2e-[a-z0-9]+$/);
  expect(publicUrl).not.toContain("pw1_");
  await expect(dialog.getByText(/공개했습니다/)).toBeVisible();
  const anonymous = await browser.newContext({ viewport: testInfo.project.use.viewport, locale: "ko-KR", baseURL: "http://127.0.0.1:4174" });
  try {
    const reader = await anonymous.newPage();
    await reader.goto(publicUrl);
    await (await wikiSearch(reader)).fill("시작 문서");
    await reader.getByRole("navigation", { name: "위키 검색 결과" }).getByRole("link", { name: /시작 문서/ }).click();
    const first = reader.locator('.wiki-panel[data-active="true"]');
    await expect(first.locator(".wiki-body")).toContainText("비공개 링크");
    await expect(first.locator("mark")).toHaveText("강조한 문장");
    await expect(reader.locator("body")).not.toContainText("개인 보관함");
    await expect(reader.locator("body")).not.toContainText("절대공개되지않는개인본문");
    await first.locator(".wiki-body").getByRole("button", { name: "연결 문서", exact: true }).click();
    await expect(reader.locator(".wiki-panel")).toHaveCount(2);
    await expect(reader.locator('.wiki-panel[data-active="true"] .wiki-title')).toHaveText("연결 문서");
    await expect(reader.locator('.wiki-panel[data-active="true"]')).toBeFocused();
    await expect(reader.getByRole("navigation", { name: "현재 메모 목차" }).getByRole("button", { name: "세부 항목", exact: true })).toBeAttached();
    await expect(reader.locator('.wiki-panel[data-active="true"]')).toContainText("공개검색테스트본문");
    await expect.poll(async () => reader.locator('.wiki-panel[data-active="true"]').evaluate((element) => {
      const panel = element.getBoundingClientRect();
      const stack = element.parentElement.getBoundingClientRect();
      return panel.right <= stack.right + 1 && panel.left >= stack.left - 1;
    }), { message: "the new reading panel finishes sliding into its clipped reading area" }).toBe(true);
    if (testInfo.project.name === "vault-chromium-tablet-768") {
      await reader.setViewportSize({ width: 800, height: 1024 });
      await expect(reader.locator('.wiki-panel[data-active="true"] .wiki-title')).toHaveText("연결 문서");
      await expectNoHorizontalOverflow(reader);
      await reader.setViewportSize({ width: 768, height: 1024 });
    }
    for (const theme of ["light", "dark"]) {
      await reader.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await expectNoHorizontalOverflow(reader);
      await expectVisibleWikiMotionFinished(reader);
      await reader.screenshot({ path: testInfo.outputPath(`public-wiki-${theme}.png`), fullPage: true });
    }
    await expect(reader.getByRole("textbox", { name: "Markdown 편집기" })).toHaveCount(0);
    expect(await ownedVaultNotesState(request, fixture.viewerAuth.uid)).toEqual(originalNotes);
    await dialog.getByRole("button", { name: "공개 중지", exact: true }).click();
    await expect(dialog.getByText(/공개를 중지했습니다/)).toBeVisible();
    await reader.bringToFront();
    await reader.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(reader.getByRole("heading", { name: "위키를 열 수 없습니다" })).toBeVisible();
    await expect(reader.locator(".wiki-body")).toHaveCount(0);
    await reader.reload();
    await expect(reader.getByRole("heading", { name: "위키를 열 수 없습니다" })).toBeVisible();
    await expect(reader.locator(".wiki-body")).toHaveCount(0);
  } finally { await anonymous.close(); }
  await dialog.getByRole("button", { name: "공개 설정 닫기" }).click();
  await navigateWithinApp(page, "/wiki");
  await (await wikiSearch(page)).fill("절대공개되지않는개인본문");
  await expect(page.getByRole("navigation", { name: "위키 검색 결과" }).getByRole("link", { name: /개인 보관함/ })).toBeVisible();
  allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  await expectCleanRuntime(diagnostics, fixture);
});
