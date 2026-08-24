/* global Buffer */

import { expect, test } from "@playwright/test";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors,
  expectCleanRuntime,
  loginDirectly,
  navigateWithinApp,
  observePage,
  ownedVaultNotesState,
  seedScenario,
  unlockEncryptedVault
} from "./helpers.mjs";

const firestoreDocumentsRoot =
  "http://127.0.0.1:8080/v1/projects/quickmemo-share-api-test/databases/(default)/documents";
const focusedImageUploadProjects = new Set([
  "vault-chromium-desktop-1440",
  "vault-webkit-desktop-1280"
]);
const imageLimitLabel = "PNG · JPG · WebP · 최대 8개 · 파일당 32MB · 합계 64MB";
const sourceFileName = "E2E_SOURCE_IMAGE_FILE_91af.png";
const livePreviewFileName = "E2E_LIVE_IMAGE_FILE_62bc.png";
const noteTitle = "E2E 이미지 파일 추가";
const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const onePixelPng = Buffer.from(onePixelPngBase64, "base64");

function activeEntryId(page) {
  return page
    .locator('.vault-tab-bar [role="tab"][aria-selected="true"]')
    .getAttribute("id")
    .then((tabId) => {
      expect(tabId).toMatch(/^entry:/u);
      const entryId = tabId?.split(":")[1] ?? "";
      expect(entryId).toMatch(/^vn1_[A-Za-z0-9_-]{43}$/u);
      return entryId;
    });
}

async function editorSource(editor) {
  return (await editor.locator(".cm-line").allTextContents()).join("\n");
}

function imageEmbeds(source) {
  return source.match(/!\[\[[^\]\r\n]+\.png\]\]/gu) ?? [];
}

async function expectImageFilePicker(wrapper) {
  await expect(wrapper).toBeVisible();
  const tools = wrapper.locator(":scope > .vault-codemirror-image-tools");
  const button = tools.getByRole("button", { name: "이미지 파일 추가", exact: true });
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await expect(tools.locator("span")).toHaveText(imageLimitLabel);
  const input = tools.locator('input[type="file"]');
  await expect(input).toHaveCount(1);
  await expect(input).toBeHidden();
  await expect(input).toBeEnabled();
  await expect(input).toHaveAttribute(
    "accept",
    ".jpeg,.jpg,.png,.webp,image/jpeg,image/png,image/webp"
  );
  await expect(input).toHaveAttribute("multiple", "");
  return { button, input };
}

async function selectOnePixelPng(page, button, name) {
  const fileChooserPromise = page.waitForEvent("filechooser");
  await button.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    buffer: onePixelPng,
    mimeType: "image/png",
    name
  });
}

async function saveActiveEntry(page) {
  const save = page.getByRole("button", { name: "저장", exact: true });
  const saveState = page.locator(".vault-save-state");
  await expect(save).toBeEnabled();
  await save.click();
  // Observe the in-flight transition before accepting the terminal label so a
  // stale pre-click "저장됨" cannot race the encrypted title/path mutation.
  await expect(save).toBeDisabled();
  await expect(saveState).toHaveText("저장됨", { timeout: 30_000 });
}

async function rawOwnedNoteDocuments(request, fixture) {
  const response = await request.post(`${firestoreDocumentsRoot}:runQuery`, {
    data: {
      structuredQuery: {
        from: [{ collectionId: "notes" }],
        limit: 10,
        where: {
          fieldFilter: {
            field: { fieldPath: "ownerUid" },
            op: "EQUAL",
            value: { stringValue: fixture.viewerAuth.uid }
          }
        }
      }
    },
    headers: {
      authorization: `Bearer ${fixture.viewerAuth.idToken}`,
      "content-type": "application/json"
    }
  });
  expect(response.ok(), "the owner-only raw Vault query must succeed").toBe(true);
  const rows = await response.json();
  return rows.flatMap((row) => row.document ? [row.document] : []);
}

async function rawOwnedFolderDocuments(request, fixture) {
  const response = await request.post(`${firestoreDocumentsRoot}:runQuery`, {
    data: {
      structuredQuery: {
        from: [{ collectionId: "noteFolders" }],
        limit: 10,
        where: {
          fieldFilter: {
            field: { fieldPath: "ownerUid" },
            op: "EQUAL",
            value: { stringValue: fixture.viewerAuth.uid }
          }
        }
      }
    },
    headers: {
      authorization: `Bearer ${fixture.viewerAuth.idToken}`,
      "content-type": "application/json"
    }
  });
  expect(response.ok(), "the owner-only raw Vault folder query must succeed").toBe(true);
  const rows = await response.json();
  return rows.flatMap((row) => row.document ? [row.document] : []);
}

test("Source and Live Preview file pickers persist encrypted Markdown image embeds", async ({
  browserName,
  page,
  request
}, testInfo) => {
  test.skip(
    !focusedImageUploadProjects.has(testInfo.project.name),
    "The encrypted file-picker acceptance runs only on Chromium 1440 and desktop WebKit 1280."
  );
  test.setTimeout(150_000);

  const diagnostics = observePage(page);
  const fixture = await seedScenario(request, "authenticated-verified");

  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  const createNote = page.locator('.vault-panel-toolbar button[aria-label="새 노트"]');
  await expect(createNote).toBeEnabled({ timeout: 40_000 });
  await createNote.click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await page.getByRole("textbox", { name: "노트 이름", exact: true }).fill(noteTitle);
  await saveActiveEntry(page);
  const entryId = await activeEntryId(page);

  await test.step("select a PNG from Source mode", async () => {
    await page.getByRole("button", { name: "소스 모드", exact: true }).click();
    const sourceWrapper = page.locator(
      ".vault-note-content > .vault-codemirror:not(.vault-codemirror--live-preview)"
    );
    const sourcePicker = await expectImageFilePicker(sourceWrapper);
    await selectOnePixelPng(page, sourcePicker.button, sourceFileName);

    const editor = sourceWrapper.getByRole("textbox", { name: "Markdown 편집기" });
    await expect.poll(async () => imageEmbeds(await editorSource(editor)).length, {
      message: "Source file selection must insert one internal image embed",
      timeout: 45_000
    }).toBe(1);
  });

  await test.step("select a PNG from Live Preview", async () => {
    await page.getByRole("button", { name: "라이브 프리뷰", exact: true }).click();
    const liveWrapper = page.locator(
      ".vault-note-content > .vault-codemirror--live-preview"
    );
    const livePicker = await expectImageFilePicker(liveWrapper);
    await selectOnePixelPng(page, livePicker.button, livePreviewFileName);

    await expect.poll(async () => {
      const states = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
      return {
        assets: states.filter((state) => (
          state.entryKind === "asset" && state.contentFormat === "asset-v1"
        )).length,
        markdown: states.filter((state) => state.id === entryId).length,
        total: states.length
      };
    }, {
      message: "both selected images must become owner-only encrypted Vault assets",
      timeout: 45_000
    }).toEqual({ assets: 2, markdown: 1, total: 3 });
  });

  await page.getByRole("button", { name: "소스 모드", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
  let persistedSource = "";
  await expect.poll(async () => {
    persistedSource = await editorSource(editor);
    return imageEmbeds(persistedSource).length;
  }, {
    message: "Source mode must contain the two image embeds created in both editor modes",
    timeout: 45_000
  }).toBe(2);
  const embeds = imageEmbeds(persistedSource);
  expect(new Set(embeds).size, "the two encrypted image assets need distinct Vault paths").toBe(2);
  expect(new Set(embeds)).toEqual(new Set([
    `![[붙여넣은 이미지/${noteTitle} -1.png]]`,
    `![[붙여넣은 이미지/${noteTitle} -2.png]]`
  ]));
  await expect(page.getByRole("treeitem", { name: "붙여넣은 이미지", exact: true }))
    .toHaveCount(1);

  const statesAfterBothUploads = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  const imageAssets = statesAfterBothUploads.filter((state) => state.entryKind === "asset");
  expect(imageAssets).toHaveLength(2);
  expect(imageAssets.every((asset) => typeof asset.folderId === "string" && asset.folderId.length > 0))
    .toBe(true);
  expect(new Set(imageAssets.map((asset) => asset.folderId)).size).toBe(1);
  expect(statesAfterBothUploads.find((state) => state.id === entryId)?.folderId ?? null).toBeNull();

  await test.step("save and prove plaintext is absent from Firestore", async () => {
    const save = page.getByRole("button", { name: "저장", exact: true });
    if (await save.isEnabled()) await save.click();
    await expect(page.locator(".vault-save-state")).toHaveText("저장됨", { timeout: 35_000 });
    await expect.poll(async () => {
      const states = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
      return states.find((state) => state.id === entryId)?.revision ?? 0;
    }, {
      message: "the Markdown note containing both embeds must reach a persisted revision",
      timeout: 35_000
    }).toBeGreaterThanOrEqual(2);

    let documents = [];
    await expect.poll(async () => {
      documents = await rawOwnedNoteDocuments(request, fixture);
      return documents.length;
    }, {
      message: "the owner must have one Markdown document and two asset documents",
      timeout: 35_000
    }).toBe(3);

    let folderDocuments = [];
    await expect.poll(async () => {
      folderDocuments = await rawOwnedFolderDocuments(request, fixture);
      return folderDocuments.length;
    }, {
      message: "the dedicated encrypted image folder must be persisted once",
      timeout: 35_000
    }).toBe(1);

    const rawFirestore = JSON.stringify([...documents, ...folderDocuments]);
    for (const marker of ["encryptedTitle", "encryptedBody", "wrappedKeys", "markdown-v1", "asset-v1"]) {
      expect(rawFirestore).toContain(marker);
    }
    for (const plaintext of [
      sourceFileName,
      livePreviewFileName,
      onePixelPngBase64,
      noteTitle,
      "붙여넣은 이미지",
      persistedSource,
      ...embeds
    ]) {
      expect(rawFirestore, `Firestore must not contain image plaintext: ${plaintext}`)
        .not.toContain(plaintext);
    }
  });

  await test.step("reload, unlock, and restore both saved embeds", async () => {
    await expect(page.locator(".vault-workspace")).toHaveAttribute(
      "data-workspace-sync",
      "saved",
      { timeout: 35_000 }
    );
    await page.reload();
    await expect(page.locator('input[type="password"][aria-label="비밀번호"]')).toBeVisible();
    await expect(page.locator("body")).not.toContainText(noteTitle);
    await unlockEncryptedVault(page, fixture.viewerAuth.password);
    await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toHaveValue(noteTitle);
    await expect(page.getByRole("treeitem", { name: "붙여넣은 이미지", exact: true }))
      .toHaveCount(1);
    await page.getByRole("button", { name: "소스 모드", exact: true }).click();
    const restoredEditor = page.getByRole("textbox", { name: "Markdown 편집기" });
    await expect.poll(() => editorSource(restoredEditor), {
      message: "both image embeds must survive a locked encrypted Vault reload",
      timeout: 35_000
    }).toBe(persistedSource);
  });

  if (browserName === "webkit") {
    allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  }
  await expectCleanRuntime(diagnostics, fixture, [
    sourceFileName,
    livePreviewFileName,
    onePixelPngBase64,
    noteTitle
  ]);
});
