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

type UpdatePayload = {
  action: "move" | "update";
  encryptedName?: EncryptedPayload;
  expectedRevision: number;
  folderId: string;
  nameClaim: VaultFolderNameClaimInput;
  order?: number;
  parentId?: string | null;
};

type MigratePayload = {
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
  if (!response.ok || !body || typeof body !== "object") {
    const code = body && typeof body === "object" && "error" in body
      && typeof body.error === "string"
      ? body.error
      : "request_failed";
    throw new VaultFolderApiError(code, response.status);
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
  payload: Exclude<VaultFolderApiPayload, MaintenancePayload>
) {
  return vaultFolderApiRequest<VaultFolderMutationResult>(ownerUid, payload);
}
