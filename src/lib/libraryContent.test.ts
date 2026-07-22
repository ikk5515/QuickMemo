import { describe, expect, it } from "vitest";
import { generateNoteKey } from "./crypto";
import {
  decryptLibraryItemContent,
  emptyLibraryItemContent,
  encryptLibraryItemContent,
  libraryAttachmentFingerprint,
  librarySearchText,
  libraryUrlFingerprint,
  normalizeLibraryItemContent,
  normalizeLibraryUrl,
  safeLibraryExternalUrl
} from "./libraryContent";

describe("library content security", () => {
  it("accepts only credential-free HTTP(S) URLs and removes tracking data", () => {
    expect(normalizeLibraryUrl("https://Example.com:443/path?utm_source=x&b=2&a=1#secret")).toBe(
      "https://example.com/path?a=1&b=2"
    );
    expect(safeLibraryExternalUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeLibraryUrl("https://user:password@example.com/private")).toBeNull();
    expect(normalizeLibraryUrl("file:///etc/passwd")).toBeNull();
  });

  it("encrypts all private metadata and rejects tampering", async () => {
    const key = await generateNoteKey();
    const content = normalizeLibraryItemContent({
      ...emptyLibraryItemContent(),
      title: "민감한 문서 제목",
      url: "https://example.com/private",
      tags: ["인사", "보안"],
      ocrText: "주민등록번호가 포함될 수 있는 OCR"
    });
    const encrypted = await encryptLibraryItemContent(content, key);
    const serializedEnvelope = JSON.stringify(encrypted);

    expect(serializedEnvelope).not.toContain(content.title);
    expect(serializedEnvelope).not.toContain(content.url);
    expect(serializedEnvelope).not.toContain(content.tags[0]);
    await expect(decryptLibraryItemContent(encrypted, key)).resolves.toEqual(content);

    const tampered = {
      ...encrypted,
      cipherText: `${encrypted.cipherText.slice(0, -2)}AA`
    };
    await expect(decryptLibraryItemContent(tampered, key)).rejects.toThrow();
  });

  it("uses a per-user keyed URL fingerprint rather than a reversible URL hash", async () => {
    const leftKey = await generateNoteKey();
    const rightKey = await generateNoteKey();
    const source = "https://example.com/article?utm_campaign=private&id=7";
    const left = await libraryUrlFingerprint(source, leftKey);

    expect(left).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(libraryUrlFingerprint(source, leftKey)).resolves.toBe(left);
    await expect(libraryUrlFingerprint(source, rightKey)).resolves.not.toBe(left);
    expect(left).not.toContain("example");
  });

  it("creates a stable opaque identity for an existing note attachment", async () => {
    const key = await generateNoteKey();
    const left = await libraryAttachmentFingerprint("note_12345678", "attachment_12345678", key);

    await expect(libraryAttachmentFingerprint("note_12345678", "attachment_12345678", key)).resolves.toBe(left);
    await expect(libraryAttachmentFingerprint("note_12345678", "attachment_87654321", key)).resolves.not.toBe(left);
    await expect(libraryAttachmentFingerprint("n", "a", key)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(libraryAttachmentFingerprint("n".repeat(180), "a".repeat(180), key)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(libraryAttachmentFingerprint("bad/slash", "attachment_87654321", key)).rejects.toThrow("식별자");
    await expect(libraryAttachmentFingerprint("n".repeat(181), "attachment_87654321", key)).rejects.toThrow("식별자");
  });

  it("normalizes blocks and keeps only valid non-overlapping highlights", () => {
    const content = normalizeLibraryItemContent({
      version: 1,
      title: "Reader",
      readerBlocks: [{ id: "block_123456", kind: "paragraph", text: "안전한 리더 본문입니다." }],
      highlights: [
        {
          id: "highlight_123456",
          blockId: "block_123456",
          startOffset: 0,
          endOffset: 3,
          quote: "변조된 인용",
          note: "  확인  ",
          color: "green",
          createdAt: "2026-07-22T00:00:00.000Z"
        },
        {
          id: "overlap_123456",
          blockId: "block_123456",
          startOffset: 1,
          endOffset: 4,
          color: "pink"
        }
      ]
    });

    expect(content.highlights).toHaveLength(1);
    expect(content.highlights[0]).toMatchObject({ quote: "안전한", note: "확인", color: "green" });
  });

  it("builds a normalized in-memory search string without persistent indexes", () => {
    const content = normalizeLibraryItemContent({
      ...emptyLibraryItemContent(),
      title: "  ＱｕｉｃｋＭｅｍｏ   자료 ",
      tags: ["업무", "업무", " Reference "]
    });

    expect(content.tags).toEqual(["업무", "Reference"]);
    expect(librarySearchText(content)).toContain("quickmemo 자료");
  });
});
