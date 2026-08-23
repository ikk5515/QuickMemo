import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalVaultPathRewriteInventory } from "../../../shared/vault-path-rewrite-inventory.js";
import {
  canonicalVaultInventoryManifestBinding,
  canonicalVaultInventoryManifestEntryKey,
  canonicalVaultInventoryManifestEntryToken,
  canonicalVaultInventoryManifestShard,
  vaultInventoryManifestContract,
  vaultInventoryManifestShardId,
  vaultInventoryManifestShardIndexFromEntryKey
} from "../../../shared/vault-inventory-manifest.js";
import {
  VaultPathRewriteInventoryInvalidError,
  VaultPathRewriteInventorySnapshotLagError,
  verifyVaultPathRewriteInventoryManifest,
  vaultPathRewriteGenerationAligned,
  vaultPathRewriteInventoryFingerprint
} from "./pathRewriteInventory";
import type { NoteFolderSnapshot, NoteSnapshot } from "../../services/notes";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "./vaultData";

const encrypted = (suffix: string) => ({
  algorithm: "AES-GCM" as const,
  cipherText: `cipher-${suffix}`,
  iv: `iv-${suffix}`,
  version: 1 as const
});
const wrapped = (suffix: string) => ({
  algorithm: "RSA-OAEP" as const,
  version: 1 as const,
  wrappedKey: `wrapped-${suffix}`
});

function note(id: string, overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    id,
    type: "personal",
    ownerUid: "user-a",
    participantUids: ["user-a"],
    encryptedTitle: encrypted(`${id}-title`),
    encryptedBody: encrypted(`${id}-body`),
    wrappedKeys: { "user-a": wrapped(id) },
    updatedBy: "user-a",
    revision: 3,
    ...overrides
  };
}

function folder(id: string, overrides: Partial<NoteFolderSnapshot> = {}): NoteFolderSnapshot {
  return {
    id,
    ownerUid: "user-a",
    name: "암호화 폴더",
    color: "#000",
    encryptedName: encrypted(id),
    wrappedKey: wrapped(id),
    parentId: null,
    revision: 2,
    ...overrides
  };
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function manifestDocuments(notes: NoteSnapshot[], folders: NoteFolderSnapshot[]) {
  const entries = Array.from(
    { length: vaultInventoryManifestContract.shardCount },
    () => ({} as Record<string, string>)
  );
  for (const [kind, documents] of [["note", notes], ["folder", folders]] as const) {
    for (const document of documents) {
      const key = digest(canonicalVaultInventoryManifestEntryKey({
        uid: "user-a",
        kind,
        document: document as unknown as Record<string, unknown>
      }));
      const canonicalToken = canonicalVaultInventoryManifestEntryToken({
        uid: "user-a",
        kind,
        document: document as unknown as Record<string, unknown>
      });
      if (canonicalToken !== null) {
        entries[vaultInventoryManifestShardIndexFromEntryKey(key)][key] = digest(canonicalToken);
      }
    }
  }
  const timestamp = { toMillis: () => 1_700_000_000_000 };
  const marker = {
    __id: vaultInventoryManifestContract.markerId,
    ownerUid: "user-a",
    version: vaultInventoryManifestContract.version,
    epoch: 1,
    shardCount: vaultInventoryManifestContract.shardCount,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const shards = entries.map((shardEntries, shardIndex) => {
    const revision = 1;
    return {
      __id: vaultInventoryManifestShardId(shardIndex),
      ownerUid: "user-a",
      version: vaultInventoryManifestContract.version,
      epoch: 1,
      shardIndex,
      revision,
      entries: shardEntries,
      root: digest(canonicalVaultInventoryManifestShard({
        uid: "user-a",
        epoch: 1,
        shardIndex,
        revision,
        entries: shardEntries
      })),
      createdAt: timestamp,
      updatedAt: timestamp
    };
  });
  return { marker, shards };
}

describe("Vault path rewrite server inventory fingerprint", () => {
  it("accepts an exact server manifest and returns its deterministic binding", async () => {
    const notes = [note("note-a"), note("note-deleted", { isDeleted: true })];
    const folders = [folder("folder-a")];
    const { marker, shards } = manifestDocuments(notes, folders);
    const verified = await verifyVaultPathRewriteInventoryManifest({
      uid: "user-a",
      notes,
      folders,
      documents: [marker, ...shards]
    });
    expect(verified).toEqual({
      epoch: 1,
      root: digest(canonicalVaultInventoryManifestBinding({ uid: "user-a", marker, shards })),
      shardCount: vaultInventoryManifestContract.shardCount,
      version: vaultInventoryManifestContract.version
    });
  });

  it("uses legacy bootstrap only for a completely absent manifest", async () => {
    await expect(verifyVaultPathRewriteInventoryManifest({
      uid: "user-a",
      notes: [note("note-a")],
      folders: [],
      documents: []
    })).resolves.toBeNull();

    const { marker, shards } = manifestDocuments([note("note-a")], []);
    await expect(verifyVaultPathRewriteInventoryManifest({
      uid: "user-a",
      notes: [note("note-a")],
      folders: [],
      documents: [marker, ...shards.slice(0, -1)]
    })).rejects.toThrow(/일부만 준비/u);
  });

  it("fails closed for a stale token, forged root, or extra document", async () => {
    const notes = [note("note-a")];
    const { marker, shards } = manifestDocuments(notes, []);
    const stale = verifyVaultPathRewriteInventoryManifest({
      uid: "user-a",
      notes: [note("note-a", { revision: 4 })],
      folders: [],
      documents: [marker, ...shards]
    });
    await expect(stale).rejects.toBeInstanceOf(VaultPathRewriteInventorySnapshotLagError);
    await expect(stale).rejects.toMatchObject({
      code: "vault_inventory_manifest_snapshot_lag"
    });

    const forged = shards.map((shard, index) => index === 0 ? { ...shard, root: "F".repeat(43) } : shard);
    const forgedManifest = verifyVaultPathRewriteInventoryManifest({
      uid: "user-a",
      notes,
      folders: [],
      documents: [marker, ...forged]
    });
    await expect(forgedManifest).rejects.toBeInstanceOf(VaultPathRewriteInventoryInvalidError);
    await expect(forgedManifest).rejects.toMatchObject({
      code: "vault_inventory_manifest_invalid"
    });

    await expect(verifyVaultPathRewriteInventoryManifest({
      uid: "user-a",
      notes,
      folders: [],
      documents: [marker, ...shards, { __id: "unexpected" }]
    })).rejects.toThrow(/일부만 준비/u);
  });

  it("accepts only plaintext from the exact raw id/revision/path generation", () => {
    const rawNote = note("note-a", {
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      folderId: "folder-a"
    });
    const rawFolder = folder("folder-a");
    const decryptedNote = {
      ...rawNote,
      body: "# note",
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      title: "note"
    } as unknown as DecryptedVaultNote;
    const decryptedFolder = {
      ...rawFolder,
      displayName: "Folder"
    } as DecryptedVaultFolder;
    const aligned = (overrides: Partial<Parameters<typeof vaultPathRewriteGenerationAligned>[0]> = {}) => (
      vaultPathRewriteGenerationAligned({
        uid: "user-a",
        rawNotes: [rawNote],
        rawFolders: [rawFolder],
        decryptedNotes: [decryptedNote],
        decryptedFolders: [decryptedFolder],
        ...overrides
      })
    );
    expect(aligned()).toBe(true);
    expect(aligned({
      decryptedNotes: [{ ...decryptedNote, revision: 4 }]
    })).toBe(false);
    expect(aligned({
      decryptedNotes: [{ ...decryptedNote, encryptedBody: encrypted("stale-body") }]
    })).toBe(false);
    expect(aligned({
      decryptedNotes: [{ ...decryptedNote, encryptedTitle: encrypted("stale-title") }]
    })).toBe(false);
    expect(aligned({
      decryptedNotes: [{
        ...decryptedNote,
        wrappedKeys: { ...decryptedNote.wrappedKeys, "user-a": wrapped("stale-key") }
      }]
    })).toBe(false);
    expect(aligned({
      decryptedFolders: [{ ...decryptedFolder, parentId: "other", revision: 3 }]
    })).toBe(false);
    expect(aligned({
      decryptedFolders: [{ ...decryptedFolder, encryptedName: encrypted("stale-folder") }]
    })).toBe(false);
    expect(aligned({
      decryptedFolders: [{ ...decryptedFolder, wrappedKey: wrapped("stale-folder-key") }]
    })).toBe(false);
    expect(aligned({
      rawNotes: [note("note-b", { contentFormat: "markdown-v1", entryKind: "markdown" })]
    })).toBe(false);
  });

  it("aligns legacy-missing storage identity but rejects partial invalid identity", () => {
    const rawLegacy = note("legacy", { contentFormat: undefined, entryKind: undefined });
    const decryptedLegacy = {
      ...rawLegacy,
      body: "<p>legacy</p>",
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      title: "legacy"
    } as unknown as DecryptedVaultNote;
    expect(vaultPathRewriteGenerationAligned({
      uid: "user-a",
      rawNotes: [rawLegacy],
      rawFolders: [],
      decryptedNotes: [decryptedLegacy],
      decryptedFolders: []
    })).toBe(true);
    expect(vaultPathRewriteGenerationAligned({
      uid: "user-a",
      rawNotes: [note("partial", { contentFormat: "markdown-v1", entryKind: undefined })],
      rawFolders: [],
      decryptedNotes: [{
        ...decryptedLegacy,
        id: "partial",
        contentFormat: "markdown-v1",
        entryKind: "markdown"
      }],
      decryptedFolders: []
    })).toBe(false);
  });

  it("matches the Node server SHA-256 for reordered equivalent raw inventories", async () => {
    const notes = [note("note_b"), note("Note-a"), note("note-A")];
    const folders = [folder("folder_b"), folder("Folder-a"), folder("folder-A")];
    const browser = await vaultPathRewriteInventoryFingerprint({ uid: "user-a", notes, folders });
    const canonical = canonicalVaultPathRewriteInventory({
      uid: "user-a",
      notes: [...notes].reverse() as unknown as Record<string, unknown>[],
      folders: [...folders].reverse() as unknown as Record<string, unknown>[]
    });
    expect(browser).toBe(createHash("sha256").update(canonical).digest("base64url"));
  });

  it("changes for active note create/save/delete/restore and folder ancestry mutation", async () => {
    const baseNotes = [note("note-a")];
    const baseFolders = [folder("root"), folder("child", { parentId: "root" })];
    const fingerprint = (notes: NoteSnapshot[], folders: NoteFolderSnapshot[]) =>
      vaultPathRewriteInventoryFingerprint({ uid: "user-a", notes, folders });
    const base = await fingerprint(baseNotes, baseFolders);
    await expect(fingerprint([...baseNotes, note("note-b")], baseFolders)).resolves.not.toBe(base);
    await expect(fingerprint([note("note-a", { revision: 4 })], baseFolders)).resolves.not.toBe(base);
    const deleted = await fingerprint([note("note-a", { isDeleted: true, revision: 4 })], baseFolders);
    expect(deleted).not.toBe(base);
    const restored = await fingerprint([note("note-a", { isDeleted: false, revision: 5 })], baseFolders);
    expect(restored).not.toBe(deleted);
    await expect(fingerprint(baseNotes, [baseFolders[0], folder("child", {
      parentId: null,
      revision: 3
    })])).resolves.not.toBe(base);
  });

  it("binds storage identity without hashing large ciphertext or plaintext bodies", () => {
    const canonical = canonicalVaultPathRewriteInventory({
      uid: "user-a",
      notes: [note("note-a") as unknown as Record<string, unknown>],
      folders: [folder("folder-a") as unknown as Record<string, unknown>]
    });
    expect(canonical).toContain("AES-GCM");
    expect(canonical).not.toContain("cipher-note-a-body");
    expect(canonical).not.toContain("private plaintext body");
  });

  it("keeps the maximum 20k/2k projected preimage bounded independently of body size", () => {
    const notes = Array.from({ length: 20_000 }, (_, index) => ({
      __id: `n_${String(index).padStart(5, "0")}`,
      ownerUid: "user-a",
      revision: index,
      folderId: null,
      type: "personal",
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      encryptedTitle: { algorithm: "AES-GCM", version: 1 },
      encryptedBody: { algorithm: "AES-GCM", version: 1 }
    }));
    const folders = Array.from({ length: 2_000 }, (_, index) => ({
      __id: `f_${String(index).padStart(4, "0")}`,
      ownerUid: "user-a",
      revision: index + 1,
      parentId: null,
      encryptedName: { algorithm: "AES-GCM", version: 1 },
      wrappedKey: { algorithm: "RSA-OAEP", version: 1 }
    }));
    const canonical = canonicalVaultPathRewriteInventory({ uid: "user-a", notes, folders });
    expect(canonical.length).toBeLessThan(8 * 1024 * 1024);
  });
});
