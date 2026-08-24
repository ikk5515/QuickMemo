import { describe, expect, it } from "vitest";
import {
  clearOptimisticVaultEntryPatch,
  projectOptimisticVaultEntries,
  type OptimisticVaultEntryPatch
} from "./optimisticEntryOperations";

const entries = [
  { id: "a", folderId: null, title: "Alpha", encryptedTitle: "cipher-a", revision: 4 },
  { id: "b", folderId: "old", title: "Beta", encryptedTitle: "cipher-b", revision: 7 }
];

describe("optimistic Vault entry explorer projection", () => {
  it("projects rename, move, and trash immediately without mutating canonical encrypted state", () => {
    const patches = new Map<string, OptimisticVaultEntryPatch>([
      ["a", { folderId: "archive", operationId: 1, title: "Renamed" }],
      ["b", { hidden: true, operationId: 2 }]
    ]);

    expect(projectOptimisticVaultEntries(entries, patches)).toEqual([
      {
        id: "a",
        folderId: "archive",
        title: "Renamed",
        encryptedTitle: "cipher-a",
        revision: 4
      }
    ]);
    expect(entries).toEqual([
      { id: "a", folderId: null, title: "Alpha", encryptedTitle: "cipher-a", revision: 4 },
      { id: "b", folderId: "old", title: "Beta", encryptedTitle: "cipher-b", revision: 7 }
    ]);
  });

  it("clears only the matching operation so an older finally cannot erase a newer projection", () => {
    const patches = new Map<string, OptimisticVaultEntryPatch>([
      ["a", { operationId: 9, title: "Newest" }]
    ]);
    expect(clearOptimisticVaultEntryPatch(patches, "a", 8)).toBe(patches);
    expect(clearOptimisticVaultEntryPatch(patches, "a", 9)).toEqual(new Map());
  });
});
