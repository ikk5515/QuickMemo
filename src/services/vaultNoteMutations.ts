import { getToken as getAppCheckToken } from "firebase/app-check";
import { appCheck, auth } from "../lib/firebase";
import type {
  BackfillRevisionedVaultNameClaimInput,
  CreateSecureShareCopyingNoteInput,
  MigrateLegacyVaultNoteInput,
  PurgeNoteInput,
  ResolveRevisionedVaultNameCollisionInput,
  RevisionedNoteLifecycleInput,
  SaveNoteInput,
  SecureShareCopyingNoteLifecycleInput,
  UpdateRevisionedEncryptedNoteInput,
  UpdateRevisionedEncryptedNoteAndFolderInput,
  UpdateRevisionedNoteAccessInput,
  UpdateRevisionedNoteFolderInput,
  VaultNameClaimReservationInput
} from "./notes";

export const vaultNoteApiPath = "/api/vault-notes";
export const vaultNoteApiActions = [
  "access",
  "backfill-claim",
  "create",
  "import-create",
  "migrate-legacy",
  "move",
  "purge",
  "resolve-collision",
  "restore",
  "secure-copy-abort",
  "secure-copy-activate",
  "secure-copy-create",
  "trash",
  "update"
] as const;

type OwnerlessSaveNoteInput = Omit<SaveNoteInput, "ownerUid">;

export type VaultNoteCreatePayload = OwnerlessSaveNoteInput & {
  action: "create";
};

export type VaultNoteImportCreatePayload = OwnerlessSaveNoteInput & {
  action: "import-create";
  importJobId: string;
  noteId: string;
};

export type VaultNoteMigrateLegacyPayload = Omit<
  MigrateLegacyVaultNoteInput,
  "uid"
> & {
  action: "migrate-legacy";
};

export type VaultNoteUpdatePayload = Omit<
  UpdateRevisionedEncryptedNoteInput,
  "uid"
> & {
  action: "update";
  folderId?: string | null;
};

export type VaultNoteAccessPayload = Omit<
  UpdateRevisionedNoteAccessInput,
  "uid"
> & {
  action: "access";
  nameClaim?: VaultNameClaimReservationInput;
};

export type VaultNoteMovePayload = Omit<UpdateRevisionedNoteFolderInput, "uid"> & {
  action: "move";
};

export type VaultNoteRestorePayload = Omit<RevisionedNoteLifecycleInput, "uid"> & {
  action: "restore";
};

export type VaultNoteTrashPayload = Omit<
  RevisionedNoteLifecycleInput,
  "nameClaim" | "uid"
> & {
  action: "trash";
};

export type VaultNoteLifecyclePayload = VaultNoteRestorePayload | VaultNoteTrashPayload;

export type VaultNotePurgePayload = Omit<PurgeNoteInput, "ownerUid" | "uid"> & {
  action: "purge";
};

export type VaultNoteSecureCopyCreatePayload = Omit<
  CreateSecureShareCopyingNoteInput,
  "ownerUid"
> & {
  action: "secure-copy-create";
};

type VaultNoteSecureCopyLifecycleFields = Omit<
  SecureShareCopyingNoteLifecycleInput,
  "uid"
>;

export type VaultNoteSecureCopyAbortPayload = VaultNoteSecureCopyLifecycleFields & {
  action: "secure-copy-abort";
};

export type VaultNoteSecureCopyActivatePayload = VaultNoteSecureCopyLifecycleFields & {
  action: "secure-copy-activate";
};

export type VaultNoteSecureCopyLifecyclePayload =
  | VaultNoteSecureCopyAbortPayload
  | VaultNoteSecureCopyActivatePayload;

export type VaultNoteBackfillClaimPayload = Omit<
  BackfillRevisionedVaultNameClaimInput,
  "uid"
> & {
  action: "backfill-claim";
};

export type VaultNoteResolveCollisionPayload = Omit<
  ResolveRevisionedVaultNameCollisionInput,
  "uid"
> & {
  action: "resolve-collision";
};

export type VaultNoteApiPayload =
  | VaultNoteAccessPayload
  | VaultNoteBackfillClaimPayload
  | VaultNoteCreatePayload
  | VaultNoteImportCreatePayload
  | VaultNoteLifecyclePayload
  | VaultNoteMigrateLegacyPayload
  | VaultNoteMovePayload
  | VaultNotePurgePayload
  | VaultNoteResolveCollisionPayload
  | VaultNoteSecureCopyCreatePayload
  | VaultNoteSecureCopyLifecyclePayload
  | VaultNoteUpdatePayload;

export interface VaultNoteRevisionedMutationResult {
  lastMutationId: string;
  noteId: string;
  ok: true;
  revision: number;
}

export interface VaultNotePurgeResult {
  noteId: string;
  ok: true;
  revision: number;
}

export interface VaultNoteSecureCopyActivateResult {
  noteId: string;
  ok: true;
  revision: number;
  state: "active";
}

export interface VaultNoteMigrateLegacyResult extends VaultNoteRevisionedMutationResult {
  claimState: "deferred" | "deleted" | "reserved";
}

export type VaultNoteMutationResultFor<TPayload extends VaultNoteApiPayload> =
  TPayload extends VaultNotePurgePayload
    ? VaultNotePurgeResult
    : TPayload extends VaultNoteSecureCopyActivatePayload
      ? VaultNoteSecureCopyActivateResult
      : TPayload extends VaultNoteMigrateLegacyPayload
        ? VaultNoteMigrateLegacyResult
        : VaultNoteRevisionedMutationResult;

export class VaultNoteApiError extends Error {
  readonly actualRevision?: number;
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, actualRevision?: unknown) {
    super(code === "vault_import_locked"
      ? "Vault 가져오기 또는 복구가 끝날 때까지 노트 변경이 잠깁니다."
      : code === "vault_name_conflict"
        ? "같은 위치에 동일한 이름의 Vault 항목이 있습니다."
        : code === "revision_conflict" || status === 409
          ? "다른 탭에서 노트가 변경되었습니다. 새로고침 후 다시 시도해주세요."
          : status === 401 || status === 403
            ? "Vault 노트 작업 권한을 다시 확인해주세요."
            : "Vault 노트 작업을 안전하게 완료하지 못했습니다.");
    this.name = "VaultNoteApiError";
    this.actualRevision = code === "revision_conflict"
      && Number.isSafeInteger(actualRevision)
      && Number(actualRevision) >= 0
      && Number(actualRevision) <= 999_999_999_999
      ? Number(actualRevision)
      : undefined;
    this.code = code;
    this.status = status;
  }
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

export async function vaultNoteApiRequest<T>(
  ownerUid: string,
  payload: VaultNoteApiPayload,
  signal?: AbortSignal
): Promise<T> {
  const user = auth.currentUser;
  if (!user || user.uid !== ownerUid) {
    throw new VaultNoteApiError("authentication_required", 401);
  }
  const [idToken, verificationToken] = await Promise.all([
    user.getIdToken(),
    bestEffortAppCheckToken()
  ]);
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${idToken}`,
    "content-type": "application/json",
    "x-quickmemo-vault-notes": "1"
  });
  if (verificationToken) headers.set("x-firebase-appcheck", verificationToken);

  let response: Response;
  try {
    response = await fetch(vaultNoteApiPath, {
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
    throw new VaultNoteApiError("network_error", 0);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new VaultNoteApiError("invalid_response", response.status);
  }
  if (
    !response.ok
    || !body
    || typeof body !== "object"
    || !("ok" in body)
    || body.ok !== true
  ) {
    const code = body && typeof body === "object" && "error" in body
      && typeof body.error === "string"
      ? body.error
      : "request_failed";
    const actualRevision = body && typeof body === "object" && "actualRevision" in body
      ? body.actualRevision
      : undefined;
    throw new VaultNoteApiError(code, response.status, actualRevision);
  }
  return body as T;
}

export async function mutateVaultNote<TPayload extends VaultNoteApiPayload>(
  ownerUid: string,
  payload: TPayload,
  signal?: AbortSignal
): Promise<VaultNoteMutationResultFor<TPayload>> {
  return vaultNoteApiRequest<VaultNoteMutationResultFor<TPayload>>(
    ownerUid,
    payload,
    signal
  );
}

/**
 * Converts the existing access input into the server-owned mutation contract
 * without copying an owner UID into the request body.
 */
export function vaultNoteAccessPayload(
  input: UpdateRevisionedNoteAccessInput,
  nameClaim?: VaultNameClaimReservationInput
): VaultNoteAccessPayload {
  const { uid: _uid, ...payload } = input;
  void _uid;
  return {
    ...payload,
    action: "access",
    ...(nameClaim ? { nameClaim } : {})
  };
}

export function vaultNoteCreatePayload(input: SaveNoteInput): VaultNoteCreatePayload {
  const { ownerUid: _ownerUid, ...payload } = input;
  void _ownerUid;
  return { ...payload, action: "create" };
}

export function vaultNoteImportCreatePayload(
  input: SaveNoteInput,
  noteId: string,
  importJobId: string
): VaultNoteImportCreatePayload {
  const { ownerUid: _ownerUid, ...payload } = input;
  void _ownerUid;
  return { ...payload, action: "import-create", importJobId, noteId };
}

export function vaultNoteMigrateLegacyPayload(
  input: MigrateLegacyVaultNoteInput
): VaultNoteMigrateLegacyPayload {
  const { uid: _uid, ...payload } = input;
  void _uid;
  return { ...payload, action: "migrate-legacy" };
}

export function vaultNoteLifecyclePayload(
  input: RevisionedNoteLifecycleInput,
  action: "restore"
): VaultNoteRestorePayload;
export function vaultNoteLifecyclePayload(
  input: Omit<RevisionedNoteLifecycleInput, "nameClaim">,
  action: "trash"
): VaultNoteTrashPayload;
export function vaultNoteLifecyclePayload(
  input: RevisionedNoteLifecycleInput,
  action: VaultNoteLifecyclePayload["action"]
): VaultNoteLifecyclePayload {
  const { uid: _uid, ...payload } = input;
  void _uid;
  if (action === "trash") {
    const { nameClaim: _nameClaim, ...trashPayload } = payload;
    void _nameClaim;
    return { ...trashPayload, action };
  }
  return { ...payload, action };
}

export function vaultNotePurgePayload(
  input: PurgeNoteInput
): VaultNotePurgePayload {
  const { ownerUid: _ownerUid, uid: _uid, ...payload } = input;
  void _ownerUid;
  void _uid;
  return { ...payload, action: "purge" };
}

export function vaultNoteUpdatePayload(
  input: UpdateRevisionedEncryptedNoteInput | UpdateRevisionedEncryptedNoteAndFolderInput
): VaultNoteUpdatePayload {
  const { uid: _uid, ...payload } = input;
  void _uid;
  return { ...payload, action: "update" };
}

export function vaultNoteMovePayload(
  input: UpdateRevisionedNoteFolderInput
): VaultNoteMovePayload {
  const { uid: _uid, ...payload } = input;
  void _uid;
  return {
    ...payload,
    action: "move"
  };
}

export function vaultNoteBackfillClaimPayload(
  input: BackfillRevisionedVaultNameClaimInput
): VaultNoteBackfillClaimPayload {
  const { uid: _uid, ...payload } = input;
  void _uid;
  return { ...payload, action: "backfill-claim" };
}

export function vaultNoteResolveCollisionPayload(
  input: ResolveRevisionedVaultNameCollisionInput
): VaultNoteResolveCollisionPayload {
  const { uid: _uid, ...payload } = input;
  void _uid;
  return { ...payload, action: "resolve-collision" };
}

export function vaultNoteSecureCopyCreatePayload(
  input: CreateSecureShareCopyingNoteInput
): VaultNoteSecureCopyCreatePayload {
  const { ownerUid: _ownerUid, ...payload } = input;
  void _ownerUid;
  return { ...payload, action: "secure-copy-create" };
}

export function vaultNoteSecureCopyLifecyclePayload(
  input: SecureShareCopyingNoteLifecycleInput,
  action: "secure-copy-activate"
): VaultNoteSecureCopyActivatePayload;
export function vaultNoteSecureCopyLifecyclePayload(
  input: SecureShareCopyingNoteLifecycleInput,
  action: "secure-copy-abort"
): VaultNoteSecureCopyAbortPayload;
export function vaultNoteSecureCopyLifecyclePayload(
  input: SecureShareCopyingNoteLifecycleInput,
  action: VaultNoteSecureCopyLifecyclePayload["action"]
): VaultNoteSecureCopyLifecyclePayload {
  const { uid: _uid, ...payload } = input;
  void _uid;
  return { ...payload, action };
}
