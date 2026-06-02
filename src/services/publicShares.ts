import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  type Unsubscribe,
  writeBatch,
  where
} from "firebase/firestore";
import { deleteObject, getBytes, ref } from "firebase/storage";
import { maxEncryptedAttachmentBytes } from "../lib/attachments";
import { encryptedAttachmentSizeLimit, type AttachmentEncryptionMetadata, type EncryptedAttachmentSource } from "../lib/attachmentCrypto";
import { db, storage } from "../lib/firebase";
import {
  deleteBlobAttachment,
  fetchBlobAttachmentBytes,
  fetchBlobAttachmentResponse,
  uploadPublicShareAttachmentBlob,
  type BlobAttachmentUploadProgressHandler
} from "./blobAttachments";
import type {
  EncryptedPayload,
  PublicNoteShareAttachmentDocument,
  PublicNoteShareDocument,
  PublicSharePasswordHash,
  WrappedNoteKey
} from "../types";

export const publicNoteShareMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

export interface PublicNoteShareSnapshot extends PublicNoteShareDocument {
  id: string;
}

export interface PublicNoteShareAttachmentSnapshot extends PublicNoteShareAttachmentDocument {
  id: string;
  shareId: string;
}

interface CreatePublicNoteShareInput {
  encryptedBody: EncryptedPayload;
  encryptedTitle: EncryptedPayload;
  expiresAt: Date;
  ownerUid: string;
  ownerWrappedShareKey: WrappedNoteKey;
  passwordHash?: PublicSharePasswordHash;
  sourceNoteId: string;
}

interface CreatePublicNoteShareAttachmentInput {
  encryptedBlob: Blob;
  encryption: AttachmentEncryptionMetadata;
  expiresAt: Date;
  extension: string;
  fileName: string;
  mimeType: string;
  onUploadProgress?: BlobAttachmentUploadProgressHandler;
  ownerUid: string;
  originalSize: number;
  sourceAttachmentId?: string;
}

type StoredPublicShareAttachmentDocument = Pick<
  PublicNoteShareAttachmentDocument,
  | "algorithm"
  | "blobPath"
  | "chunkCount"
  | "chunkIvs"
  | "chunkSize"
  | "encryptedData"
  | "encryptedSize"
  | "iv"
  | "originalSize"
  | "storagePath"
  | "version"
> & {
  id?: string;
  shareId?: string;
};

interface UpdatePublicNoteShareContentInput {
  attachmentCount: number;
  encryptedBody: EncryptedPayload;
  encryptedTitle: EncryptedPayload;
  passwordHash: PublicSharePasswordHash | null;
}

function publicShareSnapshot(id: string, data: PublicNoteShareDocument): PublicNoteShareSnapshot {
  return { id, ...data };
}

function publicShareAttachmentSnapshot(
  id: string,
  data: PublicNoteShareAttachmentDocument,
  shareId: string
): PublicNoteShareAttachmentSnapshot {
  return { id, shareId, ...data };
}

function timestampMillis(value: PublicNoteShareDocument["createdAt"]) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : 0;
}

export function publicShareActive(share: Pick<PublicNoteShareDocument, "expiresAt" | "ready" | "revokedAt">, now = Date.now()) {
  return share.ready === true && !share.revokedAt && timestampMillis(share.expiresAt) > now;
}

export function publicShareExpiresAt() {
  return new Date(Date.now() + publicNoteShareMaxAgeMs);
}

export function publicShareUrl(shareId: string, shareKey: string, origin = window.location.origin) {
  return `${origin}/share/${encodeURIComponent(shareId)}#key=${encodeURIComponent(shareKey)}`;
}

function publicShareCleanupQueueRef(shareId: string) {
  return doc(db, "publicShareCleanupQueue", shareId);
}

export function subscribePublicSharesForNote(
  sourceNoteId: string,
  ownerUid: string,
  callback: (shares: PublicNoteShareSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const sharesQuery = query(collection(db, "publicNoteShares"), where("ownerUid", "==", ownerUid));

  return onSnapshot(
    sharesQuery,
    (snapshot) => {
      callback(
        snapshot.docs
          .map((document) => publicShareSnapshot(document.id, document.data() as PublicNoteShareDocument))
          .filter((share) => share.sourceNoteId === sourceNoteId)
          .sort((left, right) => timestampMillis(right.createdAt) - timestampMillis(left.createdAt))
      );
    },
    (error) => onError?.(error)
  );
}

export function subscribePublicSharesForOwner(
  ownerUid: string,
  callback: (shares: PublicNoteShareSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const sharesQuery = query(collection(db, "publicNoteShares"), where("ownerUid", "==", ownerUid));

  return onSnapshot(
    sharesQuery,
    (snapshot) => {
      callback(
        snapshot.docs
          .map((document) => publicShareSnapshot(document.id, document.data() as PublicNoteShareDocument))
          .sort((left, right) => timestampMillis(right.createdAt) - timestampMillis(left.createdAt))
      );
    },
    (error) => onError?.(error)
  );
}

export function subscribePublicNoteShare(
  shareId: string,
  callback: (share: PublicNoteShareSnapshot | null) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, "publicNoteShares", shareId),
    (snapshot) => {
      callback(snapshot.exists() ? publicShareSnapshot(snapshot.id, snapshot.data() as PublicNoteShareDocument) : null);
    },
    (error) => onError?.(error)
  );
}

export async function createPublicNoteShare(input: CreatePublicNoteShareInput) {
  const shareRef = doc(collection(db, "publicNoteShares"));
  const cleanupRef = publicShareCleanupQueueRef(shareRef.id);
  const expiresAt = Timestamp.fromDate(input.expiresAt);
  const batch = writeBatch(db);

  batch.set(shareRef, {
    sourceNoteId: input.sourceNoteId,
    ownerUid: input.ownerUid,
    version: 1,
    encryptedTitle: input.encryptedTitle,
    encryptedBody: input.encryptedBody,
    ownerWrappedShareKey: input.ownerWrappedShareKey,
    attachmentCount: 0,
    ...(input.passwordHash ? { passwordHash: input.passwordHash } : {}),
    ready: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    expiresAt
  } satisfies Omit<PublicNoteShareDocument, "createdAt" | "updatedAt"> & {
    createdAt: ReturnType<typeof serverTimestamp>;
    updatedAt: ReturnType<typeof serverTimestamp>;
  });
  batch.set(cleanupRef, {
    shareId: shareRef.id,
    expiresAt,
    createdAt: serverTimestamp()
  });

  await batch.commit();

  return shareRef.id;
}

export async function createPublicNoteShareAttachment(shareId: string, input: CreatePublicNoteShareAttachmentInput) {
  const attachmentRef = doc(collection(db, "publicNoteShares", shareId, "attachments"));

  await uploadPublicShareAttachmentBlob(
    {
      attachmentId: attachmentRef.id,
      shareId,
      fileName: input.fileName,
      extension: input.extension,
      mimeType: input.mimeType,
      originalSize: input.originalSize,
      encryptedBlob: input.encryptedBlob,
      encryption: input.encryption,
      onUploadProgress: input.onUploadProgress,
      sourceAttachmentId: input.sourceAttachmentId
    },
    input.ownerUid
  );

  return attachmentRef;
}

export async function getEncryptedPublicShareAttachmentBytes(attachment: StoredPublicShareAttachmentDocument) {
  if (attachment.encryptedData) {
    return attachment.encryptedData.toUint8Array();
  }

  if (attachment.blobPath) {
    if (!attachment.id || !attachment.shareId) {
      throw new Error("공유 첨부파일 식별자를 찾을 수 없습니다.");
    }

    return fetchBlobAttachmentBytes(
      { scope: "publicShare", shareId: attachment.shareId, attachmentId: attachment.id },
      encryptedAttachmentSizeLimit(attachment)
    );
  }

  if (!attachment.storagePath) {
    throw new Error("공유 첨부파일 암호문 위치를 찾을 수 없습니다.");
  }

  return new Uint8Array(await getBytes(ref(storage, attachment.storagePath), maxEncryptedAttachmentBytes));
}

export async function getEncryptedPublicShareAttachmentSource(
  attachment: StoredPublicShareAttachmentDocument
): Promise<EncryptedAttachmentSource> {
  if (attachment.encryptedData) {
    return { bytes: attachment.encryptedData.toUint8Array() };
  }

  if (attachment.blobPath) {
    if (!attachment.id || !attachment.shareId) {
      throw new Error("공유 첨부파일 식별자를 찾을 수 없습니다.");
    }

    return {
      response: await fetchBlobAttachmentResponse(
        { scope: "publicShare", shareId: attachment.shareId, attachmentId: attachment.id },
        encryptedAttachmentSizeLimit(attachment)
      )
    };
  }

  if (!attachment.storagePath) {
    throw new Error("공유 첨부파일 암호문 위치를 찾을 수 없습니다.");
  }

  return { bytes: new Uint8Array(await getBytes(ref(storage, attachment.storagePath), maxEncryptedAttachmentBytes)) };
}

async function deleteStorageObjectIfPresent(storagePath: string) {
  try {
    await deleteObject(ref(storage, storagePath));
  } catch (error) {
    if (!storageObjectNotFound(error)) {
      throw error;
    }
  }
}

function storageObjectNotFound(error: unknown) {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "storage/object-not-found"
  );
}

async function deletePublicShareAttachmentStorageObjects(attachments: PublicNoteShareAttachmentSnapshot[]) {
  for (const attachment of attachments) {
    if (attachment.blobPath) {
      await deleteBlobAttachment({ scope: "publicShare", shareId: attachment.shareId, attachmentId: attachment.id });
      continue;
    }

    if (attachment.storagePath) {
      await deleteStorageObjectIfPresent(attachment.storagePath);
    }
  }
}

export async function activatePublicNoteShare(shareId: string, attachmentCount: number) {
  await updateDoc(doc(db, "publicNoteShares", shareId), {
    attachmentCount,
    ready: true,
    updatedAt: serverTimestamp()
  });
}

export async function updatePublicNoteShareContent(shareId: string, input: UpdatePublicNoteShareContentInput) {
  await updateDoc(doc(db, "publicNoteShares", shareId), {
    attachmentCount: input.attachmentCount,
    encryptedTitle: input.encryptedTitle,
    encryptedBody: input.encryptedBody,
    passwordHash: input.passwordHash ?? deleteField(),
    updatedAt: serverTimestamp()
  });
}

export async function revokePublicNoteShare(shareId: string, ownerUid: string) {
  await updateDoc(doc(db, "publicNoteShares", shareId), {
    revokedAt: serverTimestamp(),
    revokedBy: ownerUid,
    updatedAt: serverTimestamp()
  });
}

export async function deletePublicNoteShare(shareId: string) {
  const attachmentsSnapshot = await getDocs(collection(db, "publicNoteShares", shareId, "attachments"));
  const attachments = attachmentsSnapshot.docs.map((document) =>
    publicShareAttachmentSnapshot(document.id, document.data() as PublicNoteShareAttachmentDocument, shareId)
  );
  const blobAttachmentIds = new Set(attachments.filter((attachment) => attachment.blobPath).map((attachment) => attachment.id));
  const batch = writeBatch(db);

  await deletePublicShareAttachmentStorageObjects(attachments);

  attachmentsSnapshot.docs.forEach((attachment) => {
    if (!blobAttachmentIds.has(attachment.id)) {
      batch.delete(attachment.ref);
    }
  });
  batch.delete(doc(db, "publicNoteShares", shareId));

  await batch.commit();
}

export async function deletePublicNoteShareAttachments(shareId: string) {
  const attachmentsSnapshot = await getDocs(collection(db, "publicNoteShares", shareId, "attachments"));

  if (attachmentsSnapshot.empty) {
    return;
  }

  const attachments = attachmentsSnapshot.docs.map((document) =>
    publicShareAttachmentSnapshot(document.id, document.data() as PublicNoteShareAttachmentDocument, shareId)
  );
  const blobAttachmentIds = new Set(attachments.filter((attachment) => attachment.blobPath).map((attachment) => attachment.id));
  const batch = writeBatch(db);
  let hasDocumentDeletes = false;

  await deletePublicShareAttachmentStorageObjects(attachments);

  attachmentsSnapshot.docs.forEach((attachment) => {
    if (!blobAttachmentIds.has(attachment.id)) {
      batch.delete(attachment.ref);
      hasDocumentDeletes = true;
    }
  });

  if (hasDocumentDeletes) {
    await batch.commit();
  }
}

export async function deleteExpiredPublicSharesForOwner(ownerUid: string, now = Date.now()) {
  const sharesQuery = query(collection(db, "publicNoteShares"), where("ownerUid", "==", ownerUid));
  const snapshot = await getDocs(sharesQuery);
  const staleShares = snapshot.docs
    .map((document) => publicShareSnapshot(document.id, document.data() as PublicNoteShareDocument))
    .filter((share) => Boolean(share.revokedAt) || timestampMillis(share.expiresAt) <= now);

  await Promise.all(staleShares.map((share) => deletePublicNoteShare(share.id)));

  return staleShares.length;
}

export async function getPublicNoteShare(shareId: string) {
  const snapshot = await getDoc(doc(db, "publicNoteShares", shareId));

  return snapshot.exists() ? publicShareSnapshot(snapshot.id, snapshot.data() as PublicNoteShareDocument) : null;
}

export async function getPublicNoteShareAttachments(shareId: string) {
  const snapshot = await getDocs(collection(db, "publicNoteShares", shareId, "attachments"));

  return snapshot.docs
    .map((document) => publicShareAttachmentSnapshot(document.id, document.data() as PublicNoteShareAttachmentDocument, shareId))
    .filter((attachment) => attachment.isReady !== false)
    .sort((left, right) => timestampMillis(left.createdAt) - timestampMillis(right.createdAt));
}
