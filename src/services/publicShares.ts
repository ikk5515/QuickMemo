import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  type Unsubscribe,
  writeBatch,
  where
} from "firebase/firestore";
import { maxEncryptedAttachmentBytes } from "../lib/attachments";
import { encryptedAttachmentSizeLimit, type AttachmentEncryptionMetadata, type EncryptedAttachmentSource } from "../lib/attachmentCrypto";
import { db } from "../lib/firebase";
import { getLegacyStorageBytes } from "../lib/legacyFirebaseStorage";
import { buildSecureShareUrl } from "../lib/secureShareUrl";
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
export const publicNoteShareMaxAttachmentCount = 100;
const legacyOwnerShareListenerLimit = 500;

export interface PublicNoteShareSnapshot extends PublicNoteShareDocument {
  id: string;
}

export interface PublicNoteShareAttachmentSnapshot extends PublicNoteShareAttachmentDocument {
  id: string;
  shareId: string;
}

interface CreatePublicNoteShareInput {
  currentGeneration: string;
  encryptedBody: EncryptedPayload;
  encryptedTitle: EncryptedPayload;
  expiresAt: Date;
  ownerUid: string;
  ownerWrappedShareKey: WrappedNoteKey;
  passwordHash?: PublicSharePasswordHash;
  sourceNoteId: string;
  sourceAttachmentRevision: number;
  sourceRevision: number;
}

interface CreatePublicNoteShareAttachmentInput {
  encryptedBlob: Blob;
  encryptedFileName: EncryptedPayload;
  encryption: AttachmentEncryptionMetadata;
  expiresAt: Date;
  extension: string;
  generation: string;
  mimeType: string;
  onUploadProgress?: BlobAttachmentUploadProgressHandler;
  ownerUid: string;
  originalSize: number;
  sourceAttachmentId?: string;
  sourceAttachmentDigest?: string;
  sourceEncryptionVersion?: 1 | 2;
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
  currentGeneration?: string;
  encryptedBody: EncryptedPayload;
  encryptedTitle: EncryptedPayload;
  passwordHash: PublicSharePasswordHash | null;
  sourceAttachmentRevision: number;
  sourceRevision: number;
}

function publicShareSnapshot(id: string, data: PublicNoteShareDocument): PublicNoteShareSnapshot {
  return { id, ...data };
}

/**
 * Secure Share v2 documents are server-authoritative. Legacy browser code must
 * never mutate or clean them through the Firestore client SDK.
 */
export function isLegacyPublicNoteShare(
  share: Pick<PublicNoteShareDocument, "schemaVersion" | "version">
) {
  return share.schemaVersion !== 2 && share.version === 1;
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

export function publicShareActive(
  share: Pick<PublicNoteShareDocument, "expiresAt" | "ready" | "revokedAt" | "schemaVersion" | "version">,
  now = Date.now()
) {
  return isLegacyPublicNoteShare(share)
    && share.ready === true
    && !share.revokedAt
    && timestampMillis(share.expiresAt) > now;
}

export function publicShareExpiresAt() {
  return new Date(Date.now() + publicNoteShareMaxAgeMs);
}

export function createPublicShareGeneration() {
  const randomValue =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now()}${Math.random().toString(36).slice(2)}`;

  return `gen_${randomValue.slice(0, 48)}`;
}

export function publicShareUrl(
  shareId: string,
  shareKey: string,
  origin = window.location.origin,
  compactEnabled?: boolean
) {
  return buildSecureShareUrl(shareId, shareKey, origin, compactEnabled);
}

function publicShareCleanupQueueRef(shareId: string) {
  return doc(db, "publicShareCleanupQueue", shareId);
}

async function requireLegacyPublicNoteShare(shareId: string) {
  const share = await getPublicNoteShare(shareId);

  if (!share) {
    throw new Error("보안 공유는 서버 API에서만 변경할 수 있습니다.");
  }

  return share;
}

export function subscribePublicSharesForOwner(
  ownerUid: string,
  callback: (shares: PublicNoteShareSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const sharesQuery = query(
    collection(db, "publicNoteShares"),
    where("ownerUid", "==", ownerUid),
    where("version", "==", 1),
    where("ready", "==", true),
    where("expiresAt", ">", Timestamp.now()),
    orderBy("expiresAt", "asc"),
    limit(legacyOwnerShareListenerLimit)
  );

  return onSnapshot(
    sharesQuery,
    (snapshot) => {
      callback(
        snapshot.docs
          .map((document) => publicShareSnapshot(document.id, document.data() as PublicNoteShareDocument))
          .filter(isLegacyPublicNoteShare)
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
      if (!snapshot.exists()) {
        callback(null);
        return;
      }

      const share = publicShareSnapshot(snapshot.id, snapshot.data() as PublicNoteShareDocument);
      callback(isLegacyPublicNoteShare(share) ? share : null);
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
    sourceAttachmentRevision: input.sourceAttachmentRevision,
    sourceRevision: input.sourceRevision,
    ownerUid: input.ownerUid,
    version: 1,
    currentGeneration: input.currentGeneration,
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
      encryptedFileName: input.encryptedFileName,
      generation: input.generation,
      shareId,
      extension: input.extension,
      mimeType: input.mimeType,
      originalSize: input.originalSize,
      encryptedBlob: input.encryptedBlob,
      encryption: input.encryption,
      onUploadProgress: input.onUploadProgress,
      sourceAttachmentId: input.sourceAttachmentId,
      sourceAttachmentDigest: input.sourceAttachmentDigest,
      sourceEncryptionVersion: input.sourceEncryptionVersion
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

  return getLegacyStorageBytes(attachment.storagePath, maxEncryptedAttachmentBytes);
}

export async function getEncryptedPublicShareAttachmentSource(
  attachment: StoredPublicShareAttachmentDocument,
  signal?: AbortSignal
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
        encryptedAttachmentSizeLimit(attachment),
        signal
      )
    };
  }

  if (!attachment.storagePath) {
    throw new Error("공유 첨부파일 암호문 위치를 찾을 수 없습니다.");
  }

  return {
    bytes: await getLegacyStorageBytes(attachment.storagePath, maxEncryptedAttachmentBytes)
  };
}

async function deletePublicShareAttachmentStorageObjects(attachments: PublicNoteShareAttachmentSnapshot[]) {
  for (const attachment of attachments) {
    await deleteBlobAttachment({ scope: "publicShare", shareId: attachment.shareId, attachmentId: attachment.id });
  }
}

export async function activatePublicNoteShare(shareId: string, attachmentCount: number, currentGeneration: string) {
  await requireLegacyPublicNoteShare(shareId);
  await updateDoc(doc(db, "publicNoteShares", shareId), {
    attachmentCount,
    currentGeneration,
    ready: true,
    updatedAt: serverTimestamp()
  });
}

export async function updatePublicNoteShareContent(shareId: string, input: UpdatePublicNoteShareContentInput) {
  await requireLegacyPublicNoteShare(shareId);
  await updateDoc(doc(db, "publicNoteShares", shareId), {
    attachmentCount: input.attachmentCount,
    ...(input.currentGeneration ? { currentGeneration: input.currentGeneration } : {}),
    encryptedTitle: input.encryptedTitle,
    encryptedBody: input.encryptedBody,
    passwordHash: input.passwordHash ?? deleteField(),
    sourceAttachmentRevision: input.sourceAttachmentRevision,
    sourceRevision: input.sourceRevision,
    updatedAt: serverTimestamp()
  });
}

export async function revokePublicNoteShare(shareId: string, ownerUid: string) {
  await requireLegacyPublicNoteShare(shareId);
  await updateDoc(doc(db, "publicNoteShares", shareId), {
    revokedAt: serverTimestamp(),
    revokedBy: ownerUid,
    updatedAt: serverTimestamp()
  });
}

export async function deletePublicNoteShare(shareId: string) {
  await requireLegacyPublicNoteShare(shareId);
  const attachmentsSnapshot = await getDocs(collection(db, "publicNoteShares", shareId, "attachments"));
  const attachments = attachmentsSnapshot.docs.map((document) =>
    publicShareAttachmentSnapshot(document.id, document.data() as PublicNoteShareAttachmentDocument, shareId)
  );
  const batch = writeBatch(db);

  await deletePublicShareAttachmentStorageObjects(attachments);
  batch.delete(doc(db, "publicNoteShares", shareId));

  await batch.commit();
}

export async function deletePublicNoteShareAttachments(shareId: string, generation?: string | null) {
  await requireLegacyPublicNoteShare(shareId);

  const attachmentsSnapshot = await getDocs(collection(db, "publicNoteShares", shareId, "attachments"));

  if (attachmentsSnapshot.empty) {
    return;
  }

  const attachmentDocuments = attachmentsSnapshot.docs.filter((document) => {
    if (typeof generation === "undefined") {
      return true;
    }

    const attachmentGeneration = (document.data() as PublicNoteShareAttachmentDocument).generation;
    return generation === null ? typeof attachmentGeneration === "undefined" : attachmentGeneration === generation;
  });
  const attachments = attachmentDocuments.map((document) =>
    publicShareAttachmentSnapshot(document.id, document.data() as PublicNoteShareAttachmentDocument, shareId)
  );
  await deletePublicShareAttachmentStorageObjects(attachments);
}

export async function getPublicNoteShare(shareId: string) {
  const snapshot = await getDoc(doc(db, "publicNoteShares", shareId));

  if (!snapshot.exists()) {
    return null;
  }

  const share = publicShareSnapshot(snapshot.id, snapshot.data() as PublicNoteShareDocument);
  return isLegacyPublicNoteShare(share) ? share : null;
}

export async function getPublicNoteShareAttachments(shareId: string, currentGeneration?: string) {
  if (!currentGeneration) {
    return [];
  }

  const share = await getPublicNoteShare(shareId);

  if (!share) {
    return [];
  }

  const attachmentsCollection = collection(db, "publicNoteShares", shareId, "attachments");
  const snapshot = await getDocs(query(
    attachmentsCollection,
    where("generation", "==", currentGeneration),
    where("privacyVersion", "==", 1)
  ));

  return snapshot.docs
    .map((document) => publicShareAttachmentSnapshot(document.id, document.data() as PublicNoteShareAttachmentDocument, shareId))
    .filter((attachment) => attachment.isReady !== false)
    .filter((attachment) => attachment.generation === currentGeneration && attachment.privacyVersion === 1)
    .sort((left, right) => timestampMillis(left.createdAt) - timestampMillis(right.createdAt));
}

export async function getOwnerPublicNoteShareAttachments(shareId: string, currentGeneration: string) {
  const share = await getPublicNoteShare(shareId);

  if (!share) {
    return [];
  }

  const attachmentsCollection = collection(db, "publicNoteShares", shareId, "attachments");
  const snapshot = await getDocs(
    query(attachmentsCollection, where("generation", "==", currentGeneration))
  );

  return snapshot.docs
    .map((document) => publicShareAttachmentSnapshot(document.id, document.data() as PublicNoteShareAttachmentDocument, shareId))
    .filter((attachment) => attachment.isReady !== false)
    .filter((attachment) => attachment.generation === currentGeneration)
    .sort((left, right) => timestampMillis(left.createdAt) - timestampMillis(right.createdAt));
}

export async function deleteUploadedPublicShareAttachment(shareId: string, attachmentId: string) {
  await deleteBlobAttachment({ scope: "publicShare", shareId, attachmentId });
}
