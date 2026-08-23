import type { NoteFolderSnapshot, NoteSnapshot } from "../../services/notes";
import { MAX_VAULT_FOLDER_DEPTH } from "./vaultIntegrity";

/**
 * A folder trash operation is represented by one tombstone on the selected
 * root. Descendants are hidden by ancestry instead of being rewritten one by
 * one. This makes an arbitrarily large subtree one bounded atomic transaction,
 * requires no checkpoint/resume job, and avoids Firestore's 500-write and
 * Rules expression limits.
 */
export interface VaultFolderTrashPartition {
  activeFolders: NoteFolderSnapshot[];
  hiddenFolderIds: Set<string>;
  invalidFolderIds: Set<string>;
  trashRoots: NoteFolderSnapshot[];
}

export interface VaultFolderLifecyclePreflightInput {
  expectedRevision: number;
  folderId: string;
  folders: readonly NoteFolderSnapshot[];
  operation: "delete" | "restore";
  ownerUid: string;
}

function folderDeleted(folder: Pick<NoteFolderSnapshot, "isDeleted">) {
  return folder.isDeleted === true;
}

export function partitionVaultFolderTrash(
  folders: readonly NoteFolderSnapshot[]
): VaultFolderTrashPartition {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const hiddenFolderIds = new Set<string>();
  const invalidFolderIds = new Set<string>();
  const stateById = new Map<string, "active" | "hidden" | "invalid">();

  const classify = (folderId: string): "active" | "hidden" | "invalid" => {
    const cached = stateById.get(folderId);
    if (cached) return cached;

    const trail: string[] = [];
    const visited = new Set<string>();
    let currentId: string | null = folderId;
    let outcome: "active" | "hidden" | "invalid" = "active";

    while (currentId !== null) {
      const known = stateById.get(currentId);
      if (known) {
        outcome = known;
        break;
      }
      if (visited.has(currentId) || trail.length >= 64) {
        outcome = "invalid";
        break;
      }

      visited.add(currentId);
      trail.push(currentId);
      const current = byId.get(currentId);
      if (!current) {
        outcome = "invalid";
        break;
      }
      if (folderDeleted(current)) {
        outcome = "hidden";
        break;
      }
      currentId = current.parentId ?? null;
    }

    trail.forEach((id) => stateById.set(id, outcome));
    return outcome;
  };

  folders.forEach((folder) => {
    const state = classify(folder.id);
    if (state !== "active") hiddenFolderIds.add(folder.id);
    if (state === "invalid") invalidFolderIds.add(folder.id);
  });

  const trashRoots = folders.filter((folder) => {
    if (!folderDeleted(folder)) return false;
    const parentId = folder.parentId ?? null;
    return parentId === null || !hiddenFolderIds.has(parentId);
  });

  return {
    activeFolders: folders.filter((folder) => !hiddenFolderIds.has(folder.id)),
    hiddenFolderIds,
    invalidFolderIds,
    trashRoots
  };
}

/**
 * Validates a complete, server-confirmed owner snapshot before the bounded
 * lifecycle transaction. Firestore Rules can re-check only the root and direct
 * parent; therefore callers must not pass a cache-only or truncated snapshot.
 */
export function assertVaultFolderLifecyclePreflight(
  input: VaultFolderLifecyclePreflightInput
) {
  const ownerFolders = input.folders.filter((folder) => folder.ownerUid === input.ownerUid);
  if (ownerFolders.length !== input.folders.length) {
    throw new Error("다른 소유자의 폴더가 섞여 있어 작업을 잠갔습니다.");
  }
  if (new Set(ownerFolders.map((folder) => folder.id)).size !== ownerFolders.length) {
    throw new Error("중복된 폴더 스냅샷이 있어 작업을 잠겼습니다.");
  }
  const byId = new Map(ownerFolders.map((folder) => [folder.id, folder]));
  const target = byId.get(input.folderId);
  if (!target || (target.revision ?? 0) !== input.expectedRevision) {
    throw new Error("서버에서 확인한 폴더 revision이 현재 작업과 일치하지 않습니다.");
  }
  if (
    !target.encryptedName
    || !target.wrappedKey
    || !target.vaultNameClaimId
    || target.vaultNameIndexVersion !== 1
  ) {
    throw new Error("암호화 폴더 이름 예약을 확인할 수 없어 작업을 잠갔습니다.");
  }

  const partition = partitionVaultFolderTrash(ownerFolders);
  if (partition.invalidFolderIds.size) {
    throw new Error("전체 폴더 트리의 무결성을 확인할 수 없어 작업을 잠갔습니다.");
  }
  if (input.operation === "delete" && partition.hiddenFolderIds.has(target.id)) {
    throw new Error("활성 폴더만 Vault 휴지통으로 이동할 수 있습니다.");
  }
  if (
    input.operation === "restore"
    && !partition.trashRoots.some((folder) => folder.id === target.id)
  ) {
    throw new Error("가장 바깥쪽 휴지통 폴더부터 복원해주세요.");
  }

  const visited = new Set([target.id]);
  let parentId = target.parentId ?? null;
  let depth = 0;
  while (parentId !== null) {
    if (visited.has(parentId) || depth >= MAX_VAULT_FOLDER_DEPTH) {
      throw new Error("상위 폴더 체인의 무결성을 확인할 수 없습니다.");
    }
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (
      !parent
      || parent.isDeleted === true
      || !parent.encryptedName
      || !parent.wrappedKey
      || !Number.isSafeInteger(parent.revision)
    ) {
      throw new Error("상위 폴더 체인을 안전하게 확인할 수 없어 작업을 잠갔습니다.");
    }
    parentId = parent.parentId ?? null;
    depth += 1;
  }
  return target;
}

export function visibleVaultNotesForFolders(
  notes: readonly NoteSnapshot[],
  activeFolders: readonly Pick<NoteFolderSnapshot, "id">[]
) {
  const activeFolderIds = new Set(activeFolders.map((folder) => folder.id));
  return notes.filter((note) => {
    const folderId = note.folderId ?? null;
    return folderId === null || activeFolderIds.has(folderId);
  });
}

export function vaultFolderTrashCounts(
  rootId: string,
  hiddenFolders: readonly NoteFolderSnapshot[],
  notes: readonly NoteSnapshot[]
) {
  const byParent = new Map<string | null, string[]>();
  hiddenFolders.forEach((folder) => {
    const parentId = folder.parentId ?? null;
    const children = byParent.get(parentId) ?? [];
    children.push(folder.id);
    byParent.set(parentId, children);
  });
  const subtreeIds = new Set<string>();
  const pending = [rootId];
  while (pending.length) {
    const folderId = pending.pop();
    if (!folderId || subtreeIds.has(folderId)) continue;
    subtreeIds.add(folderId);
    pending.push(...(byParent.get(folderId) ?? []));
  }
  return {
    entryCount: notes.filter((note) => {
      const folderId = note.folderId ?? null;
      return folderId !== null && subtreeIds.has(folderId);
    }).length,
    folderCount: Math.max(0, subtreeIds.size - 1)
  };
}
