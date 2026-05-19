import {
  addDoc,
  Bytes,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  where
} from "firebase/firestore";
import { db } from "../lib/firebase";
import type { EncryptedPayload, PublicNoteShareAttachmentDocument, PublicNoteShareDocument } from "../types";

export const publicNoteShareMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

export interface PublicNoteShareSnapshot extends PublicNoteShareDocument {
  id: string;
}

export interface PublicNoteShareAttachmentSnapshot extends PublicNoteShareAttachmentDocument {
  id: string;
}

interface CreatePublicNoteShareInput {
  encryptedBody: EncryptedPayload;
  encryptedTitle: EncryptedPayload;
  expiresAt: Date;
  ownerUid: string;
  sourceNoteId: string;
}

interface CreatePublicNoteShareAttachmentInput {
  encryptedData: Uint8Array;
  expiresAt: Date;
  extension: string;
  fileName: string;
  iv: Uint8Array;
  mimeType: string;
  originalSize: number;
  sourceAttachmentId?: string;
}

function publicShareSnapshot(id: string, data: PublicNoteShareDocument): PublicNoteShareSnapshot {
  return { id, ...data };
}

function publicShareAttachmentSnapshot(
  id: string,
  data: PublicNoteShareAttachmentDocument
): PublicNoteShareAttachmentSnapshot {
  return { id, ...data };
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

export function subscribePublicSharesForNote(
  sourceNoteId: string,
  ownerUid: string,
  callback: (shares: PublicNoteShareSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const sharesQuery = query(
    collection(db, "publicNoteShares"),
    where("ownerUid", "==", ownerUid),
    where("sourceNoteId", "==", sourceNoteId)
  );

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

export async function createPublicNoteShare(input: CreatePublicNoteShareInput) {
  const shareRef = doc(collection(db, "publicNoteShares"));

  await setDoc(shareRef, {
    sourceNoteId: input.sourceNoteId,
    ownerUid: input.ownerUid,
    version: 1,
    encryptedTitle: input.encryptedTitle,
    encryptedBody: input.encryptedBody,
    attachmentCount: 0,
    ready: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    expiresAt: Timestamp.fromDate(input.expiresAt)
  } satisfies Omit<PublicNoteShareDocument, "createdAt" | "updatedAt"> & {
    createdAt: ReturnType<typeof serverTimestamp>;
    updatedAt: ReturnType<typeof serverTimestamp>;
  });

  return shareRef.id;
}

export async function createPublicNoteShareAttachment(shareId: string, input: CreatePublicNoteShareAttachmentInput) {
  return addDoc(collection(db, "publicNoteShares", shareId, "attachments"), {
    version: 1,
    algorithm: "AES-GCM",
    fileName: input.fileName,
    extension: input.extension,
    mimeType: input.mimeType,
    originalSize: input.originalSize,
    encryptedData: Bytes.fromUint8Array(input.encryptedData),
    iv: Bytes.fromUint8Array(input.iv),
    ...(input.sourceAttachmentId ? { sourceAttachmentId: input.sourceAttachmentId } : {}),
    expiresAt: Timestamp.fromDate(input.expiresAt),
    createdAt: serverTimestamp()
  } satisfies Omit<PublicNoteShareAttachmentDocument, "createdAt"> & {
    createdAt: ReturnType<typeof serverTimestamp>;
  });
}

export async function activatePublicNoteShare(shareId: string, attachmentCount: number) {
  await updateDoc(doc(db, "publicNoteShares", shareId), {
    attachmentCount,
    ready: true,
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
  const batch = writeBatch(db);

  attachmentsSnapshot.docs.forEach((attachment) => {
    batch.delete(attachment.ref);
  });
  batch.delete(doc(db, "publicNoteShares", shareId));

  await batch.commit();
}

export async function getPublicNoteShare(shareId: string) {
  const snapshot = await getDoc(doc(db, "publicNoteShares", shareId));

  return snapshot.exists() ? publicShareSnapshot(snapshot.id, snapshot.data() as PublicNoteShareDocument) : null;
}

export async function getPublicNoteShareAttachments(shareId: string) {
  const snapshot = await getDocs(collection(db, "publicNoteShares", shareId, "attachments"));

  return snapshot.docs
    .map((document) => publicShareAttachmentSnapshot(document.id, document.data() as PublicNoteShareAttachmentDocument))
    .sort((left, right) => timestampMillis(left.createdAt) - timestampMillis(right.createdAt));
}
