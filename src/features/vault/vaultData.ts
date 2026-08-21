import { decryptText, encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../../lib/crypto";
import { mapWithConcurrency } from "../../lib/mapWithConcurrency";
import {
  createEncryptedNoteFolder,
  migrateLegacyNoteFolder,
  updateEncryptedNoteFolder,
  type NoteFolderSnapshot,
  type NoteSnapshot
} from "../../services/notes";
import type { DecryptedNote, UserProfile, VaultContentFormat, VaultEntryKind } from "../../types";

export interface DecryptedVaultFolder extends NoteFolderSnapshot {
  displayName: string;
}

export interface DecryptedVaultNote extends DecryptedNote {
  contentFormat: VaultContentFormat;
  entryKind: Exclude<VaultEntryKind, "asset">;
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
  return Promise.all(folders.map(async (folder): Promise<DecryptedVaultFolder> => {
    if (!folder.encryptedName || !folder.wrappedKey) {
      return { ...folder, displayName: folder.name };
    }

    try {
      const folderKey = await unwrapNoteKey(folder.wrappedKey, privateKey);
      return { ...folder, displayName: await decryptText(folder.encryptedName, folderKey) };
    } catch {
      return { ...folder, displayName: "복호화할 수 없는 폴더" };
    }
  })).then((items) => items.filter((folder) => folder.ownerUid === uid));
}

export async function createEncryptedVaultFolder(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  name: string,
  parentId: string | null,
  order: number,
  color = "#7c5cff"
) {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 120 || normalizedName.includes("/")) {
    throw new Error("폴더 이름은 1~120자이며 '/'를 포함할 수 없습니다.");
  }

  const folderKey = await generateNoteKey();
  const [encryptedName, wrappedKey] = await Promise.all([
    encryptText(normalizedName, folderKey),
    wrapNoteKey(folderKey, profile.publicKeyJwk)
  ]);

  return createEncryptedNoteFolder({
    color,
    encryptedName,
    order,
    ownerUid: profile.uid,
    parentId,
    wrappedKey
  });
}

export async function migrateLegacyVaultFolder(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  folder: NoteFolderSnapshot,
  order: number
) {
  if (folder.encryptedName && folder.wrappedKey) {
    return { folderId: folder.id, revision: folder.revision ?? 1 };
  }

  const folderKey = await generateNoteKey();
  const [encryptedName, wrappedKey] = await Promise.all([
    encryptText(folder.name, folderKey),
    wrapNoteKey(folderKey, profile.publicKeyJwk)
  ]);

  return migrateLegacyNoteFolder({
    color: folder.color,
    encryptedName,
    expectedName: folder.name,
    folderId: folder.id,
    order,
    ownerUid: profile.uid,
    parentId: null,
    wrappedKey
  });
}

export async function renameEncryptedVaultFolder(
  folder: DecryptedVaultFolder,
  uid: string,
  privateKey: CryptoKey,
  name: string
) {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 120 || normalizedName.includes("/")) {
    throw new Error("폴더 이름은 1~120자이며 '/'를 포함할 수 없습니다.");
  }
  if (!folder.encryptedName || !folder.wrappedKey) {
    throw new Error("먼저 기존 폴더 이름을 암호화해주세요.");
  }
  const folderKey = await unwrapNoteKey(folder.wrappedKey, privateKey);
  const encryptedName = await encryptText(normalizedName, folderKey);
  return updateEncryptedNoteFolder({
    encryptedName,
    expectedRevision: folder.revision ?? 1,
    folderId: folder.id,
    ownerUid: uid
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
  const extension = note.entryKind === "canvas" ? ".canvas" : note.entryKind === "base" ? ".base" : ".md";
  const escapedExtension = extension.replace(".", "\\.");
  const title = note.title.replace(new RegExp(`${escapedExtension}$`, "i"), "");
  const folderPath = note.folderId ? folderPaths.get(note.folderId) : "";
  const fileName = `${title}${extension}`;
  return folderPath ? `${folderPath}/${fileName}` : fileName;
}
