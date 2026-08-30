import { attachmentDownloadName, safeAttachmentBaseName } from "../../lib/attachments";
import { decryptText, encryptText } from "../../lib/crypto";
import type { NoteAttachmentSnapshot } from "../../services/notes";
import {
  migrateNoteBlobAttachmentFileName,
  noteGenericAttachmentBaseName
} from "../../services/blobAttachments";
import type { EncryptedPayload } from "../../types";

type PrivateNoteAttachmentNameMetadata = {
  encryptedFileName?: EncryptedPayload;
  fileNameDecryptionFailed?: boolean;
  privacyVersion?: 1;
};

export type PrivateNoteAttachmentSnapshot = NoteAttachmentSnapshot & PrivateNoteAttachmentNameMetadata;

const filenameMigrationComplete = new Set<string>();
const filenameMigrationInFlight = new Set<string>();

export { noteGenericAttachmentBaseName };

function decryptedAttachmentBaseName(value: string, extension: string) {
  const normalizedValue = value.normalize("NFKC").trim();
  const extensionSuffix = `.${extension.toLowerCase()}`;
  const withoutExtension = normalizedValue.toLowerCase().endsWith(extensionSuffix)
    ? normalizedValue.slice(0, -extensionSuffix.length)
    : normalizedValue;

  return safeAttachmentBaseName(withoutExtension);
}

export async function privateNoteAttachmentNameFields(
  originalFileName: string,
  extension: string,
  noteKey: CryptoKey
) {
  const safeOriginalName = attachmentDownloadName({
    extension,
    fileName: safeAttachmentBaseName(originalFileName)
  });

  return {
    encryptedFileName: await encryptText(safeOriginalName, noteKey),
    fileName: noteGenericAttachmentBaseName(extension),
    privacyVersion: 1 as const
  };
}

export async function decryptPrivateNoteAttachmentName(
  attachment: PrivateNoteAttachmentSnapshot,
  noteKey: CryptoKey
): Promise<PrivateNoteAttachmentSnapshot> {
  if (attachment.privacyVersion !== 1) {
    // Historical attachments intentionally keep their existing plaintext name.
    return attachment;
  }

  if (!attachment.encryptedFileName) {
    // A privacy-marked record must never fall back to another plaintext field.
    return {
      ...attachment,
      fileName: noteGenericAttachmentBaseName(attachment.extension),
      fileNameDecryptionFailed: true
    };
  }

  try {
    const decryptedName = await decryptText(attachment.encryptedFileName, noteKey);
    return {
      ...attachment,
      fileName: decryptedAttachmentBaseName(decryptedName, attachment.extension),
      fileNameDecryptionFailed: false
    };
  } catch {
    return {
      ...attachment,
      fileName: noteGenericAttachmentBaseName(attachment.extension),
      fileNameDecryptionFailed: true
    };
  }
}

export async function decryptPrivateNoteAttachmentNames(
  attachments: readonly PrivateNoteAttachmentSnapshot[],
  noteKey: CryptoKey
) {
  return Promise.all(
    attachments.map((attachment) => decryptPrivateNoteAttachmentName(attachment, noteKey))
  );
}

function filenameMigrationKey(attachment: PrivateNoteAttachmentSnapshot) {
  return `${attachment.noteId}/${attachment.id}`;
}

export async function migrateLegacyPrivateNoteAttachmentNames(
  attachments: readonly PrivateNoteAttachmentSnapshot[],
  noteKey: CryptoKey,
  signal?: AbortSignal
) {
  for (const attachment of attachments) {
    signal?.throwIfAborted();
    if (attachment.privacyVersion !== undefined) continue;
    const migrationKey = filenameMigrationKey(attachment);
    if (filenameMigrationComplete.has(migrationKey) || filenameMigrationInFlight.has(migrationKey)) continue;

    filenameMigrationInFlight.add(migrationKey);
    try {
      const fields = await privateNoteAttachmentNameFields(
        attachmentDownloadName(attachment),
        attachment.extension,
        noteKey
      );
      await migrateNoteBlobAttachmentFileName({
        attachmentId: attachment.id,
        noteId: attachment.noteId,
        signal,
        ...fields
      });
      filenameMigrationComplete.add(migrationKey);
    } catch (caught) {
      if (
        signal?.aborted
        || (caught instanceof DOMException && caught.name === "AbortError")
      ) {
        throw caught;
      }
      // Migration is opportunistic. Keep the failed key retryable while
      // continuing through the remaining legacy metadata.
    } finally {
      filenameMigrationInFlight.delete(migrationKey);
    }
  }
}
