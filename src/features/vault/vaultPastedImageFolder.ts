import type { DecryptedVaultFolder } from "./vaultData";
import { canonicalVaultName } from "./vaultIntegrity";
import {
  acquireVaultPastedImageFolderLock,
  releaseVaultPastedImageFolderLock,
  vaultFolderResponseMayHaveBeenLost
} from "../../services/vaultFolderMutations";

export const VAULT_PASTED_IMAGE_FOLDER_NAME = "붙여넣은 이미지";

export interface VaultPastedImageFolderTarget {
  folderId: string;
  folderPath: string;
  folderRevision: number;
}

export interface VaultPastedImageFolderLease extends VaultPastedImageFolderTarget {
  holderId: string;
  lockId: string;
}

export function vaultPendingPastedImageFolderIds(
  reservations: Iterable<{ folderId: string | null }>,
  pendingAssetIds: ReadonlySet<string>,
  notes: readonly { folderId?: string | null; id: string }[]
) {
  const folderIds = new Set<string>();
  for (const reservation of reservations) {
    if (reservation.folderId) folderIds.add(reservation.folderId);
  }
  if (pendingAssetIds.size > 0) {
    for (const note of notes) {
      if (pendingAssetIds.has(note.id) && note.folderId) folderIds.add(note.folderId);
    }
  }
  return folderIds;
}

interface AcquireVaultPastedImageFolderLeaseInput {
  acquireLock: (lease: VaultPastedImageFolderLease) => Promise<void>;
  releaseLock: (lease: VaultPastedImageFolderLease) => Promise<void>;
  shouldRetryLockError?: (caught: unknown) => boolean;
  signal: AbortSignal;
  target: VaultPastedImageFolderTarget;
}

export interface VaultPastedImageFolderLeaseCoordinator {
  acquire: (
    input: AcquireVaultPastedImageFolderLeaseInput
  ) => Promise<VaultPastedImageFolderLease>;
  confirm: (lease: VaultPastedImageFolderLease) => Promise<void>;
  release: (lease: VaultPastedImageFolderLease) => Promise<void>;
  reset: () => void;
}

export async function acquireVaultPastedImageFolderServerLease(input: {
  coordinator: VaultPastedImageFolderLeaseCoordinator;
  ownerUid: string;
  signal: AbortSignal;
  target: VaultPastedImageFolderTarget;
}) {
  return input.coordinator.acquire({
    acquireLock: async (lease) => {
      const locked = await acquireVaultPastedImageFolderLock(input.ownerUid, {
        expectedRevision: lease.folderRevision,
        folderId: lease.folderId,
        lockId: lease.lockId
      });
      if (locked.folderId !== lease.folderId || locked.revision !== lease.folderRevision) {
        throw new Error("붙여넣은 이미지 폴더의 서버 잠금 상태가 일치하지 않습니다.");
      }
    },
    releaseLock: async (lease) => {
      const released = await releaseVaultPastedImageFolderLock(input.ownerUid, {
        folderId: lease.folderId,
        lockId: lease.lockId
      });
      if (released.folderId !== lease.folderId) {
        throw new Error("붙여넣은 이미지 폴더의 서버 잠금 해제를 확인하지 못했습니다.");
      }
    },
    shouldRetryLockError: vaultFolderResponseMayHaveBeenLost,
    signal: input.signal,
    target: input.target
  });
}

export async function resolveVaultPastedImageFolderServerLease(input: {
  coordinator: VaultPastedImageFolderCoordinator;
  createFolder: (
    currentFolders: readonly DecryptedVaultFolder[]
  ) => Promise<{ id: string; revision?: number }>;
  getFolders: () => readonly DecryptedVaultFolder[];
  isNameConflict: (caught: unknown) => boolean;
  leaseCoordinator: VaultPastedImageFolderLeaseCoordinator;
  ownerUid: string;
  signal: AbortSignal;
}) {
  const target = await input.coordinator.ensure({
    createFolder: async () => {
      const currentFolders = input.getFolders()
        .filter((folder) => folder.ownerUid === input.ownerUid);
      try {
        return await input.createFolder(currentFolders);
      } catch (caught) {
        if (!input.isNameConflict(caught)) throw caught;
        const synchronized = findVaultPastedImageFolder(input.getFolders(), input.ownerUid);
        if (synchronized) {
          return {
            id: synchronized.folderId,
            revision: synchronized.folderRevision
          };
        }
        throw new Error(
          "붙여넣은 이미지 폴더가 다른 탭에서 동기화 중이거나 휴지통에 있습니다. 동기화 후 다시 시도해주세요."
        );
      }
    },
    getFolders: input.getFolders,
    ownerUid: input.ownerUid,
    signal: input.signal
  });
  return acquireVaultPastedImageFolderServerLease({
    coordinator: input.leaseCoordinator,
    ownerUid: input.ownerUid,
    signal: input.signal,
    target
  });
}

export function assertVaultPastedImageFolderTargetCurrent(input: {
  coordinator: VaultPastedImageFolderCoordinator;
  getFolders: () => readonly DecryptedVaultFolder[];
  ownerUid: string;
  pathRewriteBusy: boolean;
  target: VaultPastedImageFolderTarget;
}) {
  if (
    input.pathRewriteBusy
    || !input.coordinator.isCurrent({
      getFolders: input.getFolders,
      ownerUid: input.ownerUid
    }, input.target)
  ) {
    throw new Error("이미지 폴더 경로가 바뀌어 저장을 중단했습니다.");
  }
}

interface ResolveVaultPastedImageFolderInput {
  createFolder: () => Promise<{ id: string; revision?: number }>;
  getFolders: () => readonly DecryptedVaultFolder[];
  ownerUid: string;
  signal: AbortSignal;
}

interface InspectVaultPastedImageFolderInput {
  getFolders: () => readonly DecryptedVaultFolder[];
  ownerUid: string;
}

const CREATED_FOLDER_SUBSCRIPTION_GRACE_MS = 60_000;
export const VAULT_PASTED_IMAGE_FOLDER_LOCK_RENEWAL_MS = 60_000;
const VAULT_PASTED_IMAGE_FOLDER_LOCK_RETRY_MS = 5_000;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

export function createVaultPastedImageFolderLockId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const lockId = `vpl1_${bytesToBase64Url(bytes)}`;
  if (!/^vpl1_[A-Za-z0-9_-]{43}$/u.test(lockId)) {
    throw new Error("붙여넣은 이미지 폴더 잠금 식별자를 안전하게 만들지 못했습니다.");
  }
  return lockId;
}

function samePastedImageFolderTarget(
  left: VaultPastedImageFolderTarget,
  right: VaultPastedImageFolderTarget
) {
  return left.folderId === right.folderId
    && left.folderPath === right.folderPath
    && left.folderRevision === right.folderRevision;
}

/**
 * Serializes the short server lease mutations and shares one lease between
 * concurrent editors in this tab. The server release runs only after every
 * committed or discarded paste has given up its holder.
 */
export function createVaultPastedImageFolderLeaseCoordinator(
  createLockId = createVaultPastedImageFolderLockId
): VaultPastedImageFolderLeaseCoordinator {
  let generation = 0;
  let operationChain: Promise<void> = Promise.resolve();
  let renewalTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let releaseRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let active: {
    acquireLock: (lease: VaultPastedImageFolderLease) => Promise<void>;
    ambiguousReleaseHolderId: string | null;
    holders: Set<string>;
    lease: VaultPastedImageFolderLease;
    releaseLock: (lease: VaultPastedImageFolderLease) => Promise<void>;
    shouldRetryLockError: (caught: unknown) => boolean;
  } | null = null;

  const enqueue = <T,>(operation: () => Promise<T>) => {
    const result = operationChain.then(operation, operation);
    operationChain = result.then(() => undefined, () => undefined);
    return result;
  };
  const clearRenewalTimer = () => {
    if (renewalTimer === null) return;
    globalThis.clearTimeout(renewalTimer);
    renewalTimer = null;
  };
  const clearReleaseRetryTimer = () => {
    if (releaseRetryTimer === null) return;
    globalThis.clearTimeout(releaseRetryTimer);
    releaseRetryTimer = null;
  };
  const scheduleRenewal = (
    entry: NonNullable<typeof active>,
    delay = VAULT_PASTED_IMAGE_FOLDER_LOCK_RENEWAL_MS
  ) => {
    clearRenewalTimer();
    renewalTimer = globalThis.setTimeout(() => {
      renewalTimer = null;
      void enqueue(async () => {
        if (active !== entry || entry.holders.size === 0) return;
        await entry.acquireLock(entry.lease);
        if (active === entry && entry.holders.size > 0) scheduleRenewal(entry);
      }).catch((caught) => {
        if (
          active === entry
          && entry.holders.size > 0
          && entry.shouldRetryLockError(caught)
        ) {
          scheduleRenewal(entry, VAULT_PASTED_IMAGE_FOLDER_LOCK_RETRY_MS);
        }
      });
    }, delay);
  };
  const scheduleReleaseRetry = (
    entry: NonNullable<typeof active>,
    holderId: string
  ) => {
    clearReleaseRetryTimer();
    releaseRetryTimer = globalThis.setTimeout(() => {
      releaseRetryTimer = null;
      void enqueue(async () => {
        if (
          active !== entry
          || entry.holders.size > 0
          || entry.ambiguousReleaseHolderId !== holderId
        ) return;
        try {
          await entry.releaseLock(entry.lease);
        } catch (caught) {
          if (!entry.shouldRetryLockError(caught)) {
            if (active === entry && entry.holders.size === 0) active = null;
            return;
          }
          if (
            active === entry
            && entry.holders.size === 0
            && entry.ambiguousReleaseHolderId === holderId
          ) {
            scheduleReleaseRetry(entry, holderId);
          }
          return;
        }
        if (active === entry && entry.holders.size === 0) active = null;
      });
    }, VAULT_PASTED_IMAGE_FOLDER_LOCK_RETRY_MS);
  };

  return {
    acquire(input) {
      const requestGeneration = generation;
      return enqueue(async () => {
        input.signal.throwIfAborted();
        if (requestGeneration !== generation) {
          throw new DOMException("Vault 접근 범위가 변경되었습니다.", "AbortError");
        }
        if (active) {
          if (!samePastedImageFolderTarget(active.lease, input.target)) {
            throw new Error("다른 붙여넣은 이미지 폴더 잠금이 끝난 뒤 다시 시도해주세요.");
          }
          if (active.holders.size === 0) {
            const reacquiring = active;
            const ambiguousReleaseHolderId = reacquiring.ambiguousReleaseHolderId;
            clearReleaseRetryTimer();
            try {
              await input.acquireLock(reacquiring.lease);
              input.signal.throwIfAborted();
            } catch (caught) {
              if (
                active === reacquiring
                && reacquiring.holders.size === 0
                && ambiguousReleaseHolderId
                && reacquiring.shouldRetryLockError(caught)
              ) {
                scheduleReleaseRetry(reacquiring, ambiguousReleaseHolderId);
              } else if (active === reacquiring && reacquiring.holders.size === 0) {
                active = null;
              }
              throw caught;
            }
            reacquiring.acquireLock = input.acquireLock;
            reacquiring.ambiguousReleaseHolderId = null;
          }
          const holderId = crypto.randomUUID();
          active.holders.add(holderId);
          // Joining holders must not postpone an already scheduled heartbeat:
          // a steady stream of pastes could otherwise push renewal beyond the
          // server's 120-second TTL indefinitely.
          if (renewalTimer === null) scheduleRenewal(active);
          return { ...active.lease, holderId };
        }

        const lease = {
          ...input.target,
          holderId: crypto.randomUUID(),
          lockId: createLockId()
        };
        await input.acquireLock(lease);
        if (input.signal.aborted || requestGeneration !== generation) {
          await input.releaseLock(lease).catch(() => undefined);
          input.signal.throwIfAborted();
          throw new DOMException("Vault 접근 범위가 변경되었습니다.", "AbortError");
        }
        active = {
          acquireLock: input.acquireLock,
          ambiguousReleaseHolderId: null,
          holders: new Set([lease.holderId]),
          lease,
          releaseLock: input.releaseLock,
          shouldRetryLockError: input.shouldRetryLockError ?? (() => false)
        };
        scheduleRenewal(active);
        return lease;
      });
    },
    confirm(lease) {
      return enqueue(async () => {
        const confirming = active;
        if (
          !confirming
          || confirming.lease.lockId !== lease.lockId
          || !confirming.holders.has(lease.holderId)
        ) {
          throw new Error("붙여넣은 이미지 폴더의 활성 서버 잠금을 확인할 수 없습니다.");
        }
        const confirmingGeneration = generation;
        await confirming.acquireLock(confirming.lease);
        if (
          active !== confirming
          || generation !== confirmingGeneration
          || !confirming.holders.has(lease.holderId)
        ) {
          throw new DOMException("Vault 접근 범위가 변경되었습니다.", "AbortError");
        }
        // A source-note commit must start with a fresh full server TTL. This
        // also atomically rechecks the folder revision/tree in the API before
        // the note update binds itself to the same lock credential.
        scheduleRenewal(confirming);
      });
    },
    release(lease) {
      return enqueue(async () => {
        if (!active || active.lease.lockId !== lease.lockId) return;
        const retryingAmbiguousRelease = active.holders.size === 0
          && active.ambiguousReleaseHolderId === lease.holderId;
        if (!active.holders.delete(lease.holderId) && !retryingAmbiguousRelease) return;
        if (active.holders.size > 0) return;
        clearRenewalTimer();
        clearReleaseRetryTimer();
        const releasing = active;
        // If release throws, keep the zero-holder lease so a later paste
        // re-acquires the same id instead of assuming an ambiguous response.
        try {
          await releasing.releaseLock(releasing.lease);
        } catch (caught) {
          if (active === releasing && releasing.shouldRetryLockError(caught)) {
            releasing.ambiguousReleaseHolderId = lease.holderId;
            scheduleReleaseRetry(releasing, lease.holderId);
          } else if (active === releasing) {
            active = null;
          }
          throw caught;
        }
        if (active === releasing) active = null;
      });
    },
    reset() {
      generation += 1;
      clearRenewalTimer();
      clearReleaseRetryTimer();
      const releasing = active;
      active = null;
      if (releasing) {
        void enqueue(() => releasing.releaseLock(releasing.lease)).catch(() => undefined);
      }
    }
  };
}

function safeFolderNameKey(folder: DecryptedVaultFolder) {
  if (folder.nameDecryptionFailed) return null;
  try {
    return canonicalVaultName(folder.displayName, "folder");
  } catch {
    return null;
  }
}

export function findVaultPastedImageFolder(
  folders: readonly DecryptedVaultFolder[],
  ownerUid: string
): VaultPastedImageFolderTarget | null {
  const expectedKey = canonicalVaultName(VAULT_PASTED_IMAGE_FOLDER_NAME, "folder");
  const matches = folders.filter((folder) => (
    folder.ownerUid === ownerUid
    && folder.isDeleted !== true
    && (folder.parentId ?? null) === null
    && safeFolderNameKey(folder) === expectedKey
  ));

  if (matches.length > 1) {
    throw new Error("붙여넣은 이미지 폴더가 중복되어 안전한 저장 위치를 선택할 수 없습니다.");
  }
  const [folder] = matches;
  if (!folder) return null;
  const folderRevision = folder.revision ?? 0;
  if (!Number.isSafeInteger(folderRevision) || folderRevision < 1) {
    throw new Error("붙여넣은 이미지 폴더의 서버 revision을 확인할 수 없습니다.");
  }
  return {
    folderId: folder.id,
    folderPath: folder.displayName.trim().normalize("NFC"),
    folderRevision
  };
}

export interface VaultPastedImageFolderCoordinator {
  ensure: (input: ResolveVaultPastedImageFolderInput) => Promise<VaultPastedImageFolderTarget>;
  isCurrent: (
    input: InspectVaultPastedImageFolderInput,
    target: VaultPastedImageFolderTarget
  ) => boolean;
  reset: () => void;
}

/**
 * Serializes same-tab creation without tying the shared server write to one
 * editor's AbortSignal. A short-lived target cache bridges the interval between
 * the mutation response and the encrypted folder subscription update.
 */
export function createVaultPastedImageFolderCoordinator(): VaultPastedImageFolderCoordinator {
  let generation = 0;
  let createdTarget: {
    expiresAt: number;
    generation: number;
    target: VaultPastedImageFolderTarget;
  } | null = null;
  let inFlight: {
    generation: number;
    promise: Promise<VaultPastedImageFolderTarget>;
  } | null = null;

  const inspect = ({ getFolders, ownerUid }: InspectVaultPastedImageFolderInput) => {
    const folders = getFolders();
    const existing = findVaultPastedImageFolder(folders, ownerUid);
    if (existing) {
      createdTarget = null;
      return existing;
    }

    if (!createdTarget || createdTarget.generation !== generation) return null;
    const observedFolder = folders.find((folder) => folder.id === createdTarget?.target.folderId);
    if (observedFolder || Date.now() > createdTarget.expiresAt) {
      createdTarget = null;
      return null;
    }
    return createdTarget.target;
  };

  return {
    async ensure(input) {
      input.signal.throwIfAborted();
      const existing = inspect(input);
      if (existing) return existing;

      const requestGeneration = generation;
      let request = inFlight?.generation === requestGeneration ? inFlight : null;
      if (!request) {
        const promise = (async () => {
          const rechecked = findVaultPastedImageFolder(input.getFolders(), input.ownerUid);
          if (rechecked) return rechecked;
          const created = await input.createFolder();
          if (!created.id || created.id.length > 120 || created.id.includes("/")) {
            throw new Error("붙여넣은 이미지 폴더의 서버 식별자가 올바르지 않습니다.");
          }
          const folderRevision = created.revision ?? 1;
          if (!Number.isSafeInteger(folderRevision) || folderRevision < 1) {
            throw new Error("붙여넣은 이미지 폴더의 서버 revision이 올바르지 않습니다.");
          }
          const target = {
            folderId: created.id,
            folderPath: VAULT_PASTED_IMAGE_FOLDER_NAME,
            folderRevision
          };
          if (generation === requestGeneration) {
            createdTarget = {
              expiresAt: Date.now() + CREATED_FOLDER_SUBSCRIPTION_GRACE_MS,
              generation: requestGeneration,
              target
            };
          }
          return target;
        })();
        request = { generation: requestGeneration, promise };
        inFlight = request;
      }

      try {
        const target = await request.promise;
        input.signal.throwIfAborted();
        if (generation !== requestGeneration) {
          throw new DOMException("Vault 접근 범위가 변경되었습니다.", "AbortError");
        }
        return target;
      } finally {
        if (inFlight === request) inFlight = null;
      }
    },
    isCurrent(input, target) {
      const current = inspect(input);
      return current?.folderId === target.folderId
        && current.folderPath === target.folderPath
        && current.folderRevision === target.folderRevision;
    },
    reset() {
      generation += 1;
      createdTarget = null;
      inFlight = null;
    }
  };
}

type VaultPastedImageFolderResolveServerLeaseInput = Omit<
  Parameters<typeof resolveVaultPastedImageFolderServerLease>[0],
  "coordinator" | "leaseCoordinator"
>;
type VaultPastedImageFolderAssertCurrentInput = Omit<
  Parameters<typeof assertVaultPastedImageFolderTargetCurrent>[0],
  "coordinator"
>;

export interface VaultPastedImageFolderRuntime {
  assertTargetCurrent: (input: VaultPastedImageFolderAssertCurrentInput) => void;
  confirm: (lease: VaultPastedImageFolderLease) => Promise<void>;
  folderName: typeof VAULT_PASTED_IMAGE_FOLDER_NAME;
  pendingFolderIds: typeof vaultPendingPastedImageFolderIds;
  release: (lease: VaultPastedImageFolderLease) => Promise<void>;
  reset: () => void;
  resolveServerLease: (
    input: VaultPastedImageFolderResolveServerLeaseInput
  ) => Promise<VaultPastedImageFolderLease>;
}

export function createVaultPastedImageFolderRuntime(): VaultPastedImageFolderRuntime {
  const coordinator = createVaultPastedImageFolderCoordinator();
  const leaseCoordinator = createVaultPastedImageFolderLeaseCoordinator();
  return {
    assertTargetCurrent(input) {
      assertVaultPastedImageFolderTargetCurrent({ ...input, coordinator });
    },
    confirm: leaseCoordinator.confirm,
    folderName: VAULT_PASTED_IMAGE_FOLDER_NAME,
    pendingFolderIds: vaultPendingPastedImageFolderIds,
    release: leaseCoordinator.release,
    reset() {
      coordinator.reset();
      leaseCoordinator.reset();
    },
    resolveServerLease(input) {
      return resolveVaultPastedImageFolderServerLease({
        ...input,
        coordinator,
        leaseCoordinator
      });
    }
  };
}
