import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const publicSharePageSource = readFileSync(join(process.cwd(), "src/pages/PublicSharePage.tsx"), "utf8");

describe("PublicSharePage security controls", () => {
  it("does not expose public attachment bytes through attacker-controlled MIME blob documents", () => {
    expect(publicSharePageSource).toContain("\"application/octet-stream\"");
    expect(publicSharePageSource).toContain("publicShareAttachmentMimeMatchesExtension(attachment.extension, attachment.mimeType)");
    expect(publicSharePageSource).toContain("isPublicShareRasterImageExtension(attachment.extension)");
    expect(publicSharePageSource).not.toContain("new Blob([bytes], { type: attachment.mimeType");
    expect(publicSharePageSource).not.toContain("attachment.mimeType || \"application/octet-stream\"");
  });

  it("uses chunk-aware decrypt helpers and avoids duplicate image object URLs", () => {
    const imagePreviewBranch = publicSharePageSource.match(/if \(isImageAttachment\(attachment\)\) \{[\s\S]*?\n {8}\}/)?.[0] ?? "";

    expect(publicSharePageSource).toContain("decryptAttachmentToBlob");
    expect(publicSharePageSource).toContain("decryptAttachmentToBytes");
    expect(publicSharePageSource).toContain("getEncryptedPublicShareAttachmentSource");
    expect(imagePreviewBranch.match(/previewObjectUrl/gu)?.length).toBe(1);
  });

  it("keeps public share attachment bytes lazy until preview or download is requested", () => {
    const contentLoader =
      publicSharePageSource.match(/async function decryptPublicShareContent[\s\S]*?function shareKeyFromHash/u)?.[0] ?? "";

    expect(contentLoader).toContain("encryptedAttachments.map(publicShareAttachmentView)");
    expect(contentLoader).not.toContain("Promise.all(encryptedAttachments.map");
    expect(publicSharePageSource).not.toContain("bytes: Uint8Array;");
    expect(publicSharePageSource).not.toContain("downloadUrl: string;");
    expect(publicSharePageSource).not.toContain("previewUrl: string | null;");
    expect(publicSharePageSource).not.toContain("src={attachment.previewUrl}");
  });

  it("routes public PDF previews through byte-based canvas rendering instead of blob iframes", () => {
    const pdfPreviewBranch = publicSharePageSource.match(/if \(extension === "pdf"\) \{[\s\S]*?\n {8}\}/)?.[0] ?? "";

    expect(pdfPreviewBranch).toContain("bytes, fileName");
    expect(pdfPreviewBranch).toContain("kind: \"pdf\"");
    expect(pdfPreviewBranch).toContain("url: downloadUrl");
    expect(publicSharePageSource).not.toContain("<iframe");
    expect(publicSharePageSource).not.toContain("src={downloadUrl}");
    expect(publicSharePageSource).not.toContain("src={attachment.url}");
  });
});
