import { encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../../lib/crypto";
import {
  backfillRevisionedVaultNameClaim,
  createRevisionedEncryptedNote,
  createRevisionedEncryptedNoteAtId,
  migrateLegacyVaultNote,
  updateRevisionedEncryptedNote,
  updateRevisionedEncryptedNoteAndFolder,
  type SaveNoteInput,
  type VaultCutoverLeaseInput
} from "../../services/notes";
import type { UserProfile } from "../../types";
import type { VaultContentFormat, VaultEntryKind } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import { decodeVaultAsset, encodeVaultAsset } from "./vaultAsset";
import {
  VAULT_NAME_INDEX_VERSION,
  canonicalVaultName,
  vaultNameFingerprint
} from "./vaultIntegrity";
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

function validateVaultIdentityDraft(
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
  return { ...draft, title };
}

function validateDraft(
  draft: MarkdownNoteDraft,
  contentFormat: VaultContentFormat,
  entryKind: VaultEntryKind
) {
  const normalized = validateVaultIdentityDraft(draft, contentFormat, entryKind);
  if (entryKind === "asset") {
    decodeVaultAsset(normalized.body);
  }
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
  vaultIntegrityKey: CryptoKey,
  draft: MarkdownNoteDraft
) {
  return createEncryptedVaultEntry(profile, vaultIntegrityKey, {
    ...draft,
    contentFormat: "markdown-v1",
    entryKind: "markdown"
  });
}

export async function createEncryptedVaultEntry(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  vaultIntegrityKey: CryptoKey,
  draft: VaultEntryDraft,
  options?: { targetId: string; importJobId: string }
) {
  const normalized = validateDraft(draft, draft.contentFormat, draft.entryKind);
  const claimId = await vaultNameFingerprint(vaultIntegrityKey, {
    kind: draft.entryKind,
    name: normalized.title,
    parentId: normalized.folderId,
    targetType: "entry"
  });
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

  const createInput: SaveNoteInput = {
    contentFormat: draft.contentFormat,
    entryKind: draft.entryKind,
    encryptedBody,
    encryptedTitle,
    folderId: normalized.folderId,
    historySnapshot,
    historySummary: historySummaryPayload,
    nameClaim: {
      claimId,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      parentId: normalized.folderId
    },
    ownerUid: profile.uid,
    participantUids: [profile.uid],
    type: "personal",
    wrappedKeys: { [profile.uid]: wrappedKey }
  };
  return options?.targetId
    ? createRevisionedEncryptedNoteAtId(createInput, options.targetId, options.importJobId)
    : createRevisionedEncryptedNote(createInput);
}

export async function createEncryptedVaultAsset(
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  vaultIntegrityKey: CryptoKey,
  draft: VaultAssetDraft,
  options?: { targetId: string; importJobId: string }
) {
  return createEncryptedVaultEntry(profile, vaultIntegrityKey, {
    body: encodeVaultAsset(draft.bytes, draft.mimeType),
    contentFormat: "asset-v1",
    entryKind: "asset",
    folderId: draft.folderId,
    title: draft.title
  }, options);
}

export async function saveMarkdownVaultNote(
  note: DecryptedVaultNote,
  uid: string,
  privateKey: CryptoKey,
  vaultIntegrityKey: CryptoKey,
  draft: MarkdownNoteDraft
) {
  return saveEncryptedVaultEntry(note, uid, privateKey, vaultIntegrityKey, draft);
}

/** Adds only the blinded reservation metadata; encrypted content is unchanged. */
export async function backfillVaultEntryNameClaim(
  note: DecryptedVaultNote,
  uid: string,
  privateKey: CryptoKey,
  vaultIntegrityKey: CryptoKey,
  repairMissingReservation = false,
  cutoverLease?: VaultCutoverLeaseInput,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  if (note.ownerUid !== uid) {
    throw new Error("Vault 이름 예약은 노트 소유자만 생성할 수 있습니다.");
  }
  const normalized = validateVaultIdentityDraft(
    { body: note.body, folderId: note.folderId ?? null, title: note.title },
    note.contentFormat,
    note.entryKind
  );
  const claimId = await vaultNameFingerprint(vaultIntegrityKey, {
    kind: note.entryKind,
    name: normalized.title,
    parentId: normalized.folderId,
    targetType: "entry"
  });
  if (
    !repairMissingReservation
    && note.vaultNameClaimId === claimId
    && note.vaultNameIndexVersion === VAULT_NAME_INDEX_VERSION
  ) {
    return { noteId: note.id, revision: note.revision ?? 0 };
  }
  const wrappedKey = note.wrappedKeys[uid];
  if (!wrappedKey) {
    throw new Error("Vault 이름 예약 이력을 암호화할 키가 없습니다.");
  }
  const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
  const historySummaryPayload = await encryptText("Vault 이름 예약 인덱스 생성", noteKey);
  signal?.throwIfAborted();

  const backfillInput = {
    expectedContentFormat: note.contentFormat,
    expectedEntryKind: note.entryKind,
    expectedRevision: note.revision ?? 0,
    historySummary: historySummaryPayload,
    ...cutoverLease,
    nameClaim: {
      claimId,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      parentId: normalized.folderId
    },
    noteId: note.id,
    readerUids: note.participantUids,
    uid
  };
  return signal
    ? backfillRevisionedVaultNameClaim(backfillInput, signal)
    : backfillRevisionedVaultNameClaim(backfillInput);
}

/**
 * Seals the inferred legacy HTML storage identity after the Vault integrity
 * marker exists. A unique active entry reserves its blinded name in the same
 * server transaction; a collision loser or deleted entry deliberately writes
 * identity only so it cannot steal or retain an active sibling reservation.
 */
export async function migrateLegacyVaultEntryIdentity(
  note: DecryptedVaultNote,
  uid: string,
  vaultIntegrityKey: CryptoKey,
  reserveNameClaim: boolean,
  cutoverLease?: VaultCutoverLeaseInput,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  if (note.ownerUid !== uid) {
    throw new Error("Vault 저장 형식은 노트 소유자만 전환할 수 있습니다.");
  }
  if (note.contentFormat !== "legacy-html-v1" || note.entryKind !== "legacy-html") {
    throw new Error("기존 HTML 노트만 명시적 Vault 저장 형식으로 전환할 수 있습니다.");
  }
  const normalized = validateVaultIdentityDraft(
    { body: note.body, folderId: note.folderId ?? null, title: note.title },
    note.contentFormat,
    note.entryKind
  );
  const nameClaim = reserveNameClaim
    ? {
        claimId: await vaultNameFingerprint(vaultIntegrityKey, {
          kind: note.entryKind,
          name: normalized.title,
          parentId: normalized.folderId,
          targetType: "entry"
        }),
        indexVersion: VAULT_NAME_INDEX_VERSION,
        parentId: normalized.folderId
      }
    : undefined;
  signal?.throwIfAborted();
  const migrationInput = {
    expectedContentFormat: "legacy-html-v1" as const,
    expectedEntryKind: "legacy-html" as const,
    expectedRevision: note.revision ?? 0,
    ...cutoverLease,
    ...(nameClaim ? { nameClaim } : {}),
    noteId: note.id,
    readerUids: note.participantUids,
    uid
  };
  return signal
    ? migrateLegacyVaultNote(migrationInput, signal)
    : migrateLegacyVaultNote(migrationInput);
}

export async function saveEncryptedVaultEntry(
  note: DecryptedVaultNote,
  uid: string,
  privateKey: CryptoKey,
  vaultIntegrityKey: CryptoKey,
  draft: MarkdownNoteDraft
) {
  if (note.contentFormat === "legacy-html-v1") {
    throw new Error("기존 HTML 노트는 Markdown 복사본으로 변환한 뒤 편집할 수 있습니다.");
  }

  const normalized = validateDraft(draft, note.contentFormat, note.entryKind);
  if ((note.folderId ?? null) !== normalized.folderId) {
    throw new Error("폴더 이동은 이력과 revision을 함께 기록하는 이동 기능을 사용해주세요.");
  }
  const isOwner = note.ownerUid === uid;
  if (!isOwner) {
    if (note.type !== "shared" || !note.participantUids.includes(uid)) {
      throw new Error("이 노트를 저장할 권한이 없습니다.");
    }
    if (normalized.title !== note.title) {
      throw new Error("공유 노트의 제목과 이름 예약은 소유자만 변경할 수 있습니다.");
    }
    if (!note.vaultNameClaimId || note.vaultNameIndexVersion !== VAULT_NAME_INDEX_VERSION) {
      throw new Error("소유자가 공유 노트의 Vault 이름 예약을 완료한 뒤 편집할 수 있습니다.");
    }
  }
  const wrappedKey = note.wrappedKeys[uid];
  if (!wrappedKey) {
    throw new Error("노트를 저장할 암호화 키가 없습니다.");
  }

  const claimId = isOwner
    ? await vaultNameFingerprint(vaultIntegrityKey, {
        kind: note.entryKind,
        name: normalized.title,
        parentId: normalized.folderId,
        targetType: "entry"
      })
    : note.vaultNameClaimId;
  const claimChanged = isOwner
    && (note.vaultNameClaimId !== claimId || note.vaultNameIndexVersion !== VAULT_NAME_INDEX_VERSION);
  const changedFields = [
    normalized.title !== note.title ? "title" : "",
    normalized.body !== note.body ? "body" : "",
    claimChanged ? "name-claim" : ""
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
    ...(isOwner ? {
      nameClaim: {
        claimId: claimId!,
        indexVersion: VAULT_NAME_INDEX_VERSION,
        parentId: normalized.folderId
      }
    } : {}),
    noteId: note.id,
    readerUids: note.participantUids,
    uid
  });
}

/**
 * Recovers only a deferred collision loser. The body ciphertext is preserved;
 * title and/or parent plus the replacement claim advance in one transaction.
 * This also works for legacy HTML entries without converting their content.
 */
/** Saves content and a folder move in one revision-aware Firestore transaction. */
export async function saveAndMoveEncryptedVaultEntry(
  note: DecryptedVaultNote,
  uid: string,
  privateKey: CryptoKey,
  vaultIntegrityKey: CryptoKey,
  draft: MarkdownNoteDraft
) {
  if (note.contentFormat === "legacy-html-v1") {
    throw new Error("기존 HTML 노트는 Markdown 복사본으로 변환한 뒤 이동할 수 있습니다.");
  }
  if (note.ownerUid !== uid || note.type !== "personal") {
    throw new Error("내 개인 항목만 폴더로 이동할 수 있습니다.");
  }

  const normalized = validateDraft(draft, note.contentFormat, note.entryKind);
  const wrappedKey = note.wrappedKeys[uid];
  if (!wrappedKey) {
    throw new Error("노트를 저장할 암호화 키가 없습니다.");
  }
  const claimId = await vaultNameFingerprint(vaultIntegrityKey, {
    kind: note.entryKind,
    name: normalized.title,
    parentId: normalized.folderId,
    targetType: "entry"
  });
  const claimChanged = note.vaultNameClaimId !== claimId || note.vaultNameIndexVersion !== VAULT_NAME_INDEX_VERSION;
  const changedFields = [
    normalized.title !== note.title ? "title" : "",
    normalized.body !== note.body ? "body" : "",
    normalized.folderId !== (note.folderId ?? null) ? "folder" : "",
    claimChanged ? "name-claim" : ""
  ].filter(Boolean);
  if (!changedFields.length) {
    throw new Error("저장하거나 이동할 변경 사항이 없습니다.");
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

  return updateRevisionedEncryptedNoteAndFolder({
    changedFields,
    encryptedBody,
    encryptedTitle,
    expectedContentFormat: note.contentFormat,
    expectedEntryKind: note.entryKind,
    expectedRevision: note.revision ?? 0,
    folderId: normalized.folderId,
    historySnapshot,
    historySummary: historySummaryPayload,
    nameClaim: {
      claimId,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      parentId: normalized.folderId
    },
    noteId: note.id,
    readerUids: note.participantUids,
    uid
  });
}
