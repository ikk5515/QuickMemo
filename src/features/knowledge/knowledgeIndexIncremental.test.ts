import { describe, expect, it } from "vitest";
import {
  MAX_INTERNAL_LINK_OCCURRENCES_PER_INDEX,
  MAX_TAG_OCCURRENCES_PER_INDEX,
  buildKnowledgeIndex,
  getKnowledgeIndexUpdateDiagnostics,
  removeKnowledgeIndex,
  upsertKnowledgeIndex
} from "./knowledgeIndex";
import {
  MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY,
  MAX_TAG_OCCURRENCES_PER_ENTRY
} from "./markdown";
import type { KnowledgeIndex, VaultIndexEntry } from "./types";

function markdownEntry(id: string, path: string, content: string): VaultIndexEntry {
  return { id, path, kind: "markdown", content };
}

function sortedMapEntries<Value>(map: ReadonlyMap<string, Value>) {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function comparableIndex(index: KnowledgeIndex) {
  return {
    entries: index.entries,
    metadata: sortedMapEntries(index.metadataByEntryId),
    outgoing: sortedMapEntries(index.outgoingByEntryId),
    backlinks: sortedMapEntries(index.backlinksByEntryId),
    tags: sortedMapEntries(index.tags)
  };
}

function expectSameAsFullBuild(
  incremental: KnowledgeIndex,
  entries: readonly VaultIndexEntry[]
) {
  expect(comparableIndex(incremental)).toEqual(
    comparableIndex(buildKnowledgeIndex(entries))
  );
}

describe("incremental knowledge index updates", () => {
  it("updates content links and tags without mutating the previous index", () => {
    const originalEntries = [
      markdownEntry("source", "Notes/Source.md", "[[Target]] #old/tag"),
      markdownEntry("target", "Notes/Target.md", ""),
      markdownEntry("other", "Notes/Other.md", "")
    ];
    const previous = buildKnowledgeIndex(originalEntries);
    const edited = markdownEntry(
      "source",
      "Notes/Source.md",
      "[[Other]] twice [[Other]] #new/tag"
    );
    const incremental = upsertKnowledgeIndex(previous, edited);

    expectSameAsFullBuild(incremental, [edited, ...originalEntries.slice(1)]);
    expect(previous.outgoingByEntryId.get("source")?.[0]?.targetEntryId).toBe("target");
    expect(previous.backlinksByEntryId.get("target")).toHaveLength(1);
    expect(previous.tags.has("old/tag")).toBe(true);
    expect(previous.tags.has("new/tag")).toBe(false);
    edited.content = "mutated after upsert";
    expect(incremental.entries.find((entry) => entry.id === "source")?.content).toBe(
      "[[Other]] twice [[Other]] #new/tag"
    );
    expect(getKnowledgeIndexUpdateDiagnostics(incremental)).toEqual({
      parsedEntryIds: ["source"],
      changedMetadataEntryIds: ["source"],
      reindexedSourceEntryIds: ["source"],
      globallyReresolved: false
    });
  });

  it("keeps alias links unresolved and re-resolves sources when a path key changes", () => {
    const source = markdownEntry(
      "source",
      "Notes/Source.md",
      "[[Readable Alias]] [[Moved]]"
    );
    const target = markdownEntry(
      "target",
      "Notes/Original.md",
      "---\naliases: [Old Alias]\n---\n"
    );
    const previous = buildKnowledgeIndex([source, target]);
    const aliasEditedTarget = markdownEntry(
      "target",
      "Notes/Original.md",
      "---\naliases: [Readable Alias]\n---\n"
    );
    const aliasIncremental = upsertKnowledgeIndex(previous, aliasEditedTarget);

    expectSameAsFullBuild(aliasIncremental, [source, aliasEditedTarget]);
    expect(aliasIncremental.outgoingByEntryId.get("source")?.[0]).toMatchObject({
      status: "unresolved"
    });
    expect(getKnowledgeIndexUpdateDiagnostics(aliasIncremental)).toEqual({
      parsedEntryIds: ["target"],
      changedMetadataEntryIds: ["target"],
      reindexedSourceEntryIds: ["source", "target"],
      globallyReresolved: true
    });

    const movedTarget = { ...aliasEditedTarget, path: "Notes/Moved.md" };
    const pathIncremental = upsertKnowledgeIndex(aliasIncremental, movedTarget);
    expectSameAsFullBuild(pathIncremental, [source, movedTarget]);
    expect(pathIncremental.outgoingByEntryId.get("source")?.[1]).toMatchObject({
      status: "resolved",
      targetEntryId: "target",
      targetPath: "Notes/Moved.md"
    });
    expect(getKnowledgeIndexUpdateDiagnostics(pathIncremental)).toMatchObject({
      parsedEntryIds: ["target"],
      globallyReresolved: true
    });
  });

  it("removes the selected duplicate, re-resolves to the next candidate, and does not parse it", () => {
    const entries = [
      markdownEntry("source", "Source.md", "[[Target]] #source"),
      markdownEntry("first", "One/Target.md", "#Shared #first"),
      markdownEntry("second", "Two/Target.md", "#shared #second")
    ];
    const previous = buildKnowledgeIndex(entries);
    expect(previous.outgoingByEntryId.get("source")?.[0]).toMatchObject({
      status: "resolved",
      targetEntryId: "first"
    });

    const incremental = removeKnowledgeIndex(previous, "first");
    expectSameAsFullBuild(incremental, [entries[0], entries[2]]);
    expect(incremental.outgoingByEntryId.get("source")?.[0]).toMatchObject({
      status: "resolved",
      targetEntryId: "second"
    });
    expect(incremental.tags.has("first")).toBe(false);
    expect(incremental.tags.get("shared")?.displayName).toBe("shared");
    expect(previous.entries.map((entry) => entry.id)).toEqual([
      "source",
      "first",
      "second"
    ]);
    expect(getKnowledgeIndexUpdateDiagnostics(incremental)).toEqual({
      parsedEntryIds: [],
      changedMetadataEntryIds: ["first"],
      reindexedSourceEntryIds: ["source", "second"],
      globallyReresolved: true
    });
  });

  it("preserves the vault-wide link cap when an edit moves the budget boundary", () => {
    const sourceCount = Math.ceil(
      MAX_INTERNAL_LINK_OCCURRENCES_PER_INDEX
      / MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY
    ) + 1;
    const sources = Array.from({ length: sourceCount }, (_, index) => markdownEntry(
      `source-${index}`,
      `Source-${index}.md`,
      "[[Target]] ".repeat(MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY)
    ));
    const target = markdownEntry("target", "Target.md", "");
    const previous = buildKnowledgeIndex([...sources, target]);
    const edited = markdownEntry("source-0", "Source-0.md", "[[Target]]");
    const expectedEntries = [edited, ...sources.slice(1), target];
    const incremental = upsertKnowledgeIndex(previous, edited);

    expectSameAsFullBuild(incremental, expectedEntries);
    expect([...incremental.outgoingByEntryId.values()].reduce(
      (total, occurrences) => total + occurrences.length,
      0
    )).toBe(MAX_INTERNAL_LINK_OCCURRENCES_PER_INDEX);
    expect(getKnowledgeIndexUpdateDiagnostics(incremental)?.parsedEntryIds).toEqual([
      "source-0"
    ]);
    expect(getKnowledgeIndexUpdateDiagnostics(incremental)?.changedMetadataEntryIds).toEqual([
      "source-0",
      `source-${sourceCount - 1}`
    ]);
  }, 15_000);

  it("preserves the vault-wide tag cap when an edit moves the budget boundary", () => {
    const sourceCount = Math.ceil(
      MAX_TAG_OCCURRENCES_PER_INDEX / MAX_TAG_OCCURRENCES_PER_ENTRY
    ) + 1;
    const sources = Array.from({ length: sourceCount }, (_, entryIndex) => markdownEntry(
      `tag-source-${entryIndex}`,
      `Tag-Source-${entryIndex}.md`,
      Array.from(
        { length: MAX_TAG_OCCURRENCES_PER_ENTRY },
        (_, tagIndex) => `#tag-${entryIndex}-${tagIndex}`
      ).join(" ")
    ));
    const previous = buildKnowledgeIndex(sources);
    const edited = markdownEntry("tag-source-0", "Tag-Source-0.md", "#edited");
    const expectedEntries = [edited, ...sources.slice(1)];
    const incremental = upsertKnowledgeIndex(previous, edited);

    expectSameAsFullBuild(incremental, expectedEntries);
    expect([...incremental.metadataByEntryId.values()].reduce(
      (total, metadata) => total + metadata.tags.length,
      0
    )).toBe(MAX_TAG_OCCURRENCES_PER_INDEX);
    expect(getKnowledgeIndexUpdateDiagnostics(incremental)?.parsedEntryIds).toEqual([
      "tag-source-0"
    ]);
    expect(getKnowledgeIndexUpdateDiagnostics(incremental)?.changedMetadataEntryIds).toEqual([
      "tag-source-0",
      `tag-source-${sourceCount - 1}`
    ]);
  }, 15_000);

  it("parses only the active entry in a 5k-entry edit regression fixture", () => {
    const entries = Array.from({ length: 5_000 }, (_, index) => markdownEntry(
      index === 2_500 ? "active" : `note-${index}`,
      index === 2_500 ? "Active.md" : `Archive/Note-${index}.md`,
      index === 2_500 ? "[[Note-1]] #draft" : `#archive note ${index}`
    ));
    const previous = buildKnowledgeIndex(entries);
    const edited = markdownEntry("active", "Active.md", "[[Note-2]] #published");
    const incremental = upsertKnowledgeIndex(previous, edited);
    const expectedEntries = entries.map((entry) => entry.id === "active" ? edited : entry);

    expectSameAsFullBuild(incremental, expectedEntries);
    expect(getKnowledgeIndexUpdateDiagnostics(incremental)).toEqual({
      parsedEntryIds: ["active"],
      changedMetadataEntryIds: ["active"],
      reindexedSourceEntryIds: ["active"],
      globallyReresolved: false
    });
  }, 15_000);
});
