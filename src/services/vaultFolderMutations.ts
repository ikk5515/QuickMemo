import { getToken as getAppCheckToken } from "firebase/app-check";
import { appCheck, auth } from "../lib/firebase";
import type { EncryptedPayload, WrappedNoteKey } from "../types";
import type { VaultPathRewriteActivationInput } from "./vaultPathRewriteJobs";
import { createVaultApiDeadline } from "./vaultApiDeadline";

export const vaultFolderApiPath = "/api/vault-folders";

export interface VaultFolderNameClaimInput {
  claimId: string;
  indexVersion: 1;
  parentId: string | null;
}

export interface VaultFolderMutationResult {
  folderId: string;
  revision: number;
  treeRevision: number;
}

type CutoverLeasePayload = {
  leaseGeneration?: string;
  leaseId?: string;
};

type CreatePayload = {
  action: "create";
  color: string;
  encryptedName: EncryptedPayload;
  folderId: string;
  importJobId?: string;
  nameClaim: VaultFolderNameClaimInput;
  order: number;
  parentId: string | null;
  wrappedKey: WrappedNoteKey;
};

type UpdatePayload = CutoverLeasePayload & {
  action: "move" | "update";
  encryptedName?: EncryptedPayload;
  expectedRevision: number;
  folderId: string;
  nameClaim: VaultFolderNameClaimInput;
  order?: number;
  parentId?: string | null;
  pathRewriteActivation?: VaultPathRewriteActivationInput;
};

type ResolveCollisionPayloadBase = CutoverLeasePayload & {
  action: "resolve-collision";
  expectedRevision: number;
  folderId: string;
  nameClaim: VaultFolderNameClaimInput;
  pathRewriteActivation?: VaultPathRewriteActivationInput;
};

type ResolveEncryptedCollisionPayload = ResolveCollisionPayloadBase & (
  | { encryptedName: EncryptedPayload; parentId?: string | null }
  | { encryptedName?: EncryptedPayload; parentId: string | null }
);

type ResolveLegacyCollisionPayload = {
  action: "resolve-collision";
  color: string;
  encryptedName: EncryptedPayload;
  expectedName: string;
  folderId: string;
  nameClaim: VaultFolderNameClaimInput;
  order: number;
  parentId: string | null;
  wrappedKey: WrappedNoteKey;
};

type ResolveCollisionPayload =
  | ResolveEncryptedCollisionPayload
  | ResolveLegacyCollisionPayload;

type MigratePayload = CutoverLeasePayload & {
  action: "migrate";
  color: string;
  encryptedName: EncryptedPayload;
  expectedName: string;
  folderId: string;
  nameClaim: VaultFolderNameClaimInput;
  order: number;
  parentId: string | null;
  wrappedKey: WrappedNoteKey;
};

type LifecyclePayload = {
  action: "restore" | "trash";
  expectedRevision: number;
  folderId: string;
};

type MaintenancePayload = { action: "audit" | "bootstrap" | "repair" };

type PastedImageFolderLockPayload = {
  action: "paste-lock-acquire";
  expectedRevision: number;
  folderId: string;
  lockId: string;
} | {
  action: "paste-lock-release";
  folderId: string;
  lockId: string;
};

export type VaultFolderApiPayload =
  | CreatePayload
  | LifecyclePayload
  | MaintenancePayload
  | MigratePayload
  | PastedImageFolderLockPayload
  | ResolveCollisionPayload
  | UpdatePayload;

export class VaultFolderApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code === "vault_paste_locked"
      ? "이미지 붙여넣기가 끝날 때까지 해당 폴더를 변경할 수 없습니다."
      : code === "vault_import_locked"
      ? "Vault 가져오기 또는 복구가 끝날 때까지 기존 폴더 변경이 잠깁니다."
      : code === "network_timeout"
        ? "서버 응답이 지연되어 폴더 작업 잠금을 해제했습니다. 현재 목록을 확인한 뒤 다시 시도해주세요."
      : code === "vault_path_rewrite_inventory_changed"
        ? "다른 탭에서 Vault 항목이나 폴더가 변경되었습니다. 최신 목록으로 다시 시도해주세요."
        : code === "vault_path_rewrite_inventory_capacity"
          ? "Vault 항목 또는 폴더 수가 안전한 경로 갱신 한도를 초과했습니다."
      : status === 409
        ? "다른 탭에서 폴더가 변경되었습니다. 새로고침 후 다시 시도해주세요."
        : status === 401 || status === 403
          ? "Vault 폴더 작업 권한을 다시 확인해주세요."
          : "Vault 폴더 작업을 안전하게 완료하지 못했습니다.");
    this.name = "VaultFolderApiError";
    this.code = code;
    this.status = status;
  }
}

const readyTreeRequests = new Map<string, Promise<{
  folderCount: number;
  revision: number;
  schemaVersion: 1;
  status: "created" | "ready";
}>>();
const activeRepairRequests = new Map<string, Promise<{
  folderCount: number;
  revision: number;
  schemaVersion: 1;
  status: "created" | "ready";
}>>();

const maximumFolderCount = 2_000;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number) {
  return Number.isSafeInteger(value)
    && Number(value) >= minimum
    && Number(value) <= maximum;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length
    && actual.every((key, index) => key === canonicalExpected[index]);
}

function validVaultFolderSuccess(
  body: unknown,
  payload: VaultFolderApiPayload
): body is Record<string, unknown> {
  if (
    !isJsonObject(body)
    || body.ok !== true
    || body.schemaVersion !== 1
    || body.maximumFolderCount !== maximumFolderCount
  ) {
    return false;
  }
  if (payload.action === "bootstrap" || payload.action === "repair") {
    return hasExactKeys(body, [
      "folderCount", "maximumFolderCount", "ok", "revision", "schemaVersion", "status"
    ])
      && isIntegerInRange(body.folderCount, 0, maximumFolderCount)
      && isIntegerInRange(body.revision, 0, 999_999_999_999)
      && (body.status === "created" || body.status === "ready");
  }
  if (payload.action === "audit") {
    return hasExactKeys(body, [
      "folderCount", "matches", "maximumFolderCount", "ok", "revision", "schemaVersion", "status"
    ])
      && isIntegerInRange(body.folderCount, 0, maximumFolderCount)
      && typeof body.matches === "boolean"
      && isIntegerInRange(body.revision, 0, 999_999_999_999)
      && (body.status === "missing" || body.status === "ok" || body.status === "stale");
  }
  return hasExactKeys(body, [
    "folderId", "maximumFolderCount", "ok", "revision", "schemaVersion", "treeRevision"
  ])
    && "folderId" in payload
    && body.folderId === payload.folderId
    && isIntegerInRange(body.revision, 1, 999_999_999_999)
    && isIntegerInRange(body.treeRevision, 1, 999_999_999_999);
}

async function bestEffortAppCheckToken() {
  if (!appCheck) return null;
  try {
    const token = (await getAppCheckToken(appCheck, false)).token;
    return typeof token === "string" && token.length <= 16_384 ? token : null;
  } catch {
    return null;
  }
}

export async function vaultFolderApiRequest<T>(
  ownerUid: string,
  payload: VaultFolderApiPayload,
  signal?: AbortSignal
): Promise<T> {
  const user = auth.currentUser;
  if (!user || user.uid !== ownerUid) {
    throw new VaultFolderApiError("authentication_required", 401);
  }
  signal?.throwIfAborted();
  const deadline = createVaultApiDeadline(signal);
  let idToken: string;
  let verificationToken: string | null;
  try {
    [idToken, verificationToken] = await deadline.race(Promise.all([
      user.getIdToken(),
      bestEffortAppCheckToken()
    ]));
  } catch (error) {
    deadline.dispose();
    if (signal?.aborted) throw error;
    throw new VaultFolderApiError(deadline.timedOut() ? "network_timeout" : "network_error", 0);
  }
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${idToken}`,
    "content-type": "application/json",
    "x-quickmemo-vault-folder-tree": "1"
  });
  if (verificationToken) headers.set("x-firebase-appcheck", verificationToken);

  let response: Response;
  try {
    response = await deadline.race(fetch(vaultFolderApiPath, {
      body: JSON.stringify(payload),
      cache: "no-store",
      credentials: "same-origin",
      headers,
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: deadline.signal
    }));
  } catch (error) {
    deadline.dispose();
    if (signal?.aborted) throw error;
    throw new VaultFolderApiError(deadline.timedOut() ? "network_timeout" : "network_error", 0);
  }
  let body: unknown;
  try {
    body = await deadline.race(response.json());
  } catch {
    deadline.dispose();
    if (signal?.aborted) signal.throwIfAborted();
    if (deadline.timedOut()) throw new VaultFolderApiError("network_timeout", 0);
    throw new VaultFolderApiError("invalid_response", response.status);
  }
  deadline.dispose();
  if (!response.ok) {
    const code = isJsonObject(body) && typeof body.error === "string"
      && typeof body.error === "string"
      ? body.error
      : "request_failed";
    throw new VaultFolderApiError(code, response.status);
  }
  if (!validVaultFolderSuccess(body, payload)) {
    throw new VaultFolderApiError("invalid_response", response.status);
  }
  return body as T;
}

export async function ensureVaultFolderTree(ownerUid: string) {
  const existing = readyTreeRequests.get(ownerUid);
  if (existing) return existing;
  const request = vaultFolderApiRequest<{
    folderCount: number;
    revision: number;
    schemaVersion: 1;
    status: "created" | "ready";
  }>(ownerUid, { action: "bootstrap" });
  readyTreeRequests.set(ownerUid, request);
  try {
    return await request;
  } catch (error) {
    readyTreeRequests.delete(ownerUid);
    throw error;
  }
}

/**
 * Rebuilds the server-owned folder tree from the owner's encrypted folder
 * documents. This is deliberately separate from the cached O(1) bootstrap so
 * ordinary sign-in never scans the complete Vault. Callers should use it only
 * after a server mutation reports a known tree/parent consistency error.
 */
export async function repairVaultFolderTree(ownerUid: string, signal?: AbortSignal) {
  const activeRepair = signal ? null : activeRepairRequests.get(ownerUid);
  if (activeRepair) return activeRepair;
  invalidateVaultFolderTreeReadiness(ownerUid);
  const request = vaultFolderApiRequest<{
    folderCount: number;
    revision: number;
    schemaVersion: 1;
    status: "created" | "ready";
  }>(ownerUid, { action: "repair" }, signal);
  if (!signal) activeRepairRequests.set(ownerUid, request);
  try {
    const repaired = await request;
    // A successful repair is also a valid readiness result. Cache only the
    // settled value so one caller's AbortSignal is never shared with another.
    readyTreeRequests.set(ownerUid, Promise.resolve(repaired));
    return repaired;
  } catch (error) {
    readyTreeRequests.delete(ownerUid);
    throw error;
  } finally {
    if (!signal && activeRepairRequests.get(ownerUid) === request) {
      activeRepairRequests.delete(ownerUid);
    }
  }
}

export function invalidateVaultFolderTreeReadiness(ownerUid: string) {
  readyTreeRequests.delete(ownerUid);
}

export async function auditVaultFolderTreeServer(ownerUid: string) {
  return vaultFolderApiRequest<{
    folderCount: number;
    matches: boolean;
    revision: number;
    schemaVersion: 1;
    status: "missing" | "ok" | "stale";
  }>(ownerUid, { action: "audit" });
}

export function vaultFolderResponseMayHaveBeenLost(caught: unknown) {
  return caught instanceof VaultFolderApiError
    && (
      caught.code === "network_error"
      || caught.code === "network_timeout"
      || caught.code === "invalid_response"
      || caught.status >= 500
    );
}

async function vaultFolderApiRequestWithSingleAmbiguousRetry<T>(
  ownerUid: string,
  payload: VaultFolderApiPayload,
  signal?: AbortSignal
) {
  try {
    return await vaultFolderApiRequest<T>(ownerUid, payload, signal);
  } catch (caught) {
    if (!vaultFolderResponseMayHaveBeenLost(caught)) throw caught;
    signal?.throwIfAborted();
    return vaultFolderApiRequest<T>(ownerUid, payload, signal);
  }
}

export async function mutateVaultFolder(
  ownerUid: string,
  payload: Exclude<VaultFolderApiPayload, MaintenancePayload | PastedImageFolderLockPayload>,
  signal?: AbortSignal
) {
  try {
    return await vaultFolderApiRequest<VaultFolderMutationResult>(ownerUid, payload, signal);
  } catch (caught) {
    const responseMayHaveBeenLost = vaultFolderResponseMayHaveBeenLost(caught);
    if (payload.action !== "create" || !responseMayHaveBeenLost) throw caught;
    signal?.throwIfAborted();
    return vaultFolderApiRequest<VaultFolderMutationResult>(ownerUid, payload, signal);
  }
}

export async function acquireVaultPastedImageFolderLock(
  ownerUid: string,
  input: {
    expectedRevision: number;
    folderId: string;
    lockId: string;
  },
  signal?: AbortSignal
) {
  return vaultFolderApiRequestWithSingleAmbiguousRetry<VaultFolderMutationResult>(ownerUid, {
    action: "paste-lock-acquire",
    expectedRevision: input.expectedRevision,
    folderId: input.folderId,
    lockId: input.lockId
  }, signal);
}

export async function releaseVaultPastedImageFolderLock(
  ownerUid: string,
  input: {
    folderId: string;
    lockId: string;
  },
  signal?: AbortSignal
) {
  // Lock ids are operation-unique and the caller cannot begin a replacement
  // lease until this promise settles. Replaying the exact matching release is
  // therefore safe: an already-released or different lease is a server no-op.
  return vaultFolderApiRequestWithSingleAmbiguousRetry<VaultFolderMutationResult>(ownerUid, {
    action: "paste-lock-release",
    folderId: input.folderId,
    lockId: input.lockId
  }, signal);
}
