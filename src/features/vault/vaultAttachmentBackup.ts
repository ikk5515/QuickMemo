import { attachmentDownloadName } from "../../lib/attachments";
import {
  attachmentCryptoRuntimeFileSizeLimit,
  decryptAttachmentToBlob,
  maxConstrainedAttachmentFileBytes,
  type EncryptedAttachmentSource
} from "../../lib/attachmentCrypto";
import { unwrapNoteKey } from "../../lib/crypto";
import {
  getEncryptedNoteAttachmentSource,
  getNoteAttachments,
  type NoteAttachmentSnapshot
} from "../../services/notes";
import type { WrappedNoteKey } from "../../types";
import { DEFAULT_VAULT_INTEROP_LIMITS, type ObsidianVaultSourceEntry } from "./interop";
import {
  decryptPrivateNoteAttachmentNames,
  type PrivateNoteAttachmentSnapshot
} from "./noteAttachmentFileName";
import {
  normalizeVaultPath,
  renamedDuplicateVaultPath,
  vaultPathCollisionKey
} from "./interop/path";

export const MAX_VAULT_ATTACHMENT_BACKUP_BYTES = 96 * 1024 * 1024;
export const MAX_CONSTRAINED_VAULT_ATTACHMENT_BACKUP_BYTES = 48 * 1024 * 1024;
export const MAX_VAULT_ATTACHMENT_BACKUP_ENTRY_BYTES = 64 * 1024 * 1024;
const vaultAttachmentManifestReserveBytes = 1024 * 1024;
const vaultAttachmentArchiveHeadroomBytes = 8 * 1024 * 1024;

export interface VaultAttachmentBackupNote {
  id: string;
  path: string;
  wrappedKey?: WrappedNoteKey;
}

export interface VaultAttachmentBackupIncluded {
  byteLength: number;
  fileName: string;
  fileNameStatus: "available" | "fallback";
  mimeType: string;
  notePath: string;
  path: string;
  sha256: string;
}

export type VaultAttachmentBackupMissingReason =
  | "attachment-list-unavailable"
  | "decryption-failed"
  | "entry-size-limit"
  | "missing-note-key"
  | "size-mismatch"
  | "total-size-limit";

export interface VaultAttachmentBackupMissing {
  fileName: string | null;
  notePath: string;
  reason: VaultAttachmentBackupMissingReason;
}

export interface VaultAttachmentBackupResult {
  included: VaultAttachmentBackupIncluded[];
  manifestSource: ObsidianVaultSourceEntry;
  missing: VaultAttachmentBackupMissing[];
  sources: ObsidianVaultSourceEntry[];
  totalBytes: number;
}

interface VaultAttachmentBackupDependencies {
  decryptPrivateNoteAttachmentNames: typeof decryptPrivateNoteAttachmentNames;
  decryptAttachmentToBlob: typeof decryptAttachmentToBlob;
  getEncryptedNoteAttachmentSource: typeof getEncryptedNoteAttachmentSource;
  getNoteAttachments: typeof getNoteAttachments;
  unwrapNoteKey: typeof unwrapNoteKey;
}

const defaultDependencies: VaultAttachmentBackupDependencies = {
  decryptPrivateNoteAttachmentNames,
  decryptAttachmentToBlob,
  getEncryptedNoteAttachmentSource,
  getNoteAttachments,
  unwrapNoteKey
};

function contentByteLength(source: ObsidianVaultSourceEntry) {
  return typeof source.content === "string"
    ? new TextEncoder().encode(source.content).byteLength
    : source.content.byteLength;
}

export function vaultAttachmentBackupByteBudget(
  existingSources: readonly ObsidianVaultSourceEntry[],
  runtimeFileSizeLimit = attachmentCryptoRuntimeFileSizeLimit()
) {
  const existingBytes = existingSources.reduce((total, source) => total + contentByteLength(source), 0);
  const archiveBudget = DEFAULT_VAULT_INTEROP_LIMITS.maxArchiveBytes
    - vaultAttachmentArchiveHeadroomBytes
    - vaultAttachmentManifestReserveBytes
    - existingBytes;
  const totalBudget = DEFAULT_VAULT_INTEROP_LIMITS.maxTotalBytes
    - vaultAttachmentManifestReserveBytes
    - existingBytes;
  const runtimeBudget = runtimeFileSizeLimit <= maxConstrainedAttachmentFileBytes
    ? MAX_CONSTRAINED_VAULT_ATTACHMENT_BACKUP_BYTES
    : MAX_VAULT_ATTACHMENT_BACKUP_BYTES;
  return Math.max(0, Math.min(runtimeBudget, archiveBudget, totalBudget));
}

function attachmentFolderPath(notePath: string) {
  const normalized = normalizeVaultPath(notePath);
  const slashIndex = normalized.lastIndexOf("/");
  const directory = slashIndex === -1 ? "" : normalized.slice(0, slashIndex + 1);
  const fileName = normalized.slice(slashIndex + 1);
  const dotIndex = fileName.lastIndexOf(".");
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return normalizeVaultPath(`${directory}${stem} attachments`);
}

function reserveUniquePath(path: string, occupied: Set<string>) {
  let candidate = normalizeVaultPath(path);
  let attempt = 2;
  while (occupied.has(vaultPathCollisionKey(candidate))) {
    candidate = renamedDuplicateVaultPath(path, attempt);
    attempt += 1;
  }
  occupied.add(vaultPathCollisionKey(candidate));
  return candidate;
}

function hexadecimal(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBackupBlob(blob: Blob) {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof FileReader !== "undefined") {
    return new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("첨부파일 백업 데이터를 읽지 못했습니다."));
      reader.onload = () => reader.result instanceof ArrayBuffer
        ? resolve(new Uint8Array(reader.result))
        : reject(new Error("첨부파일 백업 데이터 형식이 올바르지 않습니다."));
      reader.readAsArrayBuffer(blob);
    });
  }
  return new Uint8Array(await new Response(blob).arrayBuffer());
}

async function sha256(bytes: Uint8Array) {
  const digestSource = bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : Uint8Array.from(bytes).buffer;
  return hexadecimal(new Uint8Array(await crypto.subtle.digest("SHA-256", digestSource)));
}

function attachmentSortKey(attachment: NoteAttachmentSnapshot) {
  const fileName = typeof attachment.fileName === "string" ? attachment.fileName : "";
  return `${fileName.toLocaleLowerCase("en-US")}\u0000${attachment.id}`;
}

function backupAttachmentFileName(attachment: NoteAttachmentSnapshot, ordinal: number) {
  const unavailable = !attachment.fileName.trim()
    || (attachment as NoteAttachmentSnapshot & { fileNameDecryptionFailed?: boolean }).fileNameDecryptionFailed === true;
  return {
    fileName: attachmentDownloadName(unavailable
      ? { extension: attachment.extension, fileName: `attachment-${ordinal}` }
      : attachment),
    status: unavailable ? "fallback" as const : "available" as const
  };
}

function manifestJson(
  included: readonly VaultAttachmentBackupIncluded[],
  missing: readonly VaultAttachmentBackupMissing[],
  totalBytes: number,
  byteBudget: number
) {
  return `${JSON.stringify({
    version: 1,
    contentProtection: "decrypted-by-explicit-export",
    limits: {
      maximumAttachmentBytes: byteBudget,
      maximumSingleAttachmentBytes: MAX_VAULT_ATTACHMENT_BACKUP_ENTRY_BYTES
    },
    summary: {
      includedCount: included.length,
      includedBytes: totalBytes,
      missingCount: missing.length
    },
    included,
    missing
  }, null, 2)}\n`;
}

export async function collectVaultAttachmentBackup(
  notes: readonly VaultAttachmentBackupNote[],
  privateKey: CryptoKey,
  options: {
    byteBudget: number;
    dependencies?: Partial<VaultAttachmentBackupDependencies>;
    occupiedPaths?: readonly string[];
    signal?: AbortSignal;
  }
): Promise<VaultAttachmentBackupResult> {
  if (!Number.isSafeInteger(options.byteBudget) || options.byteBudget < 0) {
    throw new RangeError("첨부파일 백업 용량 제한이 올바르지 않습니다.");
  }
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const occupied = new Set((options.occupiedPaths ?? []).map(vaultPathCollisionKey));
  const included: VaultAttachmentBackupIncluded[] = [];
  const missing: VaultAttachmentBackupMissing[] = [];
  const sources: ObsidianVaultSourceEntry[] = [];
  let totalBytes = 0;

  for (const note of notes) {
    options.signal?.throwIfAborted();
    const notePath = normalizeVaultPath(note.path);
    let attachments: NoteAttachmentSnapshot[];
    try {
      attachments = await dependencies.getNoteAttachments(note.id);
      options.signal?.throwIfAborted();
    } catch {
      options.signal?.throwIfAborted();
      missing.push({ fileName: null, notePath, reason: "attachment-list-unavailable" });
      continue;
    }
    attachments.sort((left, right) => attachmentSortKey(left).localeCompare(attachmentSortKey(right), "en"));
    if (!attachments.length) continue;

    if (!note.wrappedKey) {
      attachments.forEach((attachment, index) => missing.push({
        fileName: backupAttachmentFileName(attachment, index + 1).fileName,
        notePath,
        reason: "missing-note-key"
      }));
      continue;
    }

    let noteKey: CryptoKey;
    try {
      noteKey = await dependencies.unwrapNoteKey(note.wrappedKey, privateKey);
      options.signal?.throwIfAborted();
    } catch {
      options.signal?.throwIfAborted();
      attachments.forEach((attachment, index) => missing.push({
        fileName: backupAttachmentFileName(attachment, index + 1).fileName,
        notePath,
        reason: "decryption-failed"
      }));
      continue;
    }

    try {
      attachments = await dependencies.decryptPrivateNoteAttachmentNames(
        attachments as PrivateNoteAttachmentSnapshot[],
        noteKey
      );
      attachments.sort((left, right) => attachmentSortKey(left).localeCompare(attachmentSortKey(right), "en"));
      options.signal?.throwIfAborted();
    } catch {
      options.signal?.throwIfAborted();
      attachments.forEach((attachment, index) => missing.push({
        fileName: backupAttachmentFileName(attachment, index + 1).fileName,
        notePath,
        reason: "decryption-failed"
      }));
      continue;
    }

    for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
      const attachment = attachments[attachmentIndex];
      options.signal?.throwIfAborted();
      const { fileName, status: fileNameStatus } = backupAttachmentFileName(attachment, attachmentIndex + 1);
      if (attachment.originalSize > MAX_VAULT_ATTACHMENT_BACKUP_ENTRY_BYTES) {
        missing.push({ fileName, notePath, reason: "entry-size-limit" });
        continue;
      }
      if (attachment.originalSize > options.byteBudget - totalBytes) {
        missing.push({ fileName, notePath, reason: "total-size-limit" });
        continue;
      }

      let plainBytes: Uint8Array | null = null;
      try {
        const encryptedSource = await dependencies.getEncryptedNoteAttachmentSource(attachment, options.signal);
        const blob = await dependencies.decryptAttachmentToBlob(
          attachment,
          noteKey,
          encryptedSource as EncryptedAttachmentSource,
          options.signal
        );
        options.signal?.throwIfAborted();
        if (blob.size !== attachment.originalSize) {
          missing.push({ fileName, notePath, reason: "size-mismatch" });
          continue;
        }
        const bytes = await readBackupBlob(blob);
        plainBytes = bytes;
        options.signal?.throwIfAborted();
        if (bytes.byteLength !== attachment.originalSize) {
          bytes.fill(0);
          missing.push({ fileName, notePath, reason: "size-mismatch" });
          continue;
        }
        const path = reserveUniquePath(`${attachmentFolderPath(notePath)}/${fileName}`, occupied);
        const digest = await sha256(bytes);
        options.signal?.throwIfAborted();
        const item: VaultAttachmentBackupIncluded = {
          byteLength: bytes.byteLength,
          fileName,
          fileNameStatus,
          mimeType: attachment.mimeType,
          notePath,
          path,
          sha256: digest
        };
        totalBytes += bytes.byteLength;
        included.push(item);
        sources.push({ content: bytes, kind: "asset", mimeType: attachment.mimeType, path });
        plainBytes = null;
      } catch {
        plainBytes?.fill(0);
        options.signal?.throwIfAborted();
        missing.push({ fileName, notePath, reason: "decryption-failed" });
      }
    }
  }

  const manifestPath = reserveUniquePath("QuickMemo-Attachments-Manifest.json", occupied);
  return {
    included,
    manifestSource: {
      content: manifestJson(included, missing, totalBytes, options.byteBudget),
      kind: "asset",
      mimeType: "application/json",
      path: manifestPath
    },
    missing,
    sources,
    totalBytes
  };
}
