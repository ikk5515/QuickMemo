import { describe, expect, it } from "vitest";
import type { NoteFolderSnapshot, NoteSnapshot } from "../../services/notes";
import {
  assertVaultFolderLifecyclePreflight,
  partitionVaultFolderTrash,
  vaultFolderTrashCounts,
  visibleVaultNotesForFolders
} from "./folderTrash";
import { MAX_VAULT_FOLDER_DEPTH } from "./vaultIntegrity";

function folder(id: string, parentId: string | null, isDeleted = false): NoteFolderSnapshot {
  return {
    color: "#7c5cff",
    id,
    isDeleted,
    name: "암호화 폴더",
    ownerUid: "owner",
    parentId,
    revision: 1
  };
}

function note(id: string, folderId: string | null): NoteSnapshot {
  return {
    encryptedBody: { algorithm: "AES-GCM", cipherText: "body", iv: "iv", version: 1 },
    encryptedTitle: { algorithm: "AES-GCM", cipherText: "title", iv: "iv", version: 1 },
    folderId,
    id,
    ownerUid: "owner",
    participantUids: ["owner"],
    type: "personal",
    updatedBy: "owner",
    wrappedKeys: {}
  };
}

describe("Vault folder subtree tombstones", () => {
  it("atomically hides every descendant and its entries from active consumers", () => {
    const allFolders = [
      folder("root", null, true),
      folder("child", "root"),
      folder("grandchild", "child"),
      folder("other", null)
    ];
    const partition = partitionVaultFolderTrash(allFolders);

    expect(partition.activeFolders.map(({ id }) => id)).toEqual(["other"]);
    expect([...partition.hiddenFolderIds]).toEqual(["root", "child", "grandchild"]);
    expect(partition.trashRoots.map(({ id }) => id)).toEqual(["root"]);
    expect(visibleVaultNotesForFolders([
      note("root-note", null),
      note("hidden-note", "grandchild"),
      note("visible-note", "other")
    ], partition.activeFolders).map(({ id }) => id)).toEqual(["root-note", "visible-note"]);
  });

  it("fails closed for missing parents, cycles and paths deeper than the supported audit bound", () => {
    const cyclic = [folder("a", "b"), folder("b", "a"), folder("missing-child", "missing")];
    const partition = partitionVaultFolderTrash(cyclic);
    expect(partition.activeFolders).toEqual([]);
    expect([...partition.invalidFolderIds].sort()).toEqual(["a", "b", "missing-child"]);
  });

  it("shows only the outer tombstone until it is restored and counts the logical subtree", () => {
    const allFolders = [
      folder("outer", null, true),
      folder("nested-trash", "outer", true),
      folder("leaf", "nested-trash")
    ];
    const partition = partitionVaultFolderTrash(allFolders);
    expect(partition.trashRoots.map(({ id }) => id)).toEqual(["outer"]);
    expect(vaultFolderTrashCounts("outer", allFolders, [
      note("one", "outer"),
      note("two", "leaf"),
      note("root", null)
    ])).toEqual({ entryCount: 2, folderCount: 2 });
  });

  it("requires a complete active ancestor chain and outermost tombstone for lifecycle writes", () => {
    const encryptedFolder = (id: string, parentId: string | null, isDeleted = false) => ({
      ...folder(id, parentId, isDeleted),
      encryptedName: { algorithm: "AES-GCM" as const, cipherText: "name", iv: "iv", version: 1 as const },
      revision: 4,
      vaultNameClaimId: "C".repeat(43),
      vaultNameIndexVersion: 1 as const,
      wrappedKey: { algorithm: "RSA-OAEP" as const, version: 1 as const, wrappedKey: "key" }
    });
    const active = [encryptedFolder("root", null), encryptedFolder("child", "root")];
    expect(assertVaultFolderLifecyclePreflight({
      expectedRevision: 4,
      folderId: "child",
      folders: active,
      operation: "delete",
      ownerUid: "owner"
    }).id).toBe("child");

    expect(() => assertVaultFolderLifecyclePreflight({
      expectedRevision: 4,
      folderId: "child",
      folders: [active[1]],
      operation: "delete",
      ownerUid: "owner"
    })).toThrow("무결성");

    const tooDeep = Array.from({ length: MAX_VAULT_FOLDER_DEPTH + 2 }, (_, index) =>
      encryptedFolder(`deep-${index}`, index === 0 ? null : `deep-${index - 1}`));
    expect(() => assertVaultFolderLifecyclePreflight({
      expectedRevision: 4,
      folderId: `deep-${MAX_VAULT_FOLDER_DEPTH + 1}`,
      folders: tooDeep,
      operation: "delete",
      ownerUid: "owner"
    })).toThrow("상위 폴더 체인의 무결성");

    const nestedTrash = [
      encryptedFolder("outer", null, true),
      encryptedFolder("active-middle", "outer"),
      encryptedFolder("inner", "active-middle", true)
    ];
    expect(() => assertVaultFolderLifecyclePreflight({
      expectedRevision: 4,
      folderId: "inner",
      folders: nestedTrash,
      operation: "restore",
      ownerUid: "owner"
    })).toThrow("바깥쪽");

    expect(() => assertVaultFolderLifecyclePreflight({
      expectedRevision: 4,
      folderId: "child",
      folders: [...active, active[1]],
      operation: "delete",
      ownerUid: "owner"
    })).toThrow("중복");
  });
});
