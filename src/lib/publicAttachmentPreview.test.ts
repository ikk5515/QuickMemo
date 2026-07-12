import { describe, expect, it } from "vitest";
import { decodeTextAttachmentPreview, legacyBinaryPreviewMessage } from "./publicAttachmentPreview";

describe("public attachment preview helpers", () => {
  it("formats JSON without retaining disallowed control characters", () => {
    const bytes = new TextEncoder().encode('{"name":"QuickMemo\\u0000","items":[1,2]}');
    const preview = decodeTextAttachmentPreview(bytes, "json");

    expect(preview).toContain('"items": [');
    expect(preview).not.toContain("\0");
  });

  it("recognizes readable UTF-16LE text", () => {
    const text = "공개 공유 미리보기";
    const bytes = new Uint8Array(text.length * 2);

    Array.from(text).forEach((character, index) => {
      const code = character.charCodeAt(0);
      bytes[index * 2] = code & 0xff;
      bytes[index * 2 + 1] = code >> 8;
    });

    expect(decodeTextAttachmentPreview(bytes, "txt")).toBe(text);
  });

  it("keeps legacy binary documents download-only", () => {
    expect(legacyBinaryPreviewMessage("doc")).toContain("원본 다운로드");
  });
});
