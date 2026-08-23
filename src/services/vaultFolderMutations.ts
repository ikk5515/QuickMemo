import { getToken as getAppCheckToken } from "firebase/app-check";
import { appCheck, auth } from "../lib/firebase";
import type { EncryptedPayload, WrappedNoteKey } from "../types";

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
};

type ResolveCollisionPayloadBase = CutoverLeasePayload & {
  action: "resolve-collision";
  expectedRevision: number;
  folderId: string;
  nameClaim: VaultFolderNameClaimInput;
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

type MaintenancePayload = { action: "audit" | "bootstrap" };

export type VaultFolderApiPayload =
  | CreatePayload
  | LifecyclePayload
  | MaintenancePayload
  | MigratePayload
  | ResolveCollisionPayload
  | UpdatePayload;

export class VaultFolderApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code === "vault_import_locked"
      ? "Vault 가져오기 또는 복구가 끝날 때까지 기존 폴더 변경이 잠깁니다."
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
  if (payload.action === "bootstrap") {
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
  const [idToken, verificationToken] = await Promise.all([
    user.getIdToken(),
    bestEffortAppCheckToken()
  ]);
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${idToken}`,
    "content-type": "application/json",
    "x-quickmemo-vault-folder-tree": "1"
  });
  if (verificationToken) headers.set("x-firebase-appcheck", verificationToken);

  let response: Response;
  try {
    response = await fetch(vaultFolderApiPath, {
      body: JSON.stringify(payload),
      cache: "no-store",
      credentials: "same-origin",
      headers,
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new VaultFolderApiError("network_error", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new VaultFolderApiError("invalid_response", response.status);
  }
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

export async function mutateVaultFolder(
  ownerUid: string,
  payload: Exclude<VaultFolderApiPayload, MaintenancePayload>,
  signal?: AbortSignal
) {
  return vaultFolderApiRequest<VaultFolderMutationResult>(ownerUid, payload, signal);
}
