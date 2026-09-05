/* global getComputedStyle */

import { expect, test } from "@playwright/test";
import {
  expectCleanRuntime,
  loginDirectly,
  markOnlyOwnedVaultNoteAsLegacy,
  navigateWithinApp,
  observePage,
  ownedVaultNotesState,
  seedScenario,
  vaultPathRewriteState
} from "./helpers.mjs";

test("wide source layout, files-panel intent, and legacy move/copy preserve encrypted source", async ({
  page,
  request
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "vault-chromium-desktop-1440",
    "This focused desktop regression runs once at an explicit 2048px viewport."
  );
  test.setTimeout(120_000);

  await page.setViewportSize({ width: 2048, height: 1100 });
  await page.emulateMedia({ colorScheme: "dark" });

  const diagnostics = observePage(page);
  const fixture = await seedScenario(request, "authenticated-verified");
  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app?panel=files");

  const explorer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  const leftPanelToggle = page.locator(
    '.vault-ribbon button[aria-controls="vault-left-panel"]'
  );

  await expect(explorer).toBeVisible();
  await expect(leftPanelToggle).toHaveAttribute("aria-expanded", "true");

  await leftPanelToggle.click();
  await expect(explorer).toHaveCount(0);
  await expect(leftPanelToggle).toHaveAttribute("aria-expanded", "false");

  // A route intent is a one-shot instruction. It must not replay after the
  // user's close action when unrelated effects or encrypted state settle.
  await page.waitForTimeout(1_200);
  await expect(explorer).toHaveCount(0);
  await expect(leftPanelToggle).toHaveAttribute("aria-expanded", "false");

  await leftPanelToggle.click();
  await expect(explorer).toBeVisible();
  await expect(leftPanelToggle).toHaveAttribute("aria-expanded", "true");
  await page.waitForTimeout(1_200);
  await expect(explorer).toBeVisible();

  const createNote = explorer.getByRole("button", { name: "새 노트", exact: true });
  await expect(createNote).toBeEnabled({ timeout: 30_000 });
  await createNote.click();

  await expect(page.getByRole("tabpanel")).toBeVisible();
  await page.getByRole("button", { name: "소스 모드", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
  await expect(editor).toBeVisible();
  await editor.fill("# 넓은 화면\n\n편집기 폭 회귀 확인");
  await expect(editor.locator(".cm-line")).toHaveCount(3);

  const geometry = await page.locator(".vault-note-content").evaluate((content) => {
    const sourceWrapper = content.querySelector(
      ":scope > .vault-codemirror:not(.vault-codemirror--live-preview)"
    );
    const codeMirror = sourceWrapper?.querySelector(
      ":scope > .vault-codemirror-editor > .cm-editor"
    );
    const gutter = codeMirror?.querySelector(".cm-gutters");
    if (!sourceWrapper || !codeMirror || !gutter) {
      throw new Error("source CodeMirror geometry is unavailable");
    }

    const contentBounds = content.getBoundingClientRect();
    const wrapperBounds = sourceWrapper.getBoundingClientRect();
    const editorBounds = codeMirror.getBoundingClientRect();
    const gutterBounds = gutter.getBoundingClientRect();
    const gutterStyle = getComputedStyle(gutter);

    return {
      contentWidth: contentBounds.width,
      editorWidth: editorBounds.width,
      gutterBackground: gutterStyle.backgroundColor,
      gutterWidth: gutterBounds.width,
      wrapperWidth: wrapperBounds.width
    };
  });

  expect(geometry.contentWidth, "wide note pane must retain desktop editing space")
    .toBeGreaterThan(1_200);
  expect(
    geometry.wrapperWidth / geometry.contentWidth,
    "source wrapper must use the available note-pane width instead of an 860px reading column"
  ).toBeGreaterThan(0.97);
  expect(
    geometry.editorWidth / geometry.wrapperWidth,
    "CodeMirror must fill its full-width source wrapper"
  ).toBeGreaterThan(0.99);
  expect(geometry.gutterWidth, "line-number gutter must remain measurable").toBeGreaterThan(20);

  const gutterChannels = geometry.gutterBackground.match(/[\d.]+/gu)?.slice(0, 3).map(Number) ?? [];
  expect(gutterChannels, `gutter color must resolve to RGB: ${geometry.gutterBackground}`)
    .toHaveLength(3);
  expect(
    gutterChannels.reduce((sum, channel) => sum + channel, 0) / gutterChannels.length,
    `dark-mode gutter must not regress to a white surface: ${geometry.gutterBackground}`
  ).toBeLessThan(128);

  const nestedHtmlSource = [
    "<div>",
    "  <div><h3>안쪽 제목</h3></div>",
    "  <p>바깥 문단</p>",
    "</div>"
  ].join("\n");
  await editor.fill(nestedHtmlSource);
  const saveButton = page.getByRole("button", { name: "저장", exact: true });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect.poll(async () => {
    const states = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
    return states[0]?.revision ?? 0;
  }, { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(saveButton).toBeDisabled({ timeout: 30_000 });

  // Turn the one encrypted Markdown fixture into the historical storage
  // identity without touching title/body ciphertext. This keeps production
  // crypto and creation code in the browser while making the rest of this
  // flow exercise the real legacy-html-v1 UI and move mutation.
  const legacyBeforeMove = await markOnlyOwnedVaultNoteAsLegacy(request, fixture.viewerAuth.uid);
  expect(legacyBeforeMove).toMatchObject({
    contentFormat: "legacy-html-v1",
    entryKind: "legacy-html",
    folderId: null
  });
  await expect(page.getByText("기존 HTML 노트 — 원본을 보존하고 있습니다.", { exact: true }))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("노트 이름")).toBeDisabled();
  await expect(page.locator(".vault-legacy-note")).toContainText("안쪽 제목");
  await expect(page.locator(".vault-legacy-note")).toContainText("바깥 문단");

  page.once("dialog", (dialog) => dialog.accept("이동 대상"));
  await explorer.getByRole("button", { name: "새 폴더", exact: true }).click();
  const destinationFolder = explorer.getByRole("treeitem", { name: "이동 대상", exact: true });
  await expect(destinationFolder).toBeVisible();

  const sourceTreeItem = explorer.getByRole("treeitem", { name: "새 노트", exact: true });
  await sourceTreeItem.click({ button: "right" });
  await page.getByRole("menuitem", { name: "이동…", exact: true }).click();
  const moveDialog = page.getByRole("dialog", { name: "새 노트 이동" });
  await expect(moveDialog).toBeVisible();
  await moveDialog.getByRole("button", { name: "이동 대상", exact: true }).click();
  await expect(moveDialog).toHaveCount(0);
  await expect(page.getByText(/경로 변경을 저장하지 못해/u)).toHaveCount(0);

  if ((await destinationFolder.getAttribute("aria-expanded")) !== "true") {
    await destinationFolder.click();
  }
  await expect(explorer.getByRole("treeitem", { name: "새 노트", exact: true })).toBeVisible();

  await expect.poll(async () => {
    const states = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
    return states.find((state) => state.id === legacyBeforeMove.id)?.folderId ?? null;
  }, { timeout: 30_000 }).not.toBeNull();
  const movedStates = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  const legacyAfterMove = movedStates.find((state) => state.id === legacyBeforeMove.id);
  expect(legacyAfterMove).toBeDefined();
  expect(legacyAfterMove).toMatchObject({
    bodyCipherDigest: legacyBeforeMove.bodyCipherDigest,
    contentFormat: "legacy-html-v1",
    entryKind: "legacy-html",
    titleCipherDigest: legacyBeforeMove.titleCipherDigest
  });
  expect(legacyAfterMove.folderId).not.toBeNull();
  expect(legacyAfterMove.revision).toBe(legacyBeforeMove.revision + 1);

  await page.getByRole("button", { name: "Markdown 복사본 만들기", exact: true }).click();
  const coreDialog = page.getByRole("dialog", { name: "Vault Core 도구" });
  const formatDialog = coreDialog.filter({
    has: page.getByLabel("Format converter")
  });
  await expect(formatDialog).toBeVisible();
  await expect(formatDialog.getByLabel("Markdown 복사본 이름")).toHaveValue("새 노트 Markdown");
  await expect(formatDialog).toContainText("안쪽 제목");
  await expect(formatDialog).toContainText("바깥 문단");
  await formatDialog.getByRole("button", { name: "Markdown 복사본 만들기", exact: true }).click();

  await expect.poll(
    () => ownedVaultNotesState(request, fixture.viewerAuth.uid),
    { timeout: 30_000 }
  ).toHaveLength(2);
  const statesAfterCopy = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  const legacyAfterCopy = statesAfterCopy.find((state) => state.id === legacyBeforeMove.id);
  const markdownCopy = statesAfterCopy.find((state) => state.id !== legacyBeforeMove.id);
  expect(legacyAfterCopy).toEqual(legacyAfterMove);
  expect(markdownCopy).toMatchObject({
    contentFormat: "markdown-v1",
    entryKind: "markdown",
    folderId: legacyAfterMove.folderId
  });

  // The converter child can unmount while the encrypted Vault snapshot
  // reconciles. Close the stable shell when it remains mounted, and tolerate
  // a failed click only when that shell has already closed on its own.
  if (await coreDialog.count()) {
    const closeCoreDialog = coreDialog.getByRole("button", {
      name: "Core 도구 닫기",
      exact: true
    });
    try {
      await closeCoreDialog.click({ timeout: 2_000 });
    } catch (error) {
      if (await coreDialog.count()) throw error;
    }
  }
  await expect(coreDialog).toHaveCount(0);
  await explorer.getByRole("treeitem", { name: "새 노트 Markdown", exact: true }).click();
  await expect(page.getByLabel("노트 이름")).toHaveValue("새 노트 Markdown");
  await page.getByRole("button", { name: "소스 모드", exact: true }).click();
  await expect(editor).toContainText("### 안쪽 제목");
  await expect(editor).toContainText("바깥 문단");
  await expect(editor).not.toContainText("</div>");

  // The first path mutation bootstraps the fixed manifest. A subsequent
  // mutation must bind to that 33-document manifest instead of rescanning the
  // full Vault into another pr2 fingerprint job.
  const markdownTreeItem = explorer.getByRole("treeitem", {
    name: "새 노트 Markdown",
    exact: true
  });
  await markdownTreeItem.click({ button: "right" });
  await page.getByRole("menuitem", { name: "이동…", exact: true }).click();
  const moveCopyDialog = page.getByRole("dialog", { name: "새 노트 Markdown 이동" });
  await expect(moveCopyDialog).toBeVisible();
  await moveCopyDialog.getByRole("button", { name: "Vault 루트", exact: true }).click();
  await expect(moveCopyDialog).toHaveCount(0);
  await expect(page.getByText(/경로 변경을 저장하지 못해/u)).toHaveCount(0);
  await expect.poll(async () => {
    const states = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
    return states.find((state) => state.id === markdownCopy.id)?.folderId ?? null;
  }, { timeout: 30_000 }).toBeNull();

  const rewriteState = await vaultPathRewriteState(request, fixture.viewerAuth.uid);
  expect(rewriteState.inventoryDocumentCount).toBe(33);
  expect(rewriteState.jobs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      activationMode: "atomic-manifest-v1",
      id: expect.stringMatching(/^pr3_/u)
    })
  ]));

  // Returning to the original must still open the immutable legacy renderer;
  // no conversion or move step may silently replace its storage format.
  await explorer.getByRole("treeitem", { name: "새 노트", exact: true }).click();
  await expect(page.getByLabel("노트 이름")).toHaveValue("새 노트");
  await expect(page.getByLabel("노트 이름")).toBeDisabled();
  await expect(page.getByText("기존 HTML 노트 — 원본을 보존하고 있습니다.", { exact: true }))
    .toBeVisible();
  const finalStates = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  expect(finalStates.find((state) => state.id === legacyBeforeMove.id)).toEqual(legacyAfterMove);

  await expectCleanRuntime(diagnostics, fixture);
});

test("block HTML normalization creates a Markdown copy without changing its markdown-v1 source", async ({
  page,
  request
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "vault-chromium-desktop-1440",
    "This focused copy-only regression runs once on desktop Chromium."
  );
  test.setTimeout(120_000);

  const diagnostics = observePage(page);
  const fixture = await seedScenario(request, "authenticated-verified");
  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app?panel=files");

  const explorer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  await expect(explorer).toBeVisible();
  await explorer.getByRole("button", { name: "새 노트", exact: true }).click();
  await page.getByRole("button", { name: "소스 모드", exact: true }).click();

  const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
  const sourceHtml = [
    "<h2>프로젝트 기록</h2>",
    "<p><strong>중요</strong> 설명</p>",
    "<ul>",
    "<li>첫째</li>",
    "<li>둘째</li>",
    "</ul>"
  ].join("\n");
  await editor.fill(sourceHtml);

  const saveButton = page.getByRole("button", { name: "저장", exact: true });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect.poll(async () => {
    const states = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
    return states[0]?.revision ?? 0;
  }, { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(saveButton).toBeDisabled({ timeout: 30_000 });

  const [sourceBeforeCopy] = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  expect(sourceBeforeCopy).toMatchObject({
    contentFormat: "markdown-v1",
    entryKind: "markdown",
    folderId: null
  });

  const normalizeButton = page.getByRole("button", { name: "HTML → Markdown 복사", exact: true });
  await expect(normalizeButton).toBeEnabled();
  let confirmationMessage = "";
  page.once("dialog", async (dialog) => {
    confirmationMessage = dialog.message();
    await dialog.accept();
  });
  await normalizeButton.click();
  expect(confirmationMessage).toContain("원본과 첨부·공유 설정은 변경하지 않습니다.");

  await expect.poll(
    () => ownedVaultNotesState(request, fixture.viewerAuth.uid),
    { timeout: 30_000 }
  ).toHaveLength(2);
  const statesAfterCopy = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  const sourceAfterCopy = statesAfterCopy.find((state) => state.id === sourceBeforeCopy.id);
  const markdownCopy = statesAfterCopy.find((state) => state.id !== sourceBeforeCopy.id);

  expect(sourceAfterCopy).toEqual(sourceBeforeCopy);
  expect(markdownCopy).toMatchObject({
    contentFormat: "markdown-v1",
    entryKind: "markdown",
    folderId: null
  });

  await expect(page.getByLabel("노트 이름")).toHaveValue("새 노트 Markdown");
  await page.getByRole("button", { name: "소스 모드", exact: true }).click();
  await expect(editor).toContainText("## 프로젝트 기록");
  await expect(editor).toContainText("**중요** 설명");
  await expect(editor).toContainText("- 첫째");
  await expect(editor).toContainText("- 둘째");
  await expect(editor).not.toContainText("<h2>");
  await expect(editor).not.toContainText("</ul>");

  await explorer.getByRole("treeitem", { name: "새 노트", exact: true }).click();
  await expect(page.getByLabel("노트 이름")).toHaveValue("새 노트");
  await expect(editor).toContainText("<h2>프로젝트 기록</h2>");
  await expect(editor).toContainText("<p><strong>중요</strong> 설명</p>");
  const finalStates = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  expect(finalStates.find((state) => state.id === sourceBeforeCopy.id)).toEqual(sourceBeforeCopy);

  await expectCleanRuntime(diagnostics, fixture);
});

test("desktop workspace controls and dark wikilinks remain deliberate", async ({
  page,
  request
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "vault-chromium-desktop-1440",
    "This focused interaction regression runs once on desktop Chromium."
  );
  test.setTimeout(120_000);

  await page.emulateMedia({ colorScheme: "dark" });
  const diagnostics = observePage(page);
  const fixture = await seedScenario(request, "authenticated-verified");
  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app?panel=files");

  const explorer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  const ribbonToggle = page.locator(
    '.vault-ribbon button[aria-controls="vault-left-panel"]'
  );
  await expect(explorer).toBeVisible();

  // The desktop panel owns a dedicated chevron collapse control. Closing it
  // must leave the ribbon available as the deliberate way to reopen it.
  await explorer.getByRole("button", { name: "왼쪽 패널 접기", exact: true }).click();
  await expect(explorer).toHaveCount(0);
  await expect(ribbonToggle).toHaveAttribute("aria-expanded", "false");
  await ribbonToggle.click();
  await expect(explorer).toBeVisible();
  await expect(ribbonToggle).toHaveAttribute("aria-expanded", "true");

  const createNote = explorer.getByRole("button", { name: "새 노트", exact: true });
  await expect(createNote).toBeEnabled({ timeout: 30_000 });
  await createNote.click();
  const noteTitle = page.getByRole("textbox", { name: "노트 이름", exact: true });
  await expect(noteTitle).toHaveValue("새 노트");

  // Keep a separate source note active so the wikilink popup has a real
  // cross-note target and no synthetic completion state is needed.
  await expect(createNote).toBeEnabled({ timeout: 30_000 });
  await createNote.click();
  await expect(noteTitle).toHaveValue("새 노트 2");
  await page.getByRole("button", { name: "소스 모드", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
  await editor.fill("[[새");
  await editor.press("Control+Space");

  const completion = page.locator(
    ".vault-codemirror-editor > .cm-editor .cm-tooltip.cm-tooltip-autocomplete"
  );
  await expect(completion).toBeVisible();
  const selectedCompletion = completion.locator('li[aria-selected="true"]').first();
  await expect(selectedCompletion).toBeVisible();
  await expect(selectedCompletion).toContainText("새 노트");

  const completionContrast = await selectedCompletion.evaluate((selected) => {
    const list = selected.closest("ul");
    if (!list) throw new Error("completion list is unavailable");

    const parseColor = (raw) => {
      const channels = raw.match(/[\d.]+/gu)?.map(Number) ?? [];
      if (channels.length < 3) throw new Error(`unable to parse CSS color: ${raw}`);
      return {
        red: channels[0],
        green: channels[1],
        blue: channels[2],
        alpha: channels[3] ?? 1
      };
    };
    const composite = (front, back) => ({
      red: (front.red * front.alpha) + (back.red * (1 - front.alpha)),
      green: (front.green * front.alpha) + (back.green * (1 - front.alpha)),
      blue: (front.blue * front.alpha) + (back.blue * (1 - front.alpha)),
      alpha: 1
    });
    const luminance = (color) => {
      const linear = [color.red, color.green, color.blue].map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return (linear[0] * 0.2126) + (linear[1] * 0.7152) + (linear[2] * 0.0722);
    };

    const listStyle = getComputedStyle(list);
    const selectedStyle = getComputedStyle(selected);
    const listBackground = parseColor(listStyle.backgroundColor);
    const rowBackground = composite(parseColor(selectedStyle.backgroundColor), listBackground);
    const textColor = composite(parseColor(selectedStyle.color), rowBackground);
    const bright = Math.max(luminance(rowBackground), luminance(textColor));
    const dark = Math.min(luminance(rowBackground), luminance(textColor));
    return {
      background: selectedStyle.backgroundColor,
      color: selectedStyle.color,
      listBackground: listStyle.backgroundColor,
      ratio: (bright + 0.05) / (dark + 0.05)
    };
  });
  expect(
    completionContrast.ratio,
    `dark completion text must remain readable (${JSON.stringify(completionContrast)})`
  ).toBeGreaterThanOrEqual(4.5);
  await editor.press("Escape");

  const saveButton = page.getByRole("button", { name: "저장", exact: true });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect(saveButton).toBeDisabled({ timeout: 30_000 });

  for (const retiredAction of ["새 Canvas", "새 Base", "새 Kanban"]) {
    await expect(page.getByRole("button", { name: retiredAction, exact: true })).toHaveCount(0);
  }

  // Creation leaves several normal tabs open. Close every tab and prove the
  // final explicit close remains an empty workspace after async state settles.
  const workspaceTabs = page.locator('.vault-tab-strip [role="tab"]');
  const closeButtons = page.locator(
    '.vault-tab-strip > [role="presentation"] button[aria-label$=" 닫기"]'
  );
  expect(await workspaceTabs.count()).toBeGreaterThan(0);
  for (let remaining = await workspaceTabs.count(); remaining > 0; remaining -= 1) {
    await closeButtons.last().click();
    await expect(workspaceTabs).toHaveCount(remaining - 1);
  }
  await expect(page.getByRole("heading", { name: "가볍게 적고, 쉽게 찾으세요" })).toBeVisible();
  await page.waitForTimeout(1_500);
  await expect(workspaceTabs).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "가볍게 적고, 쉽게 찾으세요" })).toBeVisible();

  await expectCleanRuntime(diagnostics, fixture);
});
