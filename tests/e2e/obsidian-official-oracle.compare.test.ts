import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_GRAPH_SETTINGS,
  DEFAULT_LOCAL_GRAPH_SETTINGS,
  buildGraphSnapshot,
  buildKnowledgeIndex
} from "../../src/features/knowledge";
import {
  createObsidianOracleFixtureManifest,
  createObsidianOracleIndexEntries
} from "./obsidian-official-oracle.fixture.mjs";
import type {
  GraphNode,
  GraphSnapshot,
  GraphViewSettings,
  KnowledgeIndex,
  ResolvedLinkOccurrence
} from "../../src/features/knowledge/types";

interface OfficialCapture {
  schemaVersion: 1;
  fixture: { fileCount: number; sha256: string };
  oracle: unknown;
}

function graphSettings(
  changes: Partial<Extract<GraphViewSettings, { scope: "global" }>["common"]> = {}
): Extract<GraphViewSettings, { scope: "global" }> {
  return {
    ...DEFAULT_GLOBAL_GRAPH_SETTINGS,
    common: { ...DEFAULT_GLOBAL_GRAPH_SETTINGS.common, ...changes }
  };
}

function nodeKey(node: GraphNode): string {
  if (node.kind === "tag") return `#${node.tag ?? node.label}`;
  if (node.kind === "unresolved") return `?${node.unresolvedKey ?? node.label}`;
  return node.path ?? node.label;
}

function canonicalGraph(snapshot: GraphSnapshot) {
  const keys = new Map(snapshot.nodes.map((node) => [node.id, nodeKey(node)]));
  return {
    nodes: snapshot.nodes.map(nodeKey).sort(),
    edges: snapshot.edges.map((edge) => ({
      kind: edge.kind,
      occurrenceCount: edge.occurrenceCount,
      source: keys.get(edge.source) ?? edge.source,
      target: keys.get(edge.target) ?? edge.target
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  };
}

function canonicalOccurrence(
  occurrence: ResolvedLinkOccurrence,
  pathByEntryId: Map<string, string>
) {
  return {
    candidatePaths: occurrence.candidateEntryIds
      .map((entryId) => pathByEntryId.get(entryId) ?? entryId)
      .sort(),
    embedded: occurrence.embedded,
    fragment: occurrence.fragment ?? null,
    raw: occurrence.raw,
    sourcePath: occurrence.sourcePath,
    status: occurrence.status,
    targetPath: occurrence.targetPath ?? null,
    unresolvedKey: occurrence.unresolvedKey
  };
}

function quickMemoOracle(index: KnowledgeIndex) {
  const pathByEntryId = new Map(index.entries.map((entry) => [entry.id, entry.path]));
  const outgoing = [...index.outgoingByEntryId.values()]
    .flat()
    .map((occurrence) => canonicalOccurrence(occurrence, pathByEntryId))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const tags = [...index.tags.values()].map((tag) => ({
    displayName: tag.displayName,
    entryPaths: tag.entryIds.map((entryId) => pathByEntryId.get(entryId) ?? entryId).sort(),
    key: tag.key,
    parentKeys: [...tag.parentKeys].sort()
  })).sort((left, right) => left.key.localeCompare(right.key));
  const hub = index.entries.find((entry) => entry.path === "Projects/Hub.md");
  if (!hub) throw new Error("Official oracle fixture is missing Projects/Hub.md.");

  return {
    graph: {
      defaultGlobal: canonicalGraph(buildGraphSnapshot(index, graphSettings())),
      withAttachments: canonicalGraph(buildGraphSnapshot(
        index,
        graphSettings({ showAttachments: true })
      )),
      withTags: canonicalGraph(buildGraphSnapshot(index, graphSettings({ showTags: true }))),
      localHubDepthTwo: canonicalGraph(buildGraphSnapshot(index, {
        ...DEFAULT_LOCAL_GRAPH_SETTINGS,
        root: { entryId: hub.id },
        depth: 2,
        incoming: true,
        outgoing: true,
        neighborLinks: false,
        common: { ...DEFAULT_LOCAL_GRAPH_SETTINGS.common }
      }))
    },
    outgoing,
    tags
  };
}

describe("official Obsidian 1.13.7 golden capture", () => {
  it("matches the exact materialized fixture and QuickMemo knowledge result", async () => {
    const capturePath = process.env.OBSIDIAN_OFFICIAL_CAPTURE_PATH;
    expect(capturePath, "The fail-closed verifier must provide a validated capture path.").toBeTruthy();
    const capture = JSON.parse(await readFile(capturePath!, "utf8")) as OfficialCapture;
    const manifest = createObsidianOracleFixtureManifest();

    expect(capture.schemaVersion).toBe(1);
    expect(capture.fixture).toEqual({
      fileCount: manifest.fileCount,
      sha256: manifest.sha256
    });
    expect(quickMemoOracle(buildKnowledgeIndex(createObsidianOracleIndexEntries())))
      .toEqual(capture.oracle);
  });
});
