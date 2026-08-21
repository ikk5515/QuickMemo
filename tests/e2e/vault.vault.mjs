/* global getComputedStyle */

import { expect, test } from "@playwright/test";
import {
  expectCleanRuntime,
  expectNoHorizontalOverflow,
  loginDirectly,
  navigateWithinApp,
  observePage,
  seedScenario
} from "./helpers.mjs";

const firestoreProjectId = "quickmemo-share-api-test";
const markdownSource = [
  "# E2E Markdown",
  "",
  "실제 암호화 저장을 확인합니다.",
  "",
  "[[연결 대상]] #vault/e2e"
].join("\n");

async function expectMutuallyExclusiveMobileDrawers(page) {
  const leftPanel = page.getByRole("complementary", { name: "Vault 탐색기" });
  const rightPanel = page.getByRole("complementary", { name: "연결 정보" });

  if (await leftPanel.count() === 0) {
    await page.getByRole("button", { name: "왼쪽 패널 열기" }).click();
  }
  await expect(leftPanel).toBeVisible();
  await expect(rightPanel).toHaveCount(0);

  await leftPanel.getByRole("button", { name: "왼쪽 패널 닫기" }).click();
  await expect(leftPanel).toHaveCount(0);
  await page.getByRole("button", { name: "오른쪽 패널 열기" }).click();
  await expect(rightPanel).toBeVisible();
  await expect(leftPanel).toHaveCount(0);

  await page.getByRole("button", { name: "왼쪽 패널 열기" }).click();
  await expect(leftPanel).toBeVisible();
  await expect(rightPanel).toHaveCount(0);
}

async function expectMinimumTouchTargets(page, selector = ".vault-workspace button") {
  const undersized = await page.locator(selector).evaluateAll((elements) => (
    elements.flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        style.display === "none"
        || style.visibility === "hidden"
        || bounds.width === 0
        || bounds.height === 0
      ) {
        return [];
      }
      if (bounds.width >= 43.5 && bounds.height >= 43.5) {
        return [];
      }
      return [{
        height: Number(bounds.height.toFixed(2)),
        label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
        width: Number(bounds.width.toFixed(2))
      }];
    })
  ));

  expect(undersized, "visible Vault touch targets must be at least 44x44 CSS pixels").toEqual([]);
}

async function expectEncryptedFirestoreDocument(request, fixture, noteId) {
  let rawDocument = "";
  await expect.poll(async () => {
    const response = await request.get(
      `http://127.0.0.1:8080/v1/projects/${firestoreProjectId}/databases/(default)/documents/notes/${encodeURIComponent(noteId)}`,
      {
        headers: {
          authorization: `Bearer ${fixture.viewerAuth.idToken}`
        }
      }
    );
    if (!response.ok()) {
      return false;
    }
    rawDocument = await response.text();
    return /"revision"\s*:\s*\{\s*"integerValue"\s*:\s*"2"/u.test(rawDocument);
  }, {
    message: "the authenticated user must read the revision-2 encrypted note"
  }).toBe(true);

  expect(rawDocument).toContain("encryptedTitle");
  expect(rawDocument).toContain("encryptedBody");
  expect(rawDocument).toContain("wrappedKeys");
  expect(rawDocument).toContain("markdown-v1");
  expect(rawDocument).not.toContain(markdownSource);
  expect(rawDocument).not.toContain("실제 암호화 저장을 확인합니다.");
}

async function expectEditorSource(editor, expectedSource) {
  await expect.poll(async () => (
    (await editor.locator(".cm-line").allTextContents()).join("\n")
  )).toBe(expectedSource);
}

test("authenticated encrypted Vault works at 1280, 390, and 320 pixels", async ({
  page,
  request
}) => {
  test.setTimeout(120_000);
  const diagnostics = observePage(page);
  const fixture = await seedScenario(request, "authenticated-verified");
  const viewportWidth = page.viewportSize()?.width ?? 1280;
  const mobileLayout = viewportWidth <= 760;

  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  await expect(page.getByRole("complementary", { name: "Vault 리본" })).toBeVisible();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page
    .locator('.vault-panel-toolbar button[aria-label="새 노트"]')
    .click();
  await expect(page.getByLabel("노트 이름")).toHaveValue("새 노트");

  await page.getByLabel("노트 이름").fill("E2E 연결 노트");

  await page.getByRole("button", { name: "소스", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
  await expect(editor).toBeVisible();
  await editor.fill(markdownSource);

  const saveButton = page.getByRole("button", { name: "저장", exact: true });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expectEditorSource(editor, markdownSource);

  const activeTabId = await page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]').getAttribute("id");
  expect(activeTabId).toMatch(/^entry:/u);
  const noteId = activeTabId?.slice("entry:".length) ?? "";
  await expectEncryptedFirestoreDocument(request, fixture, noteId);
  await expect(saveButton).toBeDisabled();
  await expect(page.getByRole("tab", { name: "E2E 연결 노트", exact: true })).toBeVisible();

  if (mobileLayout) {
    await expectMutuallyExclusiveMobileDrawers(page);
    await expectMinimumTouchTargets(page);
  }
  await expect(page.getByRole("treeitem", { name: "E2E 연결 노트", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "그래프 보기", exact: true }).click();
  const graph = page.getByRole("region", { name: "전체 그래프" });
  await expect(graph).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "그래프 화면 제어" })).toBeVisible();
  const settings = page.getByRole("complementary", { name: "전체 그래프 설정" });
  await expect(settings).toBeVisible();
  for (const sectionName of ["필터", "그룹", "표시", "장력"]) {
    await expect(settings.getByRole("button", { name: sectionName, exact: true })).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "그래프 설정 닫기" }).click();
  await expect(settings).toHaveCount(0);
  await graph.getByText("접근 가능한 그래프 목록", { exact: true }).click();
  const graphNodeList = graph.getByRole("list", { name: "그래프 노드" });
  await expect(graphNodeList).toBeVisible();
  const savedNoteNode = graphNodeList.getByRole("button", { name: /^E2E 연결 노트, 노트,/u });
  await expect(savedNoteNode).toBeVisible();

  if (mobileLayout) {
    await expectMinimumTouchTargets(page, ".qm-graph-view button, .qm-graph-view summary");
  }
  await savedNoteNode.click();
  await expect(page.getByLabel("노트 이름")).toHaveValue("E2E 연결 노트");
  await expectEditorSource(page.getByRole("textbox", { name: "Markdown 편집기" }), markdownSource);

  await page.waitForTimeout(900);
  await page.reload();
  const unlockPassword = page.locator('input[type="password"][aria-label="비밀번호"]');
  await expect(unlockPassword).toBeVisible();
  await unlockPassword.fill(fixture.viewerAuth.password);
  await page.getByRole("button", { name: "열기", exact: true }).click();
  await expect(page.getByLabel("노트 이름")).toHaveValue("E2E 연결 노트");
  await expectEditorSource(page.getByRole("textbox", { name: "Markdown 편집기" }), markdownSource);
  await expectNoHorizontalOverflow(page);
  await expectCleanRuntime(diagnostics, fixture);
});
