import { describe, expect, it } from "vitest";
import {
  applyInternalLinkRewritePlan,
  planIncomingInternalLinkRewrites
} from "./linkRewrite";
import type { RevisionedVaultIndexEntry } from "./linkRewrite";

function markdownEntry(
  id: string,
  path: string,
  content: string,
  revision = 1
): RevisionedVaultIndexEntry {
  return { id, path, kind: "markdown", content, revision };
}

function applyOnlyPlan(entries: readonly RevisionedVaultIndexEntry[], targetEntryId: string, newPath: string): string {
  const plans = planIncomingInternalLinkRewrites({ entries, targetEntryId, newTargetPath: newPath });
  expect(plans).toHaveLength(1);
  const source = entries.find((entry) => entry.id === plans[0].sourceEntryId);
  if (!source) {
    throw new Error("test source missing");
  }
  const result = applyInternalLinkRewritePlan(plans[0], source.content ?? "", source.revision);
  expect(result.status).toBe("applied");
  return result.status === "applied" ? result.markdown : "";
}

describe("incoming internal-link rewrite planning", () => {
  it("rewrites wikilink targets while preserving embeds, aliases, headings, and blocks", () => {
    const source = `[[Notes/Old]]
[[Notes/Old|표시 이름]]
![[Notes/Old#Heading|미리보기]]
[[Notes/Old#^block-id]]

\`[[Notes/Old]]\`

\`\`\`md
[[Notes/Old]]
\`\`\`
`;
    const entries = [
      markdownEntry("source", "Inbox/Source.md", source, 7),
      markdownEntry("target", "Notes/Old.md", "# Heading")
    ];

    const plans = planIncomingInternalLinkRewrites({
      entries,
      targetEntryId: "target",
      newTargetPath: "Archive/New.md"
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      sourceEntryId: "source",
      expectedRevision: 7,
      oldTargetPath: "Notes/Old.md",
      newTargetPath: "Archive/New.md"
    });
    expect(plans[0].patches).toHaveLength(4);
    expect(applyInternalLinkRewritePlan(plans[0], source, 7)).toEqual({
      status: "applied",
      markdown: `[[New]]
[[New|표시 이름]]
![[New#Heading|미리보기]]
[[New#^block-id]]

\`[[Notes/Old]]\`

\`\`\`md
[[Notes/Old]]
\`\`\`
`,
      nextRevision: 8,
      appliedPatchCount: 4
    });
  });

  it("uses the full vault path when the renamed basename would be ambiguous", () => {
    const entries = [
      markdownEntry("source", "Inbox/Source.md", "[[Notes/Old]]"),
      markdownEntry("target", "Notes/Old.md", ""),
      markdownEntry("duplicate", "Other/New.md", "")
    ];

    expect(applyOnlyPlan(entries, "target", "Archive/New.md")).toBe("[[Archive/New]]");
  });

  it("rewrites relative Markdown links, URL-encodes paths, and preserves fragments and titles", () => {
    const source = `[문서](../Old%20Name.md#Heading "title")
[블록](<../Old Name.md#^block-id>)
[외부](https://example.com/Old%20Name.md#Heading)
\`[코드](../Old%20Name.md)\`
`;
    const entries = [
      markdownEntry("source", "Projects/Sub/Source.md", source, 3),
      markdownEntry("target", "Projects/Old Name.md", "")
    ];

    expect(applyOnlyPlan(entries, "target", "Archive/New Name.md")).toBe(
      `[문서](../../Archive/New%20Name.md#Heading "title")
[블록](<../../Archive/New%20Name.md#^block-id>)
[외부](https://example.com/Old%20Name.md#Heading)
\`[코드](../Old%20Name.md)\`
`
    );
  });

  it("keeps alias-only links valid while rewriting path links and retaining their display alias", () => {
    const entries = [
      markdownEntry("source", "Source.md", "[[Reference]] [[Old|Reference display]]"),
      markdownEntry("target", "Old.md", "---\naliases: [Reference]\n---")
    ];

    const plans = planIncomingInternalLinkRewrites({
      entries,
      targetEntryId: "target",
      newTargetPath: "New.md"
    });

    expect(plans[0].patches).toEqual([
      expect.objectContaining({ before: "[[Old|Reference display]]", after: "[[New|Reference display]]" })
    ]);
    expect(applyOnlyPlan(entries, "target", "New.md")).toBe(
      "[[Reference]] [[New|Reference display]]"
    );
  });

  it("uses the renamed path as the base for explicit self links but leaves fragment-only links alone", () => {
    const target = markdownEntry(
      "target",
      "Old.md",
      "[[#Heading]] [[Old#Heading]] [self](Old.md#Heading)",
      11
    );

    const plans = planIncomingInternalLinkRewrites({
      entries: [target],
      targetEntryId: "target",
      newTargetPath: "Folder/New.md"
    });
    expect(plans[0].rewrittenSourcePath).toBe("Folder/New.md");
    expect(applyOnlyPlan([target], "target", "Folder/New.md")).toBe(
      "[[#Heading]] [[New#Heading]] [self](New.md#Heading)"
    );
  });

  it("reports revision and content conflicts without partially applying a plan", () => {
    const entries = [
      markdownEntry("source", "Source.md", "before [[Old]] after", 4),
      markdownEntry("target", "Old.md", "")
    ];
    const [plan] = planIncomingInternalLinkRewrites({
      entries,
      targetEntryId: "target",
      newTargetPath: "New.md"
    });

    expect(applyInternalLinkRewritePlan(plan, entries[0].content ?? "", 5)).toEqual({
      status: "conflict",
      reason: "revision-mismatch",
      expectedRevision: 4,
      actualRevision: 5
    });
    expect(applyInternalLinkRewritePlan(plan, "before [[Changed]] after", 4)).toEqual({
      status: "conflict",
      reason: "content-mismatch",
      expectedRevision: 4,
      actualRevision: 4
    });
  });

  it("rejects a missing, empty, or duplicate rename target before creating patches", () => {
    const entries = [
      markdownEntry("source", "Source.md", "[[Old]]"),
      markdownEntry("target", "Old.md", ""),
      markdownEntry("other", "Folder/New.md", "")
    ];

    expect(() => planIncomingInternalLinkRewrites({
      entries,
      targetEntryId: "missing",
      newTargetPath: "New.md"
    })).toThrow("missing target entry");
    expect(() => planIncomingInternalLinkRewrites({
      entries,
      targetEntryId: "target",
      newTargetPath: "/"
    })).toThrow("empty target path");
    expect(() => planIncomingInternalLinkRewrites({
      entries,
      targetEntryId: "target",
      newTargetPath: "folder/new.md"
    })).toThrow("duplicate target path");
  });
});
