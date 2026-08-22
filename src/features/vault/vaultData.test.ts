import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteFolderSnapshot } from "../../services/notes";
import { decryptVaultFolders, migrateLegacyVaultFolder } from "./vaultData";
import { vaultNameFingerprint } from "./vaultIntegrity";

const mocks = vi.hoisted(() => ({
  encryptText: vi.fn(),
  generateNoteKey: vi.fn(),
  migrateLegacyNoteFolder: vi.fn(),
  unwrapNoteKey: vi.fn(),
  wrapNoteKey: vi.fn()
}));

vi.mock("../../lib/crypto", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/crypto")>(),
  decryptText: vi.fn(),
  encryptText: mocks.encryptText,
  generateNoteKey: mocks.generateNoteKey,
  unwrapNoteKey: mocks.unwrapNoteKey,
  wrapNoteKey: mocks.wrapNoteKey
}));

vi.mock("../../services/notes", () => ({
  createEncryptedNoteFolder: vi.fn(),
  migrateLegacyNoteFolder: mocks.migrateLegacyNoteFolder,
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
    mocks.generateNoteKey.mockResolvedValue({ kind: "folder-key" } as unknown as CryptoKey);
    mocks.encryptText.mockResolvedValue(encryptedName);
    mocks.wrapNoteKey.mockResolvedValue(wrappedKey);
    mocks.migrateLegacyNoteFolder.mockResolvedValue({ folderId: "child", revision: 1 });
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
    expect(mocks.migrateLegacyNoteFolder).toHaveBeenCalledWith(expect.objectContaining({
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
