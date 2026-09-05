import {
  doc,
  getDoc,
  getDocFromServer,
  runTransaction,
  serverTimestamp,
  type DocumentData,
  type DocumentSnapshot
} from "firebase/firestore";
import { decryptText, encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../lib/crypto";
import { db } from "../lib/firebase";
import type { EncryptedPayload, WrappedNoteKey } from "../types";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type VaultWorkspaceState = { [key: string]: JsonValue };

export interface VaultWorkspaceProfile {
  uid: string;
  publicKeyJwk: JsonWebKey;
}

export interface LoadedVaultWorkspace<T extends VaultWorkspaceState> {
  state: T;
  revision: number;
}

export interface SavedVaultWorkspace {
  revision: number;
}

interface VaultWorkspaceDocument {
  ownerUid: string;
  encryptedState: EncryptedPayload;
  wrappedKey: WrappedNoteKey;
  revision: number;
}

const maxVaultWorkspaceRevision = 999_999_999_999;
const maxVaultWorkspacePlaintextBytes = 512 * 1024;
const maxVaultWorkspaceDepth = 64;
const maxVaultWorkspaceValues = 100_000;
const maxWorkspaceCommitReceipts = 5;

export class VaultWorkspaceRevisionConflictError extends Error {
  readonly actualRevision: number;
  readonly code = "vault-workspace/revision-conflict";
  readonly expectedRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `워크스페이스가 다른 곳에서 변경되었습니다. 예상 revision ${expectedRevision}, 현재 revision ${actualRevision}.`
    );
    this.name = "VaultWorkspaceRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function workspaceRef(uid: string) {
  return doc(db, "vaultWorkspaces", uid);
}

function validateUid(uid: string): string {
  if (!uid || uid !== uid.trim() || uid.length > 128 || uid.includes("/")) {
    throw new Error("워크스페이스 사용자를 확인할 수 없습니다.");
  }
  return uid;
}

function validateExpectedRevision(revision: number | undefined): number | undefined {
  if (revision === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > maxVaultWorkspaceRevision) {
    throw new RangeError(`예상 워크스페이스 revision은 0 이상 ${maxVaultWorkspaceRevision} 이하의 정수여야 합니다.`);
  }
  return revision;
}

function validateStoredRevision(revision: unknown): number {
  if (!Number.isSafeInteger(revision) || (revision as number) < 1 || (revision as number) > maxVaultWorkspaceRevision) {
    throw new Error("저장된 워크스페이스 revision이 올바르지 않습니다.");
  }
  return revision as number;
}

function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<EncryptedPayload>;
  return payload.version === 1
    && payload.algorithm === "AES-GCM"
    && typeof payload.cipherText === "string"
    && payload.cipherText.length > 0
    && typeof payload.iv === "string"
    && payload.iv.length > 0;
}

function isWrappedNoteKey(value: unknown): value is WrappedNoteKey {
  if (!value || typeof value !== "object") {
    return false;
  }
  const wrapped = value as Partial<WrappedNoteKey>;
  return wrapped.version === 1
    && wrapped.algorithm === "RSA-OAEP"
    && typeof wrapped.wrappedKey === "string"
    && wrapped.wrappedKey.length > 0;
}

function validateStoredWorkspace(data: unknown, uid: string): VaultWorkspaceDocument {
  if (!data || typeof data !== "object") {
    throw new Error("저장된 워크스페이스 문서를 확인할 수 없습니다.");
  }
  const candidate = data as Partial<VaultWorkspaceDocument>;
  if (
    candidate.ownerUid !== uid
    || !isEncryptedPayload(candidate.encryptedState)
    || !isWrappedNoteKey(candidate.wrappedKey)
  ) {
    throw new Error("저장된 워크스페이스 암호화 문서를 확인할 수 없습니다.");
  }
  return {
    ownerUid: uid,
    encryptedState: candidate.encryptedState,
    wrappedKey: candidate.wrappedKey,
    revision: validateStoredRevision(candidate.revision)
  };
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonObjectShape(value: object): void {
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") {
        continue;
      }
      if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        throw new TypeError("워크스페이스 상태 배열에 JSON으로 보존되지 않는 속성이 있습니다.");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("워크스페이스 상태 배열에는 일반 값만 저장할 수 있습니다.");
      }
    }
    return;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError("워크스페이스 상태에 JSON으로 보존되지 않는 속성이 있습니다.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("워크스페이스 상태에는 열거 가능한 일반 값만 저장할 수 있습니다.");
    }
  }
}

export function assertJsonSafeWorkspaceState(value: unknown): asserts value is VaultWorkspaceState {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isPlainObject(value)) {
    throw new TypeError("워크스페이스 상태는 JSON 객체여야 합니다.");
  }

  const active = new Set<object>();
  let valueCount = 0;
  const visit = (candidate: unknown, depth: number): void => {
    valueCount += 1;
    if (valueCount > maxVaultWorkspaceValues || depth > maxVaultWorkspaceDepth) {
      throw new RangeError("워크스페이스 상태가 너무 복잡합니다.");
    }
    if (
      candidate === null
      || typeof candidate === "string"
      || typeof candidate === "boolean"
    ) {
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new TypeError("워크스페이스 상태에 유한하지 않은 숫자를 저장할 수 없습니다.");
      }
      return;
    }
    if (typeof candidate !== "object") {
      throw new TypeError("워크스페이스 상태에 JSON이 아닌 값을 저장할 수 없습니다.");
    }
    if (active.has(candidate)) {
      throw new TypeError("워크스페이스 상태에 순환 참조를 저장할 수 없습니다.");
    }
    if (!Array.isArray(candidate) && !isPlainObject(candidate)) {
      throw new TypeError("워크스페이스 상태에는 JSON 객체와 배열만 저장할 수 있습니다.");
    }

    assertJsonObjectShape(candidate);
    active.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item, depth + 1);
      }
    } else {
      for (const item of Object.values(candidate)) {
        visit(item, depth + 1);
      }
    }
    active.delete(candidate);
  };
  visit(value, 0);
}

function serializeWorkspaceState(state: VaultWorkspaceState): string {
  assertJsonSafeWorkspaceState(state);
  const serialized = JSON.stringify(state);
  if (new TextEncoder().encode(serialized).byteLength > maxVaultWorkspacePlaintextBytes) {
    throw new RangeError("워크스페이스 상태가 저장 가능한 크기를 초과했습니다.");
  }
  return serialized;
}

function parseWorkspaceState<T extends VaultWorkspaceState>(serialized: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("저장된 워크스페이스 상태를 해석할 수 없습니다.");
  }
  assertJsonSafeWorkspaceState(parsed);
  return parsed as T;
}

async function decryptWorkspaceSnapshot<T extends VaultWorkspaceState>(
  snapshot: DocumentSnapshot<DocumentData>,
  uid: string,
  privateKey: CryptoKey
): Promise<LoadedVaultWorkspace<T> | null> {
  if (!snapshot.exists()) {
    return null;
  }
  const stored = validateStoredWorkspace(snapshot.data(), uid);
  const workspaceKey = await unwrapNoteKey(stored.wrappedKey, privateKey);
  const serialized = await decryptText(stored.encryptedState, workspaceKey);
  return {
    state: parseWorkspaceState<T>(serialized),
    revision: stored.revision
  };
}

export async function loadVaultWorkspaceRecord<T extends VaultWorkspaceState = VaultWorkspaceState>(
  uid: string,
  privateKey: CryptoKey
): Promise<LoadedVaultWorkspace<T> | null> {
  const validatedUid = validateUid(uid);
  if (!privateKey) {
    throw new Error("워크스페이스 암호화 세션을 확인할 수 없습니다.");
  }
  const snapshot = await getDoc(workspaceRef(validatedUid));
  return decryptWorkspaceSnapshot<T>(snapshot, validatedUid, privateKey);
}

export async function loadVaultWorkspace<T extends VaultWorkspaceState = VaultWorkspaceState>(
  uid: string,
  privateKey: CryptoKey
): Promise<T | null> {
  const loaded = await loadVaultWorkspaceRecord<T>(uid, privateKey);
  return loaded?.state ?? null;
}

/**
 * `expectedRevision` is omitted only for the first create (equivalent to revision 0).
 * Existing documents require an exact revision so a stale tab cannot overwrite newer state.
 */
export async function saveVaultWorkspace<T extends VaultWorkspaceState>(
  profile: VaultWorkspaceProfile,
  privateKey: CryptoKey,
  state: T,
  expectedRevision?: number
): Promise<SavedVaultWorkspace> {
  const uid = validateUid(profile.uid);
  const expected = validateExpectedRevision(expectedRevision);
  if (!profile.publicKeyJwk || !privateKey) {
    throw new Error("워크스페이스 암호화 세션을 확인할 수 없습니다.");
  }
  const serialized = serializeWorkspaceState(state);
  // A rejected commit can already have reached the server. Keep only the
  // ciphertexts prepared by this call, including bounded SDK retry attempts.
  const receipts: VaultWorkspaceDocument[] = [];
  const rememberReceipt = (receipt: VaultWorkspaceDocument) => {
    receipts.push({
      ...receipt,
      encryptedState: { ...receipt.encryptedState },
      wrappedKey: { ...receipt.wrappedKey }
    });
    if (receipts.length > maxWorkspaceCommitReceipts) receipts.shift();
  };

  try {
    return await runTransaction(db, async (transaction) => {
      const reference = workspaceRef(uid);
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) {
        if (expected !== undefined && expected !== 0) {
          throw new VaultWorkspaceRevisionConflictError(expected, 0);
        }
        const workspaceKey = await generateNoteKey();
        const [encryptedState, wrappedKey] = await Promise.all([
          encryptText(serialized, workspaceKey),
          wrapNoteKey(workspaceKey, profile.publicKeyJwk)
        ]);
        transaction.set(reference, {
          ownerUid: uid,
          encryptedState,
          wrappedKey,
          revision: 1,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
        rememberReceipt({ ownerUid: uid, encryptedState, wrappedKey, revision: 1 });
        return { revision: 1 };
      }

      const stored = validateStoredWorkspace(snapshot.data(), uid);
      const requiredRevision = expected ?? 0;
      if (stored.revision !== requiredRevision) {
        throw new VaultWorkspaceRevisionConflictError(requiredRevision, stored.revision);
      }
      if (stored.revision >= maxVaultWorkspaceRevision) {
        throw new RangeError("워크스페이스 revision 한도에 도달했습니다.");
      }
      const workspaceKey = await unwrapNoteKey(stored.wrappedKey, privateKey);
      const encryptedState = await encryptText(serialized, workspaceKey);
      const revision = stored.revision + 1;
      transaction.update(reference, {
        encryptedState,
        revision,
        updatedAt: serverTimestamp()
      });
      rememberReceipt({ ownerUid: uid, encryptedState, wrappedKey: stored.wrappedKey, revision });
      return { revision };
    });
  } catch (error) {
    if (receipts.length) {
      try {
        const snapshot = await getDocFromServer(workspaceRef(uid));
        if (
          snapshot.exists()
          && snapshot.metadata.fromCache === false
          && snapshot.metadata.hasPendingWrites === false
        ) {
          const stored = validateStoredWorkspace(snapshot.data(), uid);
          const committed = receipts.some((receipt) =>
            stored.ownerUid === receipt.ownerUid
            && stored.revision === receipt.revision
            && stored.wrappedKey.version === receipt.wrappedKey.version
            && stored.wrappedKey.algorithm === receipt.wrappedKey.algorithm
            && stored.wrappedKey.wrappedKey === receipt.wrappedKey.wrappedKey
            && stored.encryptedState.version === receipt.encryptedState.version
            && stored.encryptedState.algorithm === receipt.encryptedState.algorithm
            && stored.encryptedState.iv === receipt.encryptedState.iv
            && stored.encryptedState.cipherText === receipt.encryptedState.cipherText
          );
          if (committed) return { revision: stored.revision };
        }
      } catch {
        // A denied/failed read or a different document must retain the original
        // save failure; never infer success from plaintext or cached data.
      }
    }
    throw error;
  } finally {
    receipts.length = 0;
  }
}
