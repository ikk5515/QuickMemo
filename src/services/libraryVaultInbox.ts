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
  createEncryptedVaultFolder,
  decryptVaultFolders,
  type DecryptedVaultFolder
} from "../features/vault/vaultData";
import { db } from "../lib/firebase";
import {
  ensureVaultFolderTree
} from "./vaultFolderMutations";
import {
  VaultNameConflictError,
  type NoteFolderSnapshot
} from "./notes";
import type { UserProfile } from "../types";

export const DEFAULT_LIBRARY_VAULT_INBOX_NAME = "00_Inbox";
const acceptedInboxNames = new Set(["00_inbox", "inbox"]);
const maximumServerFolders = 2_000;

interface LibraryVaultInboxDependencies {
  createFolder: (
    ...parameters: Parameters<typeof createEncryptedVaultFolder>
  ) => Promise<unknown>;
  ensureTree: typeof ensureVaultFolderTree;
  readFolders: (uid: string, privateKey: CryptoKey) => Promise<DecryptedVaultFolder[]>;
}

const productionDependencies: LibraryVaultInboxDependencies = {
  createFolder: createEncryptedVaultFolder,
  ensureTree: ensureVaultFolderTree,
  readFolders: async (uid, privateKey) => {
    const snapshot = await getDocsFromServer(query(
      collection(db, "noteFolders"),
      where("ownerUid", "==", uid),
      limit(maximumServerFolders + 1)
    ));
    if (snapshot.docs.length > maximumServerFolders) {
      throw new LibraryVaultUserError("Vault 폴더가 안전한 승격 한도를 초과했습니다.");
    }
    const folders = snapshot.docs.map((document) => ({
      id: document.id,
      ...(document.data() as Omit<NoteFolderSnapshot, "id">)
    }));
    const { activeFolders } = partitionVaultFolderTrash(folders);
    return decryptVaultFolders(activeFolders, uid, privateKey);
  }
};

function rootInbox(folders: readonly DecryptedVaultFolder[]) {
  return folders.find((folder) => (
    (folder.parentId ?? null) === null
    && !folder.nameDecryptionFailed
    && acceptedInboxNames.has(folder.displayName.trim().normalize("NFC").toLocaleLowerCase("en-US"))
  )) ?? null;
}

/**
 * Resolves the owner's root Inbox from a backend-confirmed encrypted folder
 * snapshot. When missing, creation crosses the server-authoritative folder
 * mutation boundary; a response-loss/name-race is accepted only after a fresh
 * backend read proves that the encrypted Inbox now exists.
 */
export async function ensureLibraryVaultInboxFolder(
  input: {
    privateKey: CryptoKey;
    profile: Pick<UserProfile, "publicKeyJwk" | "uid">;
    vaultIntegrityKey: CryptoKey;
  },
  dependencies: LibraryVaultInboxDependencies = productionDependencies
) {
  if (!input.profile.uid || !input.privateKey || !input.profile.publicKeyJwk) {
    throw new LibraryVaultUserError("Vault Inbox의 암호화 소유자를 확인할 수 없습니다.");
  }
  await dependencies.ensureTree(input.profile.uid);
  const firstSnapshot = await dependencies.readFolders(input.profile.uid, input.privateKey);
  const existing = rootInbox(firstSnapshot);
  if (existing) return existing.id;

  const order = firstSnapshot.reduce(
    (maximum, folder) => Math.max(maximum, Number.isSafeInteger(folder.order) ? Number(folder.order) : 0),
    0
  ) + 1;
  try {
    await dependencies.createFolder(
      input.profile,
      input.vaultIntegrityKey,
      DEFAULT_LIBRARY_VAULT_INBOX_NAME,
      null,
      order
    );
  } catch (caught) {
    const confirmed = rootInbox(await dependencies.readFolders(input.profile.uid, input.privateKey));
    if (confirmed) return confirmed.id;
    if (caught instanceof VaultNameConflictError) {
      throw new LibraryVaultUserError("기존 Vault Inbox 이름 예약을 복호화된 폴더와 일치시킬 수 없습니다.");
    }
    throw caught;
  }

  const confirmed = rootInbox(await dependencies.readFolders(input.profile.uid, input.privateKey));
  if (!confirmed) {
    throw new LibraryVaultUserError("생성한 Vault Inbox를 서버에서 확인하지 못했습니다.");
  }
  return confirmed.id;
}

export type { LibraryVaultInboxDependencies };
