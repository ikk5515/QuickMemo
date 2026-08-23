import {
  updateEncryptedNoteFolder,
  vaultNameClaimReservationMatches,
  type NoteFolderSnapshot,
  type NoteSnapshot
} from "../../services/notes";
import type { UserProfile } from "../../types";
import {
  decryptVaultFolders,
  decryptVaultNotes,
  migrateLegacyVaultFolder,
  vaultEntryStorageIdentityState,
  type VaultEntryStorageIdentityState,
  type DecryptedVaultFolder,
  type DecryptedVaultNote
} from "./vaultData";
import {
  backfillVaultEntryNameClaim,
  migrateLegacyVaultEntryIdentity
} from "./vaultPersistence";
import {
  VAULT_NAME_INDEX_VERSION,
  planVaultNameMigration,
  requireValidVaultFolderTree,
  type VaultNameMigrationPlan
} from "./vaultIntegrity";

export interface VaultNameReservationMigrationInput {
  deletedNotes: readonly DecryptedVaultNote[];
  folders: readonly DecryptedVaultFolder[];
  legacyActiveNoteIds: ReadonlySet<string>;
  legacyDeletedNoteIds: ReadonlySet<string>;
  notes: readonly DecryptedVaultNote[];
  privateKey: CryptoKey;
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">;
  expectedFolderCount: number;
  expectedNoteCount: number;
  expectedDeletedNoteCount: number;
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

export interface VaultNameReservationAuditInput {
  deletedNotes: readonly DecryptedVaultNote[];
  expectedDeletedNoteCount: number;
  expectedFolderCount: number;
  expectedNoteCount: number;
  folders: readonly DecryptedVaultFolder[];
  notes: readonly DecryptedVaultNote[];
  profile: Pick<UserProfile, "uid">;
  vaultIntegrityKey: CryptoKey;
}

interface VaultNameReservationPlanState {
  deferredTargetIdSet: Set<string>;
  deferredTargetIds: string[];
  foldersById: Map<string, DecryptedVaultFolder>;
  notesById: Map<string, DecryptedVaultNote>;
  orderedFolders: DecryptedVaultFolder[];
  plan: VaultNameMigrationPlan;
}

export interface VaultNameCutoverPreflightResult {
  activeNotes: DecryptedVaultNote[];
  deletedNotes: DecryptedVaultNote[];
  folders: DecryptedVaultFolder[];
  legacyActiveNoteIds: Set<string>;
  legacyDeletedNoteIds: Set<string>;
}

function requireOwnedVaultNoteSnapshot(
  notes: readonly DecryptedVaultNote[],
  uid: string,
  deleted: boolean
) {
  if (notes.some((note) => (
    note.ownerUid !== uid
    || (note.type !== "personal" && note.type !== "shared")
    || (note.isDeleted === true) !== deleted
  ))) {
    throw new Error(deleted
      ? "본인 소유의 삭제 Vault 노트만 저장 형식 마이그레이션에 포함할 수 있습니다."
      : "본인 소유의 활성 Vault 노트만 이름 예약으로 마이그레이션할 수 있습니다.");
  }
}

async function buildVaultNameReservationPlan(input: VaultNameReservationAuditInput): Promise<VaultNameReservationPlanState> {
  if (
    input.folders.length !== input.expectedFolderCount
    || input.notes.length !== input.expectedNoteCount
    || input.deletedNotes.length !== input.expectedDeletedNoteCount
  ) {
    throw new Error("전체 Vault 스냅샷을 확인하기 전에는 이름 예약 마이그레이션을 시작할 수 없습니다.");
  }
  if (input.folders.some((folder) => folder.ownerUid !== input.profile.uid)) {
    throw new Error("다른 사용자의 폴더는 Vault 이름 예약으로 마이그레이션할 수 없습니다.");
  }
  if (input.folders.some((folder) => folder.nameDecryptionFailed)) {
    throw new Error("이름을 복호화하지 못한 폴더가 있어 Vault 이름 예약 마이그레이션을 중단했습니다.");
  }
  requireOwnedVaultNoteSnapshot(input.notes, input.profile.uid, false);
  requireOwnedVaultNoteSnapshot(input.deletedNotes, input.profile.uid, true);
  const allNoteIds = [...input.notes, ...input.deletedNotes].map((note) => note.id);
  if (new Set(allNoteIds).size !== allNoteIds.length) {
    throw new Error("활성·삭제 Vault inventory에 중복된 노트가 있습니다.");
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
  return {
    deferredTargetIdSet,
    deferredTargetIds,
    foldersById: new Map(orderedFolders.map((folder) => [folder.id, folder])),
    notesById: new Map(input.notes.map((note) => [note.id, note])),
    orderedFolders,
    plan
  };
}

/** Read-only, full-owner cutover phase. This must complete before the marker write. */
export async function preflightVaultNameCutover(input: {
  activeNotes: readonly NoteSnapshot[];
  deletedNotes: readonly NoteSnapshot[];
  folders: readonly NoteFolderSnapshot[];
  privateKey: CryptoKey;
  uid: string;
  vaultIntegrityKey: CryptoKey;
}): Promise<VaultNameCutoverPreflightResult> {
  if (
    input.activeNotes.some((note) => note.ownerUid !== input.uid || note.isDeleted !== false)
    || input.deletedNotes.some((note) => note.ownerUid !== input.uid || note.isDeleted !== true)
  ) {
    throw new Error("활성·삭제 owner server inventory의 삭제 상태를 확인할 수 없습니다.");
  }
  const rawNoteIds = [...input.activeNotes, ...input.deletedNotes].map((note) => note.id);
  if (new Set(rawNoteIds).size !== rawNoteIds.length) {
    throw new Error("활성·삭제 owner server inventory에 중복 노트가 있습니다.");
  }
  const identityStates = new Map<string, VaultEntryStorageIdentityState>(
    rawNoteIds.map((noteId) => [noteId, "invalid"])
  );
  for (const note of [...input.activeNotes, ...input.deletedNotes]) {
    identityStates.set(note.id, vaultEntryStorageIdentityState(note));
  }
  if ([...identityStates.values()].some((state) => state === "invalid")) {
    throw new Error("부분적으로 기록되었거나 서로 맞지 않는 Vault 저장 형식이 있습니다.");
  }
  const [activeNotes, deletedNotes, folders] = await Promise.all([
    decryptVaultNotes([...input.activeNotes], input.uid, input.privateKey),
    decryptVaultNotes([...input.deletedNotes], input.uid, input.privateKey),
    decryptVaultFolders([...input.folders], input.uid, input.privateKey)
  ]);
  if (
    activeNotes.length !== input.activeNotes.length
    || deletedNotes.length !== input.deletedNotes.length
    || folders.length !== input.folders.filter((folder) => folder.ownerUid === input.uid).length
    || folders.some((folder) => folder.nameDecryptionFailed)
  ) {
    throw new Error("전체 Vault 이름과 payload를 복호화하지 못해 무결성 전환을 중단했습니다.");
  }
  await buildVaultNameReservationPlan({
    deletedNotes,
    expectedDeletedNoteCount: input.deletedNotes.length,
    expectedFolderCount: folders.length,
    expectedNoteCount: input.activeNotes.length,
    folders,
    notes: activeNotes,
    profile: { uid: input.uid },
    vaultIntegrityKey: input.vaultIntegrityKey
  });
  return {
    activeNotes,
    deletedNotes,
    folders,
    legacyActiveNoteIds: new Set(input.activeNotes
      .filter((note) => identityStates.get(note.id) === "legacy-missing")
      .map((note) => note.id)),
    legacyDeletedNoteIds: new Set(input.deletedNotes
      .filter((note) => identityStates.get(note.id) === "legacy-missing")
      .map((note) => note.id))
  };
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
  const {
    deferredTargetIdSet,
    deferredTargetIds,
    foldersById,
    notesById,
    orderedFolders,
    plan
  } = await buildVaultNameReservationPlan(input);
  const activeIds = new Set(input.notes.map((note) => note.id));
  const deletedIds = new Set(input.deletedNotes.map((note) => note.id));
  if (
    [...input.legacyActiveNoteIds].some((noteId) => !activeIds.has(noteId))
    || [...input.legacyDeletedNoteIds].some((noteId) => !deletedIds.has(noteId))
  ) {
    throw new Error("legacy Vault 저장 형식 대상이 전체 server inventory와 일치하지 않습니다.");
  }
  const legacyNotes = [...input.notes, ...input.deletedNotes].filter((note) => (
    input.legacyActiveNoteIds.has(note.id) || input.legacyDeletedNoteIds.has(note.id)
  ));
  if (legacyNotes.some((note) => note.contentFormat !== "legacy-html-v1" || note.entryKind !== "legacy-html")) {
    throw new Error("legacy Vault 저장 형식 대상이 HTML identity와 일치하지 않습니다.");
  }

  const total = input.folders.length + input.notes.length + input.deletedNotes.length;
  const progress: VaultNameReservationMigrationProgress = {
    completed: 0,
    migrated: 0,
    skipped: 0,
    total
  };

  const processedTargetIds = new Set<string>();
  const complete = (migrated: boolean) => {
    progress.completed += 1;
    if (migrated) progress.migrated += 1;
    else progress.skipped += 1;
    input.onProgress?.({ ...progress });
  };

  for (const claim of plan.claims) {
    const target = claim.targetType === "folder"
      ? foldersById.get(claim.targetId)
      : notesById.get(claim.targetId);
    if (!target) {
      throw new Error("Vault 이름 예약 대상 스냅샷이 변경되었습니다.");
    }
    processedTargetIds.add(claim.targetId);

    if (deferredTargetIdSet.has(claim.targetId)) {
      if (claim.targetType === "entry" && input.legacyActiveNoteIds.has(claim.targetId)) {
        const result = await migrateLegacyVaultEntryIdentity(
          target as DecryptedVaultNote,
          input.profile.uid,
          input.vaultIntegrityKey,
          false
        );
        if (result.claimState !== "deferred") {
          throw new Error("충돌 대상의 Vault 저장 형식만 분리해 전환하지 못했습니다.");
        }
        complete(true);
      } else {
        complete(false);
      }
      continue;
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
      complete(false);
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
      complete(true);
    } else {
      const note = target as DecryptedVaultNote;
      if (input.legacyActiveNoteIds.has(note.id)) {
        const result = await migrateLegacyVaultEntryIdentity(
          note,
          input.profile.uid,
          input.vaultIntegrityKey,
          true
        );
        if (result.claimState !== "reserved") {
          throw new Error("활성 legacy Vault 항목의 이름 예약을 함께 전환하지 못했습니다.");
        }
      } else if (metadataMatches) {
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
      complete(true);
    }
  }

  for (const target of [...orderedFolders, ...input.notes]) {
    if (processedTargetIds.has(target.id)) continue;
    if (!deferredTargetIdSet.has(target.id)) {
      throw new Error("Vault 이름 예약 계획에서 활성 대상을 확인할 수 없습니다.");
    }
    if (input.legacyActiveNoteIds.has(target.id)) {
      const result = await migrateLegacyVaultEntryIdentity(
        target as DecryptedVaultNote,
        input.profile.uid,
        input.vaultIntegrityKey,
        false
      );
      if (result.claimState !== "deferred") {
        throw new Error("보류된 Vault 저장 형식 전환 결과를 확인할 수 없습니다.");
      }
      complete(true);
    } else {
      complete(false);
    }
  }

  for (const note of input.deletedNotes) {
    if (input.legacyDeletedNoteIds.has(note.id)) {
      const result = await migrateLegacyVaultEntryIdentity(
        note,
        input.profile.uid,
        input.vaultIntegrityKey,
        false
      );
      if (result.claimState !== "deleted") {
        throw new Error("삭제 Vault 항목의 저장 형식 전환 결과를 확인할 수 없습니다.");
      }
      complete(true);
    } else {
      complete(false);
    }
  }

  return { ...progress, collisions: plan.collisions, deferredTargetIds };
}

/**
 * Final read-only cutover gate. Callers must pass a newly decrypted server
 * inventory after every migration write. Active winners need both matching
 * metadata and the matching claim document; deferred entries need identity
 * only, while deleted entries are intentionally excluded from name claims.
 */
export async function auditVaultNameReservations(
  input: VaultNameReservationAuditInput
): Promise<Pick<VaultNameReservationMigrationResult, "collisions" | "deferredTargetIds">> {
  const {
    deferredTargetIdSet,
    deferredTargetIds,
    foldersById,
    notesById,
    plan
  } = await buildVaultNameReservationPlan(input);

  for (const claim of plan.claims) {
    const target = claim.targetType === "folder"
      ? foldersById.get(claim.targetId)
      : notesById.get(claim.targetId);
    if (!target) {
      throw new Error("최종 Vault 이름 예약 대상이 server inventory에 없습니다.");
    }
    if (deferredTargetIdSet.has(claim.targetId)) {
      if (target.vaultNameClaimId !== undefined || target.vaultNameIndexVersion !== undefined) {
        throw new Error("보류된 Vault 항목이 활성 이름 예약 metadata를 보유하고 있습니다.");
      }
      continue;
    }
    if (
      target.vaultNameClaimId !== claim.fingerprint
      || target.vaultNameIndexVersion !== VAULT_NAME_INDEX_VERSION
      || !(await vaultNameClaimReservationMatches({
        claimId: claim.fingerprint,
        ownerUid: input.profile.uid,
        parentId: claim.parentId,
        targetId: claim.targetId,
        targetType: claim.targetType
      }))
    ) {
      throw new Error("활성 Vault 항목의 이름 예약을 서버에서 최종 확인하지 못했습니다.");
    }
  }

  for (const targetId of deferredTargetIds) {
    const note = notesById.get(targetId);
    if (note && (note.vaultNameClaimId !== undefined || note.vaultNameIndexVersion !== undefined)) {
      throw new Error("보류된 Vault 노트는 이름 예약 없이 저장 형식만 보유해야 합니다.");
    }
  }

  for (const note of input.deletedNotes) {
    const hasClaimId = note.vaultNameClaimId !== undefined;
    const hasClaimVersion = note.vaultNameIndexVersion !== undefined;
    if (hasClaimId !== hasClaimVersion) {
      throw new Error("삭제 Vault 항목의 이름 예약 metadata가 부분적으로 남아 있습니다.");
    }
    if (!hasClaimId) continue;
    if (
      typeof note.vaultNameClaimId !== "string"
      || !/^[A-Za-z0-9_-]{43}$/u.test(note.vaultNameClaimId)
      || note.vaultNameIndexVersion !== VAULT_NAME_INDEX_VERSION
    ) {
      throw new Error("삭제 Vault 항목의 이름 예약 metadata가 올바르지 않습니다.");
    }
    if (await vaultNameClaimReservationMatches({
      claimId: note.vaultNameClaimId,
      ownerUid: input.profile.uid,
      parentId: note.folderId ?? null,
      targetId: note.id,
      targetType: "entry"
    })) {
      throw new Error("삭제 Vault 항목의 활성 이름 예약이 서버에 남아 있습니다.");
    }
  }

  return { collisions: plan.collisions, deferredTargetIds };
}
