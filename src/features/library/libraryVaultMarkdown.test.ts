import { describe, expect, it } from "vitest";
import type { LibraryItemContent } from "../../types";
import {
  libraryItemToVaultMarkdown,
  libraryVaultNoteTitle,
  normalizeLibraryVaultTags
} from "./libraryVaultMarkdown";

function content(overrides: Partial<LibraryItemContent> = {}): LibraryItemContent {
  return {
    archivedAt: null,
    collection: "리서치",
    description: "요약 **표현** <script>alert(1)</script>",
    highlights: [{
      blockId: "block-a",
      color: "yellow",
      createdAt: "2026-08-22T00:00:00.000Z",
      endOffset: 4,
      id: "highlight-a",
      note: "중요 #메모",
      quote: "본문",
      startOffset: 0
    }],
    ocrText: "OCR <img src=x onerror=alert(1)>",
    readerBlocks: [
      { id: "block-a", kind: "heading", text: "본문 *제목*" },
      { id: "block-b", kind: "paragraph", text: "[가짜](javascript:alert(1))" },
      { id: "block-c", kind: "code", text: "const fence = ```;" }
    ],
    selectionText: "선택\n내용",
    siteName: "Example",
    sourceFileName: "",
    tags: ["보안", "project/quickmemo", "123", "bad tag", "보안"],
    title: "보안 / 가이드",
    url: "https://Example.com/doc?utm_source=tracker&b=2",
    version: 1,
    ...overrides
  };
}

describe("library Vault Markdown conversion", () => {
  it("builds deterministic Obsidian Markdown with a sanitized source and capture time", () => {
    const converted = libraryItemToVaultMarkdown({
      capturedAt: { toMillis: () => Date.UTC(2026, 7, 22, 1, 2, 3) },
      content: content()
    });

    expect(converted.title).toBe("보안 - 가이드");
    expect(converted.sourceUrl).toBe("https://example.com/doc?b=2");
    expect(converted.capturedAt).toBe("2026-08-22T01:02:03.000Z");
    expect(converted.tags).toEqual(["보안", "project/quickmemo"]);
    expect(converted.body).toContain('source: "https://example.com/doc?b=2"');
    expect(converted.body).toContain("[Example](<https://example.com/doc?b=2>)");
    expect(converted.body).toContain('captured_at: "2026-08-22T01:02:03.000Z"');
    expect(converted.body).toContain("## 요약");
    expect(converted.body).toContain("## 본문");
    expect(converted.body).toContain("## 하이라이트");
    expect(converted.body).toContain("````\nconst fence = ```;\n````");
    expect(converted.body).not.toContain("<script>");
    expect(converted.body).not.toContain("javascript:alert(1))");
    expect(converted.body).toContain("javascript:alert\\(1\\)\\)");
  });

  it("omits non-http sources instead of writing an active scheme", () => {
    const converted = libraryItemToVaultMarkdown({
      capturedAt: null,
      content: content({ url: "javascript:alert(document.cookie)" })
    });
    expect(converted.sourceUrl).toBeNull();
    expect(converted.body).not.toContain("source:");
    expect(converted.body).not.toContain("[Example](javascript:");
    expect(converted.body).toContain("\\(javascript:alert\\(1\\)\\)");
    expect(converted.body).toContain("캡처 시각: 기록 없음");
  });

  it("normalizes titles and accepts only actual Obsidian tags", () => {
    expect(libraryVaultNoteTitle(content({ title: "../폴더\\노트" }))).toBe(".. - 폴더 - 노트");
    expect(normalizeLibraryVaultTags([
      "#Project/QuickMemo",
      "project/quickmemo",
      "😀/아이디어",
      "👨‍👩‍👧‍👦/가족",
      "12a",
      "123",
      "has space",
      "empty//segment"
    ])).toEqual(["Project/QuickMemo", "😀/아이디어", "👨‍👩‍👧‍👦/가족", "12a"]);
  });
});
