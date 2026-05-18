import type { Bytes, Timestamp } from "firebase/firestore";

export type UserRole = "admin" | "user";

export interface PublicRosterUser {
  uid: string;
  displayName: string;
  avatarText: string;
  color: string;
  order: number;
  quickKey: number;
  loginEmail: string;
  isActive: boolean;
  isAdmin: boolean;
}

export interface UserProfile extends PublicRosterUser {
  role: UserRole;
  publicKeyJwk: JsonWebKey;
  allowedShareTargetUids?: string[];
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  needsKeyRecovery?: boolean;
}

export interface EncryptedPayload {
  version: 1;
  algorithm: "AES-GCM";
  cipherText: string;
  iv: string;
}

export interface EncryptedBinaryPayload {
  version: 1;
  algorithm: "AES-GCM";
  cipherBytes: Uint8Array;
  iv: Uint8Array;
}

export interface WrappedNoteKey {
  version: 1;
  algorithm: "RSA-OAEP";
  wrappedKey: string;
}

export interface UserKeyDocument {
  uid: string;
  publicKeyJwk: JsonWebKey;
  encryptedPrivateKeyJwk: EncryptedPayload;
  kdfSalt: string;
  kdfIterations: number;
  pendingEncryptedPrivateKeyJwk?: EncryptedPayload;
  pendingKdfSalt?: string;
  pendingKdfIterations?: number;
  pendingCreatedAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type NoteKind = "personal" | "shared";

export interface NoteDocument {
  type: NoteKind;
  ownerUid: string;
  participantUids: string[];
  encryptedTitle: EncryptedPayload;
  encryptedBody: EncryptedPayload;
  wrappedKeys: Record<string, WrappedNoteKey>;
  folderId?: string | null;
  createdAt?: Timestamp;
  dueAt?: Timestamp | null;
  updatedAt?: Timestamp;
  updatedBy: string;
  savedAt?: Timestamp;
  isDeleted?: boolean;
  deletedAt?: Timestamp;
  deletedBy?: string;
  isPurged?: boolean;
  purgedAt?: Timestamp;
  purgedBy?: string;
}

export interface DecryptedNote extends NoteDocument {
  id: string;
  title: string;
  body: string;
}

export interface NoteAttachmentDocument {
  noteId: string;
  version: 1;
  algorithm: "AES-GCM";
  fileName: string;
  extension: string;
  mimeType: string;
  originalSize: number;
  encryptedData: Bytes;
  iv: Bytes;
  uploadedBy: string;
  createdAt?: Timestamp;
}

export interface NoteFolderDocument {
  ownerUid: string;
  name: string;
  color: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface NoteUserStateDocument {
  uid: string;
  noteId: string;
  isPinned?: boolean;
  readAt?: Timestamp;
  confirmedAt?: Timestamp;
  cursorOffset?: number | null;
  cursorVisible?: boolean;
  cursorClientId?: string;
  cursorUpdatedAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type NoteHistoryAction = "create" | "content" | "deadline" | "share" | "delete" | "restore";

export interface NoteHistoryDocument {
  noteId: string;
  actorUid: string;
  action: NoteHistoryAction;
  changedFields: string[];
  encryptedSummary?: EncryptedPayload;
  createdAt?: Timestamp;
}

export interface ActiveNoteDocument {
  uid: string;
  noteId: string | null;
  updatedByClientId: string;
  updatedAt?: Timestamp;
}

export interface UserKeyBundle {
  publicKeyJwk: JsonWebKey;
  encryptedPrivateKeyJwk: EncryptedPayload;
  kdfSalt: string;
  kdfIterations: number;
}

export interface NewUserPayload {
  displayName: string;
  avatarText: string;
  color: string;
  quickKey: number;
  password: string;
  isAdmin: boolean;
  allowedShareTargetUids?: string[];
  keyBundle: UserKeyBundle;
}
