import { decryptText, encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../../lib/crypto";
import { mapWithConcurrency } from "../../lib/mapWithConcurrency";
import {
  createEncryptedNoteFolder,
  createEncryptedNoteFolderAtId,
  migrateLegacyNoteFolder,
  updateEncryptedNoteFolder,
  type NoteFolderSnapshot,
  type NoteSnapshot
} from "../../services/notes";
import type { DecryptedNote, UserProfile, VaultContentFormat, VaultEntryKind } from "../../types";
import {
  VAULT_NAME_INDEX_VERSION,
  canonicalVaultName,
  vaultNameFingerprint
} from "./vaultIntegrity";

export interface DecryptedVaultFolder extends NoteFolderSnapshot {
  displayName: string;
  nameDecryptionFailed?: boolean;
}

export interface DecryptedVaultNote extends DecryptedNote {
  contentFormat: VaultContentFormat;
  entryKind: VaultEntryKind;
}

export type VaultEntryStorageIdentityState = "explicit" | "invalid" | "legacy-missing";

/**
 * Classifies the persisted storage identity without applying the legacy HTML
 * fallback used by the renderer. Cutover preflight must distinguish a truly
 * legacy document (both fields absent) from a partially written or mismatched
 * identity, which is never safe to repair automatically.
 */
export function vaultEntryStorageIdentityState(
  note: Pick<NoteSnapshot, "contentFormat" | "entryKind">
): VaultEntryStorageIdentityState {
  if (note.contentFormat === undefined && note.entryKind === undefined) {
    return "legacy-missing";
  }
  if (
    (note.contentFormat === "markdown-v1" && note.entryKind === "markdown")
    || (note.contentFormat === "legacy-html-v1" && note.entryKind === "legacy-html")
    || (note.contentFormat === "json-canvas-v1" && note.entryKind === "canvas")
    || (note.contentFormat === "base-v1" && note.entryKind === "base")
    || (note.contentFormat === "asset-v1" && note.entryKind === "asset")
  ) {
    return "explicit";
  }
  return "invalid";
}

export function resolvedNoteContentFormat(note: Pick<NoteSnapshot, "contentFormat">) {
  return note.contentFormat ?? "legacy-html-v1";
}

export function resolvedVaultEntryKind(note: Pick<NoteSnapshot, "contentFormat" | "entryKind">) {
  if (note.entryKind) {
    return note.entryKind;
  }
  if (note.contentFormat === "json-canvas-v1") {
    return "canvas" as const;
  }
  if (note.contentFormat === "base-v1") {
    return "base" as const;
  }
  if (note.contentFormat === "asset-v1") {
    return "asset" as const;
  }
  return note.contentFormat === "markdown-v1" ? "markdown" as const : "legacy-html" as const;
}

export async function decryptVaultNotes(notes: NoteSnapshot[], uid: string, privateKey: CryptoKey) {
  const decrypted = await mapWithConcurrency(notes, 4, async (note): Promise<DecryptedVaultNote | null> => {
    const wrappedKey = note.wrappedKeys[uid];
    if (!wrappedKey) {
      return null;
    }

    try {
      const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
      const [title, body] = await Promise.all([
        decryptText(note.encryptedTitle, noteKey),
        decryptText(note.encryptedBody, noteKey)
      ]);

      return {
        ...note,
        contentFormat: resolvedNoteContentFormat(note),
        entryKind: resolvedVaultEntryKind(note),
        title,
        body
      };
    } catch {
      return null;
    }
  });

  return decrypted.filter((note): note is DecryptedVaultNote => note !== null);
}

export async function decryptVaultFolders(folders: NoteFolderSnapshot[], uid: string, privateKey: CryptoKey) {
  // Filter before decryption so an accidentally over-broad caller never puts
  // another owner's legacy plaintext name into the decrypted result pipeline.
  // Bound crypto concurrency as a large Vault otherwise creates a CPU/memory
  // spike while unlocking.
  const ownedFolders = folders.filter((folder) => folder.ownerUid === uid);
  return mapWithConcurrency(ownedFolders, 4, async (folder): Promise<DecryptedVaultFolder> => {
    if (!folder.encryptedName || !folder.wrappedKey) {
      return { ...folder, displayName: folder.name };
    }

    try {
      const folderKey = await unwrapNoteKey(folder.wrappedKey, privateKey);
      return { ...folder, displayName: await decryptText(folder.encryptedName, folderKey) };
    } catch {
      return { ...folder, displayName: "복호화할 수 없는 폴더", nameDecryptionFailed: true };
    }
  });
}

export async function createEncryptedVaultFolder(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  vaultIntegrityKey: CryptoKey,
  name: string,
  parentId: string | null,
  order: number,
  color = "#7c5cff",
  options?: { targetId: string; importJobId: string }
) {
  const normalizedName = name.trim().normalize("NFC");
  if (!normalizedName || normalizedName.length > 120) {
    throw new Error("폴더 이름은 1~120자로 입력해주세요.");
  }
  canonicalVaultName(normalizedName, "folder");

  const folderKey = await generateNoteKey();
  const [encryptedName, wrappedKey] = await Promise.all([
    encryptText(normalizedName, folderKey),
    wrapNoteKey(folderKey, profile.publicKeyJwk)
  ]);
  const claimId = await vaultNameFingerprint(vaultIntegrityKey, {
    name: normalizedName,
    parentId,
    targetType: "folder"
  });

  const createInput = {
    color,
    encryptedName,
    order,
    ownerUid: profile.uid,
    parentId,
    wrappedKey,
    nameClaim: {
      claimId,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      parentId
    }
  };
  return options?.targetId
    ? createEncryptedNoteFolderAtId(createInput, options.targetId, options.importJobId)
    : createEncryptedNoteFolder(createInput);
}

export async function migrateLegacyVaultFolder(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  vaultIntegrityKey: CryptoKey,
  folder: NoteFolderSnapshot,
  order: number,
  recovery?: {
    replacementName?: string;
    targetParentId?: string | null;
  }
) {
  if (folder.encryptedName && folder.wrappedKey) {
    return { folderId: folder.id, revision: folder.revision ?? 1 };
  }

  const normalizedName = (recovery?.replacementName ?? folder.name).trim().normalize("NFC");
  if (!normalizedName || normalizedName.length > 120) {
    throw new Error("기존 폴더 이름을 안전하게 변환할 수 없습니다.");
  }
  canonicalVaultName(normalizedName, "folder");
  const parentId = recovery?.targetParentId === undefined
    ? folder.parentId ?? null
    : recovery.targetParentId;
  if (
    parentId !== null
    && (!parentId || parentId.length > 120 || parentId.includes("/") || parentId === folder.id)
  ) {
    throw new Error("상위 폴더 식별자가 올바르지 않습니다.");
  }

  const folderKey = await generateNoteKey();
  const [encryptedName, wrappedKey] = await Promise.all([
    encryptText(normalizedName, folderKey),
    wrapNoteKey(folderKey, profile.publicKeyJwk)
  ]);
  const claimId = await vaultNameFingerprint(vaultIntegrityKey, {
    name: normalizedName,
    parentId,
    targetType: "folder"
  });

  return migrateLegacyNoteFolder({
    color: folder.color,
    encryptedName,
    expectedName: folder.name,
    folderId: folder.id,
    order,
    ownerUid: profile.uid,
    parentId,
    wrappedKey,
    nameClaim: {
      claimId,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      parentId
    }
  });
}

export async function renameEncryptedVaultFolder(
  folder: DecryptedVaultFolder,
  uid: string,
  privateKey: CryptoKey,
  vaultIntegrityKey: CryptoKey,
  name: string
) {
  const normalizedName = name.trim().normalize("NFC");
  if (!normalizedName || normalizedName.length > 120) {
    throw new Error("폴더 이름은 1~120자로 입력해주세요.");
  }
  canonicalVaultName(normalizedName, "folder");
  if (!folder.encryptedName || !folder.wrappedKey) {
    throw new Error("먼저 기존 폴더 이름을 암호화해주세요.");
  }
  const folderKey = await unwrapNoteKey(folder.wrappedKey, privateKey);
  const [encryptedName, claimId] = await Promise.all([
    encryptText(normalizedName, folderKey),
    vaultNameFingerprint(vaultIntegrityKey, {
      name: normalizedName,
      parentId: folder.parentId ?? null,
      targetType: "folder"
    })
  ]);
  return updateEncryptedNoteFolder({
    encryptedName,
    expectedRevision: folder.revision ?? 1,
    folderId: folder.id,
    ownerUid: uid,
    nameClaim: {
      claimId,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      parentId: folder.parentId ?? null
    }
  });
}

export async function moveEncryptedVaultFolder(
  folder: DecryptedVaultFolder,
  uid: string,
  vaultIntegrityKey: CryptoKey,
  parentId: string | null
) {
  const claimId = await vaultNameFingerprint(vaultIntegrityKey, {
    name: folder.displayName,
    parentId,
    targetType: "folder"
  });
  return updateEncryptedNoteFolder({
    expectedRevision: folder.revision ?? 1,
    folderId: folder.id,
    nameClaim: {
      claimId,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      parentId
    },
    ownerUid: uid,
    parentId
  });
}

export function buildVaultPaths(folders: DecryptedVaultFolder[]) {
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const cache = new Map<string, string>();

  function pathFor(folderId: string, trail = new Set<string>()): string {
    const cached = cache.get(folderId);
    if (cached !== undefined) {
      return cached;
    }

    const folder = folderById.get(folderId);
    if (!folder || trail.has(folderId)) {
      return "";
    }

    const nextTrail = new Set(trail).add(folderId);
    const parentPath = folder.parentId ? pathFor(folder.parentId, nextTrail) : "";
    const path = parentPath ? `${parentPath}/${folder.displayName}` : folder.displayName;
    cache.set(folderId, path);
    return path;
  }

  folders.forEach((folder) => pathFor(folder.id));
  return cache;
}

export function vaultNotePath(note: Pick<DecryptedVaultNote, "folderId" | "title">, folderPaths: Map<string, string>) {
  const fileName = note.title.toLocaleLowerCase().endsWith(".md") ? note.title : `${note.title}.md`;
  const folderPath = note.folderId ? folderPaths.get(note.folderId) : "";
  return folderPath ? `${folderPath}/${fileName}` : fileName;
}

export function vaultEntryPath(
  note: Pick<DecryptedVaultNote, "entryKind" | "folderId" | "title">,
  folderPaths: Map<string, string>
) {
  if (note.entryKind === "asset") {
    const folderPath = note.folderId ? folderPaths.get(note.folderId) : "";
    return folderPath ? `${folderPath}/${note.title}` : note.title;
  }
  const extension = note.entryKind === "canvas" ? ".canvas" : note.entryKind === "base" ? ".base" : ".md";
  const escapedExtension = extension.replace(".", "\\.");
  const title = note.title.replace(new RegExp(`${escapedExtension}$`, "i"), "");
  const folderPath = note.folderId ? folderPaths.get(note.folderId) : "";
  const fileName = `${title}${extension}`;
  return folderPath ? `${folderPath}/${fileName}` : fileName;
}
