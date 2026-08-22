import { doc, getDocFromServer, runTransaction, serverTimestamp } from "firebase/firestore";
import { generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../lib/crypto";
import { db } from "../lib/firebase";
import type { UserProfile, VaultIntegrityDocument, WrappedNoteKey } from "../types";
import { VAULT_NAME_INDEX_VERSION } from "../features/vault/vaultIntegrity";

const integrityKeyCache = new WeakMap<CryptoKey, Map<string, Promise<CryptoKey>>>();

export interface PreparedVaultIntegrityKey {
  key: CryptoKey;
  ownerUid: string;
  state: "candidate" | "existing";
  wrappedKey: WrappedNoteKey;
}

export interface ActivatedVaultIntegrityKey {
  created: boolean;
  /** True when another tab won with a different key; preflight must rerun. */
  keyChanged: boolean;
  key: CryptoKey;
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
  return candidate.version === 1
    && candidate.algorithm === "RSA-OAEP"
    && typeof candidate.wrappedKey === "string"
    && candidate.wrappedKey.length > 0
    && candidate.wrappedKey.length <= 4_096;
}

function validateStoredIntegrityDocument(value: unknown, uid: string): VaultIntegrityDocument {
  if (!value || typeof value !== "object") {
    throw new Error("Vault 무결성 키 문서를 확인할 수 없습니다.");
  }
  const candidate = value as Partial<VaultIntegrityDocument>;
  if (
    candidate.ownerUid !== uid
    || candidate.indexVersion !== VAULT_NAME_INDEX_VERSION
    || !validWrappedKey(candidate.wrappedKey)
  ) {
    throw new Error("Vault 무결성 키 문서를 확인할 수 없습니다.");
  }
  return {
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
    const wrappedKey = validateStoredIntegrityDocument(snapshot.data(), uid).wrappedKey;
    return {
      key: await unwrapNoteKey(wrappedKey, privateKey),
      ownerUid: uid,
      state: "existing",
      wrappedKey
    };
  }

  const key = await generateNoteKey();
  return {
    key,
    ownerUid: uid,
    state: "candidate",
    wrappedKey: await wrapNoteKey(key, profile.publicKeyJwk)
  };
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
    const result = { created: false, key: prepared.key, keyChanged: false };
    const perUser = integrityKeyCache.get(privateKey) ?? new Map<string, Promise<CryptoKey>>();
    perUser.set(uid, Promise.resolve(result.key));
    integrityKeyCache.set(privateKey, perUser);
    return result;
  }

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
      indexVersion: VAULT_NAME_INDEX_VERSION,
      ownerUid: uid,
      updatedAt: serverTimestamp(),
      wrappedKey: prepared.wrappedKey
    } satisfies Omit<VaultIntegrityDocument, "createdAt" | "updatedAt"> & {
      createdAt: ReturnType<typeof serverTimestamp>;
      updatedAt: ReturnType<typeof serverTimestamp>;
    });
    return { created: true as const, wrappedKey: prepared.wrappedKey };
  });
  const key = selected.created
    ? prepared.key
    : await unwrapNoteKey(selected.wrappedKey, privateKey);
  const result = { created: selected.created, key, keyChanged: !selected.created };
  const perUser = integrityKeyCache.get(privateKey) ?? new Map<string, Promise<CryptoKey>>();
  perUser.set(uid, Promise.resolve(key));
  integrityKeyCache.set(privateKey, perUser);
  return result;
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
