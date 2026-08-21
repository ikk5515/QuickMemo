import { encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../../lib/crypto";
import {
  createRevisionedEncryptedNote,
  updateRevisionedEncryptedNote
} from "../../services/notes";
import type { UserProfile } from "../../types";
import type { VaultContentFormat, VaultEntryKind } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";

export interface MarkdownNoteDraft {
  body: string;
  folderId: string | null;
  title: string;
}

export interface VaultEntryDraft extends MarkdownNoteDraft {
  contentFormat: VaultContentFormat;
  entryKind: Exclude<VaultEntryKind, "asset">;
}

const maxVaultBodyCharacters = 500_000;
// Firestore documents are capped at 1 MiB. AES-GCM payloads are base64 encoded,
// so keep plaintext below 500 kB to leave room for ciphertext expansion,
// title/key metadata, and the separately encrypted history snapshot envelope.
const maxVaultBodyUtf8Bytes = 500_000;
const maxVaultHistorySnapshotUtf8Bytes = 520_000;
const utf8Encoder = new TextEncoder();

function validateDraft(draft: MarkdownNoteDraft) {
  const title = draft.title.trim();
  if (!title || title.length > 180) {
    throw new Error("노트 이름은 1~180자로 입력해주세요.");
  }
  if (title.includes("/") || title.includes("\\")) {
    throw new Error("노트 이름에는 경로 구분자를 사용할 수 없습니다.");
  }
  if (
    draft.body.length > maxVaultBodyCharacters
    || utf8Encoder.encode(draft.body).byteLength > maxVaultBodyUtf8Bytes
  ) {
    throw new Error("Markdown 본문은 UTF-8 기준 500KB 이하로 저장할 수 있습니다.");
  }
  const normalized = { ...draft, title };
  if (
    utf8Encoder.encode(encryptedHistorySnapshotSource(
      normalized,
      "markdown-v1",
      "markdown"
    )).byteLength > maxVaultHistorySnapshotUtf8Bytes
  ) {
    throw new Error("노트 이력 스냅샷이 저장 가능한 크기를 초과했습니다.");
  }
  return normalized;
}

function encryptedHistorySnapshotSource(
  draft: MarkdownNoteDraft,
  contentFormat: VaultContentFormat,
  entryKind: Exclude<VaultEntryKind, "asset">
) {
  return JSON.stringify({
    title: draft.title,
    body: draft.body,
    fontSize: 16,
    folderId: draft.folderId,
    contentFormat,
    entryKind
  });
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
  const normalized = validateDraft(draft);
  const noteKey = await generateNoteKey();
  const [encryptedTitle, encryptedBody, wrappedKey, historySummaryPayload, historySnapshot] = await Promise.all([
    encryptText(normalized.title, noteKey),
    encryptText(normalized.body, noteKey),
    wrapNoteKey(noteKey, profile.publicKeyJwk),
    encryptText(historySummary(null, normalized), noteKey),
    encryptText(encryptedHistorySnapshotSource(normalized, draft.contentFormat, draft.entryKind), noteKey)
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

  const normalized = validateDraft(draft);
  const wrappedKey = note.wrappedKeys[uid];
  if (!wrappedKey) {
    throw new Error("노트를 저장할 암호화 키가 없습니다.");
  }

  const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
  const [encryptedTitle, encryptedBody, historySummaryPayload, historySnapshot] = await Promise.all([
    encryptText(normalized.title, noteKey),
    encryptText(normalized.body, noteKey),
    encryptText(historySummary({ body: note.body, folderId: note.folderId ?? null, title: note.title }, normalized), noteKey),
    encryptText(encryptedHistorySnapshotSource(normalized, note.contentFormat, note.entryKind), noteKey)
  ]);

  return updateRevisionedEncryptedNote({
    changedFields: ["title", "body"],
    encryptedBody,
    encryptedTitle,
    expectedRevision: note.revision ?? 0,
    historySnapshot,
    historySummary: historySummaryPayload,
    noteId: note.id,
    readerUids: note.participantUids,
    uid
  });
}
