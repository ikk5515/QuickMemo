import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecryptedVaultFolder } from "./vaultData";
import {
  createVaultPastedImageFolderLeaseCoordinator,
  createVaultPastedImageFolderCoordinator,
  findVaultPastedImageFolder,
  vaultPendingPastedImageFolderIds,
  VAULT_PASTED_IMAGE_FOLDER_LOCK_RENEWAL_MS,
  VAULT_PASTED_IMAGE_FOLDER_NAME
} from "./vaultPastedImageFolder";

function folder(overrides: Partial<DecryptedVaultFolder> = {}) {
  return {
    color: "#7c5cff",
    displayName: VAULT_PASTED_IMAGE_FOLDER_NAME,
    id: "folder-a",
    name: "Encrypted Vault Folder",
    ownerUid: "user-a",
    parentId: null,
    revision: 1,
    ...overrides
  } as DecryptedVaultFolder;
}

describe("Vault pasted image folder", () => {
  afterEach(() => vi.useRealTimers());

  it("reuses only the active decrypted owner root folder", () => {
    const target = findVaultPastedImageFolder([
      folder({ id: "nested", parentId: "parent" }),
      folder({ id: "other-owner", ownerUid: "user-b" }),
      folder({ id: "deleted", isDeleted: true }),
      folder({ id: "failed", nameDecryptionFailed: true }),
      folder({ id: "target" })
    ], "user-a");

    expect(target).toEqual({
      folderId: "target",
      folderPath: VAULT_PASTED_IMAGE_FOLDER_NAME,
      folderRevision: 1
    });
  });

  it("fails closed when two active root folders resolve to the dedicated name", () => {
    expect(() => findVaultPastedImageFolder([
      folder({ id: "folder-a" }),
      folder({ id: "folder-b" })
    ], "user-a")).toThrow("중복");
  });

  it("collects pending destination folders in one pass", () => {
    expect(vaultPendingPastedImageFolderIds(
      [{ folderId: "reserved" }, { folderId: null }],
      new Set(["asset-a", "missing"]),
      [
        { folderId: "created", id: "asset-a" },
        { folderId: "ignored", id: "asset-b" }
      ]
    )).toEqual(new Set(["reserved", "created"]));
  });

  it("single-flights creation and bridges the encrypted subscription delay", async () => {
    const folders: DecryptedVaultFolder[] = [];
    let finishCreation!: (value: { id: string }) => void;
    const createFolder = vi.fn(() => new Promise<{ id: string }>((resolve) => {
      finishCreation = resolve;
    }));
    const coordinator = createVaultPastedImageFolderCoordinator();
    const input = {
      createFolder,
      getFolders: () => folders,
      ownerUid: "user-a",
      signal: new AbortController().signal
    };

    const first = coordinator.ensure(input);
    const second = coordinator.ensure(input);
    expect(createFolder).toHaveBeenCalledOnce();
    finishCreation({ id: "created-folder" });

    await expect(first).resolves.toEqual({
      folderId: "created-folder",
      folderPath: VAULT_PASTED_IMAGE_FOLDER_NAME,
      folderRevision: 1
    });
    await expect(second).resolves.toEqual({
      folderId: "created-folder",
      folderPath: VAULT_PASTED_IMAGE_FOLDER_NAME,
      folderRevision: 1
    });
    await expect(coordinator.ensure(input)).resolves.toMatchObject({ folderId: "created-folder" });
    expect(createFolder).toHaveBeenCalledOnce();
  });

  it("does not let one cancelled editor cancel the shared folder creation", async () => {
    let finishCreation!: (value: { id: string }) => void;
    const createFolder = vi.fn(() => new Promise<{ id: string }>((resolve) => {
      finishCreation = resolve;
    }));
    const coordinator = createVaultPastedImageFolderCoordinator();
    const firstController = new AbortController();
    const common = {
      createFolder,
      getFolders: () => [] as DecryptedVaultFolder[],
      ownerUid: "user-a"
    };
    const first = coordinator.ensure({ ...common, signal: firstController.signal });
    const second = coordinator.ensure({ ...common, signal: new AbortController().signal });

    firstController.abort(new DOMException("cancelled", "AbortError"));
    finishCreation({ id: "created-folder" });

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({ folderId: "created-folder" });
    expect(createFolder).toHaveBeenCalledOnce();
  });

  it("rejects a cached destination after the observed folder is renamed", async () => {
    const folders: DecryptedVaultFolder[] = [];
    const coordinator = createVaultPastedImageFolderCoordinator();
    const common = {
      createFolder: vi.fn().mockResolvedValue({ id: "created-folder" }),
      getFolders: () => folders,
      ownerUid: "user-a"
    };
    const target = await coordinator.ensure({
      ...common,
      signal: new AbortController().signal
    });
    expect(coordinator.isCurrent(common, target)).toBe(true);

    folders.push(folder({ displayName: "이름 변경됨", id: "created-folder" }));
    expect(coordinator.isCurrent(common, target)).toBe(false);
  });

  it("shares one server lease until every concurrent paste releases its holder", async () => {
    const acquireLock = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn().mockResolvedValue(undefined);
    const coordinator = createVaultPastedImageFolderLeaseCoordinator(
      () => `vpl1_${"A".repeat(43)}`
    );
    const input = {
      acquireLock,
      releaseLock,
      shouldRetryLockError: () => true,
      signal: new AbortController().signal,
      target: {
        folderId: "folder-a",
        folderPath: VAULT_PASTED_IMAGE_FOLDER_NAME,
        folderRevision: 1
      }
    };

    const first = await coordinator.acquire(input);
    const second = await coordinator.acquire(input);

    expect(first.lockId).toBe(second.lockId);
    expect(first.holderId).not.toBe(second.holderId);
    expect(acquireLock).toHaveBeenCalledOnce();
    await coordinator.release(first);
    expect(releaseLock).not.toHaveBeenCalled();
    await coordinator.release(first);
    expect(releaseLock).not.toHaveBeenCalled();
    await coordinator.release(second);
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("re-acquires the same lock id after an ambiguous release", async () => {
    const acquireLock = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(undefined);
    const coordinator = createVaultPastedImageFolderLeaseCoordinator(
      () => `vpl1_${"B".repeat(43)}`
    );
    const input = {
      acquireLock,
      releaseLock,
      shouldRetryLockError: () => true,
      signal: new AbortController().signal,
      target: {
        folderId: "folder-a",
        folderPath: VAULT_PASTED_IMAGE_FOLDER_NAME,
        folderRevision: 1
      }
    };
    const first = await coordinator.acquire(input);

    await expect(coordinator.release(first)).rejects.toThrow("lost response");
    const second = await coordinator.acquire(input);

    expect(second.lockId).toBe(first.lockId);
    expect(acquireLock).toHaveBeenCalledTimes(2);
    await expect(coordinator.release(second)).resolves.toBeUndefined();
  });

  it("automatically retries an ambiguous final release without dropping a later holder", async () => {
    vi.useFakeTimers();
    const acquireLock = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue(undefined);
    const createLockId = vi.fn()
      .mockReturnValueOnce(`vpl1_${"D".repeat(43)}`)
      .mockReturnValueOnce(`vpl1_${"E".repeat(43)}`);
    const coordinator = createVaultPastedImageFolderLeaseCoordinator(createLockId);
    const input = {
      acquireLock,
      releaseLock,
      shouldRetryLockError: () => true,
      signal: new AbortController().signal,
      target: {
        folderId: "folder-a",
        folderPath: VAULT_PASTED_IMAGE_FOLDER_NAME,
        folderRevision: 1
      }
    };
    const lease = await coordinator.acquire(input);

    await expect(coordinator.release(lease)).rejects.toThrow("lost response");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(releaseLock).toHaveBeenCalledTimes(2);
    const next = await coordinator.acquire(input);
    expect(next.lockId).not.toBe(lease.lockId);
    await coordinator.release(next);
  });

  it("renews an active lease before its server TTL can expire", async () => {
    vi.useFakeTimers();
    const acquireLock = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn().mockResolvedValue(undefined);
    const coordinator = createVaultPastedImageFolderLeaseCoordinator(
      () => `vpl1_${"C".repeat(43)}`
    );
    const input = {
      acquireLock,
      releaseLock,
      shouldRetryLockError: () => true,
      signal: new AbortController().signal,
      target: {
        folderId: "folder-a",
        folderPath: VAULT_PASTED_IMAGE_FOLDER_NAME,
        folderRevision: 1
      }
    };
    const lease = await coordinator.acquire(input);

    await vi.advanceTimersByTimeAsync(VAULT_PASTED_IMAGE_FOLDER_LOCK_RENEWAL_MS);
    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(acquireLock.mock.calls[1]?.[0]).toMatchObject({ lockId: lease.lockId });

    await coordinator.release(lease);
    await vi.advanceTimersByTimeAsync(VAULT_PASTED_IMAGE_FOLDER_LOCK_RENEWAL_MS);
    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("reconfirms the same server lease immediately before a source commit", async () => {
    const acquireLock = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn().mockResolvedValue(undefined);
    const coordinator = createVaultPastedImageFolderLeaseCoordinator(
      () => `vpl1_${"R".repeat(43)}`
    );
    const lease = await coordinator.acquire({
      acquireLock,
      releaseLock,
      shouldRetryLockError: () => true,
      signal: new AbortController().signal,
      target: {
        folderId: "folder-a",
        folderPath: VAULT_PASTED_IMAGE_FOLDER_NAME,
        folderRevision: 1
      }
    });

    await coordinator.confirm(lease);

    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(acquireLock.mock.calls[1]?.[0]).toMatchObject({
      folderId: "folder-a",
      folderRevision: 1,
      lockId: lease.lockId
    });
    await coordinator.release(lease);
  });

  it("does not postpone the heartbeat when another paste joins the active lease", async () => {
    vi.useFakeTimers();
    const acquireLock = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn().mockResolvedValue(undefined);
    const coordinator = createVaultPastedImageFolderLeaseCoordinator(
      () => `vpl1_${"F".repeat(43)}`
    );
    const input = {
      acquireLock,
      releaseLock,
      shouldRetryLockError: () => true,
      signal: new AbortController().signal,
      target: {
        folderId: "folder-a",
        folderPath: VAULT_PASTED_IMAGE_FOLDER_NAME,
        folderRevision: 1
      }
    };
    const first = await coordinator.acquire(input);
    await vi.advanceTimersByTimeAsync(VAULT_PASTED_IMAGE_FOLDER_LOCK_RENEWAL_MS - 1_000);
    const second = await coordinator.acquire(input);
    expect(acquireLock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(acquireLock).toHaveBeenCalledTimes(2);

    await coordinator.release(first);
    await coordinator.release(second);
  });
});
