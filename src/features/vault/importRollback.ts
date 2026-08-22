import type { VaultContentFormat, VaultEntryKind } from "../../types";

export const VAULT_IMPORT_JOB_VERSION = 1 as const;
export const MAX_VAULT_IMPORT_TARGETS = 10_000;
export const MAX_VAULT_IMPORT_FOLDERS = 5_000;
export const MAX_VAULT_IMPORT_MANIFEST_TARGETS_PER_CHUNK = 100;
export const MAX_VAULT_IMPORT_MANIFEST_CHUNKS = Math.ceil(
  MAX_VAULT_IMPORT_TARGETS / MAX_VAULT_IMPORT_MANIFEST_TARGETS_PER_CHUNK
);

export interface VaultImportEntryTargetV1 {
  type: "entry";
  targetId: string;
  claimId: string;
  folderId: string | null;
  contentFormat: VaultContentFormat;
  entryKind: Exclude<VaultEntryKind, "legacy-html">;
}

export interface VaultImportFolderTargetV1 {
  type: "folder";
  targetId: string;
  claimId: string;
  parentId: string | null;
  root: boolean;
}

export type VaultImportTargetV1 = VaultImportEntryTargetV1 | VaultImportFolderTargetV1;

export interface VaultImportManifestV1 {
  version: typeof VAULT_IMPORT_JOB_VERSION;
  ownerUid: string;
  targets: VaultImportTargetV1[];
}

export interface VaultImportManifestChunkV1 {
  version: typeof VAULT_IMPORT_JOB_VERSION;
  ownerUid: string;
  ordinal: number;
  targets: VaultImportTargetV1[];
}

export interface CreatedVaultImportEntry {
  noteId: string;
  revision: number;
}

export interface VaultImportRollbackResult {
  attempted: number;
  cleanupFailed: number;
  softDeleted: number;
}

export interface VaultImportRollbackNoteSnapshot {
  id: string;
  ownerUid: string;
  contentFormat?: VaultContentFormat;
  entryKind?: VaultEntryKind;
  folderId?: string | null;
  isDeleted?: boolean;
  revision?: number;
  vaultNameClaimId?: string;
  vaultNameIndexVersion?: number;
  vaultImportJobId?: string;
}

export interface VaultImportRollbackFolderSnapshot {
  id: string;
  ownerUid: string;
  parentId?: string | null;
  isDeleted?: boolean;
  revision?: number;
  vaultNameClaimId?: string;
  vaultNameIndexVersion?: number;
  vaultImportJobId?: string;
}

export interface VaultImportRollbackPlan {
  entryDeletes: Array<{ noteId: string; revision: 1 }>;
  folderRootDeletes: Array<{ folderId: string; revision: 1 }>;
  alreadyCleanedEntries: number;
  alreadyCleanedFolderRoots: number;
}

export class VaultImportManifestError extends Error {
  readonly code = "vault-import/invalid-manifest";

  constructor(message: string) {
    super(message);
    this.name = "VaultImportManifestError";
  }
}

export class VaultImportRollbackConflictError extends Error {
  readonly code = "vault-import/rollback-conflict";
  readonly conflictingIds: readonly string[];

  constructor(conflictingIds: readonly string[]) {
    super("가져오기 이후 변경된 항목이 있어 자동 롤백을 잠갔습니다.");
    this.name = "VaultImportRollbackConflictError";
    this.conflictingIds = [...new Set(conflictingIds)].slice(0, 100);
  }
}

function validOwnerUid(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && value === value.trim()
    && !value.includes("/");
}

function validDocumentId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 120
    && value === value.trim()
    && !value.includes("/");
}

function validClaimId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function validEntryFormatPair(contentFormat: unknown, entryKind: unknown) {
  return (contentFormat === "markdown-v1" && entryKind === "markdown")
    || (contentFormat === "json-canvas-v1" && entryKind === "canvas")
    || (contentFormat === "base-v1" && entryKind === "base")
    || (contentFormat === "asset-v1" && entryKind === "asset");
}

function validateTarget(value: unknown): VaultImportTargetV1 {
  if (!value || typeof value !== "object") {
    throw new VaultImportManifestError("가져오기 대상 정보가 올바르지 않습니다.");
  }
  const candidate = value as Partial<VaultImportTargetV1>;
  if (!validDocumentId(candidate.targetId) || !validClaimId(candidate.claimId)) {
    throw new VaultImportManifestError("가져오기 대상 식별자가 올바르지 않습니다.");
  }
  if (candidate.type === "folder") {
    if (candidate.parentId !== null && !validDocumentId(candidate.parentId)) {
      throw new VaultImportManifestError("가져오기 폴더의 상위 식별자가 올바르지 않습니다.");
    }
    if (typeof candidate.root !== "boolean") {
      throw new VaultImportManifestError("가져오기 폴더 root 정보가 올바르지 않습니다.");
    }
    return candidate as VaultImportFolderTargetV1;
  }
  if (candidate.type === "entry") {
    if (candidate.folderId !== null && !validDocumentId(candidate.folderId)) {
      throw new VaultImportManifestError("가져오기 항목의 폴더 식별자가 올바르지 않습니다.");
    }
    if (!validEntryFormatPair(candidate.contentFormat, candidate.entryKind)) {
      throw new VaultImportManifestError("가져오기 항목의 저장 형식이 올바르지 않습니다.");
    }
    return candidate as VaultImportEntryTargetV1;
  }
  throw new VaultImportManifestError("가져오기 대상 종류가 올바르지 않습니다.");
}

export function validateVaultImportManifest(value: unknown): VaultImportManifestV1 {
  if (!value || typeof value !== "object") {
    throw new VaultImportManifestError("가져오기 manifest를 확인할 수 없습니다.");
  }
  const candidate = value as Partial<VaultImportManifestV1>;
  if (
    candidate.version !== VAULT_IMPORT_JOB_VERSION
    || !validOwnerUid(candidate.ownerUid)
    || !Array.isArray(candidate.targets)
    || candidate.targets.length < 1
    || candidate.targets.length > MAX_VAULT_IMPORT_TARGETS
  ) {
    throw new VaultImportManifestError("가져오기 manifest 범위가 올바르지 않습니다.");
  }
  const targets = candidate.targets.map(validateTarget);
  const targetIds = new Set<string>();
  const claimIds = new Set<string>();
  for (const target of targets) {
    const scopedId = `${target.type}:${target.targetId}`;
    if (targetIds.has(scopedId) || claimIds.has(target.claimId)) {
      throw new VaultImportManifestError("가져오기 manifest에 중복 대상이 있습니다.");
    }
    targetIds.add(scopedId);
    claimIds.add(target.claimId);
  }
  const folders = targets.filter((target): target is VaultImportFolderTargetV1 => target.type === "folder");
  if (folders.length > MAX_VAULT_IMPORT_FOLDERS) {
    throw new VaultImportManifestError("가져오기 폴더 수가 안전한 한도를 초과했습니다.");
  }
  const folderIds = new Set(folders.map((folder) => folder.targetId));
  for (const folder of folders) {
    if (folder.parentId === folder.targetId) {
      throw new VaultImportManifestError("가져오기 폴더가 자기 자신을 상위 폴더로 가리킵니다.");
    }
    if (folder.root !== !folderIds.has(folder.parentId ?? "")) {
      throw new VaultImportManifestError("가져오기 폴더 root 정보가 계층과 일치하지 않습니다.");
    }
  }
  // Each imported folder has at most one parent, so an iterative parent walk
  // detects every internal cycle without recursive stack growth at the 5k
  // folder limit. External parents terminate the walk and remain valid roots.
  const folderById = new Map(folders.map((folder) => [folder.targetId, folder]));
  const resolvedFolders = new Set<string>();
  for (const folder of folders) {
    if (resolvedFolders.has(folder.targetId)) continue;
    const path: string[] = [];
    const pathIndexes = new Map<string, number>();
    let currentId: string | null = folder.targetId;
    while (currentId !== null && folderById.has(currentId) && !resolvedFolders.has(currentId)) {
      if (pathIndexes.has(currentId)) {
        throw new VaultImportManifestError("가져오기 폴더 계층에 순환 참조가 있습니다.");
      }
      pathIndexes.set(currentId, path.length);
      path.push(currentId);
      currentId = folderById.get(currentId)?.parentId ?? null;
    }
    path.forEach((folderId) => resolvedFolders.add(folderId));
  }
  return {
    version: VAULT_IMPORT_JOB_VERSION,
    ownerUid: candidate.ownerUid,
    targets
  };
}

export function createVaultImportManifest(input: {
  ownerUid: string;
  entries: readonly Omit<VaultImportEntryTargetV1, "type">[];
  folders: readonly Omit<VaultImportFolderTargetV1, "type" | "root">[];
}) {
  const folderIds = new Set(input.folders.map((folder) => folder.targetId));
  return validateVaultImportManifest({
    version: VAULT_IMPORT_JOB_VERSION,
    ownerUid: input.ownerUid,
    targets: [
      ...input.folders.map((folder) => ({
        ...folder,
        type: "folder" as const,
        root: !folderIds.has(folder.parentId ?? "")
      })),
      ...input.entries.map((entry) => ({ ...entry, type: "entry" as const }))
    ]
  });
}

export function chunkVaultImportManifest(manifestInput: VaultImportManifestV1): VaultImportManifestChunkV1[] {
  const manifest = validateVaultImportManifest(manifestInput);
  const chunks: VaultImportManifestChunkV1[] = [];
  for (let index = 0; index < manifest.targets.length; index += MAX_VAULT_IMPORT_MANIFEST_TARGETS_PER_CHUNK) {
    chunks.push({
      version: VAULT_IMPORT_JOB_VERSION,
      ownerUid: manifest.ownerUid,
      ordinal: chunks.length,
      targets: manifest.targets.slice(index, index + MAX_VAULT_IMPORT_MANIFEST_TARGETS_PER_CHUNK)
    });
  }
  return chunks;
}

export function assembleVaultImportManifest(ownerUid: string, chunks: readonly VaultImportManifestChunkV1[]) {
  if (!chunks.length || chunks.length > MAX_VAULT_IMPORT_MANIFEST_CHUNKS) {
    throw new VaultImportManifestError("가져오기 manifest chunk 수가 올바르지 않습니다.");
  }
  const targets: VaultImportTargetV1[] = [];
  chunks.forEach((chunk, ordinal) => {
    if (
      chunk.version !== VAULT_IMPORT_JOB_VERSION
      || chunk.ownerUid !== ownerUid
      || chunk.ordinal !== ordinal
      || !Array.isArray(chunk.targets)
      || chunk.targets.length < 1
      || chunk.targets.length > MAX_VAULT_IMPORT_MANIFEST_TARGETS_PER_CHUNK
    ) {
      throw new VaultImportManifestError("가져오기 manifest chunk 순서가 올바르지 않습니다.");
    }
    targets.push(...chunk.targets);
  });
  return validateVaultImportManifest({ version: VAULT_IMPORT_JOB_VERSION, ownerUid, targets });
}

function entryMatchesTarget(
  note: VaultImportRollbackNoteSnapshot,
  target: VaultImportEntryTargetV1,
  ownerUid: string,
  jobId: string
) {
  return note.ownerUid === ownerUid
    && note.vaultNameClaimId === target.claimId
    && note.vaultNameIndexVersion === 1
    && note.vaultImportJobId === jobId
    && (note.folderId ?? null) === target.folderId
    && note.contentFormat === target.contentFormat
    && note.entryKind === target.entryKind;
}

function folderMatchesTarget(
  folder: VaultImportRollbackFolderSnapshot,
  target: VaultImportFolderTargetV1,
  ownerUid: string,
  jobId: string
) {
  return folder.ownerUid === ownerUid
    && folder.vaultNameClaimId === target.claimId
    && folder.vaultNameIndexVersion === 1
    && folder.vaultImportJobId === jobId
    && (folder.parentId ?? null) === target.parentId;
}

/**
 * Performs a complete read-only preflight. Any revision, identity, hierarchy,
 * or unexpected-subtree change blocks every destructive callback. This keeps
 * a concurrent user edit from being mistaken for an import residue.
 */
export function planVaultImportRollback(input: {
  jobId: string;
  manifest: VaultImportManifestV1;
  notes: readonly VaultImportRollbackNoteSnapshot[];
  folders: readonly VaultImportRollbackFolderSnapshot[];
}): VaultImportRollbackPlan {
  const manifest = validateVaultImportManifest(input.manifest);
  if (!/^vi1_[A-Za-z0-9_-]{43}$/u.test(input.jobId)) {
    throw new VaultImportRollbackConflictError(["job-id"]);
  }
  const notes = input.notes.filter((note) => note.ownerUid === manifest.ownerUid);
  const folders = input.folders.filter((folder) => folder.ownerUid === manifest.ownerUid);
  if (notes.length !== input.notes.length || folders.length !== input.folders.length) {
    throw new VaultImportRollbackConflictError(["owner-scope"]);
  }
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  if (noteById.size !== notes.length || folderById.size !== folders.length) {
    throw new VaultImportRollbackConflictError(["duplicate-snapshot"]);
  }
  const entryTargets = manifest.targets.filter(
    (target): target is VaultImportEntryTargetV1 => target.type === "entry"
  );
  const folderTargets = manifest.targets.filter(
    (target): target is VaultImportFolderTargetV1 => target.type === "folder"
  );
  const entryTargetIds = new Set(entryTargets.map((target) => target.targetId));
  const folderTargetIds = new Set(folderTargets.map((target) => target.targetId));
  const rootIds = new Set(folderTargets.filter((target) => target.root).map((target) => target.targetId));
  const conflicts: string[] = [];
  const entryDeletes: VaultImportRollbackPlan["entryDeletes"] = [];
  const folderRootDeletes: VaultImportRollbackPlan["folderRootDeletes"] = [];
  let alreadyCleanedEntries = 0;
  let alreadyCleanedFolderRoots = 0;

  for (const target of entryTargets) {
    const note = noteById.get(target.targetId);
    if (!note) continue;
    if (!entryMatchesTarget(note, target, manifest.ownerUid, input.jobId)) {
      conflicts.push(`entry:${target.targetId}`);
      continue;
    }
    if (note.isDeleted === true && note.revision === 2) {
      alreadyCleanedEntries += 1;
    } else if (note.isDeleted === false && note.revision === 1) {
      entryDeletes.push({ noteId: target.targetId, revision: 1 });
    } else {
      conflicts.push(`entry:${target.targetId}`);
    }
  }

  for (const target of folderTargets) {
    const folder = folderById.get(target.targetId);
    if (!folder) continue;
    if (!folderMatchesTarget(folder, target, manifest.ownerUid, input.jobId)) {
      conflicts.push(`folder:${target.targetId}`);
      continue;
    }
    if (target.root) {
      if (folder.isDeleted === true && folder.revision === 2) {
        alreadyCleanedFolderRoots += 1;
      } else if (folder.isDeleted === false && folder.revision === 1) {
        folderRootDeletes.push({ folderId: target.targetId, revision: 1 });
      } else {
        conflicts.push(`folder:${target.targetId}`);
      }
    } else if (folder.isDeleted !== false || folder.revision !== 1) {
      conflicts.push(`folder:${target.targetId}`);
    }
  }

  const subtreeIds = new Set<string>();
  const childrenByParent = new Map<string, string[]>();
  for (const folder of folders) {
    const parentId = folder.parentId ?? null;
    if (parentId === null) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(folder.id);
    childrenByParent.set(parentId, children);
  }
  const pending = [...rootIds];
  while (pending.length) {
    const folderId = pending.pop();
    if (!folderId || subtreeIds.has(folderId)) continue;
    subtreeIds.add(folderId);
    pending.push(...(childrenByParent.get(folderId) ?? []));
  }
  for (const folder of folders) {
    if (subtreeIds.has(folder.id) && !folderTargetIds.has(folder.id)) {
      conflicts.push(`unexpected-folder:${folder.id}`);
    }
  }
  for (const note of notes) {
    const folderId = note.folderId ?? null;
    if (folderId !== null && subtreeIds.has(folderId) && !entryTargetIds.has(note.id)) {
      conflicts.push(`unexpected-entry:${note.id}`);
    }
  }
  if (conflicts.length) throw new VaultImportRollbackConflictError(conflicts);

  return {
    entryDeletes: entryDeletes.reverse(),
    folderRootDeletes,
    alreadyCleanedEntries,
    alreadyCleanedFolderRoots
  };
}

/**
 * Legacy in-memory compensation retained for callers outside the durable ZIP
 * path. It is revision-aware but cannot recover a committed response loss.
 */
export async function compensateCreatedVaultImportEntries(
  entries: readonly CreatedVaultImportEntry[],
  softDelete: (entry: CreatedVaultImportEntry) => Promise<unknown>
): Promise<VaultImportRollbackResult> {
  let cleanupFailed = 0;
  let softDeleted = 0;
  for (const entry of [...entries].reverse()) {
    try {
      await softDelete(entry);
      softDeleted += 1;
    } catch {
      cleanupFailed += 1;
    }
  }
  return { attempted: entries.length, cleanupFailed, softDeleted };
}
