import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteFolderSnapshot, NoteSnapshot } from "../../services/notes";
import {
  decryptVaultFolders,
  decryptVaultNotes,
  migrateLegacyVaultFolder,
  type DecryptedVaultNote,
  vaultEntryStorageIdentityState
} from "./vaultData";
import { resolveVaultFolderNameCollision } from "./vaultFolderCollisionRecovery";
import { vaultNameFingerprint } from "./vaultIntegrity";

const mocks = vi.hoisted(() => ({
  decryptText: vi.fn(),
  encryptText: vi.fn(),
  generateNoteKey: vi.fn(),
  migrateLegacyNoteFolder: vi.fn(),
  resolveEncryptedNoteFolderCollision: vi.fn(),
  resolveLegacyNoteFolderCollision: vi.fn(),
  unwrapNoteKey: vi.fn(),
  wrapNoteKey: vi.fn()
}));

vi.mock("../../lib/crypto", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/crypto")>(),
  decryptText: mocks.decryptText,
  encryptText: mocks.encryptText,
  generateNoteKey: mocks.generateNoteKey,
  unwrapNoteKey: mocks.unwrapNoteKey,
  wrapNoteKey: mocks.wrapNoteKey
}));

vi.mock("../../services/notes", () => ({
  createEncryptedNoteFolder: vi.fn(),
  migrateLegacyNoteFolder: mocks.migrateLegacyNoteFolder,
  resolveEncryptedNoteFolderCollision: mocks.resolveEncryptedNoteFolderCollision,
  resolveLegacyNoteFolderCollision: mocks.resolveLegacyNoteFolderCollision,
  updateEncryptedNoteFolder: vi.fn()
}));

const encryptedName = {
  algorithm: "AES-GCM" as const,
  cipherText: "encrypted-name",
  iv: "iv",
  version: 1 as const
};
const wrappedKey = {
  algorithm: "RSA-OAEP" as const,
  version: 1 as const,
  wrappedKey: "wrapped-folder-key"
};

describe("Vault folder persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decryptText.mockImplementation(async (payload: { cipherText: string }) => `plain:${payload.cipherText}`);
    mocks.generateNoteKey.mockResolvedValue({ kind: "folder-key" } as unknown as CryptoKey);
    mocks.encryptText.mockResolvedValue(encryptedName);
    mocks.wrapNoteKey.mockResolvedValue(wrappedKey);
    mocks.migrateLegacyNoteFolder.mockResolvedValue({ folderId: "child", revision: 1 });
    mocks.resolveEncryptedNoteFolderCollision.mockResolvedValue({ folderId: "duplicate", revision: 2 });
    mocks.resolveLegacyNoteFolderCollision.mockResolvedValue({ folderId: "duplicate", revision: 1 });
    mocks.unwrapNoteKey.mockResolvedValue({ kind: "folder-key" } as unknown as CryptoKey);
  });

  it("preserves a nested legacy folder parent in both its blinded claim and migration transaction", async () => {
    const vaultIntegrityKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    const folder = {
      color: "#7c5cff",
      id: "child",
      name: "Child",
      order: 4,
      ownerUid: "user-a",
      parentId: "parent"
    } as NoteFolderSnapshot;
    const expectedClaimId = await vaultNameFingerprint(vaultIntegrityKey, {
      name: "Child",
      parentId: "parent",
      targetType: "folder"
    });

    await migrateLegacyVaultFolder(
      { publicKeyJwk: { kty: "RSA" }, uid: "user-a" },
      vaultIntegrityKey,
      folder,
      4
    );

    expect(mocks.migrateLegacyNoteFolder).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "child",
      parentId: "parent",
      nameClaim: {
        claimId: expectedClaimId,
        indexVersion: 1,
        parentId: "parent"
      }
    }));
  });

  it("recovers a legacy collision by encrypting the replacement name and moving its claim atomically", async () => {
    const vaultIntegrityKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    const folder = {
      color: "#7c5cff",
      id: "duplicate",
      name: "Project",
      order: 3,
      ownerUid: "user-a",
      parentId: null
    } as NoteFolderSnapshot;
    const expectedClaimId = await vaultNameFingerprint(vaultIntegrityKey, {
      name: "Project archive",
      parentId: "archive",
      targetType: "folder"
    });

    await migrateLegacyVaultFolder(
      { publicKeyJwk: { kty: "RSA" }, uid: "user-a" },
      vaultIntegrityKey,
      folder,
      3,
      { replacementName: " Project archive ", targetParentId: "archive" }
    );

    expect(mocks.encryptText).toHaveBeenCalledWith("Project archive", expect.anything());
    expect(mocks.resolveLegacyNoteFolderCollision).toHaveBeenCalledWith(expect.objectContaining({
      encryptedName,
      expectedName: "Project",
      folderId: "duplicate",
      parentId: "archive",
      nameClaim: {
        claimId: expectedClaimId,
        indexVersion: 1,
        parentId: "archive"
      }
    }));
  });

  it("resolves an encrypted folder collision through the dedicated atomic mutation", async () => {
    const vaultIntegrityKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    const expectedClaimId = await vaultNameFingerprint(vaultIntegrityKey, {
      name: "Project archive",
      parentId: "archive",
      targetType: "folder"
    });

    await resolveVaultFolderNameCollision({
      color: "#7c5cff",
      displayName: "Project",
      encryptedName,
      id: "duplicate",
      name: "암호화 폴더",
      order: 3,
      ownerUid: "user-a",
      parentId: null,
      revision: 1,
      wrappedKey
    }, { publicKeyJwk: {}, uid: "user-a" }, { kind: "private" } as unknown as CryptoKey, vaultIntegrityKey, {
      name: " Project archive ",
      parentId: "archive"
    });

    expect(mocks.resolveEncryptedNoteFolderCollision).toHaveBeenCalledWith({
      encryptedName,
      expectedRevision: 1,
      folderId: "duplicate",
      nameClaim: {
        claimId: expectedClaimId,
        indexVersion: 1,
        parentId: "archive"
      },
      ownerUid: "user-a",
      parentId: "archive"
    });
  });

  it("routes a deferred legacy folder collision through atomic encryption migration", async () => {
    const vaultIntegrityKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    await resolveVaultFolderNameCollision({
      color: "#7c5cff",
      displayName: "Project",
      id: "legacy-duplicate",
      name: "Project",
      order: 7,
      ownerUid: "user-a",
      parentId: null
    }, { publicKeyJwk: { kty: "RSA" }, uid: "user-a" },
    { kind: "private" } as unknown as CryptoKey, vaultIntegrityKey, {
      name: "Project archive",
      parentId: "archive"
    });

    expect(mocks.resolveLegacyNoteFolderCollision).toHaveBeenCalledWith(expect.objectContaining({
      expectedName: "Project",
      folderId: "legacy-duplicate",
      order: 7,
      parentId: "archive"
    }));
    expect(mocks.migrateLegacyNoteFolder).not.toHaveBeenCalled();
    expect(mocks.resolveEncryptedNoteFolderCollision).not.toHaveBeenCalled();
  });

  it("marks an encrypted folder decryption failure so migration cannot fingerprint placeholder text", async () => {
    mocks.unwrapNoteKey.mockRejectedValueOnce(new Error("corrupt wrapped key"));

    const result = await decryptVaultFolders([{
      color: "#7c5cff",
      encryptedName,
      id: "folder-a",
      name: "암호화 폴더",
      ownerUid: "user-a",
      parentId: null,
      revision: 1,
      wrappedKey
    } as NoteFolderSnapshot], "user-a", { kind: "private" } as unknown as CryptoKey);

    expect(result).toEqual([
      expect.objectContaining({
        displayName: "복호화할 수 없는 폴더",
        id: "folder-a",
        nameDecryptionFailed: true
      })
    ]);
  });
});

describe("Vault note server snapshot decryption reuse", () => {
  const encryptedTitle = {
    algorithm: "AES-GCM" as const,
    cipherText: "encrypted-title",
    iv: "title-iv",
    version: 1 as const
  };
  const encryptedBody = {
    algorithm: "AES-GCM" as const,
    cipherText: "encrypted-body",
    iv: "body-iv",
    version: 1 as const
  };
  const noteWrappedKey = {
    algorithm: "RSA-OAEP" as const,
    version: 1 as const,
    wrappedKey: "wrapped-note-key"
  };

  function serverNote(overrides: Record<string, unknown> = {}) {
    return {
      contentFormat: "markdown-v1",
      encryptedBody,
      encryptedTitle,
      entryKind: "markdown",
      folderId: "server-folder",
      id: "note-a",
      isDeleted: false,
      ownerUid: "user-a",
      participantUids: ["user-a"],
      revision: 7,
      type: "personal",
      updatedBy: "user-a",
      wrappedKeys: { "user-a": noteWrappedKey },
      ...overrides
    } as NoteSnapshot;
  }

  function reusableNote(overrides: Record<string, unknown> = {}) {
    return {
      ...serverNote({ folderId: "subscription-folder" }),
      body: "already decrypted body",
      title: "already decrypted title",
      ...overrides
    } as DecryptedVaultNote;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decryptText.mockImplementation(async (payload: { cipherText: string }) => `plain:${payload.cipherText}`);
    mocks.unwrapNoteKey.mockResolvedValue({ kind: "note-key" } as unknown as CryptoKey);
  });

  it("reuses plaintext for an exact authoritative revision, identity, ciphertext, and wrapped key", async () => {
    const result = await decryptVaultNotes(
      [serverNote()],
      "user-a",
      { kind: "private" } as unknown as CryptoKey,
      { reusableNotes: [reusableNote()] }
    );

    expect(result).toEqual([expect.objectContaining({
      body: "already decrypted body",
      folderId: "server-folder",
      title: "already decrypted title"
    })]);
    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(mocks.decryptText).not.toHaveBeenCalled();
  });

  it.each([
    ["revision", { revision: 8 }],
    ["storage identity", { contentFormat: "legacy-html-v1", entryKind: "legacy-html" }],
    ["body ciphertext", { encryptedBody: { ...encryptedBody, cipherText: "changed-body" } }],
    ["wrapped key", { wrappedKeys: { "user-a": { ...noteWrappedKey, wrappedKey: "changed-key" } } }]
  ])("decrypts the backend payload again when %s differs", async (_label, serverOverrides) => {
    const result = await decryptVaultNotes(
      [serverNote(serverOverrides)],
      "user-a",
      { kind: "private" } as unknown as CryptoKey,
      { reusableNotes: [reusableNote()] }
    );

    expect(result).toHaveLength(1);
    expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce();
    expect(mocks.decryptText).toHaveBeenCalledTimes(2);
  });

  it("eliminates all repeated crypto work for an unchanged large server snapshot", async () => {
    const count = 200;
    const snapshots = Array.from({ length: count }, (_, index) => serverNote({ id: `note-${index}` }));
    const reusable = snapshots.map((note, index) => reusableNote({
      ...note,
      body: `body-${index}`,
      title: `title-${index}`
    }));

    const baseline = await decryptVaultNotes(
      snapshots,
      "user-a",
      { kind: "private" } as unknown as CryptoKey
    );
    expect(baseline).toHaveLength(count);
    expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(count);
    expect(mocks.decryptText).toHaveBeenCalledTimes(count * 2);

    mocks.unwrapNoteKey.mockClear();
    mocks.decryptText.mockClear();
    const result = await decryptVaultNotes(
      snapshots,
      "user-a",
      { kind: "private" } as unknown as CryptoKey,
      { reusableNotes: reusable }
    );

    expect(result).toHaveLength(count);
    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(mocks.decryptText).not.toHaveBeenCalled();
  });
});

describe("Vault entry storage identity", () => {
  it("distinguishes raw legacy absence from explicit and partial identities", () => {
    expect(vaultEntryStorageIdentityState({})).toBe("legacy-missing");
    expect(vaultEntryStorageIdentityState({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html"
    })).toBe("explicit");
    expect(vaultEntryStorageIdentityState({
      contentFormat: "markdown-v1",
      entryKind: "markdown"
    })).toBe("explicit");
    expect(vaultEntryStorageIdentityState({
      contentFormat: "legacy-html-v1"
    })).toBe("invalid");
    expect(vaultEntryStorageIdentityState({
      contentFormat: "markdown-v1",
      entryKind: "canvas"
    })).toBe("invalid");
  });
});
