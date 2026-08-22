import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "./vaultData";
import { vaultNameFingerprint } from "./vaultIntegrity";
import { migrateVaultNameReservations } from "./vaultNameMigration";

const mocks = vi.hoisted(() => ({
  claimMatches: vi.fn(),
  migrateFolder: vi.fn(),
  saveEntry: vi.fn(),
  updateFolder: vi.fn()
}));

vi.mock("../../services/notes", () => ({
  updateEncryptedNoteFolder: mocks.updateFolder,
  vaultNameClaimReservationMatches: mocks.claimMatches
}));
vi.mock("./vaultData", async (importOriginal) => ({
  ...await importOriginal<typeof import("./vaultData")>(),
  migrateLegacyVaultFolder: mocks.migrateFolder
}));
vi.mock("./vaultPersistence", () => ({ backfillVaultEntryNameClaim: mocks.saveEntry }));

const privateKey = { kind: "private" } as unknown as CryptoKey;
let vaultIntegrityKey: CryptoKey;
const encryptedPayload = { algorithm: "AES-GCM" as const, cipherText: "cipher", iv: "iv", version: 1 as const };
const wrappedKey = { algorithm: "RSA-OAEP" as const, version: 1 as const, wrappedKey: "wrapped" };
const profile = { publicKeyJwk: { kty: "RSA" }, uid: "user-a" };

function folder(overrides: Partial<DecryptedVaultFolder> = {}): DecryptedVaultFolder {
  return {
    color: "#7c5cff",
    displayName: "Project",
    encryptedName: encryptedPayload,
    id: "folder-a",
    name: "암호화 폴더",
    order: 0,
    ownerUid: "user-a",
    parentId: null,
    revision: 1,
    wrappedKey,
    ...overrides
  };
}

function note(overrides: Partial<DecryptedVaultNote> = {}): DecryptedVaultNote {
  return {
    body: "# body",
    contentFormat: "markdown-v1",
    encryptedBody: encryptedPayload,
    encryptedTitle: encryptedPayload,
    entryKind: "markdown",
    folderId: null,
    id: "note-a",
    isDeleted: false,
    ownerUid: "user-a",
    participantUids: ["user-a"],
    revision: 1,
    title: "Note",
    type: "personal",
    updatedBy: "user-a",
    wrappedKeys: { "user-a": wrappedKey },
    ...overrides
  };
}

describe("Vault name reservation migration", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vaultIntegrityKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    mocks.saveEntry.mockResolvedValue({ noteId: "note-a", revision: 2 });
    mocks.claimMatches.mockResolvedValue(true);
    mocks.updateFolder.mockResolvedValue({ folderId: "folder-a", revision: 2 });
    mocks.migrateFolder.mockResolvedValue({ folderId: "legacy-folder", revision: 1 });
  });

  it("reserves the deterministic collision winner and defers only the duplicate", async () => {
    const result = await migrateVaultNameReservations({
      folders: [],
      notes: [note({ id: "first" }), note({ id: "duplicate", title: "note.md" })],
      privateKey,
      profile,
      expectedFolderCount: 0,
      expectedNoteCount: 2,
      vaultIntegrityKey
    });

    expect(result.collisions).toHaveLength(1);
    expect(result).toMatchObject({ completed: 1, migrated: 1, skipped: 0, total: 2 });
    expect(result.deferredTargetIds).toEqual(["duplicate"]);
    expect(mocks.saveEntry).toHaveBeenCalledOnce();
    expect(mocks.saveEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "first" }),
      "user-a",
      privateKey,
      vaultIntegrityKey
    );
    expect(mocks.updateFolder).not.toHaveBeenCalled();
  });

  it("rejects incomplete, foreign-owned, deleted, and orphaned snapshots before writing", async () => {
    const cases = [
      {
        folders: [folder()],
        notes: [],
        expectedFolderCount: 2,
        expectedNoteCount: 0
      },
      {
        folders: [folder({ ownerUid: "user-b" })],
        notes: [],
        expectedFolderCount: 1,
        expectedNoteCount: 0
      },
      {
        folders: [folder({ nameDecryptionFailed: true })],
        notes: [],
        expectedFolderCount: 1,
        expectedNoteCount: 0
      },
      {
        folders: [],
        notes: [note({ ownerUid: "user-b" })],
        expectedFolderCount: 0,
        expectedNoteCount: 1
      },
      {
        folders: [],
        notes: [note({ isDeleted: true })],
        expectedFolderCount: 0,
        expectedNoteCount: 1
      },
      {
        folders: [],
        notes: [note({ folderId: "missing-folder" })],
        expectedFolderCount: 0,
        expectedNoteCount: 1
      }
    ];

    for (const migrationCase of cases) {
      await expect(migrateVaultNameReservations({
        ...migrationCase,
        privateKey,
        profile,
        vaultIntegrityKey
      })).rejects.toThrow();
    }

    expect(mocks.saveEntry).not.toHaveBeenCalled();
    expect(mocks.updateFolder).not.toHaveBeenCalled();
    expect(mocks.migrateFolder).not.toHaveBeenCalled();
  });

  it("defers a historical shared note with a folder for owner recovery instead of locking the whole cutover", async () => {
    const invalidShared = note({
      folderId: "folder-a",
      id: "legacy-shared-folder",
      participantUids: ["user-a", "user-b"],
      type: "shared"
    });
    const result = await migrateVaultNameReservations({
      folders: [folder()],
      notes: [invalidShared],
      privateKey,
      profile,
      expectedFolderCount: 1,
      expectedNoteCount: 1,
      vaultIntegrityKey
    });

    expect(result).toMatchObject({ completed: 1, migrated: 1, total: 2 });
    expect(result.deferredTargetIds).toEqual(["legacy-shared-folder"]);
    expect(mocks.saveEntry).not.toHaveBeenCalled();
  });

  it("includes active owner-owned shared Vault entries in the reservation audit", async () => {
    const shared = note({
      id: "shared-note",
      participantUids: ["user-a", "user-b"],
      type: "shared",
      wrappedKeys: { "user-a": wrappedKey, "user-b": wrappedKey }
    });

    const result = await migrateVaultNameReservations({
      folders: [],
      notes: [shared],
      privateKey,
      profile,
      expectedFolderCount: 0,
      expectedNoteCount: 1,
      vaultIntegrityKey
    });

    expect(result).toMatchObject({ completed: 1, migrated: 1, skipped: 0 });
    expect(mocks.saveEntry).toHaveBeenCalledWith(shared, "user-a", privateKey, vaultIntegrityKey);
  });

  it("defers a duplicate folder subtree while reserving its sibling winner", async () => {
    const winner = folder({ id: "winner" });
    const duplicate = folder({ id: "duplicate", displayName: "project" });
    const child = folder({ id: "child", displayName: "Child", parentId: "duplicate" });
    const nestedNote = note({ id: "nested-note", folderId: "child" });

    const result = await migrateVaultNameReservations({
      folders: [winner, duplicate, child],
      notes: [nestedNote],
      privateKey,
      profile,
      expectedFolderCount: 3,
      expectedNoteCount: 1,
      vaultIntegrityKey
    });

    expect(result.collisions).toHaveLength(1);
    expect(result.deferredTargetIds).toEqual(["duplicate", "child", "nested-note"]);
    expect(result).toMatchObject({ completed: 1, migrated: 1, total: 4 });
    expect(mocks.updateFolder).toHaveBeenCalledWith(expect.objectContaining({ folderId: "winner" }));
    expect(mocks.updateFolder).not.toHaveBeenCalledWith(expect.objectContaining({ folderId: "duplicate" }));
    expect(mocks.updateFolder).not.toHaveBeenCalledWith(expect.objectContaining({ folderId: "child" }));
    expect(mocks.saveEntry).not.toHaveBeenCalled();
  });

  it("backfills encrypted and legacy targets through revision-aware APIs", async () => {
    const progress = vi.fn();
    const result = await migrateVaultNameReservations({
      folders: [folder(), folder({ displayName: "Archive", encryptedName: undefined, id: "legacy-folder", name: "Archive", wrappedKey: undefined })],
      notes: [note(), note({ contentFormat: "legacy-html-v1", entryKind: "legacy-html", id: "legacy-note", title: "Legacy" })],
      onProgress: progress,
      privateKey,
      profile,
      expectedFolderCount: 2,
      expectedNoteCount: 2,
      vaultIntegrityKey
    });

    expect(result).toMatchObject({ completed: 4, migrated: 4, skipped: 0 });
    expect(result.deferredTargetIds).toEqual([]);
    expect(mocks.updateFolder).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 1,
      folderId: "folder-a",
      nameClaim: expect.objectContaining({ indexVersion: 1, parentId: null })
    }));
    expect(mocks.migrateFolder).toHaveBeenCalledWith(
      profile,
      vaultIntegrityKey,
      expect.objectContaining({ id: "legacy-folder" }),
      expect.any(Number)
    );
    expect(mocks.saveEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-a" }),
      "user-a",
      privateKey,
      vaultIntegrityKey
    );
    expect(mocks.saveEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "legacy-note" }),
      "user-a",
      privateKey,
      vaultIntegrityKey
    );
    expect(progress).toHaveBeenLastCalledWith({ completed: 4, migrated: 4, skipped: 0, total: 4 });
  });

  it("migrates nested legacy folders parent-first and preserves each parent claim scope", async () => {
    const child = folder({
      displayName: "Child",
      encryptedName: undefined,
      id: "legacy-child",
      name: "Child",
      order: 1,
      parentId: "legacy-parent",
      wrappedKey: undefined
    });
    const parent = folder({
      displayName: "Parent",
      encryptedName: undefined,
      id: "legacy-parent",
      name: "Parent",
      order: 0,
      wrappedKey: undefined
    });

    await migrateVaultNameReservations({
      folders: [child, parent],
      notes: [],
      privateKey,
      profile,
      expectedFolderCount: 2,
      expectedNoteCount: 0,
      vaultIntegrityKey
    });

    expect(mocks.migrateFolder.mock.calls.map((call) => call[2].id)).toEqual([
      "legacy-parent",
      "legacy-child"
    ]);
    expect(mocks.migrateFolder.mock.calls[1][2]).toMatchObject({ parentId: "legacy-parent" });
  });

  it("is restartable because already matching deterministic claims are skipped", async () => {
    const first = folder();
    const initial = await migrateVaultNameReservations({
      folders: [first],
      notes: [],
      privateKey,
      profile,
      expectedFolderCount: 1,
      expectedNoteCount: 0,
      vaultIntegrityKey
    });
    const claimId = mocks.updateFolder.mock.calls[0][0].nameClaim.claimId as string;
    vi.clearAllMocks();

    const retry = await migrateVaultNameReservations({
      folders: [{ ...first, vaultNameClaimId: claimId, vaultNameIndexVersion: 1 }],
      notes: [],
      privateKey,
      profile,
      expectedFolderCount: 1,
      expectedNoteCount: 0,
      vaultIntegrityKey
    });

    expect(initial.migrated).toBe(1);
    expect(retry).toMatchObject({ completed: 1, migrated: 0, skipped: 1 });
    expect(mocks.updateFolder).not.toHaveBeenCalled();
  });

  it("repairs a missing claim document even when the entry metadata already has the deterministic id", async () => {
    const current = note();
    mocks.claimMatches.mockResolvedValue(false);

    const fingerprint = await vaultNameFingerprint(vaultIntegrityKey, {
      kind: current.entryKind,
      name: current.title,
      parentId: null,
      targetType: "entry"
    });
    await migrateVaultNameReservations({
      folders: [],
      notes: [{ ...current, vaultNameClaimId: fingerprint, vaultNameIndexVersion: 1 }],
      privateKey,
      profile,
      expectedFolderCount: 0,
      expectedNoteCount: 1,
      vaultIntegrityKey
    });

    expect(mocks.saveEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-a", vaultNameClaimId: fingerprint }),
      "user-a",
      privateKey,
      vaultIntegrityKey,
      true
    );
  });
});
