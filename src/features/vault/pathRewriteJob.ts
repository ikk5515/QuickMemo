import { bytesToBase64 } from "../../lib/crypto";
import type { CanvasPathRewritePlan } from "../canvas/canvasLinkRewrite";
import {
  applyInternalLinkRewritePlan,
  type InternalLinkRewritePlan,
  type RevisionedVaultIndexEntry,
  type VaultEntryPathChange
} from "../knowledge";
import { normalizeVaultPath } from "./interop/path";

export const VAULT_PATH_REWRITE_JOB_VERSION = 1 as const;
export const MAX_VAULT_PATH_REWRITE_STEPS = 5_000;
export const MAX_VAULT_PATH_REWRITE_SOURCE_BYTES = 500_000;
export const MAX_VAULT_PATH_REWRITE_MANIFEST_BYTES = 500_000;

const encoder = new TextEncoder();
const hmacKeyCache = new WeakMap<CryptoKey, Promise<CryptoKey>>();

export type VaultPathRewriteSourceKind = "markdown" | "canvas";

export interface VaultPathRewriteSourcePlan {
  sourceEntryId: string;
  sourceKind: VaultPathRewriteSourceKind;
  expectedRevision: number;
  originalSource: string;
  rewrittenSource: string;
  changeCount: number;
}

export interface VaultPathRewriteManifestV1 {
  version: typeof VAULT_PATH_REWRITE_JOB_VERSION;
  ownerUid: string;
  pathChanges: VaultEntryPathChange[];
  steps: Array<{
    ordinal: number;
    sourceEntryId: string;
    sourceKind: VaultPathRewriteSourceKind;
    expectedRevision: number;
    originalSourceDigest: string;
    rewrittenSourceDigest: string;
    changeCount: number;
  }>;
}

export interface VaultPathRewriteStepV1 {
  version: typeof VAULT_PATH_REWRITE_JOB_VERSION;
  ordinal: number;
  sourceEntryId: string;
  sourceKind: VaultPathRewriteSourceKind;
  expectedRevision: number;
  originalSourceDigest: string;
  rewrittenSourceDigest: string;
  rewrittenSource: string;
  changeCount: number;
}

export interface PreparedVaultPathRewriteJob {
  jobId: string;
  manifest: VaultPathRewriteManifestV1;
  steps: VaultPathRewriteStepV1[];
}

export type VaultPathRewriteSourceState =
  | { state: "pending"; sourceDigest: string }
  | { state: "confirmed"; sourceDigest: string }
  | {
      state: "blocked";
      reason: "revision-mismatch" | "content-mismatch";
      sourceDigest: string;
    };

function base64Url(bytes: ArrayBuffer) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function assertIdentifier(value: string, label: string) {
  if (!value || value !== value.trim() || value.length > 120 || value.includes("/")) {
    throw new Error(`${label} 식별자가 올바르지 않습니다.`);
  }
}

function assertUid(uid: string) {
  if (!uid || uid !== uid.trim() || uid.length > 128 || uid.includes("/")) {
    throw new Error("경로 재작성 작업 사용자를 확인할 수 없습니다.");
  }
}

function assertRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > 999_999_999_999) {
    throw new RangeError("경로 재작성 source revision이 올바르지 않습니다.");
  }
}

function assertSourceSize(source: string) {
  if (encoder.encode(source).byteLength > MAX_VAULT_PATH_REWRITE_SOURCE_BYTES) {
    throw new RangeError("경로 재작성 source가 저장 가능한 크기를 초과했습니다.");
  }
}

async function sha256(value: string) {
  return base64Url(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmacKey(vaultIntegrityKey: CryptoKey) {
  let pending = hmacKeyCache.get(vaultIntegrityKey);
  if (!pending) {
    pending = crypto.subtle.exportKey("raw", vaultIntegrityKey).then((rawKey) => crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    ));
    hmacKeyCache.set(vaultIntegrityKey, pending);
  }
  try {
    return await pending;
  } catch (error) {
    hmacKeyCache.delete(vaultIntegrityKey);
    throw error;
  }
}

async function deterministicJobId(vaultIntegrityKey: CryptoKey, manifest: VaultPathRewriteManifestV1) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(vaultIntegrityKey),
    encoder.encode(JSON.stringify(["quickmemo/vault-path-rewrite", manifest]))
  );
  return `pr1_${base64Url(signature)}`;
}

function normalizePathChanges(pathChanges: readonly VaultEntryPathChange[]) {
  const seenEntryIds = new Set<string>();
  const seenOldPaths = new Set<string>();
  const normalized = pathChanges.map((change) => {
    assertIdentifier(change.entryId, "경로 변경 항목");
    if (seenEntryIds.has(change.entryId)) {
      throw new Error("같은 항목에 중복된 경로 변경이 있습니다.");
    }
    seenEntryIds.add(change.entryId);
    const oldPath = normalizeVaultPath(change.oldPath);
    const newPath = normalizeVaultPath(change.newPath);
    const oldPathKey = oldPath.toLocaleLowerCase("en-US");
    if (seenOldPaths.has(oldPathKey)) {
      throw new Error("중복된 기존 Vault 경로가 있습니다.");
    }
    seenOldPaths.add(oldPathKey);
    if (oldPath.toLocaleLowerCase("en-US") === newPath.toLocaleLowerCase("en-US")) {
      throw new Error("실제 변경이 없는 Vault 경로가 있습니다.");
    }
    return { entryId: change.entryId, oldPath, newPath };
  });
  return normalized.sort((left, right) =>
    left.oldPath.localeCompare(right.oldPath) || left.entryId.localeCompare(right.entryId)
  );
}

/**
 * Converts the current Markdown/Canvas planners into a shared durable source
 * contract. The full original source is used only in memory to prove that the
 * plan is current; only its SHA-256 digest enters the encrypted job record.
 */
export function buildVaultPathRewriteSourcePlans(input: {
  entries: readonly RevisionedVaultIndexEntry[];
  markdownPlans: readonly InternalLinkRewritePlan[];
  canvasPlans: readonly CanvasPathRewritePlan[];
}): VaultPathRewriteSourcePlan[] {
  const entryById = new Map(input.entries.map((entry) => [entry.id, entry]));
  const plans: VaultPathRewriteSourcePlan[] = [];
  const sourceIds = new Set<string>();

  for (const plan of input.markdownPlans) {
    const entry = entryById.get(plan.sourceEntryId);
    if (!entry || entry.kind !== "markdown" || typeof entry.content !== "string") {
      throw new Error("Markdown 경로 재작성 source를 확인할 수 없습니다.");
    }
    const applied = applyInternalLinkRewritePlan(plan, entry.content, entry.revision);
    if (applied.status !== "applied" || applied.appliedPatchCount < 1) {
      throw new Error("Markdown 경로 재작성 계획이 현재 source와 일치하지 않습니다.");
    }
    sourceIds.add(plan.sourceEntryId);
    plans.push({
      sourceEntryId: plan.sourceEntryId,
      sourceKind: "markdown",
      expectedRevision: plan.expectedRevision,
      originalSource: entry.content,
      rewrittenSource: applied.markdown,
      changeCount: applied.appliedPatchCount
    });
  }

  for (const plan of input.canvasPlans) {
    if (sourceIds.has(plan.sourceEntryId)) {
      throw new Error("한 source에 Markdown과 Canvas 재작성 계획이 동시에 지정되었습니다.");
    }
    const entry = entryById.get(plan.sourceEntryId);
    if (
      !entry
      || entry.kind !== "canvas"
      || entry.revision !== plan.expectedRevision
      || entry.content !== plan.originalSource
      || plan.changeCount < 1
    ) {
      throw new Error("Canvas 경로 재작성 계획이 현재 source와 일치하지 않습니다.");
    }
    sourceIds.add(plan.sourceEntryId);
    plans.push({
      sourceEntryId: plan.sourceEntryId,
      sourceKind: "canvas",
      expectedRevision: plan.expectedRevision,
      originalSource: plan.originalSource,
      rewrittenSource: plan.rewrittenSource,
      changeCount: plan.changeCount
    });
  }

  return plans;
}

export async function prepareVaultPathRewriteJob(
  vaultIntegrityKey: CryptoKey,
  input: {
    ownerUid: string;
    pathChanges: readonly VaultEntryPathChange[];
    sourcePlans: readonly VaultPathRewriteSourcePlan[];
  }
): Promise<PreparedVaultPathRewriteJob> {
  assertUid(input.ownerUid);
  if (!vaultIntegrityKey) {
    throw new Error("경로 재작성 무결성 키를 확인할 수 없습니다.");
  }
  if (input.sourcePlans.length > MAX_VAULT_PATH_REWRITE_STEPS) {
    throw new RangeError(`경로 재작성 source는 한 작업에 ${MAX_VAULT_PATH_REWRITE_STEPS}개까지 저장할 수 있습니다.`);
  }

  const pathChanges = normalizePathChanges(input.pathChanges);
  if (!pathChanges.length) {
    throw new Error("경로 재작성 작업에는 하나 이상의 경로 변경이 필요합니다.");
  }

  const sourceIds = new Set<string>();
  const sortedPlans = [...input.sourcePlans].sort((left, right) =>
    left.sourceEntryId.localeCompare(right.sourceEntryId)
  );
  const steps: VaultPathRewriteStepV1[] = [];
  for (const [ordinal, plan] of sortedPlans.entries()) {
    assertIdentifier(plan.sourceEntryId, "경로 재작성 source");
    if (sourceIds.has(plan.sourceEntryId)) {
      throw new Error("같은 source에 중복된 경로 재작성 계획이 있습니다.");
    }
    sourceIds.add(plan.sourceEntryId);
    if (plan.sourceKind !== "markdown" && plan.sourceKind !== "canvas") {
      throw new Error("경로 재작성 source 종류가 올바르지 않습니다.");
    }
    assertRevision(plan.expectedRevision);
    if (!Number.isSafeInteger(plan.changeCount) || plan.changeCount < 1 || plan.changeCount > 100_000) {
      throw new RangeError("경로 재작성 변경 수가 올바르지 않습니다.");
    }
    assertSourceSize(plan.originalSource);
    assertSourceSize(plan.rewrittenSource);
    if (plan.originalSource === plan.rewrittenSource) {
      throw new Error("실제 내용 변경이 없는 경로 재작성 계획이 있습니다.");
    }
    const [originalSourceDigest, rewrittenSourceDigest] = await Promise.all([
      sha256(plan.originalSource),
      sha256(plan.rewrittenSource)
    ]);
    steps.push({
      version: VAULT_PATH_REWRITE_JOB_VERSION,
      ordinal,
      sourceEntryId: plan.sourceEntryId,
      sourceKind: plan.sourceKind,
      expectedRevision: plan.expectedRevision,
      originalSourceDigest,
      rewrittenSourceDigest,
      rewrittenSource: plan.rewrittenSource,
      changeCount: plan.changeCount
    });
  }

  const manifest: VaultPathRewriteManifestV1 = {
    version: VAULT_PATH_REWRITE_JOB_VERSION,
    ownerUid: input.ownerUid,
    pathChanges,
    steps: steps.map((step) => ({
      ordinal: step.ordinal,
      sourceEntryId: step.sourceEntryId,
      sourceKind: step.sourceKind,
      expectedRevision: step.expectedRevision,
      originalSourceDigest: step.originalSourceDigest,
      rewrittenSourceDigest: step.rewrittenSourceDigest,
      changeCount: step.changeCount
    }))
  };
  if (encoder.encode(JSON.stringify(manifest)).byteLength > MAX_VAULT_PATH_REWRITE_MANIFEST_BYTES) {
    throw new RangeError("경로 재작성 manifest가 저장 가능한 크기를 초과했습니다.");
  }

  return {
    jobId: await deterministicJobId(vaultIntegrityKey, manifest),
    manifest,
    steps
  };
}

export async function classifyVaultPathRewriteSourceState(
  step: VaultPathRewriteStepV1,
  actual: { revision: number; source: string }
): Promise<VaultPathRewriteSourceState> {
  assertRevision(actual.revision);
  assertSourceSize(actual.source);
  const sourceDigest = await sha256(actual.source);
  if (actual.revision === step.expectedRevision && sourceDigest === step.originalSourceDigest) {
    return { state: "pending", sourceDigest };
  }
  if (actual.revision === step.expectedRevision + 1 && sourceDigest === step.rewrittenSourceDigest) {
    return { state: "confirmed", sourceDigest };
  }
  return {
    state: "blocked",
    reason: actual.revision === step.expectedRevision || actual.revision === step.expectedRevision + 1
      ? "content-mismatch"
      : "revision-mismatch",
    sourceDigest
  };
}
