import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_GRAPH_SETTINGS,
  DEFAULT_LOCAL_GRAPH_SETTINGS,
  backlinkOccurrences,
  buildGraphSnapshot,
  buildKnowledgeIndex,
  outgoingOccurrences,
  parseObsidianMarkdown
} from "./index";
import {
  OBSIDIAN_GOLDEN_IDS,
  OBSIDIAN_GOLDEN_VAULT
} from "./obsidianGoldenVault.fixture";
import type { GraphEdge, GraphViewSettings, VaultIndexEntry } from "./types";

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

describe("Obsidian 1.13 golden vault compatibility", () => {
  const index = buildKnowledgeIndex(OBSIDIAN_GOLDEN_VAULT);

  it("resolves file, alias, heading, block, embed and relative links occurrence-by-occurrence", () => {
    const outgoing = outgoingOccurrences(index, "hub");

    expect(outgoing).toHaveLength(11);
    expect(outgoing.filter((link) => link.targetEntryId === "research-target")).toHaveLength(6);
    expect(outgoing.find((link) => link.fragment?.kind === "heading" && link.embedded)).toBeUndefined();
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
      expect.objectContaining({ raw: "[[Missing Note]]", status: "unresolved" })
    ]));
    expect(outgoing.some((link) => link.raw.includes("Ignored"))).toBe(false);
    expect(backlinkOccurrences(index, "research-target").filter((link) => link.sourceEntryId === "hub"))
      .toHaveLength(6);
  });

  it("keeps duplicate-name and alias collisions ambiguous instead of inventing a target", () => {
    const outgoing = outgoingOccurrences(index, "hub");
    const duplicateName = outgoing.find((link) => link.raw === "[[Target]]");
    const aliasCollision = outgoing.find((link) => link.raw === "[[Shared Alias]]");

    expect(duplicateName).toMatchObject({ status: "ambiguous" });
    expect(aliasCollision).toMatchObject({ status: "ambiguous" });
    expect(duplicateName?.targetEntryId).toBeUndefined();
    expect(aliasCollision?.targetEntryId).toBeUndefined();
    expect([...(duplicateName?.candidateEntryIds ?? [])].sort()).toEqual([
      "archive-target",
      "research-target"
    ]);
    expect([...(aliasCollision?.candidateEntryIds ?? [])].sort()).toEqual([
      "archive-target",
      "research-target"
    ]);
    expect(outgoing.find((link) => link.raw === "[[Unique Alias]]")).toMatchObject({
      status: "resolved",
      targetEntryId: "research-target"
    });
  });

  it("merges YAML and inline nested tags, preserves first casing, and ignores code", () => {
    expect(index.metadataByEntryId.get("hub")?.tags).toEqual([
      "project/core",
      "SharedCase",
      "inline/tag"
    ]);
    expect(index.metadataByEntryId.get("canvas")?.tags).toEqual(["canvas/nested"]);
    expect(index.tags.get("project/core")).toMatchObject({
      displayName: "project/core",
      entryIds: ["hub", "orphan"],
      count: 2,
      parentKeys: ["project"]
    });
    expect(index.tags.has("ignored-inline")).toBe(false);
    expect(index.tags.has("ignored-fenced")).toBe(false);
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

    expect(outgoing).toHaveLength(5);
    expect(outgoing.map((link) => link.targetEntryId ?? link.unresolvedKey).sort()).toEqual([
      "Missing Canvas",
      "asset",
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

  it("matches the default global node/edge golden topology and collapses occurrences", () => {
    const snapshot = buildGraphSnapshot(index, globalSettings());

    expect(nodeIds(snapshot)).toEqual([
      ...OBSIDIAN_GOLDEN_IDS.entries,
      ...OBSIDIAN_GOLDEN_IDS.unresolved
    ].sort());
    expect(snapshot.nodes.find((node) => node.id === "entry:research-target"))
      .toMatchObject({ incomingReferenceCount: 3 });
    expect(snapshot.nodes.find((node) => node.id === "entry:hub"))
      .toMatchObject({ incomingReferenceCount: 4 });
    expect(edge(snapshot, "entry:hub", "entry:research-target")).toMatchObject({
      occurrenceCount: 6
    });
    expect(edge(snapshot, "entry:hub", "entry:hub")).toMatchObject({ occurrenceCount: 1 });
    expect(snapshot.edges.some((candidate) => candidate.target === "entry:asset")).toBe(false);
    expect(snapshot.edges).toHaveLength(13);
  });

  it("applies attachment, unresolved, orphan, query and tag filters with Obsidian semantics", () => {
    const attachments = buildGraphSnapshot(index, globalSettings({ showAttachments: true }));
    expect(nodeIds(attachments)).toContain("entry:asset");
    expect(edge(attachments, "entry:hub", "entry:asset")).toBeDefined();
    expect(edge(attachments, "entry:canvas", "entry:asset")).toBeDefined();
    expect(attachments.nodes.find((node) => node.id === "entry:asset")).toMatchObject({
      kind: "attachment",
      incomingReferenceCount: 2
    });

    const existingOnly = buildGraphSnapshot(index, globalSettings({ existingFilesOnly: true }));
    expect(existingOnly.nodes.some((node) => node.kind === "unresolved")).toBe(false);

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
      "link:entry:hub->entry:hub",
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
      "entry:hub",
      "entry:research-target",
      "unresolved:missing note",
      "unresolved:shared alias",
      "unresolved:target"
    ]);

    const outgoingDepthTwo = buildGraphSnapshot(index, localSettings({
      root: { entryId: "hub" },
      depth: 2,
      incoming: false,
      outgoing: true
    }));
    expect(nodeIds(outgoingDepthTwo)).toContain("entry:archive-target");
    expect(edge(outgoingDepthTwo, "entry:research-target", "entry:archive-target")).toBeDefined();
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
      "link:entry:canvas->entry:canvas",
      "link:entry:canvas->entry:research-target",
      "link:entry:incoming->entry:research-target"
    ]);
  });

  it("supports every local depth from one through five", () => {
    const depthVault: VaultIndexEntry[] = Array.from({ length: 6 }, (_, position) => ({
      id: `depth-${position}`,
      path: `Depth/${position}.md`,
      kind: "markdown",
      content: position < 5 ? `[[Depth/${position + 1}]]` : ""
    }));
    const depthIndex = buildKnowledgeIndex(depthVault);

    for (const depth of [1, 2, 3, 4, 5] as const) {
      const snapshot = buildGraphSnapshot(depthIndex, localSettings({
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
