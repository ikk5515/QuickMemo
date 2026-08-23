import { encryptText, unwrapNoteKey } from "../../lib/crypto";
import { resolveRevisionedVaultNameCollision } from "../../services/notes";
import type { VaultContentFormat, VaultEntryKind } from "../../types";
import type { VaultPathRewriteActivationInput } from "../../services/vaultPathRewriteJobs";
import type { DecryptedVaultNote } from "./vaultData";
import {
  VAULT_NAME_INDEX_VERSION,
  canonicalVaultName,
  vaultNameFingerprint
} from "./vaultIntegrity";

function validVaultFormatPair(contentFormat: VaultContentFormat, entryKind: VaultEntryKind) {
  return (
    (contentFormat === "markdown-v1" && entryKind === "markdown")
    || (contentFormat === "legacy-html-v1" && entryKind === "legacy-html")
    || (contentFormat === "json-canvas-v1" && entryKind === "canvas")
    || (contentFormat === "base-v1" && entryKind === "base")
    || (contentFormat === "asset-v1" && entryKind === "asset")
  );
}

function validateReplacementIdentity(
  note: DecryptedVaultNote,
  replacement: { folderId: string | null; title: string }
) {
  const title = replacement.title.trim().normalize("NFC");
  if (!title || title.length > 180) {
    throw new Error("노트 이름은 1~180자로 입력해주세요.");
  }
  canonicalVaultName(title, "entry", note.entryKind);
  if (
    replacement.folderId !== null
    && (
      !replacement.folderId
      || replacement.folderId.length > 120
      || replacement.folderId.includes("/")
    )
  ) {
    throw new Error("노트 폴더 식별자가 올바르지 않습니다.");
  }
  if (!validVaultFormatPair(note.contentFormat, note.entryKind)) {
    throw new Error("Vault 항목 종류와 저장 형식이 일치하지 않습니다.");
  }
  return { folderId: replacement.folderId, title };
}

/**
 * Recovers only a deferred collision loser. The body ciphertext is preserved;
 * title and/or parent plus the replacement claim advance in one transaction.
 */
export async function resolveVaultEntryNameCollision(
  note: DecryptedVaultNote,
  uid: string,
  privateKey: CryptoKey,
  vaultIntegrityKey: CryptoKey,
  replacement: { folderId: string | null; title: string },
  pathRewriteActivation?: VaultPathRewriteActivationInput
) {
  if (note.ownerUid !== uid) {
    throw new Error("Vault 이름 충돌은 노트 소유자만 해결할 수 있습니다.");
  }
  if (note.vaultNameClaimId || note.vaultNameIndexVersion) {
    throw new Error("이 항목은 이미 Vault 이름 예약을 보유하고 있습니다.");
  }
  const normalized = validateReplacementIdentity(note, replacement);
  const titleChanged = normalized.title !== note.title;
  const folderChanged = normalized.folderId !== (note.folderId ?? null);
  if (!titleChanged && !folderChanged) {
    throw new Error("충돌을 해결하려면 이름 또는 폴더를 변경해주세요.");
  }
  const repairsHistoricalSharedFolder = note.type === "shared"
    && (note.folderId ?? null) !== null
    && normalized.folderId === null;
  if (folderChanged && note.type !== "personal" && !repairsHistoricalSharedFolder) {
    throw new Error("공유 노트는 폴더로 이동할 수 없습니다.");
  }
  const wrappedKey = note.wrappedKeys[uid];
  if (!wrappedKey) {
    throw new Error("Vault 이름 충돌 이력을 암호화할 키가 없습니다.");
  }
  const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
  const [encryptedTitle, historySummaryPayload, claimId] = await Promise.all([
    titleChanged ? encryptText(normalized.title, noteKey) : Promise.resolve(undefined),
    encryptText(folderChanged && !titleChanged ? "폴더 변경으로 이름 충돌 해결" : "이름 충돌 해결", noteKey),
    vaultNameFingerprint(vaultIntegrityKey, {
      kind: note.entryKind,
      name: normalized.title,
      parentId: normalized.folderId,
      targetType: "entry"
    })
  ]);
  const changedFields = [
    titleChanged ? "title" as const : null,
    folderChanged ? "folder" as const : null,
    "name-claim" as const
  ].filter((field): field is "folder" | "name-claim" | "title" => field !== null);

  const result = await resolveRevisionedVaultNameCollision({
    changedFields,
    ...(encryptedTitle ? { encryptedTitle } : {}),
    expectedContentFormat: note.contentFormat,
    expectedEntryKind: note.entryKind,
    expectedRevision: note.revision ?? 0,
    ...(folderChanged ? { folderId: normalized.folderId } : {}),
    historySummary: historySummaryPayload,
    nameClaim: {
      claimId,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      parentId: normalized.folderId
    },
    noteId: note.id,
    ...(pathRewriteActivation ? { pathRewriteActivation } : {}),
    readerUids: note.participantUids,
    uid
  });
  return {
    ...result,
    encryptedBody: note.encryptedBody,
    encryptedTitle: encryptedTitle ?? note.encryptedTitle,
    vaultNameClaimId: claimId,
    vaultNameIndexVersion: VAULT_NAME_INDEX_VERSION
  };
}
