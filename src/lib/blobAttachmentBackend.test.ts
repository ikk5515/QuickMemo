import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const blobAttachmentApiSource = readFileSync(join(process.cwd(), "api/blob-attachments.js"), "utf8");
const blobAttachmentClientSource = readFileSync(join(process.cwd(), "src/services/blobAttachments.ts"), "utf8");
const firestoreRulesSource = readFileSync(join(process.cwd(), "firestore.rules"), "utf8");

describe("blob attachment backend", () => {
  it("uses authenticated Vercel Blob client uploads with a 1 GB user quota", () => {
    expect(blobAttachmentApiSource).toContain("handleUpload");
    expect(blobAttachmentApiSource).toContain("BLOB_READ_WRITE_TOKEN");
    expect(blobAttachmentApiSource).toContain("const maxAttachmentFileBytes = 50 * 1024 * 1024");
    expect(blobAttachmentApiSource).toContain("const userBlobAttachmentQuotaBytes = 1024 * 1024 * 1024");
    expect(blobAttachmentApiSource).toContain("reserveUserAttachmentBytes");
    expect(blobAttachmentApiSource).toContain("첨부파일 총 저장 한도 1.00 GB를 초과했습니다.");
  });

  it("keeps blob objects private and streams them only after Firestore authorization checks", () => {
    expect(blobAttachmentApiSource).toContain('access: "private"');
    expect(blobAttachmentApiSource).toContain("canReadNote");
    expect(blobAttachmentApiSource).toContain("publicShareActive");
    expect(blobAttachmentApiSource).toContain("Readable.fromWeb");
    expect(blobAttachmentApiSource).toContain("cache-control");
  });

  it("validates downloaded Blob metadata with head before streaming", () => {
    const streamSource = blobAttachmentApiSource.match(/async function streamBlobAttachment[\s\S]*?async function deleteBlobIfPresent/u)?.[0] ?? "";

    expect(streamSource).toContain("const blobMetadata = await headBlobIfPresent(blobPath)");
    expect(streamSource).toContain("blobMetadataMatchesAttachment(blobMetadata, blobPath, encryptedSize)");
    expect(streamSource).not.toContain("blob.blob.size !== encryptedSize");
    expect(streamSource).toContain("Readable.fromWeb(blob.stream).pipe(response)");
  });

  it("prevents client-side metadata spoofing by validating the reserved path and uploaded blob", () => {
    expect(blobAttachmentApiSource).toContain("Pathname mismatch");
    expect(blobAttachmentApiSource).toContain("validateUploadedBlob");
    expect(blobAttachmentApiSource).toContain("allowedContentTypes: [blobContentType]");
    expect(blobAttachmentApiSource).toContain("maximumSizeInBytes: payload.encryptedSize");
  });

  it("mirrors Firestore active-user revocation checks on service-account attachment mutations", () => {
    const publicShareReservationSource =
      blobAttachmentApiSource.match(/async function createPublicShareAttachmentReservation[\s\S]*?function callbackUrlForRequest/u)?.[0] ?? "";
    const completeUploadSource =
      blobAttachmentApiSource.match(/async function completeUploadFromClient[\s\S]*?async function streamBlobAttachment/u)?.[0] ?? "";
    const deleteAttachmentSource =
      blobAttachmentApiSource.match(/async function deleteAttachment[\s\S]*?function handleError/u)?.[0] ?? "";

    expect(firestoreRulesSource).toContain("function activeSignedInUser()");
    expect(firestoreRulesSource).toContain("function publicShareOwner(data)");
    expect(publicShareReservationSource).toContain("const ownerProfile = await userProfile(projectId, uid, accessToken)");
    expect(publicShareReservationSource).toContain("!ownerProfile.isActive");
    expect(completeUploadSource).toContain("const callerProfile = await userProfile(credentials.projectId, uid, accessToken)");
    expect(completeUploadSource).toContain("!callerProfile.isActive");
    expect(deleteAttachmentSource).toContain("&& callerProfile.isActive");
    expect(deleteAttachmentSource).toContain("!callerProfile.isActive");
  });

  it("allows Blob callbacks and client completion requests to mark uploads ready idempotently", () => {
    const markReadySource = blobAttachmentApiSource.match(/async function markAttachmentReady[\s\S]*?async function onUploadCompleted/u)?.[0] ?? "";

    expect(markReadySource).toContain("currentDocument: { exists: true }");
    expect(markReadySource).not.toContain("currentDocument: { updateTime: document.updateTime }");
  });

  it("uses multipart client uploads for the 50 MB Vercel Blob attachment path", () => {
    expect(blobAttachmentClientSource).toContain("requestBlobClientToken");
    expect(blobAttachmentClientSource).toContain("throw new Error(typeof body.error === \"string\" ? body.error");
    expect(blobAttachmentClientSource.match(/multipart:\s*true/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(blobAttachmentClientSource.match(/onUploadProgress:\s*input\.onUploadProgress/gu)?.length).toBeGreaterThanOrEqual(2);
  });
});
