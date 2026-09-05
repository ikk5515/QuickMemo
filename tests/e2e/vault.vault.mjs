/* global getComputedStyle */

import { expect, test } from "@playwright/test";
import { readVaultEditorSource, saveVaultDocument } from "./vault-editor-helpers.mjs";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors,
  expectCleanRuntime,
  expectNoHorizontalOverflow,
  loginDirectly,
  navigateWithinApp,
  observePage,
  openVaultMoreTool,
  seedScenario,
  unlockEncryptedVault
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
  const leftPanel = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  const rightPanel = page.locator('.vault-right-panel[aria-label="연결 정보"]');

  if (!(await leftPanel.isVisible())) {
    await page.getByRole("button", { name: "왼쪽 패널 열기" }).click();
  }
  await expect(leftPanel).toBeVisible();
  await expect(rightPanel).toHaveCount(0);

  await leftPanel.getByRole("button", { name: "왼쪽 패널 닫기" }).click();
  await expect(leftPanel).toHaveCount(0);
  await page.getByRole("button", { name: "오른쪽 패널 열기" }).click();
  await expect(rightPanel).toBeVisible();
  await expect(leftPanel).toHaveCount(0);
  await expectMinimumTouchTargets(page, ".vault-right-panel button");

  await rightPanel.getByRole("button", { name: "오른쪽 패널 닫기" }).click();
  await expect(rightPanel).toHaveCount(0);
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
    const document = await response.json();
    rawDocument = JSON.stringify(document);
    return Number(document?.fields?.revision?.integerValue ?? 0) >= 2;
  }, {
    message: "the authenticated user must read the encrypted note at revision 2 or newer"
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
    await readVaultEditorSource(editor)
  )).toBe(expectedSource);
}

async function graphViewportKey(graph) {
  return [
    await graph.getAttribute("data-graph-center-x"),
    await graph.getAttribute("data-graph-center-y"),
    await graph.getAttribute("data-graph-zoom")
  ].join(":");
}

async function stableGraphViewport(page, graph) {
  // Imperative keyboard pan/zoom uses a short visual transition. Persist and
  // compare the settled renderer coordinates, not an intermediate animation
  // frame that can differ by engine and viewport width.
  await page.waitForTimeout(250);
  let previous = "";
  let stableReads = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await graphViewportKey(graph);
    stableReads = current === previous ? stableReads + 1 : 0;
    if (stableReads >= 2) {
      const [centerX, centerY, zoom] = current.split(":");
      return { centerX, centerY, zoom };
    }
    previous = current;
    await page.waitForTimeout(100);
  }
  throw new Error("graph viewport did not settle after keyboard interaction");
}

async function expectGraphViewportRestored(graph, expected) {
  for (const [attribute, value] of [
    ["data-graph-center-x", expected.centerX],
    ["data-graph-center-y", expected.centerY],
    ["data-graph-zoom", expected.zoom]
  ]) {
    const expectedNumber = Number(value);
    expect(Number.isFinite(expectedNumber), `${attribute} fixture must be finite`).toBe(true);
    await expect.poll(async () => Number(await graph.getAttribute(attribute)), {
      message: `${attribute} must survive encrypted workspace restoration`
    }).toBeCloseTo(expectedNumber, 10);
  }
}

async function expectWheelZoomsLiveGraph(page, graph) {
  const canvas = graph.locator(".qm-graph-renderer canvas");
  await expect(canvas).toBeVisible();
  const before = Number(await graph.getAttribute("data-graph-zoom"));
  const bounds = await canvas.boundingBox();
  expect(bounds, "live graph Canvas must have measurable bounds").not.toBeNull();
  if (!bounds) return;

  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -420);
  await expect.poll(async () => Number(await graph.getAttribute("data-graph-zoom")), {
    message: "wheel input must update the live graph viewport"
  }).toBeGreaterThan(before);
}

async function expectBackgroundDragPansLiveGraph(page, graph) {
  const canvas = graph.locator(".qm-graph-renderer canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds, "live graph Canvas must have measurable bounds").not.toBeNull();
  if (!bounds) return;

  // Nodes are force-positioned, so no test may assume a fixed node coordinate.
  // Try inset corners until one real background gesture changes the viewport.
  const candidates = [
    { x: 0.08, y: 0.12 },
    { x: 0.92, y: 0.12 },
    { x: 0.08, y: 0.88 },
    { x: 0.92, y: 0.88 }
  ];
  const initial = await graphViewportKey(graph);
  for (const candidate of candidates) {
    const startX = bounds.x + bounds.width * candidate.x;
    const startY = bounds.y + bounds.height * candidate.y;
    const deltaX = candidate.x < 0.5 ? 52 : -52;
    const deltaY = candidate.y < 0.5 ? 28 : -28;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 6 });
    await page.mouse.up();
    for (let check = 0; check < 10; check += 1) {
      await page.waitForTimeout(100);
      if ((await graphViewportKey(graph)) !== initial) return;
    }
  }
  throw new Error("four coordinate-independent background drag attempts did not update the graph viewport");
}

test("authenticated encrypted Vault works across the supported responsive widths", async ({
  browserName,
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
  if (mobileLayout) {
    // Workspace restoration may reopen the persisted explorer. While its
    // modal drawer is open, the ribbon and editor are intentionally inert and
    // removed from the accessibility tree.
    await page.waitForTimeout(900);
    const explorer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
    if (!(await explorer.isVisible())) {
      await page.getByRole("button", { name: "왼쪽 패널 열기" }).click();
    }
    await expect(explorer).toBeVisible();
    await expect(explorer).toHaveAttribute("role", "dialog");
    await expect(explorer).toHaveAttribute("aria-modal", "true");
  } else {
    await expect(page.getByRole("complementary", { name: "Vault 리본" })).toBeVisible();
    await expect(page.getByRole("tabpanel")).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);

  await page
    .locator('.vault-panel-toolbar button[aria-label="새 노트"]')
    .click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await expect(page.getByLabel("노트 이름")).toHaveValue("새 노트");

  await page.getByLabel("노트 이름").fill("E2E 연결 노트");

  const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
  await expect(editor).toBeVisible();
  await editor.fill(markdownSource);

  await saveVaultDocument(page);
  await expectEditorSource(editor, markdownSource);

  const activeTabId = await page.locator('.vault-tab-bar [role="tab"][aria-selected="true"]').getAttribute("id");
  expect(activeTabId).toMatch(/^entry:/u);
  const noteId = activeTabId?.slice("entry:".length) ?? "";
  await expectEncryptedFirestoreDocument(request, fixture, noteId);
  await expect(page.getByRole("tab", { name: "E2E 연결 노트", exact: true })).toBeVisible();

  for (const removedMode of ["소스 모드", "라이브 프리뷰", "읽기 보기"]) {
    await expect(page.getByRole("button", { name: removedMode, exact: true })).toHaveCount(0);
  }
  const liveEditor = page.locator(".vault-note-content > .vault-codemirror--live-preview");
  await expect(liveEditor).toBeVisible();
  await expect(liveEditor.locator(".cm-editor")).toHaveCount(1);
  await expect(page.locator(".vault-note-content > .vault-markdown-renderer")).toHaveCount(0);
  // Activate this line before checking its
  // raw Markdown syntax; inactive headings intentionally hide the # marker.
  await liveEditor.locator(".cm-line").first().click();
  await expect(liveEditor.locator(".cm-line").first()).toContainText("# E2E Markdown");
  await expect(liveEditor.locator(".cm-live-wikilink")).toContainText("연결 대상");
  await expect(liveEditor.locator(".cm-live-tag")).toContainText("#vault/e2e");

  await expectEditorSource(editor, markdownSource);

  if (mobileLayout) {
    await expectMutuallyExclusiveMobileDrawers(page);
    await expectMinimumTouchTargets(page);
  }
  const savedNoteTreeItem = page.getByRole("treeitem", { name: "E2E 연결 노트", exact: true });
  await expect(savedNoteTreeItem).toBeVisible();
  await savedNoteTreeItem.click({ modifiers: ["Meta", "Alt"] });
  const primaryTabGroup = page.locator('.vault-tab-group[data-group-id="primary"]');
  const splitTabGroupCandidate = page.locator('.vault-tab-group:not([data-group-id="primary"])');
  await expect(splitTabGroupCandidate).toHaveCount(1);
  const splitGroupId = await splitTabGroupCandidate.getAttribute("data-group-id");
  expect(splitGroupId).toMatch(/^pane_[A-Za-z0-9_-]+$/u);
  if (!splitGroupId) throw new Error("split Vault pane id is missing");
  const secondaryTabGroup = page.locator(`.vault-tab-group[data-group-id="${splitGroupId}"]`);
  if (mobileLayout) {
    const groupSelector = page.getByLabel("탭 그룹 선택");
    await expect(page.locator(".vault-tab-group")).toHaveCount(1);
    await expect(groupSelector).toHaveValue(splitGroupId);
    await expect(groupSelector.locator("option")).toHaveCount(2);
    await expect(secondaryTabGroup.getByRole("tab", { name: "E2E 연결 노트", exact: true })).toBeVisible();
    await expectMinimumTouchTargets(page, ".vault-tab-group-selector select");
  } else {
    await expect(page.locator(".vault-tab-group")).toHaveCount(2);
    await expect(primaryTabGroup.getByRole("tab", { name: "E2E 연결 노트", exact: true })).toBeVisible();
    await expect(secondaryTabGroup.getByRole("tab", { name: "E2E 연결 노트", exact: true })).toBeVisible();
    await expect(secondaryTabGroup).toHaveClass(/active/u);
  }
  const secondaryTabId = await secondaryTabGroup
    .getByRole("tab", { name: "E2E 연결 노트", exact: true })
    .getAttribute("id");
  expect(secondaryTabId).toBe(`entry:${noteId}:${splitGroupId}`);
  await secondaryTabGroup.getByRole("button", { name: "E2E 연결 노트 탭 고정" }).click();
  await expect(secondaryTabGroup.getByRole("button", { name: "E2E 연결 노트 탭 고정 해제" }))
    .toHaveAttribute("aria-pressed", "true");
  await expectNoHorizontalOverflow(page);

  // The split and group-local active tab are part of the encrypted workspace
  // state and must survive a locked reload before the secondary instance is
  // closed for the rest of this end-to-end scenario.
  await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", "saved");
  await page.reload();
  await unlockEncryptedVault(page, fixture.viewerAuth.password);
  if (mobileLayout) {
    await expect(page.locator(".vault-tab-group")).toHaveCount(1);
    await expect(page.getByLabel("탭 그룹 선택")).toHaveValue(splitGroupId);
  } else {
    await expect(page.locator(".vault-tab-group")).toHaveCount(2);
    await expect(secondaryTabGroup).toHaveClass(/active/u);
  }
  const restoredSecondaryPin = secondaryTabGroup.getByRole("button", { name: "E2E 연결 노트 탭 고정 해제" });
  await expect(restoredSecondaryPin).toHaveAttribute("aria-pressed", "true");
  await restoredSecondaryPin.click();
  await secondaryTabGroup.getByRole("button", { name: "E2E 연결 노트 닫기" }).click();
  await expect(secondaryTabGroup).toHaveCount(0);
  await expect(primaryTabGroup.getByRole("tab", { name: "E2E 연결 노트", exact: true })).toHaveAttribute("aria-selected", "true");
  await expectNoHorizontalOverflow(page);
  if (mobileLayout) {
    const explorer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
    if (await explorer.isVisible()) {
      await explorer.getByRole("button", { name: "왼쪽 패널 닫기" }).click();
    }
    await expect(explorer).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Vault 리본" })).toBeVisible();
    const titleBounds = await page.getByLabel("노트 이름").boundingBox();
    expect(titleBounds?.width ?? 0, "mobile note title must keep a practical editing width").toBeGreaterThanOrEqual(180);
  }

  await openVaultMoreTool(page, "그래프 보기");
  let graph = page.getByRole("region", { name: "전체 그래프" });
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
  const zoomButton = page.getByRole("button", { name: "확대", exact: true });
  await expect(zoomButton).toBeEnabled();
  await graph.focus();
  await graph.press("=");
  await expect.poll(async () => Number(await graph.getAttribute("data-graph-zoom"))).toBeGreaterThan(1);
  const centerBeforeKeyboardPan = await graph.getAttribute("data-graph-center-x");
  await graph.press("ArrowRight");
  await expect.poll(async () => graph.getAttribute("data-graph-center-x")).not.toBe(centerBeforeKeyboardPan);
  if (!mobileLayout) {
    await expectWheelZoomsLiveGraph(page, graph);
    await expectBackgroundDragPansLiveGraph(page, graph);
  }
  const persistedGraphViewport = await stableGraphViewport(page, graph);
  expect(persistedGraphViewport.centerX).not.toBeNull();
  expect(persistedGraphViewport.centerY).not.toBeNull();
  expect(persistedGraphViewport.zoom).not.toBeNull();

  // The keyboard viewport target must survive an encrypted workspace save and
  // a locked reload before any note is opened from the graph.
  await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", "saved");
  await page.reload();
  await unlockEncryptedVault(page, fixture.viewerAuth.password);
  graph = page.getByRole("region", { name: "전체 그래프" });
  await expect(graph).toBeVisible();
  await expectGraphViewportRestored(graph, persistedGraphViewport);
  const restoredSettings = page.getByRole("complementary", { name: "전체 그래프 설정" });
  if (await restoredSettings.isVisible()) {
    await page.getByRole("button", { name: "그래프 설정 닫기" }).click();
    await expect(restoredSettings).toHaveCount(0);
  }

  await graph.getByText("접근 가능한 그래프 목록", { exact: true }).click();
  const graphNodeList = graph.getByRole("list", { name: "그래프 노드" });
  await expect(graphNodeList).toBeVisible();
  const savedNoteNode = graphNodeList.getByRole("button", { name: /^E2E 연결 노트, 노트,/u });
  await expect(savedNoteNode).toBeVisible();

  await savedNoteNode.click({ button: "right" });
  const graphNodeMenu = page.getByRole("menu", { name: "파일 작업" });
  await expect(graphNodeMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(graphNodeMenu).toHaveCount(0);

  if (mobileLayout) {
    await expectMinimumTouchTargets(page, ".qm-graph-view button, .qm-graph-view summary");
  }
  await page.getByRole("button", { name: "E2E 연결 노트 닫기" }).click();
  await expect(page.getByRole("tab", { name: "E2E 연결 노트", exact: true })).toHaveCount(0);
  await savedNoteNode.click({ modifiers: ["Meta"] });
  await expect(page.getByRole("tab", { name: "그래프 보기", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "E2E 연결 노트", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("노트 이름")).toHaveValue("E2E 연결 노트");
  await expectEditorSource(page.getByRole("textbox", { name: "Markdown 편집기" }), markdownSource);

  await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", "saved");
  await page.reload();
  await unlockEncryptedVault(page, fixture.viewerAuth.password);
  await expect(page.getByLabel("노트 이름")).toHaveValue("E2E 연결 노트");
  await expectEditorSource(page.getByRole("textbox", { name: "Markdown 편집기" }), markdownSource);
  await expectNoHorizontalOverflow(page);

  await navigateWithinApp(page, "/library");
  await page.getByRole("link", { name: "메모", exact: true }).click();
  await openVaultMoreTool(page, "그래프 보기");
  await expect(page).toHaveURL((url) => (
    url.pathname === "/app"
  ));
  await expect(page.getByRole("region", { name: "전체 그래프" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  if (browserName === "webkit") {
    allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  }
  await expectCleanRuntime(diagnostics, fixture);
});
