import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicShareAttachmentIsCurrent } from "../../api/blob-attachments.js";

const blobAttachmentApiSource = readFileSync(join(process.cwd(), "api/blob-attachments.js"), "utf8");
const blobAttachmentClientSource = readFileSync(join(process.cwd(), "src/services/blobAttachments.ts"), "utf8");
const firestoreRulesSource = readFileSync(join(process.cwd(), "firestore.rules"), "utf8");

describe("blob attachment backend", () => {
  it("streams both newly uploaded and retained current-generation attachments", () => {
    const document = (fields: Record<string, unknown>) => ({ fields });
    const share = document({
      currentGeneration: { stringValue: "generation-next" }
    });

    expect(publicShareAttachmentIsCurrent(
      share,
      document({ generation: { stringValue: "generation-next" } })
    )).toBe(true);
    expect(publicShareAttachmentIsCurrent(
      share,
      document({
        generation: { stringValue: "generation-old" },
        generations: {
          arrayValue: {
            values: [
              { stringValue: "generation-old" },
              { stringValue: "generation-next" }
            ]
          }
        }
      })
    )).toBe(true);
    expect(publicShareAttachmentIsCurrent(
      share,
      document({ generation: { stringValue: "generation-old" } })
    )).toBe(false);
  });

  it("uses authenticated Vercel Blob client uploads with a 1 GB user quota", () => {
    expect(blobAttachmentApiSource).toContain("handleUpload");
    expect(blobAttachmentApiSource).toContain("BLOB_READ_WRITE_TOKEN");
    expect(blobAttachmentApiSource).toContain("const maxAttachmentFileMegabytes = 150");
    expect(blobAttachmentApiSource).toContain("const maxAttachmentFileBytes = maxAttachmentFileMegabytes * 1024 * 1024");
    expect(blobAttachmentApiSource).toContain("const userBlobAttachmentQuotaBytes = 1024 * 1024 * 1024");
    expect(blobAttachmentApiSource).toContain("const userBlobAttachmentCountLimit = 500");
    expect(blobAttachmentApiSource).toContain("const reservationTtlMs = 2 * 60 * 60 * 1000");
    expect(blobAttachmentApiSource).toContain("reserveUserAttachmentBytes");
    expect(blobAttachmentApiSource).toContain("첨부파일 총 저장 한도 1.00 GB를 초과했습니다.");
  });

  it("atomically enforces the server-only global free-tier Blob counter", () => {
    const reservationSource = blobAttachmentApiSource.match(
      /async function reserveUserAttachmentBytes[\s\S]*?async function claimAttachmentDeletion/u
    )?.[0] ?? "";
    const deletionSource = blobAttachmentApiSource.match(
      /async function claimAttachmentDeletion[\s\S]*?function attachmentBaseFields/u
    )?.[0] ?? "";

    expect(reservationSource).toContain("GLOBAL_BLOB_USAGE_DOCUMENT_PATH");
    expect(reservationSource).toContain("evaluateFreeTierUpload");
    expect(reservationSource).toContain("Global Blob usage counter is missing or invalid");
    expect(reservationSource).toContain("[quotaWrite, ...(globalWrite ? [globalWrite] : []), ...resolvedExtraWrites]");
    expect(reservationSource).toContain("blob storage capacity threshold crossed");
    expect(reservationSource).toContain("!priorGlobalDecision.warnUser");
    expect(reservationSource).toContain(
      "globalDecision.warnAdmin !== priorGlobalDecision.warnAdmin"
    );
    expect(blobAttachmentApiSource).toContain("currentDocument: { updateTime: usage.updateTime }");
    expect(deletionSource).toContain("usage.usedBytes >= encryptedSize");
    expect(deletionSource).toContain("usage.attachmentCount >= 1");
    expect(deletionSource).toContain("const nextUsedBytes = usage.usedBytes - encryptedSize");
    expect(deletionSource).toContain('reason: "counter_underflow_guard"');
  });

  it("keeps blob objects private and streams them only after Firestore authorization checks", () => {
    expect(blobAttachmentApiSource).toContain('access: "private"');
    expect(blobAttachmentApiSource).toContain("canReadNote");
    expect(blobAttachmentApiSource).toContain("publicShareActive");
    expect(blobAttachmentApiSource).toContain("Readable.fromWeb");
    expect(blobAttachmentApiSource).toContain('import { pipeline } from "node:stream/promises";');
    expect(blobAttachmentApiSource).toContain("cache-control");
  });

  it("fails closed when a public share source note is gone and serves only its current attachment generation", () => {
    const sourceCheck = blobAttachmentApiSource.match(
      /async function publicShareSourceAvailable[\s\S]*?async function reserveUserAttachmentBytes/u
    )?.[0] ?? "";
    const sourceGate = blobAttachmentApiSource.match(
      /function secureShareLiveContentSyncEnabled[\s\S]*?async function publicShareSourceAvailable/u
    )?.[0] ?? "";
    const reservationSource = blobAttachmentApiSource.match(
      /async function createPublicShareAttachmentReservation[\s\S]*?function callbackUrlForRequest/u
    )?.[0] ?? "";
    const markReadySource = blobAttachmentApiSource.match(
      /async function markAttachmentReady[\s\S]*?async function onUploadCompleted/u
    )?.[0] ?? "";
    const streamSource = blobAttachmentApiSource.match(
      /async function streamBlobAttachment[\s\S]*?async function deleteBlobIfPresent/u
    )?.[0] ?? "";

    expect(sourceCheck).toContain("firestoreGetDocument(projectId, `notes/${sourceNoteId}`");
    expect(sourceCheck).toContain("userProfile(projectId, ownerUid, accessToken)");
    expect(sourceCheck).toContain("publicAttachmentSourceAvailablePolicy");
    expect(sourceCheck).toContain('noteOwnerUid: valueString(sourceNote, "ownerUid")');
    expect(sourceCheck).toContain("noteIsActive(sourceNote)");
    expect(sourceCheck).toContain('shareSourceRevision: valueInteger(share, "sourceRevision")');
    expect(sourceCheck).toContain('noteRevision: valueInteger(sourceNote, "revision")');
    expect(sourceCheck).toContain('shareSourceAttachmentRevision: valueInteger(share, "sourceAttachmentRevision")');
    expect(sourceCheck).toContain('noteAttachmentRevision: valueInteger(sourceNote, "attachmentRevision")');
    expect(sourceCheck).toContain(
      "requireMatchingRevision = publicShareSourceRequiresMatchingRevision(share)"
    );
    expect(sourceGate).toContain(
      'valueInteger(share, "schemaVersion") === 2'
    );
    expect(sourceGate).toContain("!secureShareLiveContentSyncEnabled()");
    expect(blobAttachmentApiSource).toContain(
      "const secureShareLiveContentSyncServerProductionDefault = true"
    );
    expect(reservationSource).toContain("publicShareSourceAvailable(projectId, share, accessToken)");
    expect(reservationSource).toContain("generation: stringValue(payload.generation)");
    expect(markReadySource).toContain("publicShareSourceAvailable(projectId, share, accessToken)");
    expect(markReadySource).toContain('share?.fields?.revokedAt');
    expect(markReadySource).toContain('Number.isFinite(valueTimestampMillis(share, "expiresAt"))');
    expect(streamSource).toContain("publicShareSourceActive(credentials.projectId, share, accessToken)");
    expect(sourceCheck).toContain(
      "return publicShareSourceAvailable(projectId, share, accessToken)"
    );
    expect(streamSource).toContain("publicShareAttachmentIsCurrent(publicShare, attachment)");
    expect(streamSource).toContain('valueInteger(share, "schemaVersion") === 2');
  });

  it("logs metadata-only backend error summaries instead of exception messages", () => {
    const summarySource = blobAttachmentApiSource.match(
      /function errorNumberField[\s\S]*?function parseJsonCredential/u
    )?.[0] ?? "";

    expect(blobAttachmentApiSource).toContain("function safeErrorSummary(error)");
    expect(summarySource).toContain('kind: error instanceof Error ? "error" : "non_error"');
    expect(summarySource).toContain("value >= 100 && value <= 599");
    expect(summarySource).not.toContain("error.message");
    expect(summarySource).not.toContain("error.name");
    expect(blobAttachmentApiSource).toContain('console.error("blob attachment request failed", safeErrorSummary(error))');
    expect(blobAttachmentApiSource).not.toContain('console.error("blob attachment request failed", error)');
  });

  it("reuses warm Firebase management tokens and deduplicates cold OAuth requests", () => {
    const tokenSource = blobAttachmentApiSource.match(
      /function accessTokenCacheKey[\s\S]*?async function lookupCallerUid/u
    )?.[0] ?? "";

    expect(blobAttachmentApiSource).toContain("const oauthRequestTimeoutMs = 8_000");
    expect(blobAttachmentApiSource).toContain("const accessTokenRefreshSkewMs = 60_000");
    expect(blobAttachmentApiSource).toContain("let cachedAccessToken = null");
    expect(blobAttachmentApiSource).toContain("let pendingAccessTokenRequest = null");
    expect(tokenSource).toContain("AbortSignal.timeout(oauthRequestTimeoutMs)");
    expect(tokenSource).toContain("cachedAccessToken?.cacheKey === cacheKey");
    expect(tokenSource).toContain("pendingAccessTokenRequest?.cacheKey === cacheKey");
    expect(tokenSource).toContain("pendingAccessTokenRequest?.promise === requestPromise");
    expect(tokenSource).not.toContain("await response.text()");
    expect(tokenSource).not.toContain("token.access_token}`");
  });

  it("rejects disabled callers and bounds Identity Toolkit lookup time", () => {
    const lookupSource = blobAttachmentApiSource.match(
      /async function lookupCallerUid[\s\S]*?async function readJsonBody/u
    )?.[0] ?? "";

    expect(lookupSource).toContain("AbortSignal.timeout(oauthRequestTimeoutMs)");
    expect(lookupSource).toContain("user?.disabled !== true");
  });

  it("validates metadata from the streaming Blob response without a duplicate head operation", () => {
    const streamSource = blobAttachmentApiSource.match(/async function streamBlobAttachment[\s\S]*?async function deleteBlobIfPresent/u)?.[0] ?? "";

    expect(streamSource).not.toContain("headBlobIfPresent");
    expect(streamSource).toContain("blobMetadataMatchesAttachment(blob.blob, blobPath, encryptedSize)");
    expect(streamSource).toContain("await blob.stream.cancel()");
    expect(streamSource).toContain("await pipeline(Readable.fromWeb(blob.stream), response)");
    expect(streamSource).not.toContain("Readable.fromWeb(blob.stream).pipe(response)");
  });

  it("prevents client-side metadata spoofing by validating the reserved path and uploaded blob", () => {
    expect(blobAttachmentApiSource).toContain("Pathname mismatch");
    expect(blobAttachmentApiSource).toContain("validateUploadedBlob");
    expect(blobAttachmentApiSource).toContain("allowedContentTypes: [blobContentType]");
    expect(blobAttachmentApiSource).toContain("maximumSizeInBytes: payload.encryptedSize");
  });

  it("does not build Blob callback URLs from an untrusted public Host header", () => {
    const callbackSource = blobAttachmentApiSource.match(
      /function callbackUrlForRequest[\s\S]*?async function beforeGenerateToken/u
    )?.[0] ?? "";

    expect(callbackSource).toContain('envValue("VERCEL_URL")');
    expect(callbackSource).toContain('envValue("VERCEL_PROJECT_PRODUCTION_URL")');
    expect(callbackSource).toContain("localhost|127\\.0\\.0\\.1");
    expect(callbackSource).not.toContain('request.headers["x-forwarded-proto"]');
  });

  it("mirrors Firestore active-user revocation checks on service-account attachment mutations", () => {
    const uploadAuthSource =
      blobAttachmentApiSource.match(/async function canUploadToNote[\s\S]*?function publicShareActive/u)?.[0] ?? "";
    const publicShareReservationSource =
      blobAttachmentApiSource.match(/async function createPublicShareAttachmentReservation[\s\S]*?function callbackUrlForRequest/u)?.[0] ?? "";
    const completeUploadSource =
      blobAttachmentApiSource.match(/async function completeUploadFromClient[\s\S]*?async function streamBlobAttachment/u)?.[0] ?? "";
    const deleteAttachmentSource =
      blobAttachmentApiSource.match(/async function deleteAttachment[\s\S]*?function handleError/u)?.[0] ?? "";

    expect(firestoreRulesSource).toContain("function activeSignedInUser()");
    expect(firestoreRulesSource).toContain("function publicShareOwner(data)");
    expect(firestoreRulesSource).toContain("ownerAllowsParticipant(get(notePath(noteId)).data, request.auth.uid)");
    expect(uploadAuthSource).toContain("canUploadNoteAttachmentPolicy");
    expect(publicShareReservationSource).toContain("const ownerProfile = await userProfile(projectId, uid, accessToken)");
    expect(publicShareReservationSource).toContain("!ownerProfile.isActive");
    expect(completeUploadSource).toContain("const callerProfile = await userProfile(credentials.projectId, uid, accessToken)");
    expect(completeUploadSource).toContain("!callerProfile.isActive");
    expect(deleteAttachmentSource).toContain("canDeleteNoteAttachmentPolicy");
  });

  it("mirrors Notes feature revocation across authenticated and public-share Blob access", () => {
    const profileSource = blobAttachmentApiSource.match(
      /async function userProfile[\s\S]*?function noteIsDeleted/u
    )?.[0] ?? "";
    const publicShareSource = blobAttachmentApiSource.match(
      /async function publicShareSourceAvailable[\s\S]*?async function reserveUserAttachmentBytes/u
    )?.[0] ?? "";

    expect(profileSource).toContain('profileHasFeatureAccess(document, "notes")');
    expect(profileSource).toContain('Object.prototype.hasOwnProperty.call(document.fields, "featureAccess")');
    expect(profileSource).toContain('const expectedFeatures = ["notes", "library", "schedule"]');
    expect(publicShareSource).toContain("userProfile(projectId, ownerUid, accessToken)");
    expect(publicShareSource).toContain("ownerIsActive: ownerProfile.isActive");
  });

  it("re-checks active user state before marking Blob uploads ready", () => {
    const markReadySource = blobAttachmentApiSource.match(/async function markAttachmentReady[\s\S]*?async function onUploadCompleted/u)?.[0] ?? "";

    expect(markReadySource).toContain("userProfile(projectId, tokenPayload.uid, accessToken)");
    expect(markReadySource).toContain("!uploaderProfile.isActive");
    expect(markReadySource).toContain("Inactive uploader cannot complete attachment");
    expect(markReadySource).toContain("canUploadToNote(projectId, tokenPayload.uid, note, accessToken)");
    expect(markReadySource).toContain('valueString(attachment, "generation") !== safeId(tokenPayload.generation, "generation")');
  });

  it("allows Blob callbacks and client completion requests to mark uploads ready idempotently", () => {
    const markReadySource = blobAttachmentApiSource.match(/async function markAttachmentReady[\s\S]*?async function onUploadCompleted/u)?.[0] ?? "";

    expect(markReadySource).toContain("attachmentReadyAction");
    expect(markReadySource).toContain("currentDocument: { updateTime: attachment.updateTime }");
    expect(markReadySource).toContain("currentDocument: { updateTime: note.updateTime }");
    expect(markReadySource).toContain('attachmentRevision: integerValue(valueInteger(note, "attachmentRevision") + 1)');
    expect(markReadySource).toContain('"reservationExpiresAt"');
  });

  it("binds secure-share copy reservations and ready counts to the durable note job", () => {
    const reservationSource = blobAttachmentApiSource.match(
      /async function createNoteAttachmentReservation[\s\S]*?async function createPublicShareAttachmentReservation/u
    )?.[0] ?? "";
    const markReadySource = blobAttachmentApiSource.match(
      /async function markAttachmentReady[\s\S]*?async function onUploadCompleted/u
    )?.[0] ?? "";
    const beginDeleteSource = blobAttachmentApiSource.match(
      /async function beginAttachmentDeletion[\s\S]*?async function deleteAttachment/u
    )?.[0] ?? "";

    expect(reservationSource).toContain("Secure share copy job mismatch");
    expect(reservationSource).toContain('valueString(currentNote, "secureShareCopyJobId") !== payload.secureShareCopyJobId');
    expect(reservationSource.match(/secureShareCopyCleanupClaimed\(/gu)).toHaveLength(2);
    expect(reservationSource).toContain("secureShareCopyReservedAttachmentCount: integerValue(reservedCount + 1)");
    expect(markReadySource).toContain("secureShareCopyCleanupClaimed(note)");
    expect(markReadySource).toContain("secureShareCopyReadyAttachmentCount = integerValue(readyCount + 1)");
    expect(beginDeleteSource).toContain("secureShareCopyCleanupClaimed(note)");
    expect(beginDeleteSource).toContain("Secure share copy cleanup already claimed");
    expect(beginDeleteSource).toContain("secureShareCopyReservedAttachmentCount = integerValue(reservedCount - 1)");
    expect(beginDeleteSource).toContain("secureShareCopyReadyAttachmentCount = integerValue(readyCount - 1)");
  });

  it("invalidates public attachment snapshots before deleting ready note attachments", () => {
    const beginDeleteSource = blobAttachmentApiSource.match(
      /async function beginAttachmentDeletion[\s\S]*?async function deleteAttachment/u
    )?.[0] ?? "";
    const deleteSource = blobAttachmentApiSource.match(
      /async function deleteAttachment[\s\S]*?function handleError/u
    )?.[0] ?? "";

    expect(beginDeleteSource).toContain("shouldBumpAttachmentRevisionOnDelete");
    expect(beginDeleteSource).toContain('noteFields.attachmentRevision = integerValue(valueInteger(note, "attachmentRevision") + 1)');
    expect(beginDeleteSource).toContain('attachmentRevisionBumped = booleanValue(true)');
    expect(beginDeleteSource).toContain("currentDocument: { updateTime: note.updateTime }");
    expect(deleteSource.indexOf("const deletingAttachment = await beginAttachmentDeletion(")).toBeLessThan(
      deleteSource.indexOf("await deleteAttachmentObjects(")
    );
    expect(deleteSource).toContain("claimAttachmentDeletion");
  });

  it("makes an authorized public attachment delete replay idempotent", () => {
    const deleteSource = blobAttachmentApiSource.match(
      /async function deleteAttachment[\s\S]*?function handleError/u
    )?.[0] ?? "";
    const publicDelete = deleteSource.slice(
      deleteSource.indexOf('if (scope === "publicShare")')
    );
    const ownerCheckIndex = publicDelete.indexOf(
      'valueString(share, "ownerUid") !== uid'
    );
    const absentReplayIndex = publicDelete.indexOf("if (!attachment)");
    const deletionIndex = publicDelete.indexOf(
      "const deletingAttachment = await beginAttachmentDeletion"
    );

    expect(ownerCheckIndex).toBeGreaterThanOrEqual(0);
    expect(absentReplayIndex).toBeGreaterThan(ownerCheckIndex);
    expect(publicDelete.slice(absentReplayIndex, deletionIndex))
      .toContain("jsonResponse(response, 200, { ok: true })");
    expect(deletionIndex).toBeGreaterThan(absentReplayIndex);
  });

  it("claims attachment metadata and quota atomically with preconditions", () => {
    const claimSource = blobAttachmentApiSource.match(
      /async function claimAttachmentDeletion[\s\S]*?function attachmentBaseFields/u
    )?.[0] ?? "";

    expect(claimSource).toContain("quotaReleaseAfterAttachmentClaim");
    expect(claimSource).toContain('quotaReserved: valueHasField(attachment, "quotaReserved")');
    expect(claimSource).toContain('valueString(attachment, "storageProvider") === "vercel-blob"');
    expect(claimSource).toContain("currentDocument: { updateTime: claim.attachmentUpdateTime }");
    expect(claimSource).toContain("currentDocument: { updateTime: claim.quota.quotaUpdateTime }");
    expect(claimSource).toContain("Attachment deletion claim conflict");
    expect(blobAttachmentApiSource).toContain("quotaReserved: booleanValue(true)");
    expect(blobAttachmentApiSource).toContain("countPolicyVersion");
  });

  it("deletes Vercel Blob objects and gates legacy Firebase Storage cleanup", () => {
    expect(blobAttachmentApiSource).toContain('const storageBaseUrl = "https://storage.googleapis.com/storage/v1"');
    expect(blobAttachmentApiSource).toContain("storageBucket:");
    expect(blobAttachmentApiSource).toContain("deleteStorageObjectIfPresent");
    expect(blobAttachmentApiSource).toContain('valueString(attachment, "storagePath")');
    expect(blobAttachmentApiSource).toContain(
      'envValue("LEGACY_FIREBASE_STORAGE_ENABLED") !== "true"'
    );
  });

  it("retains pending deletion reservations through token expiry and removes rejected upload blobs", () => {
    const deleteSource = blobAttachmentApiSource.match(
      /async function beginAttachmentDeletion[\s\S]*?function handleError/u
    )?.[0] ?? "";
    const callbackSource = blobAttachmentApiSource.match(
      /async function cleanupRejectedUploadedBlob[\s\S]*?async function handleBlobUploadRequest/u
    )?.[0] ?? "";

    expect(deleteSource).toContain("shouldRetainPendingDeletionReservation");
    expect(deleteSource).toContain("pendingDeletionGraceMs");
    expect(callbackSource).toContain("deleteBlobIfPresent(uploadedBlob.pathname)");
    expect(callbackSource).toContain("cleanupRejectedUploadedBlob(credentials.projectId");
  });

  it("uses multipart client uploads for the 150 MB Vercel Blob attachment path", () => {
    expect(blobAttachmentClientSource).toContain("requestBlobClientToken");
    expect(blobAttachmentClientSource).toContain("throw new Error(typeof body.error === \"string\" ? body.error");
    expect(blobAttachmentClientSource.match(/multipart:\s*true/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(blobAttachmentClientSource.match(/onUploadProgress:\s*input\.onUploadProgress/gu)?.length).toBeGreaterThanOrEqual(2);
  });

  it("propagates attachment preview cancellation to the private Blob fetch", () => {
    const fetchSource = blobAttachmentClientSource.match(
      /async function blobAttachmentFetch[\s\S]*?export async function fetchBlobAttachmentBytes/u
    )?.[0] ?? "";

    expect(fetchSource).toContain("throwIfRequestAborted(signal)");
    expect(fetchSource).toContain("signal");
    expect(fetchSource).toMatch(/fetch\(`\$\{blobAttachmentApiPath\}\?\$\{query\.toString\(\)\}`, \{\s*headers,\s*signal\s*\}\)/u);
  });

  it("accepts only validated v1 or chunked v2 attachment manifests in the Blob API", () => {
    expect(blobAttachmentApiSource).toContain("const encryptedAttachmentChunkSizeBytes = 4 * 1024 * 1024");
    expect(blobAttachmentApiSource).toContain("function safeAttachmentVersion(value)");
    expect(blobAttachmentApiSource).toContain("function safeAttachmentAlgorithm(value, version)");
    expect(blobAttachmentApiSource).toContain("function validateChunkIvBase64List(value, chunkCount)");
    expect(blobAttachmentApiSource).toContain("encryptedSize !== expectedEncryptedSize");
    expect(blobAttachmentApiSource).toContain('fields.chunkIvs = bytesArrayValue(payload.chunkIvBase64List)');
    expect(blobAttachmentApiSource).toContain('fields.iv = bytesValue(payload.ivBase64)');
    expect(blobAttachmentClientSource).toContain("function encryptionPayloadFields(encryption: AttachmentEncryptionMetadata)");
    expect(blobAttachmentClientSource).toContain("chunkIvBase64List: encryption.chunkIvs.map");
  });

  it("enforces public share MIME/extension invariants in the service-account Blob API", () => {
    expect(blobAttachmentApiSource).toContain("const publicShareAttachmentMimeTypes = {");
    expect(blobAttachmentApiSource).toContain("function safePublicShareMimeType(extension, mimeType)");
    expect(blobAttachmentApiSource).toContain("Public share MIME/extension mismatch");
    expect(blobAttachmentApiSource).toContain('scope === "publicShare" ? safePublicShareMimeType(extension, parsed.mimeType) : safeMimeType(parsed.mimeType)');
  });
});
