import { describe, expect, it } from "vitest";
import { planUnresolvedMarkdownTarget } from "./unresolvedMarkdownPath";
import { MAX_VAULT_FOLDER_DEPTH } from "./vaultIntegrity";

describe("planUnresolvedMarkdownTarget", () => {
  it("preserves every requested folder segment for an extensionless wikilink", () => {
    expect(planUnresolvedMarkdownTarget("Projects/QuickMemo/Missing")).toEqual({
      folders: [
        { name: "Projects", parentPath: null, path: "Projects" },
        { name: "QuickMemo", parentPath: "Projects", path: "Projects/QuickMemo" }
      ],
      targetPath: "Projects/QuickMemo/Missing.md",
      title: "Missing"
    });
  });

  it("normalizes Unicode and accepts an explicit Markdown extension", () => {
    const result = planUnresolvedMarkdownTarget("기록/RE\u0301SUME\u0301.md");
    expect(result.folders[0]?.path).toBe("기록");
    expect(result.title).toBe("RÉSUMÉ");
    expect(result.targetPath).toBe("기록/RÉSUMÉ.md");
  });

  it("rejects traversal and non-Markdown targets instead of creating the wrong path", () => {
    expect(() => planUnresolvedMarkdownTarget("../Outside")).toThrow();
    expect(() => planUnresolvedMarkdownTarget("Files/Image.png")).toThrow("Markdown가 아닌");
    expect(() => planUnresolvedMarkdownTarget(`${"f".repeat(121)}/Note`)).toThrow("폴더의 이름");
    expect(() => planUnresolvedMarkdownTarget("n".repeat(181))).toThrow("노트의 이름");
    const tooDeep = `${Array.from({ length: MAX_VAULT_FOLDER_DEPTH + 2 }, (_, index) => `f${index}`).join("/")}/Note`;
    expect(() => planUnresolvedMarkdownTarget(tooDeep)).toThrow("중첩 깊이");
  });
});
