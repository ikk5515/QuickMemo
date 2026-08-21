import { describe, expect, it } from "vitest";
import { buildGraphSnapshot, DEFAULT_GLOBAL_GRAPH_SETTINGS } from "./graph";
import { buildKnowledgeIndex } from "./knowledgeIndex";
import type {
  KnowledgeIndex,
  ParsedMarkdownMetadata,
  ResolvedLinkOccurrence,
  VaultIndexEntry
} from "./types";

const NODE_COUNT = 5_000;
const EDGE_COUNT = 10_000;
const LOCAL_SPOKE_COUNT = 8_000;

const emptyMetadata: ParsedMarkdownMetadata = {
  aliases: [],
  blocks: [],
  headings: [],
  links: [],
  properties: {},
  tags: []
};

function resolvedLink(sourceEntryId: string, targetEntryId: string): ResolvedLinkOccurrence {
  return {
    candidateEntryIds: [targetEntryId],
    column: 1,
    context: `[[${targetEntryId}]]`,
    embedded: false,
    line: 1,
    raw: `[[${targetEntryId}]]`,
    sourceEntryId,
    sourcePath: `${sourceEntryId}.md`,
    status: "resolved",
    syntax: "wikilink",
    target: targetEntryId,
    targetEntryId,
    targetPath: `${targetEntryId}.md`,
    unresolvedKey: targetEntryId
  };
}

function largeLocalIndex(spokeCount: number): KnowledgeIndex {
  const root: VaultIndexEntry = { id: "root", kind: "markdown", path: "root.md" };
  const sink: VaultIndexEntry = { id: "sink", kind: "markdown", path: "sink.md" };
  const spokes = Array.from({ length: spokeCount }, (_, index) => ({
    id: `spoke-${index}`,
    kind: "markdown" as const,
    path: `spoke-${index}.md`
  }));
  const entries = [root, ...spokes, sink];
  const metadataByEntryId = new Map(entries.map((entry) => [entry.id, emptyMetadata]));
  const outgoingByEntryId = new Map<string, ResolvedLinkOccurrence[]>([
    [root.id, spokes.map((spoke) => resolvedLink(root.id, spoke.id))],
    ...spokes.map((spoke): [string, ResolvedLinkOccurrence[]] => [
      spoke.id,
      [resolvedLink(spoke.id, sink.id)]
    ]),
    [sink.id, []]
  ]);
  return {
    backlinksByEntryId: new Map(entries.map((entry) => [entry.id, []])),
    entries,
    metadataByEntryId,
    outgoingByEntryId,
    tags: new Map()
  };
}

function performanceVault(): VaultIndexEntry[] {
  return Array.from({ length: NODE_COUNT }, (_, index) => ({
    content: [
      `[[Note-${(index + 1) % NODE_COUNT}]]`,
      `[[Note-${(index + 97) % NODE_COUNT}]]`
    ].join(" "),
    id: `note-${index}`,
    kind: "markdown" as const,
    path: `Notes/Note-${index}.md`
  }));
}

describe("knowledge graph performance budget", () => {
  it("indexes and materializes the 5k node / 10k edge acceptance fixture within three seconds", () => {
    const startedAt = performance.now();
    const index = buildKnowledgeIndex(performanceVault());
    const snapshot = buildGraphSnapshot(index, DEFAULT_GLOBAL_GRAPH_SETTINGS);
    const elapsedMs = performance.now() - startedAt;

    expect(snapshot.nodes).toHaveLength(NODE_COUNT);
    expect(snapshot.edges).toHaveLength(EDGE_COUNT);
    expect(elapsedMs).toBeLessThan(3_000);
  }, 10_000);

  it("applies graph filters and groups to the indexed fixture within 250ms", () => {
    const index = buildKnowledgeIndex(performanceVault());
    const durations: number[] = [];

    for (let iteration = 0; iteration < 10; iteration += 1) {
      const startedAt = performance.now();
      const snapshot = buildGraphSnapshot(index, {
        ...DEFAULT_GLOBAL_GRAPH_SETTINGS,
        common: {
          ...DEFAULT_GLOBAL_GRAPH_SETTINGS.common,
          groups: [
            { color: "#8b5cf6", id: "even", order: 0, query: "path:Note-2" },
            { color: "#22c55e", id: "hundreds", order: 1, query: "path:Note-10" }
          ],
          query: iteration % 2 === 0 ? "path:Notes" : "-path:Archive"
        }
      });
      durations.push(performance.now() - startedAt);
      expect(snapshot.nodes).toHaveLength(NODE_COUNT);
    }

    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    expect(p95).toBeLessThan(250);
  }, 10_000);

  it("traverses a large depth-two Local Graph through adjacency within a stable budget", () => {
    buildGraphSnapshot(largeLocalIndex(10), {
      common: { ...DEFAULT_GLOBAL_GRAPH_SETTINGS.common },
      depth: 2,
      incoming: false,
      neighborLinks: false,
      outgoing: true,
      root: { entryId: "root" },
      scope: "local"
    });
    const index = largeLocalIndex(LOCAL_SPOKE_COUNT);
    const startedAt = performance.now();
    const snapshot = buildGraphSnapshot(index, {
      common: { ...DEFAULT_GLOBAL_GRAPH_SETTINGS.common },
      depth: 2,
      incoming: false,
      neighborLinks: false,
      outgoing: true,
      root: { entryId: "root" },
      scope: "local"
    });
    const elapsedMs = performance.now() - startedAt;

    expect(snapshot.nodes).toHaveLength(LOCAL_SPOKE_COUNT + 2);
    expect(snapshot.edges).toHaveLength(LOCAL_SPOKE_COUNT + 1);
    expect(elapsedMs).toBeLessThan(2_000);
  }, 10_000);
});
