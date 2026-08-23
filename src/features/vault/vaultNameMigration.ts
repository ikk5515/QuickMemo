import {
  updateEncryptedNoteFolder,
  VaultNameConflictError,
  vaultNameClaimReservationMatches,
  type NoteFolderSnapshot,
  type NoteSnapshot
} from "../../services/notes";
import type { VaultIntegrityCutoverLease } from "../../services/vaultIntegrity";
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
  cutoverLease: VaultIntegrityCutoverLease;
  signal?: AbortSignal;
  onLeaseCheckpoint?: () => Promise<void>;
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

export const VAULT_NAME_MIGRATION_WRITE_CONCURRENCY = 4;
export const VAULT_NAME_MIGRATION_LEASE_CHECKPOINT_BATCH_SIZE = 16;

export class VaultNameReservationMigrationConflictError extends Error {
  readonly targetIds: string[];

  constructor(targetIds: readonly string[]) {
    super("이름 예약이 다른 활성 항목에 의해 변경되었습니다. 표시된 항목의 이름이나 위치를 확인해주세요.");
    this.name = "VaultNameReservationMigrationConflictError";
    this.targetIds = [...new Set(targetIds)];
  }
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

type VaultNameMigrationTarget = DecryptedVaultFolder | DecryptedVaultNote;

async function runBoundedMigrationWrites<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  onBatchComplete?: () => Promise<void>,
  signal?: AbortSignal
) {
  for (let offset = 0; offset < items.length; offset += VAULT_NAME_MIGRATION_LEASE_CHECKPOINT_BATCH_SIZE) {
    signal?.throwIfAborted();
    const batch = items.slice(offset, offset + VAULT_NAME_MIGRATION_LEASE_CHECKPOINT_BATCH_SIZE);
    let cursor = 0;
    let failed = false;
    let failure: unknown;
    const runner = async () => {
      while (!failed) {
        signal?.throwIfAborted();
        const index = cursor;
        cursor += 1;
        if (index >= batch.length) return;
        try {
          await worker(batch[index]);
        } catch (caught) {
          if (!failed) {
            failed = true;
            failure = caught;
          }
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(VAULT_NAME_MIGRATION_WRITE_CONCURRENCY, batch.length) },
      runner
    ));
    if (failed) throw failure;
    signal?.throwIfAborted();
    await onBatchComplete?.();
  }
}

function migrationTargetForClaim(
  claim: VaultNameMigrationPlan["claims"][number],
  targetId: string,
  foldersById: ReadonlyMap<string, DecryptedVaultFolder>,
  notesById: ReadonlyMap<string, DecryptedVaultNote>
) {
  return claim.targetType === "folder"
    ? foldersById.get(targetId)
    : notesById.get(targetId);
}

/**
 * A retry must preserve the live server reservation owner. Planning from the
 * decrypted snapshot alone is order-dependent, so a duplicate that completed
 * an earlier atomic reservation could otherwise be demoted and make the new
 * first item fail with a misleading conflict. Only a target whose encrypted
 * metadata and owner-scoped claim document both match may replace the planned
 * winner; plaintext names and target ids are never sent to a repair endpoint.
 */
async function preferExistingReservationOwners(
  plan: VaultNameMigrationPlan,
  ownerUid: string,
  foldersById: ReadonlyMap<string, DecryptedVaultFolder>,
  notesById: ReadonlyMap<string, DecryptedVaultNote>
): Promise<VaultNameMigrationPlan> {
  const duplicateIdsByFingerprint = new Map<string, string[]>();
  for (const collision of plan.collisions) {
    const duplicateIds = duplicateIdsByFingerprint.get(collision.fingerprint) ?? [];
    duplicateIds.push(collision.duplicateTargetId);
    duplicateIdsByFingerprint.set(collision.fingerprint, duplicateIds);
  }
  if (!duplicateIdsByFingerprint.size) return plan;

  const claims = [] as VaultNameMigrationPlan["claims"];
  const collisions = [] as VaultNameMigrationPlan["collisions"];
  for (const claim of plan.claims) {
    const duplicateIds = duplicateIdsByFingerprint.get(claim.fingerprint);
    if (!duplicateIds?.length) {
      claims.push(claim);
      continue;
    }
    const candidateIds = [claim.targetId, ...duplicateIds];
    const matchingOwners: VaultNameMigrationTarget[] = [];
    for (const candidateId of candidateIds) {
      const target = migrationTargetForClaim(claim, candidateId, foldersById, notesById);
      if (
        !target
        || target.vaultNameClaimId !== claim.fingerprint
        || target.vaultNameIndexVersion !== VAULT_NAME_INDEX_VERSION
      ) {
        continue;
      }
      if (await vaultNameClaimReservationMatches({
        claimId: claim.fingerprint,
        ownerUid,
        parentId: claim.parentId,
        targetId: candidateId,
        targetType: claim.targetType
      })) {
        matchingOwners.push(target);
      }
    }
    if (matchingOwners.length > 1) {
      throw new Error("하나의 Vault 이름 예약을 여러 항목이 보유하고 있어 자동 복구를 중단했습니다.");
    }
    const winnerId = matchingOwners[0]?.id ?? claim.targetId;
    claims.push({ ...claim, targetId: winnerId });
    for (const candidateId of candidateIds) {
      if (candidateId === winnerId) continue;
      collisions.push({
        duplicateTargetId: candidateId,
        fingerprint: claim.fingerprint,
        firstTargetId: winnerId
      });
    }
  }
  return { claims, collisions };
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
  const foldersById = new Map(orderedFolders.map((folder) => [folder.id, folder]));
  const notesById = new Map(input.notes.map((note) => [note.id, note]));
  const initialPlan = await planVaultNameMigration(input.vaultIntegrityKey, [
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
  const plan = await preferExistingReservationOwners(
    initialPlan,
    input.profile.uid,
    foldersById,
    notesById
  );
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
    foldersById,
    notesById,
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
    input.activeNotes.some((note) => (
      note.ownerUid !== input.uid
      || (note.isDeleted !== false && note.isDeleted !== undefined)
    ))
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
  input.signal?.throwIfAborted();
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
  await input.onLeaseCheckpoint?.();
  const migrateEntryIdentity = (
    target: DecryptedVaultNote,
    reserveNameClaim: boolean
  ) => input.signal
    ? migrateLegacyVaultEntryIdentity(
        target,
        input.profile.uid,
        input.vaultIntegrityKey,
        reserveNameClaim,
        input.cutoverLease,
        input.signal
      )
    : migrateLegacyVaultEntryIdentity(
        target,
        input.profile.uid,
        input.vaultIntegrityKey,
        reserveNameClaim,
        input.cutoverLease
      );
  const backfillEntryClaim = (
    target: DecryptedVaultNote,
    repairMissingReservation: boolean
  ) => input.signal
    ? backfillVaultEntryNameClaim(
        target,
        input.profile.uid,
        input.privateKey,
        input.vaultIntegrityKey,
        repairMissingReservation,
        input.cutoverLease,
        input.signal
      )
    : backfillVaultEntryNameClaim(
        target,
        input.profile.uid,
        input.privateKey,
        input.vaultIntegrityKey,
        repairMissingReservation,
        input.cutoverLease
      );
  const complete = (migrated: boolean) => {
    progress.completed += 1;
    if (migrated) progress.migrated += 1;
    else progress.skipped += 1;
    input.onProgress?.({ ...progress });
  };

  const processClaim = async (claim: VaultNameMigrationPlan["claims"][number]) => {
    input.signal?.throwIfAborted();
    const target = claim.targetType === "folder"
      ? foldersById.get(claim.targetId)
      : notesById.get(claim.targetId);
    if (!target) {
      throw new Error("Vault 이름 예약 대상 스냅샷이 변경되었습니다.");
    }
    processedTargetIds.add(claim.targetId);

    if (deferredTargetIdSet.has(claim.targetId)) {
      if (claim.targetType === "entry" && input.legacyActiveNoteIds.has(claim.targetId)) {
        const result = await migrateEntryIdentity(target as DecryptedVaultNote, false);
        if (result.claimState !== "deferred") {
          throw new Error("충돌 대상의 Vault 저장 형식만 분리해 전환하지 못했습니다.");
        }
        complete(true);
      } else {
        complete(false);
      }
      return;
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
    input.signal?.throwIfAborted();

    try {
      if (reservationMatches) {
        complete(false);
      } else if (claim.targetType === "folder") {
        const folder = target as DecryptedVaultFolder;
        if (folder.encryptedName && folder.wrappedKey) {
          const updateInput = {
            expectedRevision: folder.revision ?? 1,
            folderId: folder.id,
            nameClaim: {
              claimId: claim.fingerprint,
              indexVersion: VAULT_NAME_INDEX_VERSION,
              parentId: folder.parentId ?? null
            },
            ownerUid: input.profile.uid,
            ...input.cutoverLease
          };
          if (input.signal) {
            await updateEncryptedNoteFolder(updateInput, input.signal);
          } else {
            await updateEncryptedNoteFolder(updateInput);
          }
        } else {
          const migrationArguments = [
            input.profile,
            input.vaultIntegrityKey,
            folder,
            folder.order ?? progress.completed,
            undefined,
            input.cutoverLease
          ] as const;
          if (input.signal) {
            await migrateLegacyVaultFolder(...migrationArguments, input.signal);
          } else {
            await migrateLegacyVaultFolder(...migrationArguments);
          }
        }
        complete(true);
      } else {
        const note = target as DecryptedVaultNote;
        if (input.legacyActiveNoteIds.has(note.id)) {
          const result = await migrateEntryIdentity(note, true);
          if (result.claimState !== "reserved") {
            throw new Error("활성 legacy Vault 항목의 이름 예약을 함께 전환하지 못했습니다.");
          }
        } else if (metadataMatches) {
          await backfillEntryClaim(note, true);
        } else {
          await backfillEntryClaim(note, false);
        }
        complete(true);
      }
    } catch (error) {
      if (error instanceof VaultNameConflictError) {
        throw new VaultNameReservationMigrationConflictError([claim.targetId]);
      }
      throw error;
    }
  };

  // Legacy folders must stay parent-first. Entry reservations are independent
  // revision-aware transactions, so a small fixed worker pool avoids a 5,000
  // request serial waterfall without creating an unbounded write burst.
  for (const claim of plan.claims.filter((candidate) => candidate.targetType === "folder")) {
    input.signal?.throwIfAborted();
    await processClaim(claim);
    await input.onLeaseCheckpoint?.();
  }
  await runBoundedMigrationWrites(
    plan.claims.filter((claim) => claim.targetType === "entry"),
    processClaim,
    input.onLeaseCheckpoint,
    input.signal
  );

  for (const target of [...orderedFolders, ...input.notes]) {
    input.signal?.throwIfAborted();
    if (processedTargetIds.has(target.id)) continue;
    if (!deferredTargetIdSet.has(target.id)) {
      throw new Error("Vault 이름 예약 계획에서 활성 대상을 확인할 수 없습니다.");
    }
    if (input.legacyActiveNoteIds.has(target.id)) {
      const result = await migrateEntryIdentity(target as DecryptedVaultNote, false);
      if (result.claimState !== "deferred") {
        throw new Error("보류된 Vault 저장 형식 전환 결과를 확인할 수 없습니다.");
      }
      complete(true);
    } else {
      complete(false);
    }
    await input.onLeaseCheckpoint?.();
  }

  for (const note of input.deletedNotes) {
    input.signal?.throwIfAborted();
    if (input.legacyDeletedNoteIds.has(note.id)) {
      const result = await migrateEntryIdentity(note, false);
      if (result.claimState !== "deleted") {
        throw new Error("삭제 Vault 항목의 저장 형식 전환 결과를 확인할 수 없습니다.");
      }
      complete(true);
    } else {
      complete(false);
    }
    await input.onLeaseCheckpoint?.();
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
