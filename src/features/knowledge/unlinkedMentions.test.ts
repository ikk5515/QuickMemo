import { describe, expect, it } from "vitest";
import { buildKnowledgeIndex, unlinkedMentionOccurrences } from "./knowledgeIndex";
import { markdownTextForUnlinkedMentions } from "./markdown";
import {
  createUnlinkedMentionWikilinkEdit,
  findUnlinkedMentions
} from "./unlinkedMentions";
import type { UnlinkedMentionOccurrence, VaultIndexEntry } from "./types";

function markdownEntry(id: string, path: string, content: string): VaultIndexEntry {
  return { id, path, kind: "markdown", content };
}

describe("unlinked Markdown mentions", () => {
  it("finds title and alias plaintext with context while excluding non-plaintext regions", () => {
    const target = markdownEntry(
      "target",
      "Notes/Target.md",
      "---\naliases: [QM]\n---\nTarget in the target itself"
    );
    const source = markdownEntry(
      "source",
      "Sources/Source.md",
      `---
summary: Target in frontmatter
---
Target is visible and QM is an alias.
Targeted is a longer word.
\`Target QM\`

\`\`\`md
Target QM
\`\`\`

%% Target QM %%
[[Target]] [Target](../Notes/Target.md)
https://example.com/Target www.example.com/QM
`
    );
    const index = buildKnowledgeIndex([source, target]);

    expect(unlinkedMentionOccurrences(index, "target")).toEqual([
      expect.objectContaining({
        sourceEntryId: "source",
        matchedText: "Target",
        matchedTerm: "Target",
        line: 4,
        column: 1,
        context: "Target is visible and QM is an alias."
      }),
      expect.objectContaining({
        sourceEntryId: "source",
        matchedText: "QM",
        matchedTerm: "QM",
        line: 4,
        column: 23
      })
    ]);
  });

  it("uses Unicode-aware word boundaries and never scans non-Markdown sources", () => {
    const target = markdownEntry("target", "지식.md", "---\naliases: [메모]\n---");
    const source = markdownEntry("source", "Source.md", "지식과 지식, 메모장과 메모.");
    const canvas: VaultIndexEntry = {
      id: "canvas",
      kind: "canvas",
      path: "Board.canvas",
      content: JSON.stringify({ nodes: [{ type: "text", text: "지식 메모" }] })
    };
    const index = buildKnowledgeIndex([target, source, canvas]);

    expect(findUnlinkedMentions(index.entries, index.metadataByEntryId, "target").map(
      (occurrence) => occurrence.matchedText
    )).toEqual(["지식", "메모"]);
  });

  it("edits the latest draft in place, preserves newer text, and rejects shifted occurrences", () => {
    const occurrence: UnlinkedMentionOccurrence = {
      sourceEntryId: "source",
      sourcePath: "Source.md",
      targetEntryId: "target",
      targetPath: "Notes/Target.md",
      matchedText: "Target",
      matchedTerm: "Target",
      startOffset: 0,
      endOffset: 6,
      line: 1,
      column: 1,
      context: "Target stays here"
    };

    expect(createUnlinkedMentionWikilinkEdit(
      "Target stays here\nnewer edit remains",
      occurrence,
      "Notes/Target.md"
    )).toEqual({
      status: "applied",
      markdown: "[[Notes/Target|Target]] stays here\nnewer edit remains",
      wikilink: "[[Notes/Target|Target]]"
    });
    expect(createUnlinkedMentionWikilinkEdit(
      "new Target stays here",
      occurrence,
      "Notes/Target.md"
    )).toEqual({ status: "stale-occurrence" });
  });

  it("uses a shortest root Wikilink when it preserves the visible title", () => {
    const occurrence: UnlinkedMentionOccurrence = {
      sourceEntryId: "source",
      sourcePath: "Source.md",
      targetEntryId: "target",
      targetPath: "Target.md",
      matchedText: "Target",
      matchedTerm: "Target",
      startOffset: 0,
      endOffset: 6,
      line: 1,
      column: 1,
      context: "Target"
    };

    expect(createUnlinkedMentionWikilinkEdit("Target", occurrence, "Target.md"))
      .toEqual({ status: "applied", markdown: "[[Target]]", wikilink: "[[Target]]" });
  });

  it("keeps masking offset-preserving and rejects fragment-like target paths", () => {
    const markdown = "Target `Target` [[Target]] https://example.com/Target\r\nTarget";
    const masked = markdownTextForUnlinkedMentions(markdown);
    expect(masked).toHaveLength(markdown.length);
    expect(masked.split("\r\n")).toHaveLength(2);

    const occurrence: UnlinkedMentionOccurrence = {
      sourceEntryId: "source",
      sourcePath: "Source.md",
      targetEntryId: "target",
      targetPath: "Notes/Target#Draft.md",
      matchedText: "Target",
      matchedTerm: "Target",
      startOffset: 0,
      endOffset: 6,
      line: 1,
      column: 1,
      context: "Target"
    };
    expect(createUnlinkedMentionWikilinkEdit(
      "Target",
      occurrence,
      "Notes/Target#Draft.md"
    )).toEqual({ status: "unsafe-target" });
    expect(createUnlinkedMentionWikilinkEdit(
      "Target",
      { ...occurrence, targetPath: "Notes/Target^Draft.md" },
      "Notes/Target^Draft.md"
    )).toEqual({ status: "unsafe-target" });
  });
});
