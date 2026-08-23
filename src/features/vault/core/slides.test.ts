import { describe, expect, it } from "vitest";
import { createMarkdownSlidesDeck, MAX_SLIDES_PER_DECK } from "./slides";

describe("Markdown slides", () => {
  it("removes YAML properties and splits only on top-level slide markers", () => {
    const deck = createMarkdownSlidesDeck([
      "---",
      "title: secret property",
      "---",
      "# 첫 장",
      "```md",
      "---",
      "```",
      "---",
      "# 둘째 장"
    ].join("\n"), "발표");
    expect(deck.title).toBe("발표");
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0].source).toContain("```md\n---\n```");
    expect(deck.slides[0].source).not.toContain("secret property");
    expect(deck.slides[1].source).toBe("# 둘째 장");
  });

  it("bounds pathological decks", () => {
    const tooMany = Array.from({ length: MAX_SLIDES_PER_DECK + 1 }, (_, index) => `# ${index}`).join("\n---\n");
    expect(() => createMarkdownSlidesDeck(tooMany)).toThrow("최대");
  });
});
