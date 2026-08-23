import { describe, expect, it } from "vitest";
import {
  applyInternalLinkRewritePlan,
  planInternalLinkRewritesForPathChanges,
  planIncomingInternalLinkRewrites
} from "./linkRewrite";
import type {
  RevisionedVaultIndexEntry,
  VaultEntryPathChange
} from "./linkRewrite";

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

function applyBatchPlans(
  entries: readonly RevisionedVaultIndexEntry[],
  pathChanges: readonly VaultEntryPathChange[]
): Map<string, string> {
  const plans = planInternalLinkRewritesForPathChanges({ entries, pathChanges });
  return new Map(plans.map((plan) => {
    const source = entries.find((entry) => entry.id === plan.sourceEntryId);
    if (!source) {
      throw new Error("test source missing");
    }
    const result = applyInternalLinkRewritePlan(
      plan,
      source.content ?? "",
      source.revision
    );
    expect(result.status).toBe("applied");
    return [
      source.id,
      result.status === "applied" ? result.markdown : source.content ?? ""
    ];
  }));
}

describe("batch internal-link rewrite planning", () => {
  it("rewrites relative Markdown links when only their source path moves", () => {
    const entries = [
      markdownEntry(
        "source",
        "Folder/Sub/Source.md",
        `[target](../Target.md#Heading "title")`,
        9
      ),
      markdownEntry("target", "Folder/Target.md", "# Heading")
    ];
    const pathChanges = [{
      entryId: "source",
      oldPath: "Folder/Sub/Source.md",
      newPath: "Archive/Source.md"
    }];

    const plans = planInternalLinkRewritesForPathChanges({ entries, pathChanges });
    expect(plans).toEqual([
      expect.objectContaining({
        sourceEntryId: "source",
        sourcePath: "Folder/Sub/Source.md",
        rewrittenSourcePath: "Archive/Source.md",
        expectedRevision: 9
      })
    ]);
    expect(applyBatchPlans(entries, pathChanges).get("source")).toBe(
      `[target](../Folder/Target.md#Heading "title")`
    );
  });

  it("handles a folder subtree atomically, preserving valid cross-links and grouping incoming patches", () => {
    const entries = [
      markdownEntry(
        "a",
        "Folder/Sub/A.md",
        "[B](./B.md) [outside](../../Outside.md)"
      ),
      markdownEntry("b", "Folder/Sub/B.md", "[A](./A.md)"),
      markdownEntry(
        "outside",
        "Outside.md",
        "[[Folder/Sub/A#Top]] ![[Folder/Sub/B#^quote]]",
        4
      )
    ];
    const pathChanges = [
      {
        entryId: "a",
        oldPath: "Folder/Sub/A.md",
        newPath: "Archive/Deep/Sub/A.md"
      },
      {
        entryId: "b",
        oldPath: "Folder/Sub/B.md",
        newPath: "Archive/Deep/Sub/B.md"
      }
    ];

    const plans = planInternalLinkRewritesForPathChanges({ entries, pathChanges });
    expect(plans.map((plan) => plan.sourceEntryId)).toEqual(["a", "outside"]);
    expect(plans.find((plan) => plan.sourceEntryId === "outside")?.patches).toHaveLength(2);

    const rewritten = applyBatchPlans(entries, pathChanges);
    expect(rewritten.get("a")).toBe("[B](./B.md) [outside](../../../Outside.md)");
    expect(rewritten.has("b")).toBe(false);
    expect(rewritten.get("outside")).toBe("[[A#Top]] ![[B#^quote]]");
  });

  it("does not churn shortest wikilinks or relative links that still resolve after a joint move", () => {
    const entries = [
      markdownEntry("source", "Folder/Source.md", "[[Target]] [target](./Target.md)"),
      markdownEntry("target", "Folder/Target.md", "")
    ];

    expect(planInternalLinkRewritesForPathChanges({
      entries,
      pathChanges: [
        { entryId: "source", oldPath: "Folder/Source.md", newPath: "Archive/Source.md" },
        { entryId: "target", oldPath: "Folder/Target.md", newPath: "Archive/Target.md" }
      ]
    })).toEqual([]);
  });

  it("uses a full path when duplicate basenames make the shortest wikilink ambiguous", () => {
    const entries = [
      markdownEntry("source", "Source.md", "[[One/Note#Heading]]"),
      markdownEntry("target", "One/Note.md", "# Heading"),
      markdownEntry("duplicate-name", "Two/Note.md", "")
    ];
    const pathChanges = [{
      entryId: "target",
      oldPath: "One/Note.md",
      newPath: "Three/Note.md"
    }];

    expect(applyBatchPlans(entries, pathChanges).get("source")).toBe(
      "[[Three/Note#Heading]]"
    );
  });

  it("rewrites explicit self links while preserving fragment-only, heading, block, and embed syntax", () => {
    const entries = [markdownEntry(
      "self",
      "Old.md",
      "[[Old#Heading]] [[#Heading]] ![[Old#^block-id]] [self](Old.md#Heading)",
      12
    )];
    const pathChanges = [{
      entryId: "self",
      oldPath: "Old.md",
      newPath: "Folder/New.md"
    }];

    expect(applyBatchPlans(entries, pathChanges).get("self")).toBe(
      "[[New#Heading]] [[#Heading]] ![[New#^block-id]] [self](New.md#Heading)"
    );
  });

  it("preserves aliases, fragments, embeds, Markdown titles, and ignored code", () => {
    const source = `![[Docs/Old#Heading|preview]]
[[Docs/Old#^block-id|block]]
![image](../Docs/Old.md#Heading "title")
\`[[Docs/Old]]\`
`;
    const entries = [
      markdownEntry("source", "Inbox/Source.md", source),
      markdownEntry("target", "Docs/Old.md", "")
    ];
    const pathChanges = [{
      entryId: "target",
      oldPath: "Docs/Old.md",
      newPath: "Archive/New.md"
    }];

    expect(applyBatchPlans(entries, pathChanges).get("source")).toBe(
      `![[New#Heading|preview]]
[[New#^block-id|block]]
![image](../Archive/New.md#Heading "title")
\`[[Docs/Old]]\`
`
    );
  });

  it("rejects duplicate current/resulting paths, repeated changes, and stale old paths", () => {
    const normalEntries = [
      markdownEntry("a", "A.md", "[[B]]"),
      markdownEntry("b", "B.md", "")
    ];

    expect(() => planInternalLinkRewritesForPathChanges({
      entries: [
        markdownEntry("a", "Same.md", ""),
        markdownEntry("b", "same.md", "")
      ],
      pathChanges: [{ entryId: "a", oldPath: "Same.md", newPath: "New.md" }]
    })).toThrow("current vault contains a duplicate path");
    expect(() => planInternalLinkRewritesForPathChanges({
      entries: normalEntries,
      pathChanges: [{ entryId: "a", oldPath: "A.md", newPath: "b.md" }]
    })).toThrow("resulting vault contains a duplicate path");
    expect(() => planInternalLinkRewritesForPathChanges({
      entries: normalEntries,
      pathChanges: [
        { entryId: "a", oldPath: "A.md", newPath: "C.md" },
        { entryId: "a", oldPath: "A.md", newPath: "D.md" }
      ]
    })).toThrow("duplicate path changes");
    expect(() => planInternalLinkRewritesForPathChanges({
      entries: normalEntries,
      pathChanges: [{ entryId: "a", oldPath: "Stale.md", newPath: "C.md" }]
    })).toThrow("path change is stale");
  });
});
