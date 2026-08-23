import { describe, expect, it, vi } from "vitest";
import {
  assembleVaultImportManifest,
  chunkVaultImportManifest,
  compensateCreatedVaultImportEntries,
  createVaultImportManifest,
  planVaultImportRollback,
  VaultImportManifestError,
  VaultImportRollbackConflictError
} from "./importRollback";

const claim = (fill: string) => fill.repeat(43);
const importJobId = `vi1_${"J".repeat(43)}`;

function manifestFixture() {
  return createVaultImportManifest({
    ownerUid: "user-a",
    folders: [
      { targetId: "folder-root", claimId: claim("A"), parentId: null },
      { targetId: "folder-child", claimId: claim("B"), parentId: "folder-root" }
    ],
    entries: [
      {
        targetId: "entry-root",
        claimId: claim("C"),
        folderId: null,
        contentFormat: "markdown-v1",
        entryKind: "markdown"
      },
      {
        targetId: "entry-child",
        claimId: claim("D"),
        folderId: "folder-child",
        contentFormat: "asset-v1",
        entryKind: "asset"
      }
    ]
  });
}

describe("compensateCreatedVaultImportEntries", () => {
  it("soft-deletes only supplied import entries in reverse creation order", async () => {
    const softDelete = vi.fn(async (entry: { noteId: string; revision: number }) => {
      expect(entry.noteId).toBeTruthy();
    });
    const result = await compensateCreatedVaultImportEntries([
      { noteId: "first", revision: 1 },
      { noteId: "second", revision: 2 }
    ], softDelete);

    expect(softDelete.mock.calls.map(([entry]) => entry.noteId)).toEqual(["second", "first"]);
    expect(result).toEqual({ attempted: 2, cleanupFailed: 0, softDeleted: 2 });
  });

  it("continues compensation after a soft-delete failure and reports the residue", async () => {
    const softDelete = vi.fn(async ({ noteId }: { noteId: string }) => {
      if (noteId === "second") {
        throw new Error("transient");
      }
    });
    await expect(compensateCreatedVaultImportEntries([
      { noteId: "first", revision: 1 },
      { noteId: "second", revision: 1 }
    ], softDelete)).resolves.toEqual({ attempted: 2, cleanupFailed: 1, softDeleted: 1 });
    expect(softDelete).toHaveBeenCalledTimes(2);
  });
});

describe("durable Vault import manifest", () => {
  it("derives only outer imported folders as roots and round-trips ordered chunks", () => {
    const manifest = manifestFixture();
    const folderTargets = manifest.targets.filter((target) => target.type === "folder");
    expect(folderTargets.map((target) => [target.targetId, target.root])).toEqual([
      ["folder-root", true],
      ["folder-child", false]
    ]);
    expect(assembleVaultImportManifest("user-a", chunkVaultImportManifest(manifest))).toEqual(manifest);
  });

  it("rejects duplicate claims, inconsistent roots, and plaintext-shaped invalid targets", () => {
    const manifest = manifestFixture();
    const duplicateClaim = structuredClone(manifest);
    duplicateClaim.targets[1].claimId = duplicateClaim.targets[0].claimId;
    expect(() => chunkVaultImportManifest(duplicateClaim)).toThrow(VaultImportManifestError);

    const inconsistentRoot = structuredClone(manifest);
    const child = inconsistentRoot.targets.find((target) => target.type === "folder" && !target.root);
    if (!child || child.type !== "folder") throw new Error("fixture missing child");
    child.root = true;
    expect(() => chunkVaultImportManifest(inconsistentRoot)).toThrow(VaultImportManifestError);

    const invalidId = structuredClone(manifest);
    invalidId.targets[0].targetId = "Private/Journal";
    expect(() => chunkVaultImportManifest(invalidId)).toThrow(VaultImportManifestError);
  });

  it("rejects multi-folder cycles even when every supplied root flag matches the closed loop", () => {
    const cyclic = createVaultImportManifest({
      ownerUid: "user-a",
      folders: [
        { targetId: "cycle-a", claimId: claim("E"), parentId: null },
        { targetId: "cycle-b", claimId: claim("F"), parentId: "cycle-a" }
      ],
      entries: [{
        targetId: "cycle-entry",
        claimId: claim("G"),
        folderId: "cycle-a",
        contentFormat: "markdown-v1",
        entryKind: "markdown"
      }]
    });
    const folderA = cyclic.targets.find((target) => target.type === "folder" && target.targetId === "cycle-a");
    if (!folderA || folderA.type !== "folder") throw new Error("fixture missing cycle-a");
    folderA.parentId = "cycle-b";
    folderA.root = false;

    expect(() => chunkVaultImportManifest(cyclic)).toThrow(/순환 참조/u);
  });
});

describe("planVaultImportRollback", () => {
  it("plans revision-one entry deletes and only outer folder tombstones", () => {
    const manifest = manifestFixture();
    const plan = planVaultImportRollback({
      jobId: importJobId,
      manifest,
      folders: [
        {
          id: "folder-root", ownerUid: "user-a", parentId: null, revision: 1, isDeleted: false,
          vaultNameClaimId: claim("A"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
        },
        {
          id: "folder-child", ownerUid: "user-a", parentId: "folder-root", revision: 1, isDeleted: false,
          vaultNameClaimId: claim("B"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
        }
      ],
      notes: [
        {
          id: "entry-root", ownerUid: "user-a", folderId: null, revision: 1, isDeleted: false,
          contentFormat: "markdown-v1", entryKind: "markdown",
          vaultNameClaimId: claim("C"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
        },
        {
          id: "entry-child", ownerUid: "user-a", folderId: "folder-child", revision: 1, isDeleted: false,
          contentFormat: "asset-v1", entryKind: "asset",
          vaultNameClaimId: claim("D"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
        }
      ]
    });

    expect(plan.entryDeletes).toEqual([
      { noteId: "entry-child", revision: 1 },
      { noteId: "entry-root", revision: 1 }
    ]);
    expect(plan.folderRootDeletes).toEqual([{ folderId: "folder-root", revision: 1 }]);
  });

  it("is idempotent after committed-response loss from note and folder cleanup", () => {
    const manifest = manifestFixture();
    const plan = planVaultImportRollback({
      jobId: importJobId,
      manifest,
      folders: [
        {
          id: "folder-root", ownerUid: "user-a", parentId: null, revision: 2, isDeleted: true,
          vaultNameClaimId: claim("A"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
        },
        {
          id: "folder-child", ownerUid: "user-a", parentId: "folder-root", revision: 1, isDeleted: false,
          vaultNameClaimId: claim("B"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
        }
      ],
      notes: [
        {
          id: "entry-root", ownerUid: "user-a", folderId: null, revision: 2, isDeleted: true,
          contentFormat: "markdown-v1", entryKind: "markdown",
          vaultNameClaimId: claim("C"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
        }
      ]
    });
    expect(plan).toMatchObject({
      entryDeletes: [],
      folderRootDeletes: [],
      alreadyCleanedEntries: 1,
      alreadyCleanedFolderRoots: 1
    });
  });

  it.each([
    ["edited imported entry", {
      folders: [],
      notes: [{
        id: "entry-root", ownerUid: "user-a", folderId: null, revision: 2, isDeleted: false,
        contentFormat: "markdown-v1" as const, entryKind: "markdown" as const,
        vaultNameClaimId: claim("C"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
      }]
    }],
    ["unrelated entry moved into imported subtree", {
      folders: [
        {
          id: "folder-root", ownerUid: "user-a", parentId: null, revision: 1, isDeleted: false,
          vaultNameClaimId: claim("A"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
        },
        {
          id: "folder-child", ownerUid: "user-a", parentId: "folder-root", revision: 1, isDeleted: false,
          vaultNameClaimId: claim("B"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
        }
      ],
      notes: [{ id: "existing-note", ownerUid: "user-a", folderId: "folder-child", revision: 8 }]
    }],
    ["unrelated folder moved into imported subtree", {
      folders: [
        {
          id: "folder-root", ownerUid: "user-a", parentId: null, revision: 1, isDeleted: false,
          vaultNameClaimId: claim("A"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
        },
        {
          id: "folder-child", ownerUid: "user-a", parentId: "folder-root", revision: 1, isDeleted: false,
          vaultNameClaimId: claim("B"), vaultNameIndexVersion: 1, vaultImportJobId: importJobId
        },
        { id: "existing-folder", ownerUid: "user-a", parentId: "folder-root", revision: 4 }
      ],
      notes: []
    }]
  ])("fails closed before destructive callbacks for %s", (_label, snapshot) => {
    expect(() => planVaultImportRollback({ jobId: importJobId, manifest: manifestFixture(), ...snapshot }))
      .toThrow(VaultImportRollbackConflictError);
  });
});
