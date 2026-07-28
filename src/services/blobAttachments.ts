import type { PutBlobResult } from "@vercel/blob";
import { put } from "@vercel/blob/client";
import { encryptedAttachmentSizeLimit, type AttachmentEncryptionMetadata } from "../lib/attachmentCrypto";
import { auth } from "../lib/firebase";
import type { EncryptedPayload } from "../types";

const blobAttachmentApiPath = "/api/blob-attachments";
const blobContentType = "application/octet-stream";
const cancelBlobAttachmentUploadAttempts = 2;

export type BlobAttachmentScope = "note" | "publicShare";

export interface BlobAttachmentUploadProgress {
  loaded: number;
  percentage: number;
  total: number;
}

export type BlobAttachmentUploadProgressHandler = (progress: BlobAttachmentUploadProgress) => void;

interface BaseBlobAttachmentUploadInput {
  encryptedBlob: Blob;
  encryption: AttachmentEncryptionMetadata;
  extension: string;
  mimeType: string;
  onUploadProgress?: BlobAttachmentUploadProgressHandler;
  originalSize: number;
  signal?: AbortSignal;
}

export interface NoteBlobAttachmentUploadInput extends BaseBlobAttachmentUploadInput {
  attachmentId: string;
  fileName: string;
  noteId: string;
  secureShareCopyJobId?: string;
  uploadedBy: string;
}

export interface PublicShareBlobAttachmentUploadInput extends BaseBlobAttachmentUploadInput {
  attachmentId: string;
  encryptedFileName: EncryptedPayload;
  generation: string;
  shareId: string;
  sourceAttachmentId?: string;
}

interface CompletedBlobAttachmentUploadInput {
  attachmentId: string;
  blob: PutBlobResult;
  noteId?: string;
  scope: BlobAttachmentScope;
  shareId?: string;
}

interface DeleteBlobAttachmentInput {
  attachmentId: string;
  noteId?: string;
  scope: BlobAttachmentScope;
  shareId?: string;
}

export class BlobAttachmentReservationCleanupError extends Error {
  readonly attachmentId: string;
  readonly cleanupError: unknown;
  readonly code = "blob/reservation-cleanup-failed";
  readonly noteId?: string;
  readonly scope: BlobAttachmentScope;
  readonly shareId?: string;
  readonly uploadError: unknown;

  constructor(
    input: DeleteBlobAttachmentInput,
    uploadError: unknown,
    cleanupError: unknown
  ) {
    super("첨부파일 업로드 예약 정리를 완료하지 못했습니다.", {
      cause: uploadError
    });
    this.name = "BlobAttachmentReservationCleanupError";
    this.attachmentId = input.attachmentId;
    this.cleanupError = cleanupError;
    this.noteId = input.noteId;
    this.scope = input.scope;
    this.shareId = input.shareId;
    this.uploadError = uploadError;
  }
}

interface BlobClientTokenResponse {
  clientToken?: string;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
}

function authHeaders(idToken: string) {
  return { authorization: `Bearer ${idToken}` };
}

async function currentUserIdToken() {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("첨부파일 작업을 위해 다시 로그인해주세요.");
  }

  return user.getIdToken();
}

function noteBlobPath(input: Pick<NoteBlobAttachmentUploadInput, "attachmentId" | "noteId" | "uploadedBy">) {
  return `users/${input.uploadedBy}/notes/${input.noteId}/attachments/${input.attachmentId}/data`;
}

function publicShareBlobPath(input: Pick<PublicShareBlobAttachmentUploadInput, "attachmentId" | "shareId"> & { ownerUid: string }) {
  return `users/${input.ownerUid}/publicNoteShares/${input.shareId}/attachments/${input.attachmentId}/data`;
}

export function publicShareGenericAttachmentBaseName(extension: string) {
  const safeExtension = extension.trim().toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 10) || "file";
  return `shared-${safeExtension}-attachment`;
}

function encryptionPayloadFields(encryption: AttachmentEncryptionMetadata) {
  if (encryption.version === 1) {
    return {
      algorithm: encryption.algorithm,
      encryptedSize: encryption.encryptedSize,
      ivBase64: bytesToBase64(encryption.iv),
      version: encryption.version
    };
  }

  return {
    algorithm: encryption.algorithm,
    chunkCount: encryption.chunkCount,
    chunkIvBase64List: encryption.chunkIvs.map((iv) => bytesToBase64(iv)),
    chunkSize: encryption.chunkSize,
    encryptedSize: encryption.encryptedSize,
    version: encryption.version
  };
}

async function completeBlobAttachmentUpload(
  input: CompletedBlobAttachmentUploadInput,
  idToken: string,
  signal?: AbortSignal
) {
  const response = await fetch(blobAttachmentApiPath, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...authHeaders(idToken)
    },
    body: JSON.stringify(input),
    signal
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : "첨부파일 업로드 완료 처리를 하지 못했습니다.");
  }
}

async function cancelBlobAttachmentUpload(input: DeleteBlobAttachmentInput, idToken: string) {
  let lastError: unknown;

  for (let attempt = 0; attempt < cancelBlobAttachmentUploadAttempts; attempt += 1) {
    try {
      const response = await fetch(blobAttachmentApiPath, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          ...authHeaders(idToken)
        },
        body: JSON.stringify(input)
      });

      if (response.ok) {
        return;
      }

      const body = await response.json().catch(() => ({}));
      lastError = new Error(
        typeof body.error === "string"
          ? body.error
          : "첨부파일 업로드 예약을 정리하지 못했습니다."
      );
    } catch (caught) {
      lastError = caught;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("첨부파일 업로드 예약을 정리하지 못했습니다.");
}

async function requestBlobClientToken(
  pathname: string,
  clientPayload: string,
  idToken: string
) {
  const response = await fetch(blobAttachmentApiPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(idToken)
    },
    body: JSON.stringify({
      type: "blob.generate-client-token",
      payload: {
        pathname,
        clientPayload,
        multipart: true
      }
    })
  });
  const body = await response.json().catch(() => ({})) as BlobClientTokenResponse & { error?: unknown };

  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "첨부파일 업로드 권한을 받지 못했습니다.");
  }

  if (typeof body.clientToken !== "string" || !body.clientToken) {
    throw new Error("첨부파일 업로드 토큰을 받지 못했습니다.");
  }

  return body.clientToken;
}

export async function uploadNoteAttachmentBlob(input: NoteBlobAttachmentUploadInput) {
  throwIfRequestAborted(input.signal);
  const idToken = await currentUserIdToken();
  throwIfRequestAborted(input.signal);
  const pathname = noteBlobPath(input);
  const payload = {
    scope: "note",
    attachmentId: input.attachmentId,
    noteId: input.noteId,
    fileName: input.fileName,
    extension: input.extension,
    mimeType: input.mimeType,
    originalSize: input.originalSize,
    secureShareCopyJobId: input.secureShareCopyJobId ?? null,
    uploadedBy: input.uploadedBy,
    ...encryptionPayloadFields(input.encryption)
  };
  let hasReservation = false;

  try {
    const clientPayload = JSON.stringify(payload);
    // Token issuance reserves quota server-side. Let that response settle so a
    // cancellation can release the reservation deterministically.
    const token = await requestBlobClientToken(pathname, clientPayload, idToken);
    hasReservation = true;
    throwIfRequestAborted(input.signal);
    const blob = await put(pathname, input.encryptedBlob, {
      access: "private",
      abortSignal: input.signal,
      contentType: blobContentType,
      multipart: true,
      onUploadProgress: input.onUploadProgress,
      token
    });

    await completeBlobAttachmentUpload(
      { scope: "note", noteId: input.noteId, attachmentId: input.attachmentId, blob },
      idToken,
      input.signal
    );

    return blob;
  } catch (error) {
    if (hasReservation) {
      const cleanupTarget = {
        scope: "note" as const,
        noteId: input.noteId,
        attachmentId: input.attachmentId
      };

      try {
        await cancelBlobAttachmentUpload(cleanupTarget, idToken);
      } catch (cleanupError) {
        throw new BlobAttachmentReservationCleanupError(
          cleanupTarget,
          error,
          cleanupError
        );
      }
    }
    throw error;
  }
}

export async function uploadPublicShareAttachmentBlob(
  input: PublicShareBlobAttachmentUploadInput,
  ownerUid: string
) {
  throwIfRequestAborted(input.signal);
  const idToken = await currentUserIdToken();
  throwIfRequestAborted(input.signal);
  const pathname = publicShareBlobPath({ ...input, ownerUid });
  const payload = {
    scope: "publicShare",
    attachmentId: input.attachmentId,
    generation: input.generation,
    shareId: input.shareId,
    fileName: publicShareGenericAttachmentBaseName(input.extension),
    encryptedFileName: input.encryptedFileName,
    extension: input.extension,
    mimeType: input.mimeType,
    originalSize: input.originalSize,
    sourceAttachmentId: input.sourceAttachmentId ?? null,
    ...encryptionPayloadFields(input.encryption)
  };
  let hasReservation = false;

  try {
    const clientPayload = JSON.stringify(payload);
    const token = await requestBlobClientToken(pathname, clientPayload, idToken);
    hasReservation = true;
    throwIfRequestAborted(input.signal);
    const blob = await put(pathname, input.encryptedBlob, {
      access: "private",
      abortSignal: input.signal,
      contentType: blobContentType,
      multipart: true,
      onUploadProgress: input.onUploadProgress,
      token
    });

    await completeBlobAttachmentUpload(
      { scope: "publicShare", shareId: input.shareId, attachmentId: input.attachmentId, blob },
      idToken,
      input.signal
    );

    return blob;
  } catch (error) {
    if (hasReservation) {
      const cleanupTarget = {
        scope: "publicShare" as const,
        shareId: input.shareId,
        attachmentId: input.attachmentId
      };

      try {
        await cancelBlobAttachmentUpload(cleanupTarget, idToken);
      } catch (cleanupError) {
        throw new BlobAttachmentReservationCleanupError(
          cleanupTarget,
          error,
          cleanupError
        );
      }
    }
    throw error;
  }
}

interface FetchBlobAttachmentInput {
  attachmentId: string;
  noteId?: string;
  scope: BlobAttachmentScope;
  shareId?: string;
}

function throwIfRequestAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("첨부파일 요청이 취소되었습니다.", "AbortError");
  }
}

async function blobAttachmentFetch(input: FetchBlobAttachmentInput, signal?: AbortSignal) {
  throwIfRequestAborted(signal);
  const query = new URLSearchParams({
    attachmentId: input.attachmentId,
    scope: input.scope
  });
  const headers: Record<string, string> = {};

  if (input.scope === "note") {
    if (!input.noteId) {
      throw new Error("첨부파일 노트 정보를 찾을 수 없습니다.");
    }

    query.set("noteId", input.noteId);
    Object.assign(headers, authHeaders(await currentUserIdToken()));
    throwIfRequestAborted(signal);
  } else {
    if (!input.shareId) {
      throw new Error("공유 첨부파일 정보를 찾을 수 없습니다.");
    }

    query.set("shareId", input.shareId);
  }

  const response = await fetch(`${blobAttachmentApiPath}?${query.toString()}`, {
    headers,
    signal
  });

  return response;
}

export async function fetchBlobAttachmentResponse(
  input: FetchBlobAttachmentInput,
  maxBytes: number,
  signal?: AbortSignal
) {
  const response = await blobAttachmentFetch(input, signal);

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : "첨부파일 암호문을 불러오지 못했습니다.");
  }

  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("첨부파일 암호문이 허용 크기를 초과했습니다.");
  }

  return response;
}

export async function fetchBlobAttachmentBytes(
  input: FetchBlobAttachmentInput,
  maxBytes = encryptedAttachmentSizeLimit({ version: 1, algorithm: "AES-GCM" }),
  signal?: AbortSignal
) {
  const response = await fetchBlobAttachmentResponse(input, maxBytes, signal);
  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.byteLength > maxBytes) {
    throw new Error("첨부파일 암호문이 허용 크기를 초과했습니다.");
  }

  return bytes;
}

export async function deleteBlobAttachment(input: DeleteBlobAttachmentInput) {
  const idToken = await currentUserIdToken();
  const response = await fetch(blobAttachmentApiPath, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...authHeaders(idToken)
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : "첨부파일을 삭제하지 못했습니다.");
  }
}
