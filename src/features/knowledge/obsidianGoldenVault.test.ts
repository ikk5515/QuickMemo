import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_GRAPH_SETTINGS,
  DEFAULT_LOCAL_GRAPH_SETTINGS,
  backlinkOccurrences,
  buildGraphSnapshot,
  buildKnowledgeIndex,
  matchesVaultSearchQuery,
  outgoingOccurrences,
  parseObsidianMarkdown
} from "./index";
import {
  LOCAL_OBSIDIAN_CONTRACT_COUNTS,
  LOCAL_OBSIDIAN_CONTRACT_IDS,
  LOCAL_OBSIDIAN_CONTRACT_VAULT
} from "./obsidianGoldenVault.fixture";
import type { GraphEdge, GraphViewSettings } from "./types";

function globalSettings(
  common: Partial<Extract<GraphViewSettings, { scope: "global" }>["common"]> = {},
  view: Partial<Omit<Extract<GraphViewSettings, { scope: "global" }>, "common" | "scope">> = {}
): Extract<GraphViewSettings, { scope: "global" }> {
  return {
    ...DEFAULT_GLOBAL_GRAPH_SETTINGS,
    ...view,
    scope: "global",
    common: { ...DEFAULT_GLOBAL_GRAPH_SETTINGS.common, ...common }
  };
}

function localSettings(
  view: Partial<Extract<GraphViewSettings, { scope: "local" }>> = {}
): Extract<GraphViewSettings, { scope: "local" }> {
  return {
    ...DEFAULT_LOCAL_GRAPH_SETTINGS,
    ...view,
    scope: "local",
    common: { ...DEFAULT_LOCAL_GRAPH_SETTINGS.common, ...view.common }
  };
}

function nodeIds(snapshot: ReturnType<typeof buildGraphSnapshot>): string[] {
  return snapshot.nodes.map((node) => node.id);
}

function edgeIds(snapshot: ReturnType<typeof buildGraphSnapshot>): string[] {
  return snapshot.edges.map((edge) => edge.id);
}

function edge(
  snapshot: ReturnType<typeof buildGraphSnapshot>,
  source: string,
  target: string
): GraphEdge | undefined {
  return snapshot.edges.find((candidate) => (
    candidate.source === source && candidate.target === target
  ));
}

function representedOccurrences(snapshot: ReturnType<typeof buildGraphSnapshot>): number {
  return snapshot.edges
    .filter((candidate) => candidate.kind === "internal-link")
    .reduce((total, candidate) => total + candidate.occurrenceCount, 0);
}

describe("QuickMemo local Obsidian-style knowledge contract fixture", () => {
  const index = buildKnowledgeIndex(LOCAL_OBSIDIAN_CONTRACT_VAULT);

  const matchingEntryIds = (query: string) => index.entries
    .filter((entry) => matchesVaultSearchQuery(
      query,
      entry,
      index.metadataByEntryId.get(entry.id) ?? {
        aliases: [],
        properties: {},
        tags: []
      }
    ))
    .map((entry) => entry.id)
    .sort();

  it("pins the complete entry, occurrence, resolution, tag and topology totals", () => {
    const occurrences = [...index.outgoingByEntryId.values()].flat();
    const defaultGlobal = buildGraphSnapshot(index, globalSettings());
    const withAttachments = buildGraphSnapshot(
      index,
      globalSettings({ showAttachments: true })
    );
    const withTags = buildGraphSnapshot(index, globalSettings({ showTags: true }));

    expect(index.entries).toHaveLength(LOCAL_OBSIDIAN_CONTRACT_COUNTS.vaultEntries);
    expect(index.entries.filter((entry) => entry.kind === "markdown")).toHaveLength(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.markdownEntries
    );
    expect(index.entries.filter((entry) => entry.kind === "canvas")).toHaveLength(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.canvasEntries
    );
    expect(index.entries.filter((entry) => entry.kind === "asset")).toHaveLength(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.assetEntries
    );
    expect(occurrences).toHaveLength(LOCAL_OBSIDIAN_CONTRACT_COUNTS.linkOccurrences.total);
    expect(occurrences.filter((occurrence) => occurrence.status === "resolved")).toHaveLength(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.linkOccurrences.resolved
    );
    expect(occurrences.filter((occurrence) => occurrence.status === "ambiguous")).toHaveLength(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.linkOccurrences.ambiguous
    );
    expect(occurrences.filter((occurrence) => occurrence.status === "unresolved")).toHaveLength(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.linkOccurrences.unresolved
    );
    expect(index.tags).toHaveLength(LOCAL_OBSIDIAN_CONTRACT_COUNTS.tags.nodes);

    expect(defaultGlobal.nodes).toHaveLength(LOCAL_OBSIDIAN_CONTRACT_COUNTS.defaultGlobal.nodes);
    expect(defaultGlobal.edges).toHaveLength(LOCAL_OBSIDIAN_CONTRACT_COUNTS.defaultGlobal.edges);
    expect(representedOccurrences(defaultGlobal)).toBe(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.defaultGlobal.representedLinkOccurrences
    );
    expect(withAttachments.nodes).toHaveLength(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.withAttachments.nodes
    );
    expect(withAttachments.edges).toHaveLength(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.withAttachments.edges
    );
    expect(representedOccurrences(withAttachments)).toBe(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.withAttachments.representedLinkOccurrences
    );
    expect(withTags.nodes).toHaveLength(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.defaultGlobal.nodes
        + LOCAL_OBSIDIAN_CONTRACT_COUNTS.tags.nodes
    );
    expect(withTags.edges).toHaveLength(
      LOCAL_OBSIDIAN_CONTRACT_COUNTS.defaultGlobal.edges
        + LOCAL_OBSIDIAN_CONTRACT_COUNTS.tags.edges
    );
  });

  it("evaluates shared search fields, Boolean operators, properties, nested tags and regex", () => {
    expect(matchingEntryIds("path:Projects tag:#project [status:active]")).toEqual(["hub"]);
    expect(matchingEntryIds("tag:#project -path:Projects")).toEqual(["orphan"]);
    expect(matchingEntryIds("(file:Hub OR file:Orphan)")).toEqual(["hub", "orphan"]);
    expect(matchingEntryIds("file:/^Target\\.md$/")).toEqual([
      "archive-target",
      "research-target"
    ]);
    expect(matchingEntryIds("path:Depth -file:5")).toEqual([
      "depth-0",
      "depth-1",
      "depth-2",
      "depth-3",
      "depth-4"
    ]);
  });

  it("resolves file, heading, block, embed and relative links occurrence-by-occurrence", () => {
    const outgoing = outgoingOccurrences(index, "hub");

    expect(outgoing).toHaveLength(LOCAL_OBSIDIAN_CONTRACT_COUNTS.linkOccurrences.hub);
    expect(outgoing.filter((link) => link.targetEntryId === "research-target")).toHaveLength(5);
    expect(outgoing.find((link) => (
      link.targetEntryId === "research-target"
      && link.fragment?.kind === "heading"
      && link.embedded
    ))).toBeUndefined();
    expect(outgoing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        raw: "[[Research/Target#Section|target heading]]",
        targetEntryId: "research-target",
        fragment: { kind: "heading", value: "Section" },
        displayText: "target heading",
        embedded: false
      }),
      expect.objectContaining({
        raw: "![[Research/Target#^block-a]]",
        targetEntryId: "research-target",
        fragment: { kind: "block", value: "block-a" },
        embedded: true
      }),
      expect.objectContaining({
        raw: "[relative](../Research/Target.md#Section)",
        syntax: "markdown",
        targetEntryId: "research-target"
      }),
      expect.objectContaining({
        raw: "[[#Local Heading]]",
        targetEntryId: "hub",
        fragment: { kind: "heading", value: "Local Heading" }
      }),
      expect.objectContaining({ raw: "![[Assets/diagram.png]]", targetEntryId: "asset" }),
      expect.objectContaining({
        raw: "![[Assets/reference.pdf#page=1]]",
        targetEntryId: "asset-pdf",
        embedded: true
      }),
      expect.objectContaining({ raw: "[[Missing Note]]", status: "unresolved" })
    ]));
    expect(outgoing.some((link) => link.raw.includes("Ignored Inline"))).toBe(false);
    expect(outgoing.some((link) => link.raw.includes("Ignored Fenced"))).toBe(false);
    expect(outgoing.find((link) => link.raw === "[[Ignored Comment]]")).toMatchObject({
      status: "unresolved"
    });
    expect(outgoing.some((link) => link.raw.includes("example.com"))).toBe(false);
    expect(backlinkOccurrences(index, "research-target").filter((link) => link.sourceEntryId === "hub"))
      .toHaveLength(5);
  });

  it("uses the official shortest-path duplicate target and keeps aliases unresolved", () => {
    const outgoing = outgoingOccurrences(index, "hub");
    const duplicateName = outgoing.find((link) => link.raw === "[[Target]]");
    const aliasCollision = outgoing.find((link) => link.raw === "[[Shared Alias]]");
    const uniqueAlias = outgoing.find((link) => link.raw === "[[Unique Alias]]");

    expect(duplicateName).toMatchObject({
      status: "resolved",
      targetEntryId: "archive-target"
    });
    expect(aliasCollision).toMatchObject({ status: "unresolved" });
    expect(uniqueAlias).toMatchObject({ status: "unresolved" });
    expect(aliasCollision?.targetEntryId).toBeUndefined();
    expect([...(duplicateName?.candidateEntryIds ?? [])].sort()).toEqual([
      "archive-target",
      "research-target"
    ]);
    expect(aliasCollision?.candidateEntryIds).toEqual([]);
    expect(uniqueAlias?.candidateEntryIds).toEqual([]);
  });

  it("merges YAML and inline nested tags, preserves first casing, and ignores code", () => {
    expect(index.metadataByEntryId.get("hub")?.tags).toEqual([
      "project/core",
      "SharedCase",
      "inline/tag",
      "ignored-comment"
    ]);
    expect(index.metadataByEntryId.get("canvas")?.tags).toEqual([]);
    expect(index.tags.get("project/core")).toMatchObject({
      displayName: "project/core",
      entryIds: ["hub", "orphan"],
      count: 2,
      parentKeys: ["project"]
    });
    expect(index.tags.has("ignored-inline")).toBe(false);
    expect(index.tags.has("ignored-fenced")).toBe(false);
    expect(index.tags.get("ignored-comment")).toMatchObject({
      displayName: "ignored-comment",
      entryIds: ["hub"]
    });
  });

  it("does not turn hashtags inside wikilinks, Markdown links, embeds, or inline code into tags", () => {
    const metadata = parseObsidianMarkdown(
      "tag-link-regression",
      "Tag Link Regression.md",
      "#real [[Note#Heading|#wiki-hidden]] ![[Image.png#^block|#embed-hidden]] "
        + "[#markdown-hidden](Note.md#Heading) ![#alt-hidden](Image.png) `#code-hidden`"
    );

    expect(metadata.tags).toEqual(["real"]);
    expect(metadata.links).toHaveLength(4);
    expect(metadata.links.filter((link) => link.embedded)).toHaveLength(2);
  });

  it("indexes Canvas file and text cards but not a purely visual Canvas edge", () => {
    const outgoing = outgoingOccurrences(index, "canvas");

    expect(outgoing).toHaveLength(LOCAL_OBSIDIAN_CONTRACT_COUNTS.linkOccurrences.canvas);
    expect(outgoing.map((link) => link.targetEntryId ?? link.unresolvedKey).sort()).toEqual([
      "Missing Canvas",
      "asset",
      "asset-pdf",
      "canvas",
      "hub",
      "research-target"
    ]);
    expect(outgoing.find((link) => link.targetEntryId === "hub")).toMatchObject({ embedded: true });
    expect(outgoing.find((link) => link.targetEntryId === "research-target")).toMatchObject({
      raw: "[[../Research/Target]]",
      embedded: false
    });
    expect(outgoing.some((link) => link.raw === "visual-only-edge")).toBe(false);
  });

  it("matches the default global local-contract topology and collapses occurrences", () => {
    const snapshot = buildGraphSnapshot(index, globalSettings());

    expect(nodeIds(snapshot)).toEqual([
      ...LOCAL_OBSIDIAN_CONTRACT_IDS.entries,
      ...LOCAL_OBSIDIAN_CONTRACT_IDS.unresolved
    ].sort());
    expect(snapshot.nodes.find((node) => node.id === "entry:research-target"))
      .toMatchObject({ incomingReferenceCount: 3 });
    expect(snapshot.nodes.find((node) => node.id === "entry:hub"))
      .toMatchObject({ incomingReferenceCount: 4 });
    expect(edge(snapshot, "entry:hub", "entry:research-target")).toMatchObject({
      occurrenceCount: 5
    });
    expect(edge(snapshot, "entry:hub", "entry:hub")).toMatchObject({ occurrenceCount: 1 });
    expect(snapshot.edges.some((candidate) => candidate.target === "entry:asset")).toBe(false);
    expect(snapshot.edges.some((candidate) => candidate.target === "entry:asset-pdf")).toBe(false);
    expect(snapshot.edges).toHaveLength(LOCAL_OBSIDIAN_CONTRACT_COUNTS.defaultGlobal.edges);
  });

  it("applies attachment, unresolved, orphan, query and tag filters under the local contract", () => {
    const attachments = buildGraphSnapshot(index, globalSettings({ showAttachments: true }));
    expect(nodeIds(attachments)).toContain("entry:asset");
    expect(edge(attachments, "entry:hub", "entry:asset")).toBeDefined();
    expect(edge(attachments, "entry:canvas", "entry:asset")).toBeDefined();
    expect(edge(attachments, "entry:hub", "entry:asset-pdf")).toBeDefined();
    expect(edge(attachments, "entry:canvas", "entry:asset-pdf")).toBeDefined();
    expect(attachments.nodes.find((node) => node.id === "entry:asset")).toMatchObject({
      kind: "attachment",
      incomingReferenceCount: 2
    });
    expect(attachments.nodes.find((node) => node.id === "entry:asset-pdf")).toMatchObject({
      kind: "attachment",
      incomingReferenceCount: 2
    });

    const existingOnly = buildGraphSnapshot(index, globalSettings({ existingFilesOnly: true }));
    expect(existingOnly.nodes.some((node) => node.kind === "unresolved")).toBe(false);
    expect(existingOnly.edges.some((candidate) => candidate.target.startsWith("unresolved:")))
      .toBe(false);

    const withoutOrphans = buildGraphSnapshot(
      index,
      globalSettings({ showTags: true }, { showOrphans: false })
    );
    expect(nodeIds(withoutOrphans)).not.toContain("entry:orphan");
    expect(nodeIds(withoutOrphans)).toContain("tag:project/core");

    const projectTag = buildGraphSnapshot(index, globalSettings({
      query: "tag:#project",
      showTags: true
    }));
    expect(nodeIds(projectTag)).toEqual([
      "entry:hub",
      "entry:orphan",
      "tag:ignored-comment",
      "tag:inline/tag",
      "tag:project/core",
      "tag:sharedcase"
    ]);
    expect(edge(projectTag, "entry:orphan", "tag:project/core")).toBeDefined();
  });

  it("colors nodes by the first ordered matching group", () => {
    const snapshot = buildGraphSnapshot(index, globalSettings({
      groups: [
        { id: "project-path", query: "path:Projects", color: "#0000ff", order: 20 },
        { id: "hub-first", query: "file:Hub", color: "#ff0000", order: 10 },
        { id: "tag-project", query: "tag:#project", color: "#00ff00", order: 30 },
        { id: "missing", query: "file:Missing", color: "#800080", order: 5 }
      ]
    }));

    expect(snapshot.nodes.find((node) => node.id === "entry:hub")).toMatchObject({
      groupId: "hub-first",
      color: "#ff0000"
    });
    expect(snapshot.nodes.find((node) => node.id === "entry:orphan")).toMatchObject({
      groupId: "tag-project",
      color: "#00ff00"
    });
    expect(snapshot.nodes.find((node) => node.id === "unresolved:missing note")).toMatchObject({
      groupId: "missing",
      color: "#800080"
    });
  });

  it("keeps arrow and animation display toggles out of topology calculations", () => {
    const base = buildGraphSnapshot(index, globalSettings());
    const displayToggles = globalSettings({ arrows: true }, { animate: true });
    const toggled = buildGraphSnapshot(index, displayToggles);

    expect(displayToggles.common.arrows).toBe(true);
    expect(displayToggles.animate).toBe(true);
    expect(toggled).toEqual(base);
  });

  it("honors local incoming/outgoing direction and depth", () => {
    const incomingOnly = buildGraphSnapshot(index, localSettings({
      root: { entryId: "hub" },
      depth: 1,
      incoming: true,
      outgoing: false
    }));
    expect(nodeIds(incomingOnly)).toEqual([
      "entry:canvas",
      "entry:hub",
      "entry:incoming",
      "entry:research-target"
    ]);
    expect(edgeIds(incomingOnly)).toEqual([
      "link:entry:canvas->entry:hub",
      "link:entry:incoming->entry:hub",
      "link:entry:research-target->entry:hub"
    ]);

    const outgoingDepthOne = buildGraphSnapshot(index, localSettings({
      root: { entryId: "hub" },
      depth: 1,
      incoming: false,
      outgoing: true
    }));
    expect(nodeIds(outgoingDepthOne)).toEqual([
      "entry:archive-target",
      "entry:hub",
      "entry:research-target",
      "unresolved:ignored comment",
      "unresolved:missing note",
      "unresolved:shared alias",
      "unresolved:unique alias"
    ]);

    const outgoingDepthTwo = buildGraphSnapshot(index, localSettings({
      root: { entryId: "hub" },
      depth: 2,
      incoming: false,
      outgoing: true
    }));
    expect(nodeIds(outgoingDepthTwo)).toContain("entry:archive-target");
    expect(edge(outgoingDepthTwo, "entry:research-target", "entry:archive-target")).toBeUndefined();
  });

  it("adds links among already selected local neighbors only when enabled", () => {
    const baseSettings = {
      root: { entryId: "hub" } as const,
      depth: 1 as const,
      incoming: true,
      outgoing: true
    };
    const withoutNeighbors = buildGraphSnapshot(index, localSettings({
      ...baseSettings,
      neighborLinks: false
    }));
    const withNeighbors = buildGraphSnapshot(index, localSettings({
      ...baseSettings,
      neighborLinks: true
    }));
    const additionalEdges = edgeIds(withNeighbors).filter((id) => !edgeIds(withoutNeighbors).includes(id));

    expect(additionalEdges).toEqual([
      "link:entry:canvas->entry:research-target",
      "link:entry:incoming->entry:research-target",
      "link:entry:research-target->entry:archive-target"
    ]);
  });

  it("supports every local depth from one through five", () => {
    for (const depth of [1, 2, 3, 4, 5] as const) {
      const snapshot = buildGraphSnapshot(index, localSettings({
        root: { entryId: "depth-0" },
        depth,
        incoming: false,
        outgoing: true
      }));
      expect(nodeIds(snapshot), `depth ${depth}`).toHaveLength(depth + 1);
      expect(snapshot.edges, `depth ${depth}`).toHaveLength(depth);
    }
  });
});
