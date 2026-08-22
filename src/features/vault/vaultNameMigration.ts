import {
  updateEncryptedNoteFolder,
  vaultNameClaimReservationMatches
} from "../../services/notes";
import type { UserProfile } from "../../types";
import {
  migrateLegacyVaultFolder,
  type DecryptedVaultFolder,
  type DecryptedVaultNote
} from "./vaultData";
import { backfillVaultEntryNameClaim } from "./vaultPersistence";
import {
  VAULT_NAME_INDEX_VERSION,
  planVaultNameMigration,
  requireValidVaultFolderTree,
  type VaultNameMigrationPlan
} from "./vaultIntegrity";

export interface VaultNameReservationMigrationInput {
  folders: readonly DecryptedVaultFolder[];
  notes: readonly DecryptedVaultNote[];
  privateKey: CryptoKey;
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">;
  expectedFolderCount: number;
  expectedNoteCount: number;
  vaultIntegrityKey: CryptoKey;
  onProgress?: (progress: VaultNameReservationMigrationProgress) => void;
}

export interface VaultNameReservationMigrationProgress {
  completed: number;
  migrated: number;
  skipped: number;
  total: number;
}

export interface VaultNameReservationMigrationResult extends VaultNameReservationMigrationProgress {
  collisions: VaultNameMigrationPlan["collisions"];
  deferredTargetIds: string[];
}

/**
 * Backfills blinded sibling-name reservations without persisting plaintext.
 *
 * The full decrypted snapshot is planned before the first write. For an
 * existing collision, the deterministic first target acquires the claim while
 * only the duplicate target (and, for a duplicate folder, its subtree) stays
 * write-locked until the user gives it a different name or parent. This avoids
 * leaving the original sibling name unreserved while still preserving every
 * colliding target for explicit recovery. Each migrated target moves to its
 * claim in the same revision-aware transaction as its target document. A retry
 * is safe: already matching targets are skipped.
 */
export async function migrateVaultNameReservations(
  input: VaultNameReservationMigrationInput
): Promise<VaultNameReservationMigrationResult> {
  if (
    input.folders.length !== input.expectedFolderCount
    || input.notes.length !== input.expectedNoteCount
  ) {
    throw new Error("전체 Vault 스냅샷을 확인하기 전에는 이름 예약 마이그레이션을 시작할 수 없습니다.");
  }
  if (input.folders.some((folder) => folder.ownerUid !== input.profile.uid)) {
    throw new Error("다른 사용자의 폴더는 Vault 이름 예약으로 마이그레이션할 수 없습니다.");
  }
  if (input.folders.some((folder) => folder.nameDecryptionFailed)) {
    throw new Error("이름을 복호화하지 못한 폴더가 있어 Vault 이름 예약 마이그레이션을 중단했습니다.");
  }
  if (input.notes.some((note) => (
    note.ownerUid !== input.profile.uid
    || (note.type !== "personal" && note.type !== "shared")
    || note.isDeleted === true
  ))) {
    throw new Error("본인 소유의 활성 Vault 노트만 이름 예약으로 마이그레이션할 수 있습니다.");
  }

  const ancestryByFolderId = requireValidVaultFolderTree(input.folders.map((folder) => ({
    id: folder.id,
    parentId: folder.parentId ?? null
  })));
  const sourceOrderByFolderId = new Map(input.folders.map((folder, index) => [folder.id, index]));
  const orderedFolders = [...input.folders].sort((left, right) => {
    const depthDifference = (ancestryByFolderId.get(left.id)?.depth ?? 0)
      - (ancestryByFolderId.get(right.id)?.depth ?? 0);
    return depthDifference
      || (sourceOrderByFolderId.get(left.id) ?? 0) - (sourceOrderByFolderId.get(right.id) ?? 0);
  });
  const folderIds = new Set(orderedFolders.map((folder) => folder.id));
  if (input.notes.some((note) => note.folderId !== null && note.folderId !== undefined && !folderIds.has(note.folderId))) {
    throw new Error("Vault 노트의 상위 폴더가 전체 스냅샷에 없습니다.");
  }

  // Historical clients could leave shared notes in a personal folder even
  // though the current shared-note model requires a null parent. Do not let
  // one such document abort the whole cutover or reserve its invalid parent;
  // keep it write-locked for the same one-step owner recovery used by a
  // collision loser (move to root + acquire the root-scoped claim).
  const invalidSharedFolderTargetIds = new Set(
    input.notes
      .filter((note) => note.type === "shared" && (note.folderId ?? null) !== null)
      .map((note) => note.id)
  );
  const plan = await planVaultNameMigration(input.vaultIntegrityKey, [
    ...orderedFolders.map((folder) => ({
      id: folder.id,
      name: folder.displayName,
      parentId: folder.parentId ?? null,
      targetType: "folder" as const
    })),
    ...input.notes.filter((note) => !invalidSharedFolderTargetIds.has(note.id)).map((note) => ({
      id: note.id,
      kind: note.entryKind,
      name: note.title,
      parentId: note.folderId ?? null,
      targetType: "entry" as const
    }))
  ]);
  const duplicateTargetIds = new Set(plan.collisions.map((collision) => collision.duplicateTargetId));
  const duplicateFolderIds = new Set(
    orderedFolders
      .filter((folder) => duplicateTargetIds.has(folder.id))
      .map((folder) => folder.id)
  );
  const deferredFolderIds = new Set(
    orderedFolders
      .filter((folder) => (
        duplicateFolderIds.has(folder.id)
        || (ancestryByFolderId.get(folder.id)?.ancestorIds ?? []).some((ancestorId) => duplicateFolderIds.has(ancestorId))
      ))
      .map((folder) => folder.id)
  );
  const deferredTargetIdSet = new Set<string>([
    ...invalidSharedFolderTargetIds,
    ...duplicateTargetIds,
    ...deferredFolderIds,
    ...input.notes
      .filter((note) => note.folderId !== null && note.folderId !== undefined && deferredFolderIds.has(note.folderId))
      .map((note) => note.id)
  ]);
  const deferredTargetIds = [
    ...orderedFolders.map((folder) => folder.id),
    ...input.notes.map((note) => note.id)
  ].filter((targetId) => deferredTargetIdSet.has(targetId));
  const total = input.folders.length + input.notes.length;
  const progress: VaultNameReservationMigrationProgress = {
    completed: 0,
    migrated: 0,
    skipped: 0,
    total
  };

  const foldersById = new Map(orderedFolders.map((folder) => [folder.id, folder]));
  const notesById = new Map(input.notes.map((note) => [note.id, note]));
  for (const claim of plan.claims) {
    if (deferredTargetIdSet.has(claim.targetId)) {
      continue;
    }
    const target = claim.targetType === "folder"
      ? foldersById.get(claim.targetId)
      : notesById.get(claim.targetId);
    if (!target) {
      throw new Error("Vault 이름 예약 대상 스냅샷이 변경되었습니다.");
    }

    const metadataMatches = (
      target.vaultNameClaimId === claim.fingerprint
      && target.vaultNameIndexVersion === VAULT_NAME_INDEX_VERSION
    );
    const reservationMatches = metadataMatches && await vaultNameClaimReservationMatches({
      claimId: claim.fingerprint,
      ownerUid: input.profile.uid,
      parentId: claim.parentId,
      targetId: claim.targetId,
      targetType: claim.targetType
    });

    if (reservationMatches) {
      progress.skipped += 1;
    } else if (claim.targetType === "folder") {
      const folder = target as DecryptedVaultFolder;
      if (folder.encryptedName && folder.wrappedKey) {
        await updateEncryptedNoteFolder({
          expectedRevision: folder.revision ?? 1,
          folderId: folder.id,
          nameClaim: {
            claimId: claim.fingerprint,
            indexVersion: VAULT_NAME_INDEX_VERSION,
            parentId: folder.parentId ?? null
          },
          ownerUid: input.profile.uid
        });
      } else {
        await migrateLegacyVaultFolder(
          input.profile,
          input.vaultIntegrityKey,
          folder,
          folder.order ?? progress.completed
        );
      }
      progress.migrated += 1;
    } else {
      const note = target as DecryptedVaultNote;
      if (metadataMatches) {
        await backfillVaultEntryNameClaim(
          note,
          input.profile.uid,
          input.privateKey,
          input.vaultIntegrityKey,
          true
        );
      } else {
        await backfillVaultEntryNameClaim(
          note,
          input.profile.uid,
          input.privateKey,
          input.vaultIntegrityKey
        );
      }
      progress.migrated += 1;
    }

    progress.completed += 1;
    input.onProgress?.({ ...progress });
  }

  return { ...progress, collisions: plan.collisions, deferredTargetIds };
}
