import { encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../../lib/crypto";
import {
  createRevisionedEncryptedNote,
  updateRevisionedEncryptedNote
} from "../../services/notes";
import type { UserProfile } from "../../types";
import type { VaultContentFormat, VaultEntryKind } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import { decodeVaultAsset, encodeVaultAsset } from "./vaultAsset";
import { canonicalVaultName } from "./vaultIntegrity";
import {
  assertVaultPayloadFitsPersistence,
  encryptedHistorySnapshotSource
} from "./vaultPayloadLimits";

export interface MarkdownNoteDraft {
  body: string;
  folderId: string | null;
  title: string;
}

export interface VaultEntryDraft extends MarkdownNoteDraft {
  contentFormat: VaultContentFormat;
  entryKind: VaultEntryKind;
}

export interface VaultAssetDraft {
  bytes: Uint8Array;
  folderId: string | null;
  mimeType?: string;
  title: string;
}

function validVaultFormatPair(
  contentFormat: VaultContentFormat,
  entryKind: VaultEntryKind
) {
  return (
    (contentFormat === "markdown-v1" && entryKind === "markdown")
    || (contentFormat === "legacy-html-v1" && entryKind === "legacy-html")
    || (contentFormat === "json-canvas-v1" && entryKind === "canvas")
    || (contentFormat === "base-v1" && entryKind === "base")
    || (contentFormat === "asset-v1" && entryKind === "asset")
  );
}

function validateDraft(
  draft: MarkdownNoteDraft,
  contentFormat: VaultContentFormat,
  entryKind: VaultEntryKind
) {
  const title = draft.title.trim().normalize("NFC");
  if (!title || title.length > 180) {
    throw new Error("노트 이름은 1~180자로 입력해주세요.");
  }
  canonicalVaultName(title, "entry", entryKind);
  if (
    draft.folderId !== null
    && (
      !draft.folderId
      || draft.folderId.length > 120
      || draft.folderId.includes("/")
    )
  ) {
    throw new Error("노트 폴더 식별자가 올바르지 않습니다.");
  }
  if (!validVaultFormatPair(contentFormat, entryKind)) {
    throw new Error("Vault 항목 종류와 저장 형식이 일치하지 않습니다.");
  }
  if (entryKind === "asset") {
    decodeVaultAsset(draft.body);
  }
  const normalized = { ...draft, title };
  assertVaultPayloadFitsPersistence({ ...normalized, contentFormat, entryKind });
  return normalized;
}

function historySummary(previous: MarkdownNoteDraft | null, next: MarkdownNoteDraft) {
  if (!previous) {
    return `항목 생성: ${next.title}`;
  }
  const fields = [
    previous.title !== next.title ? "이름" : "",
    previous.body !== next.body ? "내용" : "",
    previous.folderId !== next.folderId ? "폴더" : ""
  ].filter(Boolean);
  return fields.length ? `${fields.join(", ")} 변경` : "저장됨";
}

export async function createMarkdownVaultNote(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  draft: MarkdownNoteDraft
) {
  return createEncryptedVaultEntry(profile, {
    ...draft,
    contentFormat: "markdown-v1",
    entryKind: "markdown"
  });
}

export async function createEncryptedVaultEntry(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  draft: VaultEntryDraft
) {
  const normalized = validateDraft(draft, draft.contentFormat, draft.entryKind);
  const noteKey = await generateNoteKey();
  const [encryptedTitle, encryptedBody, wrappedKey, historySummaryPayload, historySnapshot] = await Promise.all([
    encryptText(normalized.title, noteKey),
    encryptText(normalized.body, noteKey),
    wrapNoteKey(noteKey, profile.publicKeyJwk),
    encryptText(historySummary(null, normalized), noteKey),
    encryptText(encryptedHistorySnapshotSource({
      ...normalized,
      contentFormat: draft.contentFormat,
      entryKind: draft.entryKind
    }), noteKey)
  ]);

  return createRevisionedEncryptedNote({
    contentFormat: draft.contentFormat,
    entryKind: draft.entryKind,
    encryptedBody,
    encryptedTitle,
    folderId: normalized.folderId,
    historySnapshot,
    historySummary: historySummaryPayload,
    ownerUid: profile.uid,
    participantUids: [profile.uid],
    type: "personal",
    wrappedKeys: { [profile.uid]: wrappedKey }
  });
}

export async function createEncryptedVaultAsset(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  draft: VaultAssetDraft
) {
  return createEncryptedVaultEntry(profile, {
    body: encodeVaultAsset(draft.bytes, draft.mimeType),
    contentFormat: "asset-v1",
    entryKind: "asset",
    folderId: draft.folderId,
    title: draft.title
  });
}

export async function saveMarkdownVaultNote(
  note: DecryptedVaultNote,
  uid: string,
  privateKey: CryptoKey,
  draft: MarkdownNoteDraft
) {
  return saveEncryptedVaultEntry(note, uid, privateKey, draft);
}

export async function saveEncryptedVaultEntry(
  note: DecryptedVaultNote,
  uid: string,
  privateKey: CryptoKey,
  draft: MarkdownNoteDraft
) {
  if (note.contentFormat === "legacy-html-v1") {
    throw new Error("기존 HTML 노트는 Markdown 복사본으로 변환한 뒤 편집할 수 있습니다.");
  }

  const normalized = validateDraft(draft, note.contentFormat, note.entryKind);
  if ((note.folderId ?? null) !== normalized.folderId) {
    throw new Error("폴더 이동은 이력과 revision을 함께 기록하는 이동 기능을 사용해주세요.");
  }
  const wrappedKey = note.wrappedKeys[uid];
  if (!wrappedKey) {
    throw new Error("노트를 저장할 암호화 키가 없습니다.");
  }

  const changedFields = [
    normalized.title !== note.title ? "title" : "",
    normalized.body !== note.body ? "body" : ""
  ].filter(Boolean);
  if (!changedFields.length) {
    return { noteId: note.id, revision: note.revision ?? 0 };
  }

  const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
  const [encryptedTitle, encryptedBody, historySummaryPayload, historySnapshot] = await Promise.all([
    changedFields.includes("title")
      ? encryptText(normalized.title, noteKey)
      : Promise.resolve(note.encryptedTitle),
    changedFields.includes("body")
      ? encryptText(normalized.body, noteKey)
      : Promise.resolve(note.encryptedBody),
    encryptText(historySummary({ body: note.body, folderId: note.folderId ?? null, title: note.title }, normalized), noteKey),
    encryptText(encryptedHistorySnapshotSource({
      ...normalized,
      contentFormat: note.contentFormat,
      entryKind: note.entryKind
    }), noteKey)
  ]);

  return updateRevisionedEncryptedNote({
    changedFields,
    encryptedBody,
    encryptedTitle,
    expectedContentFormat: note.contentFormat,
    expectedEntryKind: note.entryKind,
    expectedRevision: note.revision ?? 0,
    historySnapshot,
    historySummary: historySummaryPayload,
    noteId: note.id,
    readerUids: note.participantUids,
    uid
  });
}
