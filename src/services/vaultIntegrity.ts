import { getToken as getAppCheckToken } from "firebase/app-check";
import { doc, getDocFromServer, runTransaction, serverTimestamp } from "firebase/firestore";
import { generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../lib/crypto";
import { appCheck, auth, db } from "../lib/firebase";
import type { UserProfile, VaultIntegrityDocument, WrappedNoteKey } from "../types";
import { VAULT_NAME_INDEX_VERSION } from "../features/vault/vaultIntegrity";

const integrityKeyCache = new WeakMap<CryptoKey, Map<string, Promise<CryptoKey>>>();
const integrityBaseFields = ["createdAt", "indexVersion", "ownerUid", "updatedAt", "wrappedKey"] as const;
const integrityPendingFields = [...integrityBaseFields, "cutoverState", "cutoverVersion"].sort();
const integrityReadyFields = [...integrityPendingFields, "verifiedAt"].sort();

interface PreparedVaultIntegrityKeyBase {
  key: CryptoKey;
  ownerUid: string;
  wrappedKey: WrappedNoteKey;
}

export type PreparedVaultIntegrityKey = PreparedVaultIntegrityKeyBase & (
  | { cutoverState: "candidate"; state: "candidate" }
  | { cutoverState: "pending" | "ready"; state: "existing" }
);

export interface ActivatedVaultIntegrityKey {
  cutoverState: "pending" | "ready";
  created: boolean;
  /** True when another tab won with a different key; preflight must rerun. */
  keyChanged: boolean;
  key: CryptoKey;
}

export class VaultIntegrityNotReadyError extends Error {
  constructor() {
    super("먼저 Vault를 열어 암호화된 이름 준비를 완료해주세요.");
    this.name = "VaultIntegrityNotReadyError";
  }
}

export class VaultIntegrityApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(status === 409
      ? "검증 중 Vault가 변경되었습니다. 서버 최신 상태를 다시 확인해주세요."
      : status === 401 || status === 403
        ? "Vault 무결성 확인 권한을 다시 확인해주세요."
        : status === 0
          ? "Vault 무결성 서버에 연결하지 못했습니다."
          : "Vault 무결성 확인을 안전하게 완료하지 못했습니다.");
    this.name = "VaultIntegrityApiError";
    this.code = code;
    this.status = status;
  }
}

function validateUid(uid: string) {
  if (!uid || uid !== uid.trim() || uid.length > 128 || uid.includes("/")) {
    throw new Error("Vault 무결성 키 사용자를 확인할 수 없습니다.");
  }
  return uid;
}

function integrityRef(uid: string) {
  return doc(db, "vaultIntegrity", validateUid(uid));
}

function validWrappedKey(value: unknown): value is WrappedNoteKey {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<WrappedNoteKey>;
  return Object.keys(value).sort().join("\u0000") === ["algorithm", "version", "wrappedKey"].join("\u0000")
    && candidate.version === 1
    && candidate.algorithm === "RSA-OAEP"
    && typeof candidate.wrappedKey === "string"
    && candidate.wrappedKey.length >= 8
    && candidate.wrappedKey.length <= 4_096;
}

function validTimestamp(value: unknown) {
  if (!value || typeof value !== "object" || !("toMillis" in value)) return false;
  try {
    return Number.isFinite((value as { toMillis: () => number }).toMillis());
  } catch {
    return false;
  }
}

function hasExactFields(value: object, expected: readonly string[]) {
  return Object.keys(value).sort().join("\u0000") === [...expected].sort().join("\u0000");
}

function validateStoredIntegrityDocument(value: unknown, uid: string): VaultIntegrityDocument & {
  cutoverState: "pending" | "ready";
} {
  if (!value || typeof value !== "object") {
    throw new Error("Vault 무결성 키 문서를 확인할 수 없습니다.");
  }
  const candidate = value as Partial<VaultIntegrityDocument>;
  if (
    candidate.ownerUid !== uid
    || candidate.indexVersion !== VAULT_NAME_INDEX_VERSION
    || !validWrappedKey(candidate.wrappedKey)
    || !validTimestamp(candidate.createdAt)
    || !validTimestamp(candidate.updatedAt)
  ) {
    throw new Error("Vault 무결성 키 문서를 확인할 수 없습니다.");
  }
  const hasCutoverState = candidate.cutoverState !== undefined;
  const hasCutoverVersion = candidate.cutoverVersion !== undefined;
  const hasVerifiedAt = candidate.verifiedAt !== undefined;
  const legacyPending = !hasCutoverState && !hasCutoverVersion && !hasVerifiedAt
    && hasExactFields(value, integrityBaseFields);
  const versionedPending = hasExactFields(value, integrityPendingFields)
    && candidate.cutoverState === "pending"
    && candidate.cutoverVersion === 1
    && !hasVerifiedAt;
  const versionedReady = hasExactFields(value, integrityReadyFields)
    && candidate.cutoverState === "ready"
    && candidate.cutoverVersion === 1
    && validTimestamp(candidate.verifiedAt);
  if (!legacyPending && !versionedPending && !versionedReady) {
    throw new Error("Vault 무결성 완료 상태를 확인할 수 없습니다.");
  }
  return {
    cutoverState: versionedReady ? "ready" : "pending",
    ...(candidate.cutoverVersion === 1 ? { cutoverVersion: 1 as const } : {}),
    ...(versionedReady ? { verifiedAt: candidate.verifiedAt } : {}),
    indexVersion: VAULT_NAME_INDEX_VERSION,
    ownerUid: uid,
    wrappedKey: candidate.wrappedKey
  };
}

async function createOrLoadIntegrityKey(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  privateKey: CryptoKey
) {
  const uid = validateUid(profile.uid);
  const candidateKey = await generateNoteKey();
  const candidateWrappedKey = await wrapNoteKey(candidateKey, profile.publicKeyJwk);
  const selected = await runTransaction(db, async (transaction) => {
    const reference = integrityRef(uid);
    const snapshot = await transaction.get(reference);
    if (snapshot.exists()) {
      return {
        created: false as const,
        wrappedKey: validateStoredIntegrityDocument(snapshot.data(), uid).wrappedKey
      };
    }

    transaction.set(reference, {
      createdAt: serverTimestamp(),
      cutoverState: "pending",
      cutoverVersion: 1,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      ownerUid: uid,
      updatedAt: serverTimestamp(),
      wrappedKey: candidateWrappedKey
    } satisfies Omit<VaultIntegrityDocument, "createdAt" | "updatedAt"> & {
      createdAt: ReturnType<typeof serverTimestamp>;
      updatedAt: ReturnType<typeof serverTimestamp>;
    });
    return { created: true as const, wrappedKey: candidateWrappedKey };
  });

  return selected.created
    ? candidateKey
    : unwrapNoteKey(selected.wrappedKey, privateKey);
}

/**
 * Server-confirmed, read-only phase for the Vault cutover. A missing marker
 * yields an in-memory candidate but deliberately performs no Firestore write,
 * so callers can decrypt and validate the complete snapshot before enabling
 * claim-enforcing Rules for the owner.
 */
export async function prepareVaultIntegrityKey(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  privateKey: CryptoKey
): Promise<PreparedVaultIntegrityKey> {
  const uid = validateUid(profile.uid);
  const snapshot = await getDocFromServer(integrityRef(uid));
  if (snapshot.exists()) {
    const stored = validateStoredIntegrityDocument(snapshot.data(), uid);
    return {
      cutoverState: stored.cutoverState,
      key: await unwrapNoteKey(stored.wrappedKey, privateKey),
      ownerUid: uid,
      state: "existing",
      wrappedKey: stored.wrappedKey
    };
  }

  const key = await generateNoteKey();
  return {
    cutoverState: "candidate",
    key,
    ownerUid: uid,
    state: "candidate",
    wrappedKey: await wrapNoteKey(key, profile.publicKeyJwk)
  };
}

/**
 * Reads an already-activated integrity key without ever creating the cutover
 * marker. Secondary entry points such as public-share copy must not activate a
 * marker because they do not own a complete Vault snapshot.
 */
export async function requireExistingVaultIntegrityKey(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  privateKey: CryptoKey
) {
  const prepared = await prepareVaultIntegrityKey(profile, privateKey);
  if (prepared.state !== "existing" || prepared.cutoverState !== "ready") {
    throw new VaultIntegrityNotReadyError();
  }
  return prepared.key;
}

/**
 * Explicit write phase used only after complete-snapshot preflight succeeds.
 * The transaction remains race-safe across tabs. If another tab created the
 * marker first, its wrapped key wins and keyChanged tells the caller to rerun
 * all blinded-name planning before any migration write.
 */
export async function activatePreparedVaultIntegrityKey(
  prepared: PreparedVaultIntegrityKey,
  privateKey: CryptoKey
): Promise<ActivatedVaultIntegrityKey> {
  const uid = validateUid(prepared.ownerUid);
  if (prepared.state === "existing") {
    const result = {
      created: false,
      cutoverState: prepared.cutoverState,
      key: prepared.key,
      keyChanged: false
    };
    const perUser = integrityKeyCache.get(privateKey) ?? new Map<string, Promise<CryptoKey>>();
    perUser.set(uid, Promise.resolve(result.key));
    integrityKeyCache.set(privateKey, perUser);
    return result;
  }

  const selected = await runTransaction(db, async (transaction) => {
    const reference = integrityRef(uid);
    const snapshot = await transaction.get(reference);
    if (snapshot.exists()) {
      const stored = validateStoredIntegrityDocument(snapshot.data(), uid);
      return {
        created: false as const,
        cutoverState: stored.cutoverState,
        wrappedKey: stored.wrappedKey
      };
    }
    transaction.set(reference, {
      createdAt: serverTimestamp(),
      cutoverState: "pending",
      cutoverVersion: 1,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      ownerUid: uid,
      updatedAt: serverTimestamp(),
      wrappedKey: prepared.wrappedKey
    } satisfies Omit<VaultIntegrityDocument, "createdAt" | "updatedAt"> & {
      createdAt: ReturnType<typeof serverTimestamp>;
      updatedAt: ReturnType<typeof serverTimestamp>;
    });
    return {
      created: true as const,
      cutoverState: "pending" as const,
      wrappedKey: prepared.wrappedKey
    };
  });
  const key = selected.created
    ? prepared.key
    : await unwrapNoteKey(selected.wrappedKey, privateKey);
  const result = {
    created: selected.created,
    cutoverState: selected.cutoverState,
    key,
    keyChanged: !selected.created
  };
  const perUser = integrityKeyCache.get(privateKey) ?? new Map<string, Promise<CryptoKey>>();
  perUser.set(uid, Promise.resolve(key));
  integrityKeyCache.set(privateKey, perUser);
  return result;
}

export interface SealVaultIntegrityCutoverInput {
  expectedActiveNoteCount: number;
  expectedDeletedNoteCount: number;
  expectedFolderCount: number;
}

export interface SealVaultIntegrityCutoverResult {
  activeNoteCount: number;
  cutoverVersion: 1;
  deletedNoteCount: number;
  folderCount: number;
  ok: true;
  state: "ready";
  verifiedAt: string;
}

function validCutoverCount(value: number, maximum = 20_000) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
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

export async function sealVaultIntegrityCutover(
  ownerUid: string,
  input: SealVaultIntegrityCutoverInput,
  signal?: AbortSignal
): Promise<SealVaultIntegrityCutoverResult> {
  const uid = validateUid(ownerUid);
  if (
    !validCutoverCount(input.expectedActiveNoteCount)
    || !validCutoverCount(input.expectedDeletedNoteCount)
    || input.expectedActiveNoteCount + input.expectedDeletedNoteCount > 20_000
    || !validCutoverCount(input.expectedFolderCount, 2_000)
  ) {
    throw new RangeError("Vault 무결성 확인 대상 수가 올바르지 않습니다.");
  }
  const user = auth.currentUser;
  if (!user || user.uid !== uid) {
    throw new VaultIntegrityApiError("authentication_required", 401);
  }
  const [idToken, verificationToken] = await Promise.all([
    user.getIdToken(),
    bestEffortAppCheckToken()
  ]);
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${idToken}`,
    "content-type": "application/json",
    "x-quickmemo-vault-integrity": "1"
  });
  if (verificationToken) headers.set("x-firebase-appcheck", verificationToken);

  let response: Response;
  try {
    response = await fetch("/api/vault-integrity", {
      body: JSON.stringify({ action: "seal-ready", ...input }),
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
    throw new VaultIntegrityApiError("network_error", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new VaultIntegrityApiError("invalid_response", response.status);
  }
  if (!response.ok || !body || typeof body !== "object") {
    const code = body && typeof body === "object" && "error" in body
      && typeof body.error === "string"
      ? body.error
      : "request_failed";
    throw new VaultIntegrityApiError(code, response.status);
  }
  const result = body as Partial<SealVaultIntegrityCutoverResult>;
  if (
    result.ok !== true
    || result.state !== "ready"
    || result.cutoverVersion !== 1
    || typeof result.verifiedAt !== "string"
    || !Number.isFinite(Date.parse(result.verifiedAt))
    || !validCutoverCount(result.activeNoteCount ?? -1)
    || !validCutoverCount(result.deletedNoteCount ?? -1)
    || !validCutoverCount(result.folderCount ?? -1, 2_000)
    || result.activeNoteCount !== input.expectedActiveNoteCount
    || result.deletedNoteCount !== input.expectedDeletedNoteCount
    || result.folderCount !== input.expectedFolderCount
  ) {
    throw new VaultIntegrityApiError("invalid_response", response.status);
  }
  return result as SealVaultIntegrityCutoverResult;
}

/**
 * Returns the per-user random key used only for blinded Vault-name equality
 * tokens. The key is persisted solely as an RSA-OAEP wrapped value and cached
 * in memory for the current unlocked private-key object.
 */
export function getOrCreateVaultIntegrityKey(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  privateKey: CryptoKey
) {
  const uid = validateUid(profile.uid);
  const perUser = integrityKeyCache.get(privateKey) ?? new Map<string, Promise<CryptoKey>>();
  const cached = perUser.get(uid);
  if (cached) {
    return cached;
  }

  const pending = createOrLoadIntegrityKey(profile, privateKey).catch((error) => {
    perUser.delete(uid);
    throw error;
  });
  perUser.set(uid, pending);
  integrityKeyCache.set(privateKey, perUser);
  return pending;
}
