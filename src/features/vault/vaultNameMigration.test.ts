import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "./vaultData";
import { VaultNameConflictError } from "../../services/notes";
import { vaultNameFingerprint } from "./vaultIntegrity";
import {
  auditVaultNameReservations,
  migrateVaultNameReservations,
  preflightVaultNameCutover,
  VaultNameReservationMigrationConflictError,
  type VaultNameReservationMigrationInput
} from "./vaultNameMigration";

const mocks = vi.hoisted(() => ({
  claimMatches: vi.fn(),
  decryptFolders: vi.fn(),
  decryptNotes: vi.fn(),
  migrateEntry: vi.fn(),
  migrateFolder: vi.fn(),
  saveEntry: vi.fn(),
  updateFolder: vi.fn()
}));

vi.mock("../../services/notes", () => ({
  updateEncryptedNoteFolder: mocks.updateFolder,
  VaultNameConflictError: class VaultNameConflictError extends Error {
    readonly claimId: string;

    constructor(claimId: string) {
      super("같은 위치에 동일한 이름의 Vault 항목이 있습니다.");
      this.name = "VaultNameConflictError";
      this.claimId = claimId;
    }
  },
  vaultNameClaimReservationMatches: mocks.claimMatches
}));
vi.mock("./vaultData", async (importOriginal) => ({
  ...await importOriginal<typeof import("./vaultData")>(),
  decryptVaultFolders: mocks.decryptFolders,
  decryptVaultNotes: mocks.decryptNotes,
  migrateLegacyVaultFolder: mocks.migrateFolder
}));
vi.mock("./vaultPersistence", () => ({
  backfillVaultEntryNameClaim: mocks.saveEntry,
  migrateLegacyVaultEntryIdentity: mocks.migrateEntry
}));

const privateKey = { kind: "private" } as unknown as CryptoKey;
let vaultIntegrityKey: CryptoKey;
const encryptedPayload = { algorithm: "AES-GCM" as const, cipherText: "cipher", iv: "iv", version: 1 as const };
const wrappedKey = { algorithm: "RSA-OAEP" as const, version: 1 as const, wrappedKey: "wrapped" };
const profile = { publicKeyJwk: { kty: "RSA" }, uid: "user-a" };
const cutoverLease = {
  leaseGeneration: "g".repeat(43),
  leaseId: "l".repeat(43)
};

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

function migrate(
  input: Omit<
    VaultNameReservationMigrationInput,
    "cutoverLease" | "deletedNotes" | "expectedDeletedNoteCount" | "legacyActiveNoteIds" | "legacyDeletedNoteIds"
  > & Partial<Pick<
    VaultNameReservationMigrationInput,
    "deletedNotes" | "expectedDeletedNoteCount" | "legacyActiveNoteIds" | "legacyDeletedNoteIds"
  >>
) {
  return migrateVaultNameReservations({
    cutoverLease,
    deletedNotes: [],
    expectedDeletedNoteCount: 0,
    legacyActiveNoteIds: new Set(),
    legacyDeletedNoteIds: new Set(),
    ...input
  });
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
    mocks.decryptFolders.mockImplementation(async (items: DecryptedVaultFolder[]) => items);
    mocks.decryptNotes.mockImplementation(async (items: DecryptedVaultNote[]) => items.map((item) => ({
      ...item,
      contentFormat: item.contentFormat ?? "legacy-html-v1",
      entryKind: item.entryKind ?? "legacy-html"
    })));
    mocks.migrateEntry.mockImplementation(async (target: DecryptedVaultNote, _uid: string, _key: CryptoKey, reserve: boolean) => ({
      claimState: target.isDeleted === true ? "deleted" : reserve ? "reserved" : "deferred",
      noteId: target.id,
      revision: (target.revision ?? 0) + 1
    }));
    mocks.claimMatches.mockResolvedValue(true);
    mocks.updateFolder.mockResolvedValue({ folderId: "folder-a", revision: 2 });
    mocks.migrateFolder.mockResolvedValue({ folderId: "legacy-folder", revision: 1 });
  });

  it("reserves the deterministic collision winner and defers only the duplicate", async () => {
    const result = await migrate({
      folders: [],
      notes: [note({ id: "first" }), note({ id: "duplicate", title: "note.md" })],
      privateKey,
      profile,
      expectedFolderCount: 0,
      expectedNoteCount: 2,
      vaultIntegrityKey
    });

    expect(result.collisions).toHaveLength(1);
    expect(result).toMatchObject({ completed: 2, migrated: 1, skipped: 1, total: 2 });
    expect(result.deferredTargetIds).toEqual(["duplicate"]);
    expect(mocks.saveEntry).toHaveBeenCalledOnce();
    expect(mocks.saveEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "first" }),
      "user-a",
      privateKey,
      vaultIntegrityKey,
      false,
      cutoverLease
    );
    expect(mocks.updateFolder).not.toHaveBeenCalled();
  });

  it("keeps an existing atomic reservation owner as the retry winner", async () => {
    const reserved = note({ id: "already-reserved", title: "note.md" });
    const fingerprint = await vaultNameFingerprint(vaultIntegrityKey, {
      kind: reserved.entryKind,
      name: reserved.title,
      parentId: null,
      targetType: "entry"
    });
    const result = await migrate({
      folders: [],
      notes: [
        note({ id: "new-input-first" }),
        { ...reserved, vaultNameClaimId: fingerprint, vaultNameIndexVersion: 1 }
      ],
      privateKey,
      profile,
      expectedFolderCount: 0,
      expectedNoteCount: 2,
      vaultIntegrityKey
    });

    expect(result.collisions).toEqual([expect.objectContaining({
      duplicateTargetId: "new-input-first",
      firstTargetId: "already-reserved"
    })]);
    expect(result.deferredTargetIds).toEqual(["new-input-first"]);
    expect(result).toMatchObject({ completed: 2, migrated: 0, skipped: 2, total: 2 });
    expect(mocks.claimMatches).toHaveBeenCalledWith(expect.objectContaining({
      claimId: fingerprint,
      targetId: "already-reserved"
    }));
    expect(mocks.saveEntry).not.toHaveBeenCalled();
  });

  it("keeps the affected target actionable when a concurrent reservation wins", async () => {
    mocks.saveEntry.mockRejectedValueOnce(new VaultNameConflictError("A".repeat(43)));

    const migration = migrate({
      folders: [],
      notes: [note({ id: "concurrent-target" })],
      privateKey,
      profile,
      expectedFolderCount: 0,
      expectedNoteCount: 1,
      vaultIntegrityKey
    });

    await expect(migration).rejects.toMatchObject({
      name: "VaultNameReservationMigrationConflictError",
      targetIds: ["concurrent-target"]
    });
    await expect(migration).rejects.toBeInstanceOf(VaultNameReservationMigrationConflictError);
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
      await expect(migrate({
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
    const result = await migrate({
      folders: [folder()],
      notes: [invalidShared],
      privateKey,
      profile,
      expectedFolderCount: 1,
      expectedNoteCount: 1,
      vaultIntegrityKey
    });

    expect(result).toMatchObject({ completed: 2, migrated: 1, skipped: 1, total: 2 });
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

    const result = await migrate({
      folders: [],
      notes: [shared],
      privateKey,
      profile,
      expectedFolderCount: 0,
      expectedNoteCount: 1,
      vaultIntegrityKey
    });

    expect(result).toMatchObject({ completed: 1, migrated: 1, skipped: 0 });
    expect(mocks.saveEntry).toHaveBeenCalledWith(
      shared,
      "user-a",
      privateKey,
      vaultIntegrityKey,
      false,
      cutoverLease
    );
  });

  it("defers a duplicate folder subtree while reserving its sibling winner", async () => {
    const winner = folder({ id: "winner" });
    const duplicate = folder({ id: "duplicate", displayName: "project" });
    const child = folder({ id: "child", displayName: "Child", parentId: "duplicate" });
    const nestedNote = note({ id: "nested-note", folderId: "child" });

    const result = await migrate({
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
    expect(result).toMatchObject({ completed: 4, migrated: 1, skipped: 3, total: 4 });
    expect(mocks.updateFolder).toHaveBeenCalledWith(expect.objectContaining({ folderId: "winner" }));
    expect(mocks.updateFolder).not.toHaveBeenCalledWith(expect.objectContaining({ folderId: "duplicate" }));
    expect(mocks.updateFolder).not.toHaveBeenCalledWith(expect.objectContaining({ folderId: "child" }));
    expect(mocks.saveEntry).not.toHaveBeenCalled();
  });

  it("backfills encrypted and legacy targets through revision-aware APIs", async () => {
    const progress = vi.fn();
    const result = await migrate({
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
      expect.any(Number),
      undefined,
      cutoverLease
    );
    expect(mocks.saveEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-a" }),
      "user-a",
      privateKey,
      vaultIntegrityKey,
      false,
      cutoverLease
    );
    expect(mocks.saveEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "legacy-note" }),
      "user-a",
      privateKey,
      vaultIntegrityKey,
      false,
      cutoverLease
    );
    expect(progress).toHaveBeenLastCalledWith({ completed: 4, migrated: 4, skipped: 0, total: 4 });
  });

  it("bounds independent entry migration writes while avoiding a serial waterfall", async () => {
    let active = 0;
    let maximumActive = 0;
    mocks.saveEntry.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { noteId: "saved", revision: 2 };
    });
    const notes = Array.from({ length: 24 }, (_, index) => note({
      id: `bounded-${index}`,
      title: `Bounded ${index}`
    }));

    const result = await migrate({
      folders: [],
      notes,
      privateKey,
      profile,
      expectedFolderCount: 0,
      expectedNoteCount: notes.length,
      vaultIntegrityKey
    });

    expect(result).toMatchObject({ completed: 24, migrated: 24, skipped: 0 });
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(4);
  });

  it("stops dequeuing the current migration batch when the Vault is locked", async () => {
    const controller = new AbortController();
    let started = 0;
    let releaseWrites: (() => void) | undefined;
    const writeBarrier = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    mocks.saveEntry.mockImplementation(async (...args: unknown[]) => {
      started += 1;
      expect(args[6]).toBe(controller.signal);
      await writeBarrier;
      return { noteId: "saved", revision: 2 };
    });
    const notes = Array.from({ length: 24 }, (_, index) => note({
      id: `cancelled-${index}`,
      title: `Cancelled ${index}`
    }));

    const migration = migrate({
      folders: [],
      notes,
      privateKey,
      profile,
      expectedFolderCount: 0,
      expectedNoteCount: notes.length,
      signal: controller.signal,
      vaultIntegrityKey
    });
    await vi.waitFor(() => expect(started).toBe(4));
    controller.abort();
    releaseWrites?.();

    await expect(migration).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBe(4);
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

    await migrate({
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
    const initial = await migrate({
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

    const retry = await migrate({
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
    await migrate({
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
      true,
      cutoverLease
    );
  });

  it("preflights active and deleted raw identities before the marker and rejects partial identities", async () => {
    const activeLegacy = note({
      contentFormat: undefined,
      entryKind: undefined,
      id: "active-legacy",
      isDeleted: undefined
    });
    const deletedLegacy = note({
      contentFormat: undefined,
      entryKind: undefined,
      id: "deleted-legacy",
      isDeleted: true
    });

    const preflight = await preflightVaultNameCutover({
      activeNotes: [activeLegacy],
      deletedNotes: [deletedLegacy],
      folders: [],
      privateKey,
      uid: profile.uid,
      vaultIntegrityKey
    });

    expect(preflight.legacyActiveNoteIds).toEqual(new Set(["active-legacy"]));
    expect(preflight.legacyDeletedNoteIds).toEqual(new Set(["deleted-legacy"]));
    expect(preflight.activeNotes[0]).toMatchObject({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html"
    });
    await expect(preflightVaultNameCutover({
      activeNotes: [note({ contentFormat: "legacy-html-v1", entryKind: undefined })],
      deletedNotes: [],
      folders: [],
      privateKey,
      uid: profile.uid,
      vaultIntegrityKey
    })).rejects.toThrow("서로 맞지 않는 Vault 저장 형식");
  });

  it("migrates a unique active missing identity together with its deterministic claim", async () => {
    const legacy = note({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      id: "legacy-unique",
      title: "Legacy"
    });

    const result = await migrate({
      folders: [],
      legacyActiveNoteIds: new Set([legacy.id]),
      notes: [legacy],
      privateKey,
      profile,
      expectedFolderCount: 0,
      expectedNoteCount: 1,
      vaultIntegrityKey
    });

    expect(result).toMatchObject({ completed: 1, migrated: 1, skipped: 0 });
    expect(mocks.migrateEntry).toHaveBeenCalledWith(
      legacy,
      profile.uid,
      vaultIntegrityKey,
      true,
      cutoverLease
    );
    expect(mocks.saveEntry).not.toHaveBeenCalled();
  });

  it("gives a legacy collision winner a claim and seals the loser identity-only", async () => {
    const winner = note({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      id: "legacy-first",
      title: "Legacy"
    });
    const loser = note({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      id: "legacy-second",
      title: "legacy"
    });

    const result = await migrate({
      folders: [],
      legacyActiveNoteIds: new Set([winner.id, loser.id]),
      notes: [winner, loser],
      privateKey,
      profile,
      expectedFolderCount: 0,
      expectedNoteCount: 2,
      vaultIntegrityKey
    });

    expect(result.deferredTargetIds).toEqual([loser.id]);
    expect(mocks.migrateEntry).toHaveBeenCalledWith(
      winner,
      profile.uid,
      vaultIntegrityKey,
      true,
      cutoverLease
    );
    expect(mocks.migrateEntry).toHaveBeenCalledWith(
      loser,
      profile.uid,
      vaultIntegrityKey,
      false,
      cutoverLease
    );
  });

  it("seals a deleted legacy identity without reserving its name", async () => {
    const deleted = note({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      id: "legacy-trash",
      isDeleted: true,
      title: "Trash"
    });

    const result = await migrate({
      deletedNotes: [deleted],
      expectedDeletedNoteCount: 1,
      expectedFolderCount: 0,
      expectedNoteCount: 0,
      folders: [],
      legacyDeletedNoteIds: new Set([deleted.id]),
      notes: [],
      privateKey,
      profile,
      vaultIntegrityKey
    });

    expect(result).toMatchObject({ completed: 1, migrated: 1, skipped: 0 });
    expect(mocks.migrateEntry).toHaveBeenCalledWith(
      deleted,
      profile.uid,
      vaultIntegrityKey,
      false,
      cutoverLease
    );
  });

  it("audits active claims, deferred identity-only entries, and released trash claims", async () => {
    const active = note();
    const duplicate = note({ id: "duplicate", title: "note.md" });
    const deleted = note({
      id: "deleted",
      isDeleted: true,
      vaultNameClaimId: "D".repeat(43),
      vaultNameIndexVersion: 1
    });
    mocks.claimMatches.mockImplementation(async (input: { targetId: string }) => input.targetId === active.id);
    const fingerprint = await vaultNameFingerprint(vaultIntegrityKey, {
      kind: active.entryKind,
      name: active.title,
      parentId: null,
      targetType: "entry"
    });

    const result = await auditVaultNameReservations({
      deletedNotes: [deleted],
      expectedDeletedNoteCount: 1,
      expectedFolderCount: 0,
      expectedNoteCount: 2,
      folders: [],
      notes: [
        { ...active, vaultNameClaimId: fingerprint, vaultNameIndexVersion: 1 },
        { ...duplicate, vaultNameClaimId: undefined, vaultNameIndexVersion: undefined }
      ],
      profile,
      vaultIntegrityKey
    });

    expect(result.deferredTargetIds).toEqual([duplicate.id]);
    expect(mocks.claimMatches).toHaveBeenCalledWith(expect.objectContaining({
      targetId: deleted.id,
      targetType: "entry"
    }));

    mocks.claimMatches.mockResolvedValue(true);
    await expect(auditVaultNameReservations({
      deletedNotes: [deleted],
      expectedDeletedNoteCount: 1,
      expectedFolderCount: 0,
      expectedNoteCount: 1,
      folders: [],
      notes: [{ ...active, vaultNameClaimId: fingerprint, vaultNameIndexVersion: 1 }],
      profile,
      vaultIntegrityKey
    })).rejects.toThrow("삭제 Vault 항목의 활성 이름 예약");
  });

  it("rejects malformed deleted and deferred claim metadata instead of treating it as absent", async () => {
    const active = note();
    const duplicate = note({
      id: "duplicate",
      title: "note.md",
      vaultNameClaimId: "",
      vaultNameIndexVersion: undefined
    });
    const fingerprint = await vaultNameFingerprint(vaultIntegrityKey, {
      kind: active.entryKind,
      name: active.title,
      parentId: null,
      targetType: "entry"
    });
    mocks.claimMatches.mockResolvedValue(true);

    await expect(auditVaultNameReservations({
      deletedNotes: [],
      expectedDeletedNoteCount: 0,
      expectedFolderCount: 0,
      expectedNoteCount: 2,
      folders: [],
      notes: [
        { ...active, vaultNameClaimId: fingerprint, vaultNameIndexVersion: 1 },
        duplicate
      ],
      profile,
      vaultIntegrityKey
    })).rejects.toThrow("보류된 Vault");

    await expect(auditVaultNameReservations({
      deletedNotes: [note({
        id: "deleted-partial",
        isDeleted: true,
        vaultNameClaimId: undefined,
        vaultNameIndexVersion: 2 as unknown as 1
      })],
      expectedDeletedNoteCount: 1,
      expectedFolderCount: 0,
      expectedNoteCount: 1,
      folders: [],
      notes: [{ ...active, vaultNameClaimId: fingerprint, vaultNameIndexVersion: 1 }],
      profile,
      vaultIntegrityKey
    })).rejects.toThrow("부분적으로 남아");

    await expect(auditVaultNameReservations({
      deletedNotes: [note({
        id: "deleted-malformed",
        isDeleted: true,
        vaultNameClaimId: "",
        vaultNameIndexVersion: 1
      })],
      expectedDeletedNoteCount: 1,
      expectedFolderCount: 0,
      expectedNoteCount: 1,
      folders: [],
      notes: [{ ...active, vaultNameClaimId: fingerprint, vaultNameIndexVersion: 1 }],
      profile,
      vaultIntegrityKey
    })).rejects.toThrow("metadata가 올바르지");
  });
});
