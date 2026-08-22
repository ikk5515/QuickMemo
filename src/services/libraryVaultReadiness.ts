import {
  collection,
  getDocsFromServer,
  limit,
  query,
  where
} from "firebase/firestore";
import { partitionVaultFolderTrash } from "../features/vault/folderTrash";
import { LibraryVaultUserError } from "../features/library/libraryVaultErrors";
import {
  auditVaultFolderTree,
  vaultNameFingerprint
} from "../features/vault/vaultIntegrity";
import {
  decryptVaultFolders,
  decryptVaultNotes,
  type DecryptedVaultFolder,
  type DecryptedVaultNote
} from "../features/vault/vaultData";
import { db } from "../lib/firebase";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";
import {
  loadOwnedVaultCutoverNotes,
  type NoteFolderSnapshot
} from "./notes";
import type { UserProfile } from "../types";

const maximumServerFolders = 2_000;
const readinessCache = new WeakMap<CryptoKey, WeakMap<CryptoKey, Map<string, Promise<void>>>>();

interface LibraryVaultReadinessSnapshot {
  folders: DecryptedVaultFolder[];
  notes: DecryptedVaultNote[];
}

interface LibraryVaultReadinessDependencies {
  loadSnapshot: (
    uid: string,
    privateKey: CryptoKey
  ) => Promise<LibraryVaultReadinessSnapshot>;
}

const productionDependencies: LibraryVaultReadinessDependencies = {
  loadSnapshot: async (uid, privateKey) => {
    const [noteSnapshots, folderSnapshot] = await Promise.all([
      loadOwnedVaultCutoverNotes(uid),
      getDocsFromServer(query(
        collection(db, "noteFolders"),
        where("ownerUid", "==", uid),
        limit(maximumServerFolders + 1)
      ))
    ]);
    if (folderSnapshot.docs.length > maximumServerFolders) {
      throw new LibraryVaultUserError("Vault 폴더가 안전한 승격 한도를 초과했습니다.");
    }
    const allFolders = folderSnapshot.docs.map((document) => ({
      id: document.id,
      ...(document.data() as Omit<NoteFolderSnapshot, "id">)
    }));
    const { activeFolders } = partitionVaultFolderTrash(allFolders);
    const [notes, folders] = await Promise.all([
      decryptVaultNotes(noteSnapshots, uid, privateKey),
      decryptVaultFolders(activeFolders, uid, privateKey)
    ]);
    if (notes.length !== noteSnapshots.length || folders.some((folder) => folder.nameDecryptionFailed)) {
      throw new LibraryVaultUserError("전체 Vault 이름과 payload를 복호화하지 못했습니다.");
    }
    return { folders, notes };
  }
};

async function verifySnapshot(
  snapshot: LibraryVaultReadinessSnapshot,
  uid: string,
  vaultIntegrityKey: CryptoKey
) {
  if (
    snapshot.notes.some((note) => note.ownerUid !== uid)
    || snapshot.folders.some((folder) => folder.ownerUid !== uid)
  ) {
    throw new LibraryVaultUserError("Vault 승격 준비 범위에 다른 소유자의 항목이 포함되었습니다.");
  }
  const folderAudit = auditVaultFolderTree(snapshot.folders);
  if (!folderAudit.valid) {
    throw new LibraryVaultUserError("Vault 폴더 트리 무결성을 먼저 복구해주세요.");
  }
  const folderIds = new Set(snapshot.folders.map((folder) => folder.id));
  if (snapshot.notes.some((note) => note.folderId && !folderIds.has(note.folderId))) {
    throw new LibraryVaultUserError("Vault 노트의 상위 폴더를 서버 snapshot에서 확인하지 못했습니다.");
  }

  const folderClaims = await mapWithConcurrency(snapshot.folders, 8, async (folder) => ({
    actual: folder.vaultNameClaimId,
    expected: await vaultNameFingerprint(vaultIntegrityKey, {
      name: folder.displayName,
      parentId: folder.parentId ?? null,
      targetType: "folder"
    }),
    version: folder.vaultNameIndexVersion
  }));
  const noteClaims = await mapWithConcurrency(snapshot.notes, 8, async (note) => ({
    actual: note.vaultNameClaimId,
    expected: await vaultNameFingerprint(vaultIntegrityKey, {
      kind: note.entryKind,
      name: note.title,
      parentId: note.folderId ?? null,
      targetType: "entry"
    }),
    version: note.vaultNameIndexVersion
  }));
  if ([...folderClaims, ...noteClaims].some((claim) => (
    claim.version !== 1 || !claim.actual || claim.actual !== claim.expected
  ))) {
    throw new LibraryVaultUserError("먼저 Vault를 열어 기존 노트와 폴더의 암호화 이름 준비를 완료해주세요.");
  }
}

/**
 * Reconstructs the same complete, backend-confirmed name readiness boundary
 * used by VaultPage before Library is allowed to write into the Inbox. The
 * successful result is cached only under the in-memory private-key object;
 * lock/logout therefore discards it and no plaintext index is persisted.
 */
export function assertLibraryVaultPromotionReady(
  input: {
    privateKey: CryptoKey;
    profile: Pick<UserProfile, "uid">;
    vaultIntegrityKey: CryptoKey;
  },
  dependencies: LibraryVaultReadinessDependencies = productionDependencies
) {
  if (!input.profile.uid || !input.privateKey || !input.vaultIntegrityKey) {
    return Promise.reject(new LibraryVaultUserError("Vault 승격 준비 상태를 확인할 수 없습니다."));
  }
  const perIntegrityKey = readinessCache.get(input.privateKey) ?? new WeakMap<CryptoKey, Map<string, Promise<void>>>();
  const perUser = perIntegrityKey.get(input.vaultIntegrityKey) ?? new Map<string, Promise<void>>();
  const existing = perUser.get(input.profile.uid);
  if (existing && dependencies === productionDependencies) return existing;
  const pending = dependencies.loadSnapshot(input.profile.uid, input.privateKey)
    .then((snapshot) => verifySnapshot(snapshot, input.profile.uid, input.vaultIntegrityKey))
    .catch((error) => {
      if (dependencies === productionDependencies) perUser.delete(input.profile.uid);
      throw error;
    });
  if (dependencies === productionDependencies) {
    perUser.set(input.profile.uid, pending);
    perIntegrityKey.set(input.vaultIntegrityKey, perUser);
    readinessCache.set(input.privateKey, perIntegrityKey);
  }
  return pending;
}

export type { LibraryVaultReadinessDependencies, LibraryVaultReadinessSnapshot };
