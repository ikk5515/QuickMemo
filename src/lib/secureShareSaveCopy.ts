import {
  attachmentExtension,
  isAllowedAttachmentExtension,
  maxAttachmentFileBytes,
  maxAttachmentStorageBytes,
  publicShareAttachmentMimeMatchesExtension,
  safeAttachmentBaseName,
  safePublicShareAttachmentMimeType
} from "./attachments";
import { encryptAttachmentBlob } from "./attachmentCrypto";
import {
  encryptText,
  generateNoteKey,
  unwrapNoteKey,
  wrapNoteKey
} from "./crypto";
import {
  parseEditorContent,
  sanitizeEditorHtml,
  serializeEditorContent
} from "./editorContent";
import { hasFeatureAccess } from "./featureAccess";
import {
  abortSecureShareCopyingNote,
  activateSecureShareCopyingNote,
  createNoteAttachment,
  createSecureShareCopyingNote,
  deleteNoteAttachment,
} from "../services/notes";
import type {
  SecurePublicShareAttachmentMetadata,
  SecurePublicShareCopyPayload
} from "../components/SecurePublicShareViewer";
import type { UserProfile } from "../types";

const maximumCopyAttachmentCount = 100;
const maximumCopyTitleBytes = 64 * 1024;
const maximumSerializedBodyBytes = 900 * 1024;

export type SecureShareSaveCopyPhase =
  | "cleaning_up"
  | "complete"
  | "creating_note"
  | "activating"
  | "downloading"
  | "encrypting"
  | "preparing"
  | "uploading";

export interface SecureShareSaveCopyProgress {
  fileCount: number;
  fileIndex: number;
  fileName: string;
  loadedBytes: number;
  percent: number;
  phase: SecureShareSaveCopyPhase;
  totalBytes: number;
}

export interface SecureShareSaveCopyInput {
  payload: SecurePublicShareCopyPayload;
  privateKey: CryptoKey;
  profile: UserProfile;
  signal: AbortSignal;
  onProgress?: (progress: SecureShareSaveCopyProgress) => void;
}

export type SecureShareSaveCopyErrorCode =
  | "cancelled"
  | "cleanup_incomplete"
  | "grant_expired"
  | "invalid_attachment"
  | "invalid_content"
  | "not_authorized"
  | "save_failed";

export class SecureShareSaveCopyError extends Error {
  code: SecureShareSaveCopyErrorCode;

  constructor(code: SecureShareSaveCopyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecureShareSaveCopyError";
    this.code = code;
  }
}

interface SecureShareSaveCopyDependencies {
  abortSecureShareCopyingNote: typeof abortSecureShareCopyingNote;
  activateSecureShareCopyingNote: typeof activateSecureShareCopyingNote;
  createCopyJobId: () => string;
  createNoteAttachment: typeof createNoteAttachment;
  createSecureShareCopyingNote: typeof createSecureShareCopyingNote;
  deleteNoteAttachment: typeof deleteNoteAttachment;
  encryptAttachmentBlob: typeof encryptAttachmentBlob;
  encryptText: typeof encryptText;
  generateNoteKey: typeof generateNoteKey;
  now: () => number;
  unwrapNoteKey: typeof unwrapNoteKey;
  wrapNoteKey: typeof wrapNoteKey;
}

const defaultDependencies: SecureShareSaveCopyDependencies = {
  abortSecureShareCopyingNote,
  activateSecureShareCopyingNote,
  createCopyJobId: () => crypto.randomUUID(),
  createNoteAttachment,
  createSecureShareCopyingNote,
  deleteNoteAttachment,
  encryptAttachmentBlob,
  encryptText,
  generateNoteKey,
  now: Date.now,
  unwrapNoteKey,
  wrapNoteKey
};

interface ValidatedCopyAttachment {
  metadata: SecurePublicShareAttachmentMetadata;
  safeBaseName: string;
  safeMimeType: string;
}

function emitProgress(
  callback: SecureShareSaveCopyInput["onProgress"],
  progress: SecureShareSaveCopyProgress
) {
  try {
    callback?.(progress);
  } catch {
    // A rendering callback must not interrupt encryption, upload, or cleanup.
  }
}

function abortOrExpiryError(signal: AbortSignal, expiresAt: number, now: number) {
  if (signal.aborted) {
    return new SecureShareSaveCopyError(
      "cancelled",
      "복사본 저장을 취소했습니다. 생성된 데이터를 정리했습니다."
    );
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return new SecureShareSaveCopyError(
      "grant_expired",
      "복사 권한 시간이 만료되었습니다. 공유 페이지에서 다시 시도해주세요."
    );
  }
  return null;
}

function assertActive(signal: AbortSignal, expiresAt: number, now: number) {
  const error = abortOrExpiryError(signal, expiresAt, now);

  if (error) {
    throw error;
  }
}

function validateAttachment(
  attachment: SecurePublicShareAttachmentMetadata
): ValidatedCopyAttachment {
  const extension = attachment.extension.trim().toLowerCase();
  const mimeType = attachment.mimeType.trim().toLowerCase();
  const fileExtension = attachmentExtension(attachment.fileName);

  if (
    !/^[A-Za-z0-9_-]{6,128}$/u.test(attachment.id)
    || !isAllowedAttachmentExtension(extension)
    || fileExtension !== extension
    || !publicShareAttachmentMimeMatchesExtension(extension, mimeType)
    || !Number.isSafeInteger(attachment.originalSize)
    || attachment.originalSize <= 0
    || attachment.originalSize > maxAttachmentFileBytes
    || attachment.fileName.length > 255
    || /[<>:"/\\|?*]/u.test(attachment.fileName)
    || Array.from(attachment.fileName).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new SecureShareSaveCopyError(
      "invalid_attachment",
      "복사할 첨부파일 정보가 안전 기준을 충족하지 않습니다."
    );
  }

  return {
    metadata: attachment,
    safeBaseName: safeAttachmentBaseName(attachment.fileName),
    safeMimeType: safePublicShareAttachmentMimeType(extension)
  };
}

function validatePayload(payload: SecurePublicShareCopyPayload) {
  if (
    payload.capabilities.canSaveCopy !== true
    || payload.capabilities.permissionLevel !== "save_copy"
    || !Array.isArray(payload.attachments)
    || payload.attachments.length > maximumCopyAttachmentCount
    || typeof payload.title !== "string"
    || typeof payload.body !== "string"
    || typeof payload.copyAttachment !== "function"
  ) {
    throw new SecureShareSaveCopyError(
      "not_authorized",
      "이 공유에서 복사본을 저장할 권한을 확인하지 못했습니다."
    );
  }

  const title = payload.title.trim() || "제목 없음";
  const parsedBody = parseEditorContent(payload.body);
  const sanitizedBody = sanitizeEditorHtml(parsedBody.html || "<p>내용 없음</p>");
  const serializedBody = serializeEditorContent(sanitizedBody, parsedBody.fontSize);
  const historySnapshot = JSON.stringify({
    title,
    body: sanitizedBody,
    fontSize: parsedBody.fontSize
  });
  const encoder = new TextEncoder();

  if (
    encoder.encode(title).byteLength > maximumCopyTitleBytes
    || encoder.encode(serializedBody).byteLength > maximumSerializedBodyBytes
  ) {
    throw new SecureShareSaveCopyError(
      "invalid_content",
      "공유 본문이 복사본 저장 크기 제한을 초과했습니다."
    );
  }

  const attachments = payload.attachments.map(validateAttachment);
  const attachmentIds = new Set(attachments.map(({ metadata }) => metadata.id));
  const totalAttachmentBytes = attachments.reduce(
    (total, { metadata }) => total + metadata.originalSize,
    0
  );

  if (
    attachmentIds.size !== attachments.length
    || totalAttachmentBytes > maxAttachmentStorageBytes
  ) {
    throw new SecureShareSaveCopyError(
      "invalid_attachment",
      "복사할 첨부파일의 개수 또는 전체 크기가 안전 제한을 초과했습니다."
    );
  }

  const copyGrantExpiresAt = Date.parse(payload.copyGrantExpiresAt);

  if (!Number.isFinite(copyGrantExpiresAt)) {
    throw new SecureShareSaveCopyError(
      "grant_expired",
      "복사 권한 만료 시간을 확인하지 못했습니다."
    );
  }

  return {
    attachments,
    copyGrantExpiresAt,
    historySnapshot,
    serializedBody,
    title
  };
}

async function retryAttachmentCleanup(
  noteId: string,
  attachmentId: string,
  dependency: typeof deleteNoteAttachment
) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await dependency(noteId, attachmentId);
      return null;
    } catch (caught) {
      lastError = caught;
    }
  }

  return lastError;
}

export async function saveSecureShareCopy(
  input: SecureShareSaveCopyInput,
  dependencies: SecureShareSaveCopyDependencies = defaultDependencies
) {
  const { payload, privateKey, profile, signal } = input;

  if (
    !profile.isActive
    || !hasFeatureAccess(profile, "notes")
    || !profile.uid
    || !profile.publicKeyJwk
    || !privateKey
  ) {
    throw new SecureShareSaveCopyError(
      "not_authorized",
      "활성 QuickMemo 노트 권한과 암호화 키를 확인해주세요."
    );
  }

  const validated = validatePayload(payload);
  assertActive(signal, validated.copyGrantExpiresAt, dependencies.now());
  emitProgress(input.onProgress, {
    fileCount: validated.attachments.length,
    fileIndex: 0,
    fileName: "",
    loadedBytes: 0,
    percent: 0,
    phase: "preparing",
    totalBytes: 0
  });

  let createdNoteId: string | null = null;
  let copyJobId: string | null = null;
  let activationAttempted = false;
  const createdAttachmentIds: string[] = [];

  try {
    const generatedNoteKey = await dependencies.generateNoteKey();
    const ownerWrappedKey = await dependencies.wrapNoteKey(
      generatedNoteKey,
      profile.publicKeyJwk
    );
    const noteKey = await dependencies.unwrapNoteKey(ownerWrappedKey, privateKey);
    assertActive(signal, validated.copyGrantExpiresAt, dependencies.now());

    const [encryptedTitle, encryptedBody, historySummary, historySnapshot] = await Promise.all([
      dependencies.encryptText(validated.title, noteKey),
      dependencies.encryptText(validated.serializedBody, noteKey),
      dependencies.encryptText("보안 공유에서 독립 복사본을 저장했습니다.", noteKey),
      dependencies.encryptText(validated.historySnapshot, noteKey)
    ]);

    emitProgress(input.onProgress, {
      fileCount: validated.attachments.length,
      fileIndex: 0,
      fileName: "",
      loadedBytes: 0,
      percent: 0,
      phase: "creating_note",
      totalBytes: 0
    });
    assertActive(signal, validated.copyGrantExpiresAt, dependencies.now());

    copyJobId = dependencies.createCopyJobId();
    const createdNote = await dependencies.createSecureShareCopyingNote({
      type: "personal",
      ownerUid: profile.uid,
      participantUids: [profile.uid],
      encryptedTitle,
      encryptedBody,
      wrappedKeys: { [profile.uid]: ownerWrappedKey },
      folderId: null,
      historySummary,
      historySnapshot,
      copyJobId,
      expectedAttachmentCount: validated.attachments.length
    });
    createdNoteId = createdNote.noteId;
    assertActive(signal, validated.copyGrantExpiresAt, dependencies.now());

    for (const [attachmentIndex, attachment] of validated.attachments.entries()) {
      const fileIndex = attachmentIndex + 1;
      const { metadata } = attachment;

      emitProgress(input.onProgress, {
        fileCount: validated.attachments.length,
        fileIndex,
        fileName: metadata.fileName,
        loadedBytes: 0,
        percent: 0,
        phase: "downloading",
        totalBytes: metadata.originalSize
      });
      assertActive(signal, validated.copyGrantExpiresAt, dependencies.now());
      const plainBlob = await payload.copyAttachment(metadata, signal);
      assertActive(signal, validated.copyGrantExpiresAt, dependencies.now());

      if (
        plainBlob.size !== metadata.originalSize
        || plainBlob.type.toLowerCase() !== attachment.safeMimeType
      ) {
        throw new SecureShareSaveCopyError(
          "invalid_attachment",
          "복사한 첨부파일의 크기 또는 형식이 원본 메타데이터와 일치하지 않습니다."
        );
      }

      emitProgress(input.onProgress, {
        fileCount: validated.attachments.length,
        fileIndex,
        fileName: metadata.fileName,
        loadedBytes: 0,
        percent: 0,
        phase: "encrypting",
        totalBytes: metadata.originalSize
      });
      const encryptedAttachment = await dependencies.encryptAttachmentBlob(
        plainBlob,
        noteKey,
        (progress) => {
          assertActive(signal, validated.copyGrantExpiresAt, dependencies.now());
          emitProgress(input.onProgress, {
            fileCount: validated.attachments.length,
            fileIndex,
            fileName: metadata.fileName,
            loadedBytes: progress.loaded,
            percent: progress.percentage,
            phase: "encrypting",
            totalBytes: progress.total
          });
        }
      );
      assertActive(signal, validated.copyGrantExpiresAt, dependencies.now());

      const attachmentRef = await dependencies.createNoteAttachment({
        noteId: createdNote.noteId,
        fileName: attachment.safeBaseName,
        extension: metadata.extension,
        mimeType: attachment.safeMimeType,
        originalSize: metadata.originalSize,
        encryptedBlob: encryptedAttachment.blob,
        encryption: encryptedAttachment.metadata,
        secureShareCopyJobId: copyJobId,
        uploadedBy: profile.uid,
        onUploadProgress: (progress) => {
          emitProgress(input.onProgress, {
            fileCount: validated.attachments.length,
            fileIndex,
            fileName: metadata.fileName,
            loadedBytes: progress.loaded,
            percent: progress.percentage,
            phase: "uploading",
            totalBytes: progress.total
          });
        }
      });
      createdAttachmentIds.push(attachmentRef.id);
      assertActive(signal, validated.copyGrantExpiresAt, dependencies.now());
    }

    emitProgress(input.onProgress, {
      fileCount: validated.attachments.length,
      fileIndex: validated.attachments.length,
      fileName: "",
      loadedBytes: 0,
      percent: 100,
      phase: "activating",
      totalBytes: 0
    });
    assertActive(signal, validated.copyGrantExpiresAt, dependencies.now());
    activationAttempted = true;
    await dependencies.activateSecureShareCopyingNote({
      copyJobId,
      expectedRevision: 1,
      noteId: createdNote.noteId,
      uid: profile.uid
    });

    emitProgress(input.onProgress, {
      fileCount: validated.attachments.length,
      fileIndex: validated.attachments.length,
      fileName: "",
      loadedBytes: 0,
      percent: 100,
      phase: "complete",
      totalBytes: 0
    });
    return { noteId: createdNote.noteId };
  } catch (caught) {
    const originalError = signal.aborted
      ? new SecureShareSaveCopyError(
          "cancelled",
          "복사본 저장을 취소했습니다. 생성된 데이터를 정리했습니다.",
          { cause: caught }
        )
      : caught instanceof SecureShareSaveCopyError
        ? caught
        : new SecureShareSaveCopyError(
            "save_failed",
            "복사본 저장 중 오류가 발생했습니다. 생성된 데이터를 정리했습니다.",
            { cause: caught }
          );

    if (!createdNoteId || !copyJobId) {
      throw originalError;
    }

    if (activationAttempted) {
      try {
        await dependencies.activateSecureShareCopyingNote({
          copyJobId,
          expectedRevision: 1,
          noteId: createdNoteId,
          uid: profile.uid
        });
        return { noteId: createdNoteId };
      } catch {
        throw new SecureShareSaveCopyError(
          "cleanup_incomplete",
          "복사본 최종 상태를 확인하지 못했습니다. 다음 로그인에서 안전하게 복구합니다.",
          { cause: originalError }
        );
      }
    }

    emitProgress(input.onProgress, {
      fileCount: validated.attachments.length,
      fileIndex: createdAttachmentIds.length,
      fileName: "",
      loadedBytes: 0,
      percent: 0,
      phase: "cleaning_up",
      totalBytes: 0
    });

    const cleanupErrors: unknown[] = [];

    for (const attachmentId of [...createdAttachmentIds].reverse()) {
      const cleanupError = await retryAttachmentCleanup(
        createdNoteId,
        attachmentId,
        dependencies.deleteNoteAttachment
      );

      if (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }

    try {
      await dependencies.abortSecureShareCopyingNote({
        copyJobId,
        expectedRevision: 1,
        noteId: createdNoteId,
        uid: profile.uid
      });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }

    if (cleanupErrors.length) {
      throw new SecureShareSaveCopyError(
        "cleanup_incomplete",
        "복사본 저장에 실패했고 일부 생성 데이터의 자동 정리를 완료하지 못했습니다.",
        { cause: originalError }
      );
    }

    throw originalError;
  }
}
