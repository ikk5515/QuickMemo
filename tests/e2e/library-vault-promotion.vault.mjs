import { expect, test } from "@playwright/test";
import { readVaultEditorSource } from "./vault-editor-helpers.mjs";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors,
  expectCleanRuntime,
  loginDirectly,
  navigateWithinApp,
  observePage,
  seedScenario
} from "./helpers.mjs";

const firestoreProjectId = "quickmemo-share-api-test";
const firestoreDocumentsRoot =
  `http://127.0.0.1:8080/v1/projects/${firestoreProjectId}/databases/(default)/documents`;

function ownerAuthorization(fixture) {
  return { authorization: `Bearer ${fixture.viewerAuth.idToken}` };
}

function documentId(document) {
  return document.name.split("/").at(-1) ?? "";
}

function firestoreString(document, fieldName) {
  const value = document.fields?.[fieldName]?.stringValue;
  return typeof value === "string" ? value : "";
}

function sourceFieldsWithoutOpenTelemetry(document) {
  const fields = JSON.parse(JSON.stringify(document.fields ?? {}));
  // Opening a reader deliberately records only this access timestamp. It is
  // not source-content mutation and may acknowledge concurrently with the
  // promotion transaction.
  delete fields.lastOpenedAt;
  return fields;
}

async function ownedCollectionDocuments(request, fixture, collectionId) {
  const response = await request.post(`${firestoreDocumentsRoot}:runQuery`, {
    data: {
      structuredQuery: {
        from: [{ collectionId }],
        limit: 2,
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
      ...ownerAuthorization(fixture),
      "content-type": "application/json"
    }
  });
  expect(response.ok(), `owner query for ${collectionId} must succeed`).toBe(true);
  const rows = await response.json();
  return rows.flatMap((row) => row.document ? [row.document] : []);
}

async function waitForSingleOwnedDocument(request, fixture, collectionId) {
  let documents = [];
  await expect.poll(async () => {
    documents = await ownedCollectionDocuments(request, fixture, collectionId);
    return documents.length;
  }, {
    message: `exactly one owned ${collectionId} document must be persisted`,
    timeout: 30_000
  }).toBe(1);
  return documents[0];
}

async function importJobSummaries(request, fixture) {
  const response = await request.get(
    `${firestoreDocumentsRoot}/vaultMaintenanceJobs/${encodeURIComponent(fixture.viewerAuth.uid)}/imports?pageSize=10`,
    { headers: ownerAuthorization(fixture) }
  );
  if (!response.ok()) return [{ readStatus: response.status() }];
  const body = await response.json();
  return (body.documents ?? []).map((document) => ({
    chunkCount: document.fields?.chunkCount?.integerValue ?? null,
    remainingChunkCount: document.fields?.remainingChunkCount?.integerValue ?? null,
    revision: document.fields?.revision?.integerValue ?? null,
    status: document.fields?.status?.stringValue ?? null
  }));
}

async function rawFirestoreDocument(request, fixture, collectionId, id) {
  let raw = "";
  let document = null;
  await expect.poll(async () => {
    const response = await request.get(
      `${firestoreDocumentsRoot}/${collectionId}/${encodeURIComponent(id)}`,
      { headers: ownerAuthorization(fixture) }
    );
    if (!response.ok()) return false;
    raw = await response.text();
    document = JSON.parse(raw);
    return Boolean(document?.fields);
  }, {
    message: `${collectionId}/${id} must become readable to its owner`,
    timeout: 30_000
  }).toBe(true);
  return { document, raw };
}

function expectCiphertextAtRest(raw, requiredMarkers, forbiddenPlaintext) {
  for (const marker of requiredMarkers) expect(raw).toContain(marker);
  for (const plaintext of forbiddenPlaintext) {
    expect(raw, `Firestore must not contain plaintext: ${plaintext}`).not.toContain(plaintext);
  }
}

async function ensureVaultExplorer(page) {
  const explorer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  await expect.poll(async () => {
    if (await explorer.isVisible()) return true;
    const opener = page.getByRole("button", { name: "왼쪽 패널 열기" });
    if (await opener.isVisible()) await opener.click({ timeout: 500 }).catch(() => undefined);
    return explorer.isVisible();
  }, { message: "Vault explorer must be open" }).toBe(true);
  return explorer;
}

async function closeMobileVaultExplorer(page) {
  const explorer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  if (await explorer.getAttribute("role") === "dialog" && await explorer.isVisible()) {
    await explorer.getByRole("button", { name: "왼쪽 패널 닫기" }).click();
    await expect(explorer).toHaveCount(0);
  }
}

test("an authenticated Library item is source-preserved when promoted into encrypted Vault 00_Inbox", async ({
  browserName,
  page,
  request
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "vault-chromium-desktop-1280",
    "The encrypted Library promotion integration runs once; shared Vault suites cover responsive and WebKit layouts."
  );
  test.setTimeout(150_000);
  const diagnostics = observePage(page);
  const vaultFolderResponses = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/vault-folders")) {
      vaultFolderResponses.push(response);
    }
  });
  const fixture = await seedScenario(request, "authenticated-verified");
  const title = "E2E 자료 승격 LIBRARY_TITLE_7317";
  const sourceUrl = "https://example.com/quickmemo-promotion?marker=LIBRARY_URL_7317";
  const collection = "LIBRARY_COLLECTION_7317";
  const tag = "library-promotion-7317";
  const description = "LIBRARY_DESCRIPTION_7317";
  const selection = "LIBRARY_SELECTION_7317";
  const readerBody = "LIBRARY_READER_BODY_7317";
  const forbiddenPlaintext = [
    title,
    sourceUrl,
    collection,
    tag,
    description,
    selection,
    readerBody,
    "00_Inbox"
  ];

  await loginDirectly(page, fixture.viewerAuth, diagnostics);

  await test.step("open Vault once and wait for the encrypted name boundary", async () => {
    await navigateWithinApp(page, "/app");
    const explorer = await ensureVaultExplorer(page);
    await expect(explorer.locator('.vault-panel-toolbar button[aria-label="새 노트"]'))
      .toBeEnabled({ timeout: 40_000 });
  });

  await test.step("create a real encrypted Library source through the authenticated UI", async () => {
    await navigateWithinApp(page, "/library");
    await expect(page.locator(".library-workspace")).toBeVisible();
    await page.locator(".library-header-actions").getByRole("button", { name: "자료 저장" }).click();
    const dialog = page.getByRole("dialog", { name: "링크나 클립 저장" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("제목").fill(title);
    await dialog.getByLabel(/^URL/u).fill(sourceUrl);
    await dialog.getByLabel("컬렉션").fill(collection);
    await dialog.getByLabel("태그").fill(tag);
    await dialog.getByLabel(/메모$/u).fill(description);
    await dialog.getByLabel(/선택 텍스트/u).fill(selection);
    await dialog.getByLabel(/리더 본문/u).fill(readerBody);
    await dialog.getByRole("button", { name: "자료 저장", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: `${title} 열기` })).toBeVisible();
  });

  const sourceBeforeOpen = await waitForSingleOwnedDocument(request, fixture, "libraryItems");
  const sourceId = documentId(sourceBeforeOpen);
  const sourceBeforeRaw = JSON.stringify(sourceBeforeOpen);
  expect(sourceId).not.toBe("");
  expectCiphertextAtRest(
    sourceBeforeRaw,
    ["encryptedContent", "wrappedKeys", "generationId"],
    forbiddenPlaintext
  );

  await test.step("promote the decrypted source and retain the original Library document", async () => {
    await page.getByRole("button", { name: `${title} 열기` }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    const sourceAfterOpen = await rawFirestoreDocument(request, fixture, "libraryItems", sourceId);
    const sourceContentBeforePromotion = sourceFieldsWithoutOpenTelemetry(sourceAfterOpen.document);

    await page.getByRole("button", { name: "Vault Markdown으로 저장" }).click();
    const promotionStatus = page.locator(".library-vault-promotion").getByRole("status");
    await expect(promotionStatus).not.toHaveText("", { timeout: 45_000 });
    const promotionMessage = (await promotionStatus.textContent())?.trim() ?? "";
    if (!promotionMessage.includes("원본 자료는 그대로")) {
      const failureStage = await page.locator(".library-vault-promotion")
        .getAttribute("data-e2e-promotion-stage");
      const [folderResponses, jobs, notes] = await Promise.all([
        Promise.all(vaultFolderResponses.map(async (response) => ({
          body: (await response.text()).slice(0, 500),
          status: response.status()
        }))),
        importJobSummaries(request, fixture),
        ownedCollectionDocuments(request, fixture, "notes")
      ]);
      const noteSummaries = notes.map((document) => ({
        deleted: document.fields?.isDeleted?.booleanValue ?? null,
        importBound: Boolean(document.fields?.vaultImportJobId?.stringValue),
        revision: document.fields?.revision?.integerValue ?? null
      }));
      throw new Error([
        `Library promotion failed: ${promotionMessage || "unknown UI error"}`,
        `Failure stage: ${failureStage ?? "unclassified"}`,
        `Vault folder API: ${JSON.stringify(folderResponses)}`,
        `Import jobs: ${JSON.stringify(jobs)}`,
        `Owned notes: ${JSON.stringify(noteSummaries)}`,
        `Browser console: ${JSON.stringify(diagnostics.consoleErrors)}`
      ].join("\n"));
    }
    await expect(page.getByRole("button", { name: "Vault에서 열기" })).toBeVisible();

    const sourceAfterPromotion = await rawFirestoreDocument(request, fixture, "libraryItems", sourceId);
    expect(sourceFieldsWithoutOpenTelemetry(sourceAfterPromotion.document))
      .toEqual(sourceContentBeforePromotion);
    expectCiphertextAtRest(
      sourceAfterPromotion.raw,
      ["encryptedContent", "wrappedKeys", "generationId"],
      forbiddenPlaintext
    );
  });

  let promotedEntryId = "";
  await test.step("open the promoted note in Vault and verify the 00_Inbox destination", async () => {
    await page.getByRole("button", { name: "Vault에서 열기" }).click();
    await expect(page).toHaveURL((url) => {
      promotedEntryId = url.searchParams.get("entry") ?? "";
      return url.pathname === "/app" && /^vit1_[A-Za-z0-9_-]{43}$/u.test(promotedEntryId);
    });
    await closeMobileVaultExplorer(page);
    await expect(page.getByRole("textbox", { name: "노트 이름", exact: true })).toHaveValue(title, {
      timeout: 35_000
    });
    await expect(page.getByRole("button", { name: "소스 모드", exact: true })).toHaveCount(0);
    const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
    await expect(editor).toBeVisible();
    await expect.poll(() => readVaultEditorSource(editor))
      .toContain("type: library-clip");
    const markdown = await readVaultEditorSource(editor);
    const semanticallyUnescapedMarkdown = markdown.replaceAll("\\_", "_");
    for (const expected of [title, sourceUrl, description, selection, readerBody]) {
      expect(semanticallyUnescapedMarkdown).toContain(expected);
    }

    await page.getByRole("button", { name: "파일", exact: true }).click();
    const explorer = await ensureVaultExplorer(page);
    await expect(explorer.getByRole("treeitem", { name: "00_Inbox", exact: true })).toBeVisible();
  });

  await test.step("prove the promoted entry and its folder contain ciphertext only at rest", async () => {
    const promoted = await rawFirestoreDocument(request, fixture, "notes", promotedEntryId);
    expectCiphertextAtRest(
      promoted.raw,
      ["encryptedTitle", "encryptedBody", "wrappedKeys", "markdown-v1"],
      forbiddenPlaintext
    );
    const inboxFolderId = firestoreString(promoted.document, "folderId");
    expect(inboxFolderId).not.toBe("");
    const inbox = await rawFirestoreDocument(request, fixture, "noteFolders", inboxFolderId);
    expectCiphertextAtRest(
      inbox.raw,
      ["encryptedName", "wrappedKey", "vaultNameClaimId"],
      ["00_Inbox"]
    );
    expect(firestoreString(inbox.document, "ownerUid")).toBe(fixture.viewerAuth.uid);
  });

  if (browserName === "webkit") {
    allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  }
  await expectCleanRuntime(diagnostics, fixture, forbiddenPlaintext);
});
