import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Secure Share attachment reuse integration guards", () => {
  it("wires source fingerprints through the owner upload boundary", () => {
    const notesPage = source("src/pages/NotesPage.tsx");
    const blobClient = source("src/services/blobAttachments.ts");
    const blobBackend = source("api/blob-attachments.js");

    expect(notesPage).toContain("secureShareSourceAttachmentFingerprint(attachment)");
    expect(notesPage).toContain("sourceAttachmentDigest: fingerprint?.digest");
    expect(notesPage).toContain("sourceEncryptionVersion: fingerprint?.encryptionVersion");
    expect(blobClient).toContain("sourceAttachmentDigest: input.sourceAttachmentDigest ?? null");
    expect(blobBackend).toContain("sourceAttachmentFingerprintMatches(");
    expect(blobBackend).toContain("fields.sourceAttachmentDigest = stringValue(");
    expect(blobBackend).toContain("fields.sourceEncryptionVersion = integerValue(");
  });

  it("uploads only the changed partition and commits retained generation membership atomically", () => {
    const notesPage = source("src/pages/NotesPage.tsx");
    const backend = source("api/public-shares-v2.js");

    expect(notesPage).toContain("selectSecureShareAttachmentReuse(");
    expect(notesPage).toContain("of reuseSelection.attachmentsToUpload");
    expect(notesPage).toContain("retainedAttachmentIds = reuseSelection.retainedAttachmentIds");
    expect(notesPage).toContain("retainedAttachmentIds,");
    expect(backend).toContain("retainedAttachmentIds: input.retainedAttachmentIds");
    expect(backend).toContain("sourceAttachmentFingerprintMatches(");
    expect(backend).toContain(".filter((attachment) => !retainedIdSet.has(attachment.__id))");
    expect(backend).toContain("...attachmentSnapshot.retainedAttachments.map((attachment) =>");
    expect(backend).toContain("{ generations: attachment.generations }");
    expect(backend).toContain("attachment.updateTime");
  });

  it("gets the minimal reuse manifest through owner-details without a v2 client Firestore read", () => {
    const matcher = source("src/lib/secureShareAttachmentReuse.ts");
    const publicShares = source("src/services/publicShares.ts");
    const notesPage = source("src/pages/NotesPage.tsx");
    const backend = source("api/public-shares-v2.js");
    const ownerDetails = backend.match(
      /async function handleOwnerDetails[\s\S]*?function validateUpdateBody/u
    )?.[0] ?? "";
    const manifestMapper = backend.match(
      /function ownerAttachmentReuseManifest[\s\S]*?function validateUpdateBody/u
    )?.[0] ?? "";

    expect(matcher).not.toMatch(/contentKey|blobUrl|blobDownloadUrl/u);
    expect(publicShares).not.toContain("getOwnerSecurePublicNoteShareAttachments");
    expect(notesPage).not.toContain("getOwnerSecurePublicNoteShareAttachments");
    expect(notesPage).toContain("currentOwnerDetails?.attachmentReuseManifests ?? []");
    expect(ownerDetails).toContain("const user = await ownerContext(request)");
    expect(ownerDetails).toContain("requireOwner(state, user)");
    expect(ownerDetails).toContain("currentAttachments(user.context, state.share)");
    expect(ownerDetails).toContain(
      "attachmentReuseManifests: attachments.map(ownerAttachmentReuseManifest)"
    );
    expect(manifestMapper).toContain("digest: attachment.sourceAttachmentDigest");
    expect(manifestMapper).not.toMatch(
      /blobPath|blobUrl|storagePath|encryptedFileName|encryptedData|contentKey/u
    );
  });

  it("atomically verifies uploaded attachment snapshots before advancing the root", () => {
    const backend = source("api/public-shares-v2.js");
    const attachmentSnapshot = backend.match(
      /async function contentUpdateAttachmentSnapshot[\s\S]*?async function beginContentUpdateTransaction/u
    )?.[0] ?? "";
    const contentUpdate = backend.match(
      /async function handleOwnerContentUpdate[\s\S]*?async function handleOwnerActivate/u
    )?.[0] ?? "";

    expect(attachmentSnapshot).toContain("uploadedAttachments: uploaded.map((attachment) =>");
    expect(attachmentSnapshot).toContain("updateTime: attachment.__updateTime");
    expect(contentUpdate).toContain(
      "...attachmentSnapshot.uploadedAttachments.map((attachment) =>"
    );
    expect(contentUpdate).toContain("verifyDocumentSnapshotWrite(");
    expect(backend).toContain("verify: firestoreDocumentName(projectId, documentPath)");
    expect(backend).toContain("currentDocument: { updateTime }");
    expect(contentUpdate).toContain(
      "...attachmentSnapshot.retiredAttachments.map((attachment) =>"
    );
    expect(contentUpdate).toContain("deletionStarted: true");
    expect(contentUpdate).toContain('"deletionStartedAt"');
  });

  it("scopes active attachment reads to generations and keeps failed cleanup durably retryable", () => {
    const backend = source("api/public-shares-v2.js");
    const blobBackend = source("api/blob-attachments.js");
    const notesPage = source("src/pages/NotesPage.tsx");
    const attachmentSnapshot = backend.match(
      /async function contentUpdateAttachmentSnapshot[\s\S]*?async function beginContentUpdateTransaction/u
    )?.[0] ?? "";
    const generationSnapshot = backend.match(
      /async function attachmentGenerationSnapshot[\s\S]*?async function currentAttachments/u
    )?.[0] ?? "";
    const currentReader = backend.match(
      /async function currentAttachments[\s\S]*?async function handleRevision/u
    )?.[0] ?? "";

    expect(attachmentSnapshot).toContain("attachmentGenerationSnapshot(");
    expect(attachmentSnapshot).not.toContain("firestoreListCollection(");
    expect(attachmentSnapshot).toContain("transaction");
    expect(generationSnapshot).toContain('generationQuery("generation", "EQUAL")');
    expect(generationSnapshot).toContain(
      'generationQuery("generations", "ARRAY_CONTAINS")'
    );
    expect(generationSnapshot).toContain("limit: maximumCount + 1");
    expect(generationSnapshot).toContain("parentPath,\n      transaction");
    expect(generationSnapshot).toContain("attachment.isReady !== true");
    expect(generationSnapshot).toContain("attachment.privacyVersion !== 1");
    expect(currentReader).toContain("attachmentGenerationSnapshot(");
    expect(currentReader).not.toContain("firestoreListCollection(");
    expect(notesPage).toContain("cleanupSecureShareAttachmentIdsWithRetry(");
    expect(notesPage).toContain("secureShareAttachmentCleanupPendingMessage");
    expect(blobBackend).toContain(
      "publicShareCleanupQueue/${payload.shareId}/publicShareAttachmentCleanupQueue/"
    );
  });
});
