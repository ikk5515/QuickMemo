import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_GRAPH_SETTINGS,
  DEFAULT_LOCAL_GRAPH_SETTINGS,
  MAX_ALIASES_PER_ENTRY,
  MAX_BLOCK_REFERENCES_PER_ENTRY,
  MAX_CANVAS_NODES_PER_ENTRY,
  MAX_CANVAS_TEXT_CHARACTERS_PER_NODE,
  MAX_FRONTMATTER_PROPERTIES_PER_ENTRY,
  MAX_FRONTMATTER_SCALAR_CHARACTERS,
  MAX_HEADINGS_PER_ENTRY,
  MAX_HEADING_TEXT_CHARACTERS,
  MAX_INTERNAL_LINK_CONTEXT_CHARACTERS,
  MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY,
  MAX_INTERNAL_LINK_OCCURRENCES_PER_INDEX,
  MAX_INTERNAL_LINK_SYNTAX_CHARACTERS,
  MAX_TAG_CHARACTERS,
  MAX_TAG_OCCURRENCES_PER_ENTRY,
  MAX_TAG_OCCURRENCES_PER_INDEX,
  backlinkOccurrences,
  buildGraphSnapshot,
  buildKnowledgeIndex,
  matchesVaultSearchQuery,
  outgoingOccurrences,
  parseObsidianMarkdown,
  parseVaultSearchQuery
} from "./index";
import type { GraphViewSettings, VaultIndexEntry } from "./types";

function markdownEntry(id: string, path: string, content: string, createdAt?: number): VaultIndexEntry {
  return { id, path, kind: "markdown", content, createdAt };
}

function globalSettings(
  overrides: Partial<Extract<GraphViewSettings, { scope: "global" }>> = {}
): Extract<GraphViewSettings, { scope: "global" }> {
  return {
    ...DEFAULT_GLOBAL_GRAPH_SETTINGS,
    ...overrides,
    scope: "global",
    common: {
      ...DEFAULT_GLOBAL_GRAPH_SETTINGS.common,
      ...overrides.common
    }
  };
}

function localSettings(
  overrides: Partial<Extract<GraphViewSettings, { scope: "local" }>> = {}
): Extract<GraphViewSettings, { scope: "local" }> {
  return {
    ...DEFAULT_LOCAL_GRAPH_SETTINGS,
    ...overrides,
    scope: "local",
    common: {
      ...DEFAULT_LOCAL_GRAPH_SETTINGS.common,
      ...overrides.common
    }
  };
}

describe("Obsidian-style Markdown metadata", () => {
  it("parses frontmatter aliases, properties, links, headings, blocks, and nested tags", () => {
    const metadata = parseObsidianMarkdown(
      "source",
      "Projects/QuickMemo.md",
      `---
aliases:
  - QM
  - "Quick Memo"
tags: [project/QuickMemo, "#개인"]
status: active
priority: 2
published: true
related: "[[Reference]]"
---
# 나만의 언어
본문 #Work/Ideas 와 #work/ideas ^main-block

보조 제목
---
`
    );

    expect(metadata.aliases).toEqual(["QM", "Quick Memo"]);
    expect(metadata.properties).toMatchObject({ status: "active", priority: 2, published: true });
    expect(metadata.tags).toEqual(["project/QuickMemo", "개인", "Work/Ideas"]);
    expect(metadata.headings).toEqual([
      { level: 1, text: "나만의 언어", line: 11, slug: "나만의-언어" },
      { level: 2, text: "보조 제목", line: 14, slug: "보조-제목" }
    ]);
    expect(metadata.blocks).toEqual([{ id: "main-block", line: 12 }]);
    expect(metadata.links).toEqual([
      expect.objectContaining({ target: "Reference", syntax: "wikilink", line: 9 })
    ]);
  });

  it("ignores tags and links in fenced code, inline code, and Obsidian comments", () => {
    const metadata = parseObsidianMarkdown(
      "source",
      "Source.md",
      `#visible

\`#inline [[Inline]]\`

\`\`\`md
#fenced [[Fenced]]
\`\`\`

%% #comment [[Comment]] %%
[[Actual#Heading|표시]] ![[Asset.png]] [relative](Folder/Note.md#^block)
[external](https://example.com/#not-a-tag)
`
    );

    expect(metadata.tags).toEqual(["visible"]);
    expect(metadata.links).toEqual([
      expect.objectContaining({ target: "Actual", fragment: { kind: "heading", value: "Heading" } }),
      expect.objectContaining({ target: "Asset.png", embedded: true }),
      expect.objectContaining({
        target: "Folder/Note.md",
        syntax: "markdown",
        fragment: { kind: "block", value: "block" }
      })
    ]);
  });

  it("bounds link context around the occurrence instead of cloning an entire malicious line", () => {
    const source = `${"before ".repeat(1_000)}[[Target]]${" after".repeat(1_000)}`;
    const metadata = parseObsidianMarkdown("source", "Source.md", source);

    expect(metadata.links).toHaveLength(1);
    expect(metadata.links[0].context.length).toBeLessThanOrEqual(
      MAX_INTERNAL_LINK_CONTEXT_CHARACTERS
    );
    expect(metadata.links[0].context).toContain("[[Target]]");
    expect(metadata.links[0].context.length).toBeLessThan(source.length);
  });

  it("deterministically truncates excessive occurrences within one entry", () => {
    const source = "[[Target]] ".repeat(MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY + 250);
    const metadata = parseObsidianMarkdown("source", "Source.md", source);

    expect(metadata.links).toHaveLength(MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY);
    expect(metadata.links.at(-1)?.column).toBe(
      (MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY - 1) * "[[Target]] ".length + 1
    );
  });

  it("deduplicates and bounds 50k unique tags in linear time", () => {
    const source = `---\ntags: [${Array.from(
      { length: 50_000 },
      (_, index) => `tag-${index}`
    ).join(",")}]\n---\n`;
    const startedAt = performance.now();
    const metadata = parseObsidianMarkdown("source", "Source.md", source);
    const elapsed = performance.now() - startedAt;

    expect(metadata.tags).toHaveLength(MAX_TAG_OCCURRENCES_PER_ENTRY);
    expect(metadata.tags.at(-1)).toBe(`tag-${MAX_TAG_OCCURRENCES_PER_ENTRY - 1}`);
    expect(elapsed).toBeLessThan(2_000);
  }, 10_000);

  it("bounds frontmatter properties, aliases, and scalar text before indexing", () => {
    const properties = Array.from(
      { length: MAX_FRONTMATTER_PROPERTIES_PER_ENTRY + 50 },
      (_, index) => `property_${index}: ${index}`
    ).join("\n");
    const aliases = Array.from(
      { length: MAX_ALIASES_PER_ENTRY + 50 },
      (_, index) => `alias-${index}`
    ).join(",");
    const oversizedScalar = "x".repeat(MAX_FRONTMATTER_SCALAR_CHARACTERS + 500);
    const metadata = parseObsidianMarkdown(
      "source",
      "Source.md",
      `---\naliases: [${aliases}]\nsummary: ${oversizedScalar}\n${properties}\n---\n`
    );

    expect(metadata.aliases).toHaveLength(MAX_ALIASES_PER_ENTRY);
    expect(Object.keys(metadata.properties)).toHaveLength(
      MAX_FRONTMATTER_PROPERTIES_PER_ENTRY
    );
    expect(metadata.properties.summary).toBe(oversizedScalar.slice(
      0,
      MAX_FRONTMATTER_SCALAR_CHARACTERS
    ));
  });

  it("ignores overlong tags and link syntax while keeping bounded valid metadata", () => {
    const validHeading = "제목".repeat(MAX_HEADING_TEXT_CHARACTERS);
    const overlongTag = `#a${"b".repeat(MAX_TAG_CHARACTERS)}`;
    const overlongLink = `[[${"x".repeat(MAX_INTERNAL_LINK_SYNTAX_CHARACTERS)}]]`;
    const metadata = parseObsidianMarkdown(
      "source",
      "Source.md",
      `${overlongTag}\n${overlongLink}\n# ${validHeading}\n[[Valid]]`
    );

    expect(metadata.tags).toEqual([]);
    expect(metadata.links).toEqual([
      expect.objectContaining({ target: "Valid", raw: "[[Valid]]" })
    ]);
    expect(metadata.headings[0]?.text).toHaveLength(MAX_HEADING_TEXT_CHARACTERS);
  });

  it("caps heading and block-reference collections for pathological notes", () => {
    const lineCount = Math.max(MAX_HEADINGS_PER_ENTRY, MAX_BLOCK_REFERENCES_PER_ENTRY) + 20;
    const metadata = parseObsidianMarkdown(
      "source",
      "Source.md",
      Array.from({ length: lineCount }, (_, index) => `# Heading ${index} ^block-${index}`).join("\n")
    );

    expect(metadata.headings).toHaveLength(MAX_HEADINGS_PER_ENTRY);
    expect(metadata.blocks).toHaveLength(MAX_BLOCK_REFERENCES_PER_ENTRY);
  });
});

describe("knowledge index and resolution", () => {
  it("resolves exact, relative, alias and self-heading links while retaining unresolved occurrences", () => {
    const index = buildKnowledgeIndex([
      markdownEntry(
        "source",
        "Projects/Source.md",
        "[[Projects/Target#Heading]] [relative](./Target.md) [[Home Alias]] [[#Local]] [[Missing]]"
      ),
      markdownEntry("target", "Projects/Target.md", "---\naliases: [Home Alias]\n---\n# Heading"),
      markdownEntry("duplicate", "Archive/Target.md", "")
    ]);
    const outgoing = outgoingOccurrences(index, "source");

    expect(outgoing.map((link) => [link.status, link.targetEntryId])).toEqual([
      ["resolved", "target"],
      ["resolved", "target"],
      ["resolved", "target"],
      ["resolved", "source"],
      ["unresolved", undefined]
    ]);
    expect(backlinkOccurrences(index, "target")).toHaveLength(3);
    expect(outgoing[4].unresolvedKey).toBe("Missing");
  });

  it("marks a shortest-name link ambiguous when neither path nor alias selects one file", () => {
    const index = buildKnowledgeIndex([
      markdownEntry("source", "Source.md", "[[Target]]"),
      markdownEntry("one", "One/Target.md", ""),
      markdownEntry("two", "Two/Target.md", "")
    ]);

    expect(outgoingOccurrences(index, "source")[0]).toMatchObject({
      status: "ambiguous",
      candidateEntryIds: ["one", "two"]
    });
  });

  it("prefers a same-folder shortest name and resolves explicit parent-relative Markdown paths", () => {
    const index = buildKnowledgeIndex([
      markdownEntry("source", "Folder/Source.md", "[[Target]] [root](../Root.md)"),
      markdownEntry("near", "Folder/Target.md", ""),
      markdownEntry("far", "Elsewhere/Target.md", ""),
      markdownEntry("root", "Root.md", "")
    ]);

    expect(outgoingOccurrences(index, "source").map((link) => link.targetEntryId)).toEqual(["near", "root"]);
  });

  it("indexes a real nested tag once per file and preserves its first casing", () => {
    const index = buildKnowledgeIndex([
      markdownEntry("one", "One.md", "#Project/QuickMemo #project/quickmemo"),
      markdownEntry("two", "Two.md", "---\ntags: [PROJECT/QUICKMEMO]\n---")
    ]);

    expect(index.tags.get("project/quickmemo")).toEqual({
      key: "project/quickmemo",
      displayName: "Project/QuickMemo",
      entryIds: ["one", "two"],
      count: 2,
      parentKeys: ["project"]
    });
  });

  it("includes Canvas file cards and text-node links in outgoing/backlink data", () => {
    const index = buildKnowledgeIndex([
      {
        id: "canvas",
        path: "Research.canvas",
        kind: "canvas",
        content: JSON.stringify({
          nodes: [
            { id: "file", type: "file", file: "Notes/Source.md" },
            { id: "text", type: "text", text: "[[Notes/Other]] #canvas" }
          ],
          edges: []
        })
      },
      markdownEntry("source", "Notes/Source.md", ""),
      markdownEntry("other", "Notes/Other.md", "")
    ]);

    expect(outgoingOccurrences(index, "canvas").map((link) => link.targetEntryId).sort()).toEqual([
      "other",
      "source"
    ]);
    expect(backlinkOccurrences(index, "source")).toHaveLength(1);
    expect(index.tags.get("canvas")?.entryIds).toEqual(["canvas"]);
  });

  it("bounds Canvas node and text indexing without changing the Canvas payload", () => {
    const canvas = {
      id: "bounded-canvas",
      path: "Bounded.canvas",
      kind: "canvas" as const,
      content: JSON.stringify({
        nodes: [
          {
            id: "bounded-text",
            type: "text",
            text: `[[Visible]]${"x".repeat(MAX_CANVAS_TEXT_CHARACTERS_PER_NODE)}[[HiddenByTextBudget]]`
          },
          ...Array.from({ length: MAX_CANVAS_NODES_PER_ENTRY - 1 }, (_, index) => ({
            id: `ignored-shape-${index}`,
            type: "group"
          })),
          { id: "beyond-node-budget", type: "file", file: "HiddenByNodeBudget.md" }
        ]
      })
    };
    const index = buildKnowledgeIndex([
      canvas,
      markdownEntry("visible", "Visible.md", ""),
      markdownEntry("hidden-text", "HiddenByTextBudget.md", ""),
      markdownEntry("hidden-node", "HiddenByNodeBudget.md", "")
    ]);

    expect(outgoingOccurrences(index, canvas.id).map((link) => link.targetEntryId)).toEqual([
      "visible"
    ]);
    expect(canvas.content).toContain("HiddenByNodeBudget.md");
  });

  it("enforces a deterministic vault-wide occurrence budget before backlink resolution", () => {
    const linksPerEntry = MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY;
    const fullEntries = Math.floor(MAX_INTERNAL_LINK_OCCURRENCES_PER_INDEX / linksPerEntry);
    const sources = Array.from({ length: fullEntries + 1 }, (_, index) => markdownEntry(
      `source-${index}`,
      `Source-${index}.md`,
      "[[Target]] ".repeat(linksPerEntry)
    ));
    const index = buildKnowledgeIndex([
      ...sources,
      markdownEntry("target", "Target.md", "")
    ]);
    const totalOutgoing = sources.reduce(
      (total, source) => total + outgoingOccurrences(index, source.id).length,
      0
    );

    expect(totalOutgoing).toBe(MAX_INTERNAL_LINK_OCCURRENCES_PER_INDEX);
    expect(outgoingOccurrences(index, sources.at(-1)?.id ?? "")).toHaveLength(0);
    expect(backlinkOccurrences(index, "target")).toHaveLength(
      MAX_INTERNAL_LINK_OCCURRENCES_PER_INDEX
    );
  });

  it("shares one entry tag budget across Canvas text nodes", () => {
    const tagsPerNode = Math.floor(MAX_TAG_OCCURRENCES_PER_ENTRY * 0.75);
    const canvas = {
      id: "canvas-tags",
      path: "Tags.canvas",
      kind: "canvas" as const,
      content: JSON.stringify({
        nodes: [0, 1].map((nodeIndex) => ({
          id: `node-${nodeIndex}`,
          type: "text",
          text: Array.from(
            { length: tagsPerNode },
            (_, tagIndex) => `#canvas-${nodeIndex}-${tagIndex}`
          ).join(" ")
        })),
        edges: []
      })
    };
    const index = buildKnowledgeIndex([canvas]);

    expect(index.metadataByEntryId.get(canvas.id)?.tags).toHaveLength(
      MAX_TAG_OCCURRENCES_PER_ENTRY
    );
  });

  it("enforces a deterministic vault-wide tag occurrence budget", () => {
    const tagsPerEntry = MAX_TAG_OCCURRENCES_PER_ENTRY;
    const fullEntries = Math.floor(MAX_TAG_OCCURRENCES_PER_INDEX / tagsPerEntry);
    const entries = Array.from({ length: fullEntries + 1 }, (_, entryIndex) => markdownEntry(
      `tag-source-${entryIndex}`,
      `Tag-Source-${entryIndex}.md`,
      Array.from(
        { length: tagsPerEntry },
        (_, tagIndex) => `#tag-${entryIndex}-${tagIndex}`
      ).join(" ")
    ));
    const index = buildKnowledgeIndex(entries);
    const totalTags = entries.reduce(
      (total, entry) => total + (index.metadataByEntryId.get(entry.id)?.tags.length ?? 0),
      0
    );

    expect(totalTags).toBe(MAX_TAG_OCCURRENCES_PER_INDEX);
    expect(index.metadataByEntryId.get(entries.at(-1)?.id ?? "")?.tags).toHaveLength(0);
    expect(index.tags).toHaveLength(MAX_TAG_OCCURRENCES_PER_INDEX);
  });
});

describe("shared search query", () => {
  it("supports AND, OR, negation, parent-tag matching, fields, properties and regex", () => {
    const entry = markdownEntry(
      "one",
      "Projects/QuickMemo.md",
      "---\nstatus: active\ntags: [project/quickmemo]\n---\nimportant todo"
    );
    const metadata = parseObsidianMarkdown(entry.id, entry.path, entry.content ?? "");

    expect(matchesVaultSearchQuery("tag:#project [status:active]", entry, metadata)).toBe(true);
    expect(matchesVaultSearchQuery("path:Archive OR content:/important/i", entry, metadata)).toBe(true);
    expect(matchesVaultSearchQuery("tag:#project -content:done", entry, metadata)).toBe(true);
    expect(matchesVaultSearchQuery(parseVaultSearchQuery("file:Other OR (tag:#project content:todo)"), entry, metadata)).toBe(true);
  });
});

describe("graph snapshots", () => {
  it("collapses duplicate links for topology while preserving occurrence count and backlinks", () => {
    const index = buildKnowledgeIndex([
      markdownEntry("source", "Source.md", "[[Target]] then [[Target#Details]]"),
      markdownEntry("target", "Target.md", "")
    ]);
    const snapshot = buildGraphSnapshot(index, globalSettings());
    const edge = snapshot.edges.find((candidate) => candidate.kind === "internal-link");

    expect(backlinkOccurrences(index, "target")).toHaveLength(2);
    expect(edge).toMatchObject({
      source: "entry:source",
      target: "entry:target",
      occurrenceCount: 2,
      occurrenceLines: [1, 1]
    });
    expect(snapshot.nodes.find((node) => node.id === "entry:target")?.incomingReferenceCount).toBe(1);
  });

  it("coalesces unresolved targets case-insensitively across source files", () => {
    const index = buildKnowledgeIndex([
      markdownEntry("one", "One.md", "[[Missing]]"),
      markdownEntry("two", "Two.md", "[[missing]]")
    ]);
    const snapshot = buildGraphSnapshot(index, globalSettings());
    const missingNodes = snapshot.nodes.filter((node) => node.kind === "unresolved");

    expect(missingNodes).toEqual([
      expect.objectContaining({ id: "unresolved:missing", incomingReferenceCount: 2 })
    ]);
    expect(snapshot.edges.filter((edge) => edge.target === "unresolved:missing")).toHaveLength(2);
  });

  it("applies query, attachment, missing-target, orphan, tag and first-matching group settings", () => {
    const index = buildKnowledgeIndex([
      markdownEntry("alpha", "Projects/Alpha.md", "[[Projects/Beta]] [[Missing]] #work"),
      markdownEntry("beta", "Projects/Beta.md", ""),
      markdownEntry("orphan", "Projects/Orphan.md", ""),
      { id: "asset", path: "Projects/Image.png", kind: "asset" }
    ]);
    const snapshot = buildGraphSnapshot(index, globalSettings({
      showOrphans: false,
      common: {
        ...DEFAULT_GLOBAL_GRAPH_SETTINGS.common,
        showTags: true,
        groups: [
          { id: "later", query: "path:Projects", color: "blue", order: 2 },
          { id: "first", query: "file:Alpha", color: "red", order: 1 }
        ]
      }
    }));

    expect(snapshot.nodes.map((node) => node.id)).toEqual([
      "entry:alpha",
      "entry:beta",
      "tag:work",
      "unresolved:missing"
    ]);
    expect(snapshot.nodes.find((node) => node.id === "entry:alpha")).toMatchObject({
      groupId: "first",
      color: "red"
    });
    expect(snapshot.nodes.find((node) => node.id === "entry:beta")?.groupId).toBe("later");

    const existingOnly = buildGraphSnapshot(index, globalSettings({
      common: { ...DEFAULT_GLOBAL_GRAPH_SETTINGS.common, existingFilesOnly: true }
    }));
    expect(existingOnly.nodes.some((node) => node.kind === "unresolved")).toBe(false);

    const filtered = buildGraphSnapshot(index, globalSettings({
      common: { ...DEFAULT_GLOBAL_GRAPH_SETTINGS.common, query: "file:Alpha" }
    }));
    expect(filtered.nodes.map((node) => node.id)).toEqual(["entry:alpha"]);
  });

  it("uses outgoing local depth and includes cross-neighbor links only when requested", () => {
    const index = buildKnowledgeIndex([
      markdownEntry("a", "A.md", "[[B]]"),
      markdownEntry("b", "B.md", "[[C]]"),
      markdownEntry("c", "C.md", "[[A]]")
    ]);
    const depthOne = buildGraphSnapshot(index, localSettings({
      root: { entryId: "a" },
      depth: 1,
      incoming: false,
      outgoing: true
    }));
    expect(depthOne.nodes.map((node) => node.id)).toEqual(["entry:a", "entry:b"]);
    expect(depthOne.edges.map((edge) => edge.id)).toEqual(["link:entry:a->entry:b"]);

    const depthTwo = buildGraphSnapshot(index, localSettings({
      root: { entryId: "a" },
      depth: 2,
      incoming: false,
      outgoing: true,
      neighborLinks: false
    }));
    expect(depthTwo.nodes.map((node) => node.id)).toEqual(["entry:a", "entry:b", "entry:c"]);
    expect(depthTwo.edges.map((edge) => edge.id)).toEqual([
      "link:entry:a->entry:b",
      "link:entry:b->entry:c"
    ]);

    const withNeighbors = buildGraphSnapshot(index, localSettings({
      root: { entryId: "a" },
      depth: 2,
      incoming: false,
      outgoing: true,
      neighborLinks: true
    }));
    expect(withNeighbors.edges.map((edge) => edge.id)).toEqual([
      "link:entry:a->entry:b",
      "link:entry:b->entry:c",
      "link:entry:c->entry:a"
    ]);

    const incomingOnly = buildGraphSnapshot(index, localSettings({
      root: { entryId: "a" },
      depth: 1,
      incoming: true,
      outgoing: false
    }));
    expect(incomingOnly.nodes.map((node) => node.id)).toEqual(["entry:a", "entry:c"]);
    expect(incomingOnly.edges.map((edge) => edge.id)).toEqual(["link:entry:c->entry:a"]);
  });
});
