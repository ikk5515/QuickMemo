import { describe, expect, it } from "vitest";
import { buildVaultFootnoteView } from "./footnotes";

describe("Footnotes view model", () => {
  it("indexes referenced definitions, continuation lines and inline footnotes", () => {
    const model = buildVaultFootnoteView([
      "본문[^same] 다시[^same] 인라인^[짧은 설명]",
      "",
      "[^same]: 첫 줄",
      "    둘째 줄"
    ].join("\n"));
    expect(model.items).toHaveLength(2);
    expect(model.items[0]).toMatchObject({
      definitionLine: 3,
      definitionMarkdown: "첫 줄\n둘째 줄",
      label: "same",
      referenceCount: 2
    });
    expect(model.items[0].preview).toContain("첫 줄 둘째 줄");
    expect(model.items[1]).toMatchObject({ inline: true, referenceCount: 1 });
  });

  it("ignores apparent definitions inside frontmatter and fenced code", () => {
    const model = buildVaultFootnoteView([
      "---",
      "fake: '[^x]: property'",
      "---",
      "```md",
      "[^x]: code",
      "```",
      "실제[^x]",
      "[^x]: 안전한 정의"
    ].join("\n"));
    expect(model.items[0]).toMatchObject({ definitionLine: 8, preview: "안전한 정의" });
  });
});
