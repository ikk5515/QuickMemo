import {
  collection,
  getDocsFromServer,
  limit,
  query,
  where
} from "firebase/firestore";
import { createVaultImportManifest } from "../features/vault/importRollback";
import { deterministicVaultOperationId } from "../features/vault/core/operationId";
import {
  LibraryVaultPromotionStageError,
  LibraryVaultUserError,
  type LibraryVaultPromotionStage
} from "../features/library/libraryVaultErrors";
import { libraryItemToVaultMarkdown } from "../features/library/libraryVaultMarkdown";
import { decryptVaultNotes } from "../features/vault/vaultData";
import {
  canonicalVaultName,
  vaultNameFingerprint
} from "../features/vault/vaultIntegrity";
import { assertVaultPayloadFitsPersistence } from "../features/vault/vaultPayloadLimits";
import { createEncryptedVaultEntry } from "../features/vault/vaultPersistence";
import { db } from "../lib/firebase";
import type { DecryptedLibraryItem } from "./library";
import type { NoteSnapshot } from "./notes";
import {
  cleanupTerminalVaultImportJob,
  commitVaultImportJob,
  ensureVaultImportJob,
  loadVaultImportJob,
  rollbackVaultImportJob,
  type VaultImportJobSummary
} from "./vaultImportJobs";
import type { UserProfile } from "../types";

export interface PromoteLibraryItemToVaultInput {
  folderId?: string | null;
  item: DecryptedLibraryItem;
  privateKey: CryptoKey;
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">;
  title?: string;
  vaultIntegrityKey: CryptoKey;
}

export interface LibraryVaultPromotionResult {
  body: string;
  noteId: string;
  revision: number;
  state: "created" | "existing" | "recovered";
  title: string;
}

interface PromotionTarget {
  body: string;
  contentFormat: string | undefined;
  entryKind: string | undefined;
  folderId: string | null;
  isDeleted: boolean;
  isPurged: boolean;
  noteId: string;
  ownerUid: string;
  revision: number;
  title: string;
  vaultImportJobId: string | undefined;
}

interface PromotionDependencies {
  cleanupJob: typeof cleanupTerminalVaultImportJob;
  commitJob: typeof commitVaultImportJob;
  createEntry: (
    ...parameters: Parameters<typeof createEncryptedVaultEntry>
  ) => Promise<unknown>;
  ensureJob: typeof ensureVaultImportJob;
  loadJob: typeof loadVaultImportJob;
  readTarget: (
    uid: string,
    privateKey: CryptoKey,
    noteId: string,
    jobId: string
  ) => Promise<PromotionTarget | null>;
  rollbackJob: typeof rollbackVaultImportJob;
}

const productionDependencies: PromotionDependencies = {
  cleanupJob: cleanupTerminalVaultImportJob,
  commitJob: commitVaultImportJob,
  createEntry: createEncryptedVaultEntry,
  ensureJob: ensureVaultImportJob,
  loadJob: loadVaultImportJob,
  readTarget: async (uid, privateKey, noteId, jobId) => {
    // A documentId equality query still makes the Rules emulator evaluate a
    // missing resource and fail closed. Bind the lookup to both the owner and
    // deterministic import job instead. The job marker survives later edits
    // and moves, while the bounded result and exact id check prevent a corrupt
    // job from being mistaken for this promotion target.
    const snapshot = await getDocsFromServer(query(
      collection(db, "notes"),
      where("ownerUid", "==", uid),
      where("vaultImportJobId", "==", jobId),
      limit(2)
    ));
    if (snapshot.docs.length > 1) {
      throw new Error("자료실 승격 작업에 둘 이상의 Vault 대상이 연결되어 있습니다.");
    }
    const document = snapshot.docs.find((candidate) => candidate.id === noteId);
    if (snapshot.docs.length && !document) {
      throw new Error("자료실 승격 작업의 Vault 대상 식별자가 일치하지 않습니다.");
    }
    if (!document) return null;
    const encrypted = { id: document.id, ...(document.data() as Omit<NoteSnapshot, "id">) };
    const [note] = await decryptVaultNotes([encrypted], uid, privateKey);
    if (!note) throw new Error("승격된 Vault 노트를 복호화해 확인하지 못했습니다.");
    return {
      body: note.body,
      contentFormat: note.contentFormat,
      entryKind: note.entryKind,
      folderId: note.folderId ?? null,
      isDeleted: note.isDeleted === true,
      isPurged: note.isPurged === true,
      noteId: note.id,
      ownerUid: note.ownerUid,
      revision: note.revision ?? 0,
      title: note.title,
      vaultImportJobId: note.vaultImportJobId
    };
  },
  rollbackJob: rollbackVaultImportJob
};

async function promotionStage<T>(
  stage: LibraryVaultPromotionStage,
  operation: () => Promise<T>
) {
  try {
    return await operation();
  } catch (caught) {
    if (caught instanceof LibraryVaultUserError || caught instanceof LibraryVaultPromotionStageError) {
      throw caught;
    }
    throw new LibraryVaultPromotionStageError(stage, caught);
  }
}

export class LibraryVaultPromotionRecoveryError extends LibraryVaultUserError {
  readonly code = "library-vault/recovery-required";

  constructor() {
    super("Vault 저장 상태를 즉시 정리하지 못했습니다. Vault의 가져오기 복구 화면에서 서버 상태를 다시 확인해주세요.");
    this.name = "LibraryVaultPromotionRecoveryError";
  }
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

async function promotionOperationSeed(item: DecryptedLibraryItem, vaultIntegrityKey: CryptoKey) {
  if (
    !/^[A-Za-z0-9_-]{1,180}$/u.test(item.id)
    || !/^[A-Za-z0-9_-]{8,160}$/u.test(item.generationId)
  ) {
    throw new LibraryVaultUserError("자료실 항목 식별자를 확인할 수 없습니다.");
  }
  const rawKey = await crypto.subtle.exportKey("raw", vaultIntegrityKey);
  const rawKeyBytes = new Uint8Array(rawKey);
  let hmacKey: CryptoKey;
  try {
    hmacKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"]
    );
  } finally {
    rawKeyBytes.fill(0);
  }
  const digest = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode(`quickmemo:library-vault-promotion:v1:${item.id}:${item.generationId}`)
  );
  return base64Url(new Uint8Array(digest));
}

function validateDestinationFolderId(folderId: string | null) {
  if (folderId !== null && (!folderId || folderId.length > 120 || folderId.includes("/"))) {
    throw new LibraryVaultUserError("Vault 대상 폴더를 확인할 수 없습니다.");
  }
  return folderId;
}

function assertPromotionTarget(
  target: PromotionTarget,
  input: { jobId: string; ownerUid: string }
) {
  if (
    target.ownerUid !== input.ownerUid
    || target.vaultImportJobId !== input.jobId
    || target.contentFormat !== "markdown-v1"
    || target.entryKind !== "markdown"
    || target.isPurged
  ) {
    throw new LibraryVaultUserError("승격 대상 식별자가 다른 Vault 항목과 충돌했습니다.");
  }
  if (target.isDeleted) {
    throw new LibraryVaultUserError("이 자료에서 만든 Vault 노트가 휴지통에 있습니다. 먼저 복구하거나 완전히 정리해주세요.");
  }
  return target;
}

function manifestMatchesPromotion(
  job: VaultImportJobSummary,
  input: { claimId: string; folderId: string | null; targetId: string }
) {
  const target = job.manifest?.targets[0];
  return job.entryCount === 1
    && job.folderCount === 0
    && job.itemCount === 1
    && job.manifest?.targets.length === 1
    && target?.type === "entry"
    && target.targetId === input.targetId
    && target.claimId === input.claimId
    && target.folderId === input.folderId
    && target.contentFormat === "markdown-v1"
    && target.entryKind === "markdown";
}

function assertPromotionJobPlan(
  job: VaultImportJobSummary,
  input: { claimId: string; folderId: string | null; jobId: string; targetId: string },
  allowIncompleteManifest = false
) {
  if (
    job.jobId !== input.jobId
    || job.entryCount !== 1
    || job.folderCount !== 0
    || job.itemCount !== 1
    || job.rootFolderCount !== 0
    || (
      job.manifest !== null
      && !manifestMatchesPromotion(job, input)
    )
  ) {
    throw new LibraryVaultUserError("저장된 자료실 승격 계획이 현재 Vault 대상과 다릅니다.");
  }
  if (!allowIncompleteManifest && job.manifest === null) {
    throw new LibraryVaultPromotionRecoveryError();
  }
  return job;
}

function verifiedPromotionTarget(
  target: PromotionTarget | null,
  input: {
    body: string;
    folderId: string | null;
    jobId: string;
    ownerUid: string;
    title: string;
  }
) {
  if (!target) {
    throw new LibraryVaultPromotionRecoveryError();
  }
  const verified = assertPromotionTarget(target, input);
  if (
    verified.body !== input.body
    || verified.title !== input.title
    || verified.folderId !== input.folderId
    || verified.revision !== 1
  ) {
    throw new LibraryVaultUserError("승격된 Vault 노트가 선택한 자료와 일치하지 않습니다.");
  }
  return verified;
}

async function commitWithResponseLossCheck(
  dependencies: PromotionDependencies,
  uid: string,
  privateKey: CryptoKey,
  jobId: string
) {
  try {
    return { job: await dependencies.commitJob(uid, jobId), responseLost: false as const };
  } catch (caught) {
    const confirmed = await dependencies.loadJob(uid, privateKey, jobId);
    if (confirmed?.status === "committed") return { job: confirmed, responseLost: true as const };
    throw caught;
  }
}

async function bestEffortCompensation(
  dependencies: PromotionDependencies,
  input: PromoteLibraryItemToVaultInput,
  jobId: string
) {
  try {
    const current = await dependencies.loadJob(input.profile.uid, input.privateKey, jobId);
    if (current?.status === "committed") return "committed" as const;
    const rollback = await dependencies.rollbackJob({
      jobId,
      privateKey: input.privateKey,
      uid: input.profile.uid
    });
    if (rollback.status === "committed") return "committed" as const;
    await dependencies.cleanupJob(input.profile.uid, jobId).catch(() => undefined);
    return "rolled-back" as const;
  } catch {
    throw new LibraryVaultPromotionRecoveryError();
  }
}

export async function promoteLibraryItemToVault(
  input: PromoteLibraryItemToVaultInput,
  dependencies: PromotionDependencies = productionDependencies
): Promise<LibraryVaultPromotionResult> {
  if (
    !input.profile.uid
    || input.item.ownerUid !== input.profile.uid
    || !input.privateKey
    || !input.profile.publicKeyJwk
  ) {
    throw new LibraryVaultUserError("자료실과 Vault의 암호화 소유자를 확인할 수 없습니다.");
  }
  const folderId = validateDestinationFolderId(input.folderId ?? null);
  const markdown = libraryItemToVaultMarkdown({
    capturedAt: input.item.createdAt ?? input.item.updatedAt,
    content: input.item.content
  });
  const title = input.title === undefined
    ? markdown.title
    : input.title.trim().normalize("NFC");
  if (!title || Array.from(title).length > 180) {
    throw new LibraryVaultUserError("Vault 노트 이름은 1~180자로 입력해주세요.");
  }
  canonicalVaultName(title, "entry", "markdown");
  assertVaultPayloadFitsPersistence({
    body: markdown.body,
    contentFormat: "markdown-v1",
    entryKind: "markdown",
    folderId,
    title
  });

  const operationSeed = await promotionOperationSeed(input.item, input.vaultIntegrityKey);
  const [jobId, targetId, claimId] = await Promise.all([
    deterministicVaultOperationId("vi1_", operationSeed, "library-promotion-job"),
    deterministicVaultOperationId("vit1_", operationSeed, "library-promotion-entry"),
    vaultNameFingerprint(input.vaultIntegrityKey, {
      kind: "markdown",
      name: title,
      parentId: folderId,
      targetType: "entry"
    })
  ]);
  const manifest = createVaultImportManifest({
    ownerUid: input.profile.uid,
    folders: [],
    entries: [{
      claimId,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      folderId,
      targetId
    }]
  });

  const expectedTarget = {
    body: markdown.body,
    folderId,
    jobId,
    ownerUid: input.profile.uid,
    title
  };
  const ownerVisibleTarget = await promotionStage("read-existing-target", () => (
    dependencies.readTarget(input.profile.uid, input.privateKey, targetId, jobId)
  ));
  if (ownerVisibleTarget) {
    // The deterministic owner+import-job query is safe for a missing or
    // foreign id and lets a terminally cleaned promotion remain idempotent
    // after the user has edited, renamed, or moved it. Those legitimate
    // revisions are accepted only when no live job still controls the target.
    const target = assertPromotionTarget(ownerVisibleTarget, {
      jobId,
      ownerUid: input.profile.uid
    });
    const job = await promotionStage("load-import-job", () => (
      dependencies.loadJob(input.profile.uid, input.privateKey, jobId)
    ));
    if (!job) {
      return {
        body: target.body,
        noteId: target.noteId,
        revision: target.revision,
        state: "existing",
        title: target.title
      };
    }
    assertPromotionJobPlan(
      job,
      { claimId, folderId, jobId, targetId },
      job.status === "committed"
    );
    if (job.status === "preparing" || (
      job.status !== "staging" && job.status !== "committed"
    )) {
      throw new LibraryVaultPromotionRecoveryError();
    }
    // A live job still controls the target, so accepting an edited revision as
    // an idempotent retry would commit or erase evidence for the wrong import.
    // Relaxed revision/content semantics apply only after terminal cleanup.
    verifiedPromotionTarget(target, expectedTarget);
    if (job.status === "staging") {
      await promotionStage("commit-import-job", () => commitWithResponseLossCheck(
        dependencies,
        input.profile.uid,
        input.privateKey,
        jobId
      ));
    }
    await dependencies.cleanupJob(input.profile.uid, jobId).catch(() => undefined);
    return {
      body: target.body,
      noteId: target.noteId,
      revision: target.revision,
      state: "recovered",
      title: target.title
    };
  }

  let loadedJob = await promotionStage("load-import-job", () => (
    dependencies.loadJob(input.profile.uid, input.privateKey, jobId)
  ));
  const recoveredInterruptedOperation = loadedJob !== null;

  if (loadedJob?.status === "committed") {
    assertPromotionJobPlan(loadedJob, { claimId, folderId, jobId, targetId }, true);
    throw new LibraryVaultPromotionRecoveryError();
  }

  if (loadedJob?.status === "rolled-back") {
    assertPromotionJobPlan(loadedJob, { claimId, folderId, jobId, targetId }, true);
    await promotionStage("cleanup-import-job", () => (
      dependencies.cleanupJob(input.profile.uid, jobId)
    ));
    loadedJob = null;
  } else if (
    loadedJob
    && loadedJob.status !== "preparing"
    && loadedJob.status !== "staging"
  ) {
    throw new LibraryVaultPromotionRecoveryError();
  }

  if (loadedJob) {
    assertPromotionJobPlan(
      loadedJob,
      { claimId, folderId, jobId, targetId },
      loadedJob.status === "preparing"
    );
  }

  let prepared = loadedJob?.status === "staging";
  let recoveredResponseLoss = false;
  try {
    let job = loadedJob;
    if (!job || job.status === "preparing") {
      job = await promotionStage("ensure-import-job", () => dependencies.ensureJob({
        jobId,
        manifest,
        privateKey: input.privateKey,
        profile: input.profile
      }));
    }
    assertPromotionJobPlan(job, { claimId, folderId, jobId, targetId });
    if (job.status !== "staging") {
      throw new LibraryVaultUserError("자료실 승격 작업이 저장 준비 상태가 아닙니다.");
    }
    prepared = true;
    try {
      await promotionStage("create-vault-entry", () => dependencies.createEntry(input.profile, input.vaultIntegrityKey, {
        body: markdown.body,
        contentFormat: "markdown-v1",
        entryKind: "markdown",
        folderId,
        title
      }, { importJobId: jobId, targetId }));
    } catch (createError) {
      // This probe is intentionally reachable only after a deterministic,
      // manifest-bound create was attempted. Missing-note reads remain denied
      // by Rules, while an owner-readable target proves response loss or a
      // prior idempotent promotion without exposing arbitrary document ids.
      const responseLossTarget = await dependencies
        .readTarget(input.profile.uid, input.privateKey, targetId, jobId)
        .catch(() => null);
      if (!responseLossTarget) throw createError;
      verifiedPromotionTarget(responseLossTarget, expectedTarget);
      recoveredResponseLoss = true;
    }
    const committed = await promotionStage("commit-import-job", () => commitWithResponseLossCheck(
      dependencies,
      input.profile.uid,
      input.privateKey,
      jobId
    ));
    recoveredResponseLoss = recoveredResponseLoss || committed.responseLost;
    const target = verifiedPromotionTarget(
      await promotionStage("verify-vault-entry", () => (
        dependencies.readTarget(input.profile.uid, input.privateKey, targetId, jobId)
      )),
      expectedTarget
    );
    await dependencies.cleanupJob(input.profile.uid, jobId).catch(() => undefined);
    return {
      body: target.body,
      noteId: target.noteId,
      revision: target.revision,
      state: recoveredResponseLoss || recoveredInterruptedOperation ? "recovered" : "created",
      title: target.title
    };
  } catch (caught) {
    if (prepared) {
      const compensation = await bestEffortCompensation(dependencies, input, jobId);
      if (compensation === "committed") {
        const target = verifiedPromotionTarget(
          await dependencies.readTarget(input.profile.uid, input.privateKey, targetId, jobId),
          expectedTarget
        );
        return {
          body: target.body,
          noteId: target.noteId,
          revision: target.revision,
          state: "recovered",
          title: target.title
        };
      }
    }
    throw caught;
  }
}

export type { PromotionDependencies as LibraryVaultPromotionDependencies };
