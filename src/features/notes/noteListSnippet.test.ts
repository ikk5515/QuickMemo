import { describe, expect, it } from "vitest";
import { NOTE_LIST_SNIPPET_MAX_LENGTH, noteListSnippet } from "./noteListSnippet";

describe("noteListSnippet", () => {
  it("keeps short previews readable and normalizes layout-only whitespace", () => {
    expect(noteListSnippet("  짧은\n\n본문  ")).toBe("짧은 본문");
  });

  it("bounds plaintext rendered into the note list DOM", () => {
    const result = noteListSnippet("가".repeat(2_000));

    expect(result.length).toBeLessThanOrEqual(NOTE_LIST_SNIPPET_MAX_LENGTH);
    expect(result.endsWith("…")).toBe(true);
  });

  it("shows context around a full-text match without rendering the full body", () => {
    const result = noteListSnippet(
      `${"앞".repeat(1_000)}찾을검색어${"뒤".repeat(1_000)}`,
      "찾을검색어"
    );

    expect(result).toContain("찾을검색어");
    expect(result.startsWith("…")).toBe(true);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(NOTE_LIST_SNIPPET_MAX_LENGTH);
  });
});
