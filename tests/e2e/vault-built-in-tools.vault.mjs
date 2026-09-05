/* global document, getComputedStyle */

import { expect, test } from "@playwright/test";
import { readVaultEditorSource, saveVaultDocument } from "./vault-editor-helpers.mjs";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors,
  expectCleanRuntime,
  loginDirectly,
  navigateWithinApp,
  observePage,
  seedScenario,
  unlockEncryptedVault
} from "./helpers.mjs";

const firestoreProjectId = "quickmemo-share-api-test";
const drawingSecret = "E2E_DRAWING_PLAINTEXT_7d21";
const dataviewSecret = "E2E_DATAVIEW_PLAINTEXT_4e63";
const templateSecret = "E2E_TEMPLATE_PLAINTEXT_9c84";
const recoveryV1Secret = "E2E_RECOVERY_V1_PLAINTEXT_1d95";
const recoveryV2Secret = "E2E_RECOVERY_V2_PLAINTEXT_2ea6";
const generatedTitle = "E2E 템플릿 결과";
const searchBookmarkLabel = "E2E 암호화 검색";
const focusedBuiltInAcceptanceProjects = new Set([
  "vault-chromium-desktop-1280",
  "vault-chromium-mobile-390",
  "vault-webkit-desktop-1280",
  "vault-webkit-mobile-390"
]);

async function currentLocalDateKey(page) {
  return page.evaluate(() => {
    const now = new Date();
    const twoDigits = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
  });
}

async function activeEntryId(page) {
  const tabId = await page
    .locator('.vault-tab-bar [role="tab"][aria-selected="true"]')
    .getAttribute("id");
  expect(tabId).toMatch(/^entry:/u);
  return tabId.slice("entry:".length);
}

async function expectEditorSource(page, expectedSource) {
  const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
  await expect(editor).toBeVisible();
  await expect.poll(async () => (
    await readVaultEditorSource(editor)
  )).toBe(expectedSource);
}

async function saveActiveEntry(page) {
  await saveVaultDocument(page);
}

async function expectVaultNameWritesReady(page) {
  // Mobile drawers are modal surfaces. While one is open, the background
  // ribbon is intentionally inert/aria-hidden and the equivalent toolbar
  // action inside the drawer is the only accessible create control. Query the
  // active accessibility surface so this readiness assertion covers both
  // valid drawer states instead of mistaking correct modal isolation for a
  // missing Vault shell.
  const createNote = page.getByRole("button", { name: "새 노트", exact: true }).first();
  await expect(createNote).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole("status", { name: "Vault 이름 무결성 준비" })).toHaveCount(0);
}

async function ensureLeftPanel(page) {
  const panel = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  await expect.poll(async () => {
    if (await panel.isVisible()) return true;
    const opener = page.getByRole("button", { name: "왼쪽 패널 열기" });
    if (await opener.isVisible()) {
      await opener.click({ timeout: 500 }).catch(() => undefined);
    }
    return panel.isVisible();
  }, { message: "Vault explorer must settle open after workspace restoration" }).toBe(true);
  await expect(panel).toBeVisible();
  return panel;
}

async function expectPageViewportContained(page) {
  const overflow = await page.evaluate(() => ({
    body: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
    root: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    workspace: (() => {
      const workspace = document.querySelector(".vault-workspace");
      if (!workspace) return null;
      const bounds = workspace.getBoundingClientRect();
      return {
        left: Math.round(bounds.left * 100) / 100,
        right: Math.round(bounds.right * 100) / 100,
        viewport: document.documentElement.clientWidth
      };
    })()
  }));

  expect(overflow.body, "body must not horizontally overflow").toBe(0);
  expect(overflow.root, "document root must not horizontally overflow").toBe(0);
  expect(overflow.workspace).not.toBeNull();
  expect(overflow.workspace.left).toBeGreaterThanOrEqual(-1);
  expect(overflow.workspace.right).toBeLessThanOrEqual(overflow.workspace.viewport + 1);
}

async function expectMobileButtonTargets(scope, label) {
  const undersized = await scope.locator("button").evaluateAll((buttons) => buttons.flatMap((button) => {
    const bounds = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    if (
      style.display === "none"
      || style.visibility === "hidden"
      || bounds.width === 0
      || bounds.height === 0
    ) {
      return [];
    }
    return bounds.width >= 43.5 && bounds.height >= 43.5 ? [] : [{
      height: Number(bounds.height.toFixed(2)),
      name: button.getAttribute("aria-label") || button.textContent?.trim() || "button",
      width: Number(bounds.width.toFixed(2))
    }];
  }));
  expect(undersized, `${label} buttons must provide 44x44 CSS pixel touch targets`).toEqual([]);
}

async function expectPointerTarget(locator, label) {
  const details = await locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      bounds: {
        height: Number(bounds.height.toFixed(2)),
        left: Number(bounds.left.toFixed(2)),
        top: Number(bounds.top.toFixed(2)),
        width: Number(bounds.width.toFixed(2))
      },
      hit: hit?.getAttribute("aria-label") || hit?.className || hit?.tagName || null,
      receivesPointer: hit === element || element.contains(hit)
    };
  });
  expect(details.receivesPointer, `${label} must be the topmost target at its center: ${JSON.stringify(details)}`).toBe(true);
}

async function expectEncryptedEntry(request, fixture, entryId, forbiddenPlaintext, contentFormat = "markdown-v1") {
  let rawDocument = "";
  await expect.poll(async () => {
    const response = await request.get(
      `http://127.0.0.1:8080/v1/projects/${firestoreProjectId}/databases/(default)/documents/notes/${encodeURIComponent(entryId)}`,
      { headers: { authorization: `Bearer ${fixture.viewerAuth.idToken}` } }
    );
    if (!response.ok()) return false;
    rawDocument = await response.text();
    return rawDocument.includes("encryptedTitle") && rawDocument.includes("encryptedBody");
  }, { message: `encrypted Firestore entry ${entryId} must become readable to its owner` }).toBe(true);

  expect(rawDocument).toContain("wrappedKeys");
  expect(rawDocument).toContain(contentFormat);
  for (const plaintext of forbiddenPlaintext) {
    expect(rawDocument, `Firestore must not contain plugin plaintext: ${plaintext}`).not.toContain(plaintext);
  }
}

async function encryptedEntryRevision(request, fixture, entryId) {
  const response = await request.get(
    `http://127.0.0.1:8080/v1/projects/${firestoreProjectId}/databases/(default)/documents/notes/${encodeURIComponent(entryId)}`,
    { headers: { authorization: `Bearer ${fixture.viewerAuth.idToken}` } }
  );
  if (!response.ok()) return 0;
  const document = await response.json();
  return Number(document?.fields?.revision?.integerValue ?? 0);
}

async function expectEncryptedHistoryAtRest(
  request,
  fixture,
  entryId,
  minimumEntries,
  forbiddenPlaintext
) {
  let rawCollection = "";
  await expect.poll(async () => {
    const response = await request.get(
      `http://127.0.0.1:8080/v1/projects/${firestoreProjectId}/databases/(default)/documents/notes/${encodeURIComponent(entryId)}/history?pageSize=20`,
      { headers: { authorization: `Bearer ${fixture.viewerAuth.idToken}` } }
    );
    if (!response.ok()) return 0;
    rawCollection = await response.text();
    const payload = rawCollection ? JSON.parse(rawCollection) : {};
    return Array.isArray(payload.documents) ? payload.documents.length : 0;
  }, { message: `encrypted history for ${entryId} must contain ${minimumEntries} revisions` })
    .toBeGreaterThanOrEqual(minimumEntries);

  expect(rawCollection).toContain("encryptedSummary");
  expect(rawCollection).toContain("encryptedSnapshot");
  for (const plaintext of forbiddenPlaintext) {
    expect(rawCollection, `history documents must not contain plaintext: ${plaintext}`).not.toContain(plaintext);
  }
}

async function expectEncryptedWorkspace(request, fixture, forbiddenPlaintext) {
  let rawDocument = "";
  await expect.poll(async () => {
    const response = await request.get(
      `http://127.0.0.1:8080/v1/projects/${firestoreProjectId}/databases/(default)/documents/vaultWorkspaces/${encodeURIComponent(fixture.viewerAuth.uid)}`,
      { headers: { authorization: `Bearer ${fixture.viewerAuth.idToken}` } }
    );
    if (!response.ok()) return false;
    rawDocument = await response.text();
    return rawDocument.includes("encryptedState") && rawDocument.includes("wrappedKey");
  }, { message: "encrypted Vault workspace must be persisted" }).toBe(true);

  for (const plaintext of forbiddenPlaintext) {
    expect(rawDocument, `workspace document must not contain plaintext: ${plaintext}`).not.toContain(plaintext);
  }
}

async function openCommand(page, query) {
  await page.getByRole("button", { name: "명령 팔레트" }).click();
  const dialog = page.getByRole("dialog", { name: "명령 팔레트" });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole("combobox", { name: "명령 검색" });
  await search.fill(query);
  await expect(dialog.getByRole("option", { name: new RegExp(query, "u") })).toHaveCount(1);
  await search.press("Enter");
}

test("authenticated Vault built-in tools are encrypted, persistent, safe, and responsive", async ({
  browserName,
  page,
  request
}) => {
  test.setTimeout(180_000);
  const diagnostics = observePage(page);
  const fixture = await seedScenario(request, "authenticated-verified");
  const viewportWidth = page.viewportSize()?.width ?? 1280;
  const mobileLayout = viewportWidth <= 760;
  const entryIds = {};
  // Calendar creation, later template expansion, and reload share one date
  // fixture even when the real Asia/Seoul clock crosses midnight. Only Date is
  // fixed; autosave, animation, and network timers continue to run normally.
  await page.clock.setFixedTime(new Date());
  const todayKey = await currentLocalDateKey(page);

  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  if (mobileLayout) {
    // The default drawer can render before the encrypted workspace snapshot
    // finishes restoring. Let that one-time restore settle, then cover either
    // valid persisted state without racing an in-flight close.
    await page.waitForTimeout(900);
    const drawer = await ensureLeftPanel(page);
    await expect(drawer).toHaveAttribute("role", "dialog");
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    const drawerControls = drawer.locator('summary, button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]');
    await drawerControls.filter({ visible: true }).last().focus();
    await page.keyboard.press("Tab");
    await expect(drawer.getByRole("button", { name: "왼쪽 패널 닫기" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    const reopen = page.getByRole("button", { name: "왼쪽 패널 열기" });
    await expect(reopen).toBeFocused();
    await reopen.click();
    await expect(page.getByRole("dialog", { name: "Vault 탐색기" })).toBeVisible();
  } else {
    await expect(page.getByRole("complementary", { name: "Vault 리본" })).toBeVisible();
    for (const tool of ["파일", "검색", "명령 팔레트"]) {
      await expect(page.getByRole("button", { name: tool, exact: true })).toBeVisible();
    }
  }
  await expectPageViewportContained(page);

  await test.step("Daily Notes calendar creates a date-addressed encrypted Markdown note", async () => {
    const panel = await ensureLeftPanel(page);
    let calendar;
    if (mobileLayout) {
      await panel.getByRole("button", { name: "날짜별 메모", exact: true }).click();
      calendar = page.getByRole("dialog", { name: "Daily Notes 달력" });
      await expect(calendar).toBeVisible();
      await expect(calendar.getByRole("button", { name: "Daily Notes 달력 닫기" })).toBeFocused();
      await expectMobileButtonTargets(calendar, "Daily Notes calendar");
    } else {
      const toggle = panel.locator(".vault-calendar-toggle");
      if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      calendar = panel.locator(".qm-daily-calendar");
      await expect(calendar).toBeVisible();
    }

    const today = calendar.locator(`button[data-date="${todayKey}"]`);
    await expect(today).toHaveAttribute("aria-current", "date");
    await expect(today).toHaveAccessibleName(/Daily Note 만들기/u);
    if (mobileLayout) {
      await today.focus();
      await today.press("ArrowRight");
      const nextFocusedDay = calendar.locator('.qm-daily-calendar-grid button[data-date]:focus');
      await expect(nextFocusedDay).toBeFocused();
      await expect(nextFocusedDay).not.toHaveAttribute("data-date", todayKey);
      await today.focus();
    }
    await today.click();
    await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toHaveValue(todayKey);

    const dailySource = (await readVaultEditorSource(page.getByRole("textbox", { name: "Markdown 편집기" }))).split("\n");
    expect(dailySource.join("\n")).toContain(`type: daily-note\ndate: ${todayKey}`);
    expect(dailySource.join("\n")).toContain(`# ${todayKey}`);
    expect(dailySource.join("\n")).toContain("## 인박스");
    entryIds.daily = await activeEntryId(page);
    if (mobileLayout) {
      await expect(page.getByRole("complementary", { name: "Vault 리본" })).toBeVisible();
      for (const tool of ["파일", "검색", "명령 팔레트"]) {
        await expect(page.getByRole("button", { name: tool, exact: true })).toBeVisible();
      }
    }
    await expectPageViewportContained(page);
  });

  await test.step("Drawing edits through the visual canvas and survives encrypted save", async () => {
    await openCommand(page, "새 드로잉 만들기");
    await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toHaveValue("새 드로잉");

    const drawing = page.getByRole("region", { name: "QuickMemo Drawing beta" });
    await expect(drawing).toBeVisible();
    await drawing.getByRole("button", { name: "텍스트", exact: true }).click();
    await drawing.getByLabel("배치할 텍스트").fill(drawingSecret);
    const canvas = drawing.getByRole("application", { name: "Drawing 캔버스" });
    await canvas.click({ position: { x: 96, y: 96 } });
    await expect(canvas.locator("text")).toContainText(drawingSecret);
    await drawing.getByRole("button", { name: "확대" }).click();
    await expect(drawing.getByLabel("확대 비율")).toHaveText("125%");
    await drawing.getByRole("button", { name: "실행 취소" }).click();
    await expect(canvas.locator("text")).toHaveCount(0);
    await drawing.getByRole("button", { name: "다시 실행" }).click();
    await expect(canvas.locator("text")).toContainText(drawingSecret);
    await saveActiveEntry(page);
    entryIds.drawing = await activeEntryId(page);
    if (mobileLayout) await expectMobileButtonTargets(drawing, "Drawing toolbar");
    await expectPageViewportContained(page);
  });

  await test.step("safe Dataview renders indexed notes while DataviewJS remains inert", async () => {
    const source = [
      "# E2E Dataview",
      "",
      dataviewSecret,
      "",
      "```dataview",
      "LIST",
      "SORT file.name ASC",
      "LIMIT 20",
      "```",
      "",
      "```dataviewjs",
      "globalThis.__quickmemoDataviewE2E = true",
      "```"
    ].join("\n");
    const newNoteTab = page.getByRole("button", { name: "새 노트 탭" });
    await expectPointerTarget(newNoteTab, "New note tab button");
    await newNoteTab.click();
    await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toHaveValue("새 노트");
    await page.getByRole("textbox", { name: "노트 이름", exact: true }).fill("E2E Dataview");

    await page.getByRole("textbox", { name: "Markdown 편집기" }).fill(source);
    await saveActiveEntry(page);
    await expect(page.getByRole("textbox", { name: "노트 이름", exact: true }))
      .toHaveValue("E2E Dataview");
    entryIds.dataview = await activeEntryId(page);

    await page.getByRole("textbox", { name: "Markdown 편집기" }).press("ControlOrMeta+Home");
    const result = page.getByRole("region", { name: "Dataview 결과" });
    await expect(result).toBeVisible();
    await expect(result.locator("output")).not.toHaveText("0개");
    await expect(result.getByRole("button", { name: "E2E Dataview" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("DataviewJS는 실행하지 않습니다.");
    expect(await page.evaluate(() => globalThis.__quickmemoDataviewE2E)).toBeUndefined();
    if (mobileLayout) await expectMobileButtonTargets(result, "Dataview result");
    await expectPageViewportContained(page);
  });

  await test.step("safe Templater expands allowlisted tokens and preserves scripts as inert text", async () => {
    const panel = await ensureLeftPanel(page);
    page.once("dialog", async (dialog) => dialog.accept("Templates"));
    await panel.getByRole("button", { name: "새 폴더" }).click();
    const templateFolder = panel.getByRole("treeitem", { name: "Templates", exact: true });
    await expect(templateFolder).toBeVisible();
    await templateFolder.click();
    await panel.locator('.vault-panel-toolbar button[aria-label="새 노트"]').click();
    await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toHaveValue("새 노트");
    const templateSource = [
      "# {{title}}",
      "",
      `template-marker: ${templateSecret}`,
      "date: {{date}}",
      "unsafe: <% globalThis.__quickmemoTemplateE2E = true %>",
      "unknown: {{script:alert(1)}}"
    ].join("\n");
    await page.getByRole("textbox", { name: "노트 이름", exact: true }).fill("회의록 템플릿");

    await page.getByRole("textbox", { name: "Markdown 편집기" }).fill(templateSource);
    await saveActiveEntry(page);
    entryIds.template = await activeEntryId(page);

    await openCommand(page, "템플릿에서 새 노트 만들기");
    const dialog = page.getByRole("dialog", { name: "템플릿에서 새 노트" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("JavaScript와 네트워크 호출은 실행하지 않습니다.");
    await dialog.getByLabel("새 노트 이름").fill(generatedTitle);
    await expect(dialog.getByRole("option", { name: /회의록 템플릿/u })).toHaveAttribute("aria-selected", "true");
    if (mobileLayout) await expectMobileButtonTargets(dialog, "Template dialog");
    const createFromTemplate = dialog.getByRole("button", { name: "만들기", exact: true });
    await expect(createFromTemplate).toBeEnabled();
    await createFromTemplate.click();
    await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toHaveValue(generatedTitle);

    const generatedSource = [
      `# ${generatedTitle}`,
      "",
      `template-marker: ${templateSecret}`,
      `date: ${todayKey}`,
      "unsafe: <% globalThis.__quickmemoTemplateE2E = true %>",
      "unknown: {{script:alert(1)}}"
    ].join("\n");
    await expectEditorSource(page, generatedSource);
    expect(await page.evaluate(() => globalThis.__quickmemoTemplateE2E)).toBeUndefined();
    entryIds.generated = await activeEntryId(page);
    await expectPageViewportContained(page);
  });

  await test.step("search context and bookmarks persist only inside the encrypted workspace", async () => {
    await page.getByRole("button", { name: "검색", exact: true }).click();
    const panel = await ensureLeftPanel(page);
    const search = panel.getByRole("searchbox", { name: "Vault 검색식" });
    await search.fill(`content:"${dataviewSecret}"`);
    const result = panel.getByRole("button", { name: /E2E Dataview/u });
    await expect(result).toContainText(dataviewSecret);
    await panel.getByRole("button", { name: "현재 검색 저장" }).click();
    await panel.getByLabel("검색 북마크 이름").fill(searchBookmarkLabel);
    await panel.getByRole("button", { name: "저장", exact: true }).click();
    await expect(panel.getByRole("button", { name: searchBookmarkLabel, exact: true })).toBeVisible();
    await page.waitForTimeout(900);
    await expectEncryptedWorkspace(request, fixture, [searchBookmarkLabel, dataviewSecret, "content:"]);
    if (mobileLayout) {
      await panel.getByRole("button", { name: "왼쪽 패널 닫기" }).click();
    }
  });

  await test.step("every built-in artifact is ciphertext at rest", async () => {
    await expectEncryptedEntry(request, fixture, entryIds.daily, [`# ${todayKey}`]);
    await expectEncryptedEntry(request, fixture, entryIds.drawing, [drawingSecret, "quickmemo-plugin: drawing-v1"]);
    await expectEncryptedEntry(request, fixture, entryIds.dataview, [dataviewSecret, "globalThis.__quickmemoDataviewE2E"]);
    await expectEncryptedEntry(request, fixture, entryIds.template, [templateSecret, "globalThis.__quickmemoTemplateE2E"]);
    await expectEncryptedEntry(request, fixture, entryIds.generated, [generatedTitle, templateSecret]);
  });

  await test.step("reload locks plaintext, then restores persisted content", async () => {
    await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", "saved");
    await page.reload();
    await expect(page.locator('input[type="password"][aria-label="비밀번호"]')).toBeVisible();
    for (const plaintext of [
      drawingSecret,
      dataviewSecret,
      templateSecret
    ]) {
      await expect(page.locator("body")).not.toContainText(plaintext);
    }
    await unlockEncryptedVault(page, fixture.viewerAuth.password);
    await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toHaveValue(generatedTitle);
    await expectEditorSource(page, [
      `# ${generatedTitle}`,
      "",
      `template-marker: ${templateSecret}`,
      `date: ${todayKey}`,
      "unsafe: <% globalThis.__quickmemoTemplateE2E = true %>",
      "unknown: {{script:alert(1)}}"
    ].join("\n"));

    await page.getByRole("button", { name: "검색", exact: true }).click();
    let panel = await ensureLeftPanel(page);
    await expect(panel.getByRole("button", { name: searchBookmarkLabel, exact: true })).toBeVisible();
    if (mobileLayout) await panel.getByRole("button", { name: "왼쪽 패널 닫기" }).click();

    await page.getByRole("button", { name: "파일", exact: true }).click();
    panel = await ensureLeftPanel(page);
    await panel.getByRole("treeitem", { name: "새 드로잉", exact: true }).click();

    await expect(page.getByRole("application", { name: "Drawing 캔버스" }).locator("text")).toContainText(drawingSecret);

    await expectPageViewportContained(page);
  });

  if (browserName === "webkit") {
    allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  }
  await expectCleanRuntime(diagnostics, fixture, [
    drawingSecret,
    dataviewSecret,
    templateSecret
  ]);
});

test("File Recovery restores an old body as a new encrypted revision", async ({
  browserName,
  page,
  request
}, testInfo) => {
  test.skip(
    !focusedBuiltInAcceptanceProjects.has(testInfo.project.name),
    "File Recovery acceptance runs on the bounded Chromium/WebKit desktop-1280 and mobile-390 matrix."
  );
  test.setTimeout(120_000);
  const diagnostics = observePage(page);
  const fixture = await seedScenario(request, "authenticated-verified");
  const mobileLayout = (page.viewportSize()?.width ?? 1280) <= 760;
  const firstVersion = ["# E2E File Recovery", "", recoveryV1Secret].join("\n");
  const secondVersion = ["# E2E File Recovery", "", recoveryV2Secret].join("\n");

  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  await expectVaultNameWritesReady(page);
  const panel = await ensureLeftPanel(page);
  await panel.locator('.vault-panel-toolbar button[aria-label="새 노트"]').click();
  await page.getByRole("textbox", { name: "노트 이름", exact: true }).fill("E2E File Recovery");
  // Persist the name-claim mutation separately so the body-history fixture
  // below has exactly one V1 content revision. A combined title+body save
  // correctly creates both a body snapshot and a subsequent rename snapshot.
  await saveActiveEntry(page);

  const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
  await editor.fill(firstVersion);
  await saveActiveEntry(page);
  const entryId = await activeEntryId(page);
  await editor.fill(secondVersion);
  await saveActiveEntry(page);
  const revisionBeforeRestore = await encryptedEntryRevision(request, fixture, entryId);
  await expectEncryptedHistoryAtRest(
    request,
    fixture,
    entryId,
    2,
    [recoveryV1Secret, recoveryV2Secret]
  );

  const rightPanel = page.locator('.vault-right-panel[aria-label="연결 정보"]');
  if (!(await rightPanel.isVisible())) {
    await page.getByRole("button", { name: "오른쪽 패널 열기" }).click();
  }
  await expect(rightPanel).toBeVisible();
  await rightPanel.getByRole("tab", { name: "File Recovery" }).click();
  const recovery = rightPanel.getByRole("region", { name: "File Recovery" });
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText("독립 백업은 아닙니다");
  const oldVersion = recovery.locator("article").filter({ hasText: recoveryV1Secret });
  await expect(oldVersion).toHaveCount(1);
  await oldVersion.getByText("E2E File Recovery 미리보기", { exact: true }).click();
  await expect(oldVersion.locator("pre")).toContainText(recoveryV1Secret);
  if (mobileLayout) await expectMobileButtonTargets(recovery, "File Recovery");

  page.once("dialog", async (dialog) => dialog.accept());
  await oldVersion.getByRole("button", { name: "이 버전으로 복원" }).click();
  await rightPanel.getByRole("button", { name: "오른쪽 패널 닫기" }).click();
  await expectEditorSource(page, firstVersion);
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨", { timeout: 20_000 });
  await expect.poll(() => encryptedEntryRevision(request, fixture, entryId), {
    message: "File Recovery must persist the selected snapshot as a new encrypted revision"
  }).toBeGreaterThan(revisionBeforeRestore);
  await expectEncryptedHistoryAtRest(
    request,
    fixture,
    entryId,
    3,
    [recoveryV1Secret, recoveryV2Secret]
  );
  await expectEncryptedEntry(request, fixture, entryId, [recoveryV1Secret, recoveryV2Secret]);
  await expectPageViewportContained(page);

  await page.reload();
  await expect(page.locator('input[type="password"][aria-label="비밀번호"]')).toBeVisible();
  await expect(page.locator("body")).not.toContainText(recoveryV1Secret);
  await expect(page.locator("body")).not.toContainText(recoveryV2Secret);
  await unlockEncryptedVault(page, fixture.viewerAuth.password);
  await expectEditorSource(page, firstVersion);
  await expectPageViewportContained(page);

  if (browserName === "webkit") allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  await expectCleanRuntime(diagnostics, fixture, [recoveryV1Secret, recoveryV2Secret]);
});
