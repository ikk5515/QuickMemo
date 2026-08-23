import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DecryptedVaultFolder } from "../features/vault/vaultData";
import {
  DEFAULT_LIBRARY_VAULT_INBOX_NAME,
  ensureLibraryVaultInboxFolder,
  type LibraryVaultInboxDependencies
} from "./libraryVaultInbox";

const profile = { publicKeyJwk: {}, uid: "owner-a" };
const privateKey = {} as CryptoKey;
let vaultIntegrityKey: CryptoKey;

function folder(id: string, name: string, parentId: string | null = null): DecryptedVaultFolder {
  return {
    color: "#7c5cff",
    displayName: name,
    id,
    name: "암호화 폴더",
    order: 1,
    ownerUid: profile.uid,
    parentId
  };
}

function dependencies(snapshots: DecryptedVaultFolder[][]) {
  return {
    createFolder: vi.fn().mockResolvedValue({ folderId: "folder-inbox", revision: 1, treeRevision: 2 }),
    ensureTree: vi.fn().mockResolvedValue({ folderCount: 0, revision: 1, schemaVersion: 1, status: "ready" }),
    readFolders: vi.fn(async () => snapshots.shift() ?? [])
  } satisfies LibraryVaultInboxDependencies;
}

describe("Library Vault Inbox resolver", () => {
  beforeAll(async () => {
    vaultIntegrityKey = await crypto.subtle.generateKey(
      { length: 256, name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"]
    );
  });

  it("reuses a server-confirmed encrypted root Inbox", async () => {
    const mocks = dependencies([[folder("existing", "Inbox")]]);
    await expect(ensureLibraryVaultInboxFolder({
      privateKey, profile, vaultIntegrityKey
    }, mocks)).resolves.toBe("existing");
    expect(mocks.ensureTree).toHaveBeenCalledWith(profile.uid);
    expect(mocks.createFolder).not.toHaveBeenCalled();
  });

  it("creates 00_Inbox through the authoritative folder service and verifies it", async () => {
    const mocks = dependencies([[], [folder("folder-inbox", DEFAULT_LIBRARY_VAULT_INBOX_NAME)]]);
    await expect(ensureLibraryVaultInboxFolder({
      privateKey, profile, vaultIntegrityKey
    }, mocks)).resolves.toBe("folder-inbox");
    expect(mocks.createFolder).toHaveBeenCalledWith(
      profile,
      vaultIntegrityKey,
      DEFAULT_LIBRARY_VAULT_INBOX_NAME,
      null,
      1
    );
    expect(mocks.readFolders).toHaveBeenCalledTimes(2);
  });

  it("accepts a lost create response only after a fresh backend snapshot proves Inbox", async () => {
    const mocks = dependencies([[], [folder("folder-inbox", DEFAULT_LIBRARY_VAULT_INBOX_NAME)]]);
    vi.mocked(mocks.createFolder).mockRejectedValueOnce(new Error("response lost"));
    await expect(ensureLibraryVaultInboxFolder({
      privateKey, profile, vaultIntegrityKey
    }, mocks)).resolves.toBe("folder-inbox");
  });

  it("does not mistake a nested or undecryptable folder for the root Inbox", async () => {
    const undecryptable = { ...folder("broken", "Inbox"), nameDecryptionFailed: true };
    const mocks = dependencies([
      [folder("nested", "Inbox", "parent"), undecryptable],
      [folder("folder-inbox", DEFAULT_LIBRARY_VAULT_INBOX_NAME)]
    ]);
    await expect(ensureLibraryVaultInboxFolder({
      privateKey, profile, vaultIntegrityKey
    }, mocks)).resolves.toBe("folder-inbox");
    expect(mocks.createFolder).toHaveBeenCalledOnce();
  });
});
