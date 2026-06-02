import type { PutBlobResult } from "@vercel/blob";
import { put } from "@vercel/blob/client";
import { maxEncryptedAttachmentBytes } from "../lib/attachments";
import { auth } from "../lib/firebase";

const blobAttachmentApiPath = "/api/blob-attachments";
const blobContentType = "application/octet-stream";

export type BlobAttachmentScope = "note" | "publicShare";

export interface BlobAttachmentUploadProgress {
  loaded: number;
  percentage: number;
  total: number;
}

export type BlobAttachmentUploadProgressHandler = (progress: BlobAttachmentUploadProgress) => void;

interface BaseBlobAttachmentUploadInput {
  encryptedData: Uint8Array;
  extension: string;
  fileName: string;
  iv: Uint8Array;
  mimeType: string;
  onUploadProgress?: BlobAttachmentUploadProgressHandler;
  originalSize: number;
}

export interface NoteBlobAttachmentUploadInput extends BaseBlobAttachmentUploadInput {
  attachmentId: string;
  noteId: string;
  uploadedBy: string;
}

export interface PublicShareBlobAttachmentUploadInput extends BaseBlobAttachmentUploadInput {
  attachmentId: string;
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

function bytesToBlob(bytes: Uint8Array) {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return new Blob([bytes.buffer], { type: blobContentType });
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: blobContentType });
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

async function completeBlobAttachmentUpload(input: CompletedBlobAttachmentUploadInput, idToken: string) {
  const response = await fetch(blobAttachmentApiPath, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...authHeaders(idToken)
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : "첨부파일 업로드 완료 처리를 하지 못했습니다.");
  }
}

async function cancelBlobAttachmentUpload(input: DeleteBlobAttachmentInput, idToken: string) {
  await fetch(blobAttachmentApiPath, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...authHeaders(idToken)
    },
    body: JSON.stringify(input)
  }).catch(() => undefined);
}

async function requestBlobClientToken(pathname: string, clientPayload: string, idToken: string) {
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
  const idToken = await currentUserIdToken();
  const pathname = noteBlobPath(input);
  const payload = {
    scope: "note",
    attachmentId: input.attachmentId,
    noteId: input.noteId,
    fileName: input.fileName,
    extension: input.extension,
    mimeType: input.mimeType,
    originalSize: input.originalSize,
    encryptedSize: input.encryptedData.byteLength,
    ivBase64: bytesToBase64(input.iv),
    uploadedBy: input.uploadedBy
  };
  let hasReservation = false;

  try {
    const clientPayload = JSON.stringify(payload);
    const token = await requestBlobClientToken(pathname, clientPayload, idToken);
    hasReservation = true;
    const blob = await put(pathname, bytesToBlob(input.encryptedData), {
      access: "private",
      contentType: blobContentType,
      multipart: true,
      onUploadProgress: input.onUploadProgress,
      token
    });

    await completeBlobAttachmentUpload({ scope: "note", noteId: input.noteId, attachmentId: input.attachmentId, blob }, idToken);

    return blob;
  } catch (error) {
    if (hasReservation) {
      await cancelBlobAttachmentUpload({ scope: "note", noteId: input.noteId, attachmentId: input.attachmentId }, idToken);
    }
    throw error;
  }
}

export async function uploadPublicShareAttachmentBlob(
  input: PublicShareBlobAttachmentUploadInput,
  ownerUid: string
) {
  const idToken = await currentUserIdToken();
  const pathname = publicShareBlobPath({ ...input, ownerUid });
  const payload = {
    scope: "publicShare",
    attachmentId: input.attachmentId,
    shareId: input.shareId,
    fileName: input.fileName,
    extension: input.extension,
    mimeType: input.mimeType,
    originalSize: input.originalSize,
    encryptedSize: input.encryptedData.byteLength,
    ivBase64: bytesToBase64(input.iv),
    sourceAttachmentId: input.sourceAttachmentId ?? null
  };
  let hasReservation = false;

  try {
    const clientPayload = JSON.stringify(payload);
    const token = await requestBlobClientToken(pathname, clientPayload, idToken);
    hasReservation = true;
    const blob = await put(pathname, bytesToBlob(input.encryptedData), {
      access: "private",
      contentType: blobContentType,
      multipart: true,
      onUploadProgress: input.onUploadProgress,
      token
    });

    await completeBlobAttachmentUpload(
      { scope: "publicShare", shareId: input.shareId, attachmentId: input.attachmentId, blob },
      idToken
    );

    return blob;
  } catch (error) {
    if (hasReservation) {
      await cancelBlobAttachmentUpload({ scope: "publicShare", shareId: input.shareId, attachmentId: input.attachmentId }, idToken);
    }
    throw error;
  }
}

export async function fetchBlobAttachmentBytes(input: {
  attachmentId: string;
  noteId?: string;
  scope: BlobAttachmentScope;
  shareId?: string;
}) {
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
  } else {
    if (!input.shareId) {
      throw new Error("공유 첨부파일 정보를 찾을 수 없습니다.");
    }

    query.set("shareId", input.shareId);
  }

  const response = await fetch(`${blobAttachmentApiPath}?${query.toString()}`, {
    headers
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : "첨부파일 암호문을 불러오지 못했습니다.");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.byteLength > maxEncryptedAttachmentBytes) {
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
