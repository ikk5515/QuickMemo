import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const publicSharePageSource = readFileSync(join(process.cwd(), "src/pages/PublicSharePage.tsx"), "utf8");

describe("PublicSharePage security controls", () => {
  it("does not expose public attachment bytes through attacker-controlled MIME blob documents", () => {
    expect(publicSharePageSource).toContain("new Blob([bytes], { type: \"application/octet-stream\" })");
    expect(publicSharePageSource).toContain("publicShareAttachmentMimeMatchesExtension(extension, mimeType)");
    expect(publicSharePageSource).toContain("isPublicShareRasterImageExtension(extension)");
    expect(publicSharePageSource).not.toContain("new Blob([bytes], { type: attachment.mimeType");
    expect(publicSharePageSource).not.toContain("attachment.mimeType || \"application/octet-stream\"");
  });

  it("renders public image previews as in-page buttons instead of same-origin new-tab blob links", () => {
    const imageAttachmentBranch =
      publicSharePageSource.match(/\{isImageAttachment\(attachment\) \? \([\s\S]*?\) : \(/)?.[0] ?? "";

    expect(imageAttachmentBranch).toContain("<button");
    expect(imageAttachmentBranch).toContain("openAttachmentPreview(attachment)");
    expect(imageAttachmentBranch).toContain("src={attachment.previewUrl}");
    expect(imageAttachmentBranch).not.toContain("<a");
    expect(imageAttachmentBranch).not.toContain("target=\"_blank\"");
  });
});
