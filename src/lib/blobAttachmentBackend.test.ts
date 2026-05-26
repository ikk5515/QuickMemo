import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const blobAttachmentApiSource = readFileSync(join(process.cwd(), "api/blob-attachments.js"), "utf8");

describe("blob attachment backend", () => {
  it("uses authenticated Vercel Blob client uploads with a 50 MB user quota", () => {
    expect(blobAttachmentApiSource).toContain("handleUpload");
    expect(blobAttachmentApiSource).toContain("BLOB_READ_WRITE_TOKEN");
    expect(blobAttachmentApiSource).toContain("const userBlobAttachmentQuotaBytes = 50 * 1024 * 1024");
    expect(blobAttachmentApiSource).toContain("reserveUserAttachmentBytes");
    expect(blobAttachmentApiSource).toContain("첨부파일 저장 한도 50.00 MB를 초과했습니다.");
  });

  it("keeps blob objects private and streams them only after Firestore authorization checks", () => {
    expect(blobAttachmentApiSource).toContain('access: "private"');
    expect(blobAttachmentApiSource).toContain("canReadNote");
    expect(blobAttachmentApiSource).toContain("publicShareActive");
    expect(blobAttachmentApiSource).toContain("Readable.fromWeb");
    expect(blobAttachmentApiSource).toContain("cache-control");
  });

  it("prevents client-side metadata spoofing by validating the reserved path and uploaded blob", () => {
    expect(blobAttachmentApiSource).toContain("Pathname mismatch");
    expect(blobAttachmentApiSource).toContain("validateUploadedBlob");
    expect(blobAttachmentApiSource).toContain("allowedContentTypes: [blobContentType]");
    expect(blobAttachmentApiSource).toContain("maximumSizeInBytes: payload.encryptedSize");
  });
});
