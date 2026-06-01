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

export type DefaultHomeView = "notes" | "schedule";
export type ScheduleView = "todo" | "calendar" | "matrix" | "recurring" | "completed";
export type MatrixLabelKey = "todayOverdue" | "importantUrgent" | "urgent" | "important" | "waiting";
export type MatrixLabels = Record<MatrixLabelKey, string>;

export interface UserPreferencesDocument {
  uid: string;
  defaultHome: DefaultHomeView;
  matrixLabels: MatrixLabels;
  scheduleDefaultView: ScheduleView;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
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

export interface PublicSharePasswordHash {
  version: 1 | 2;
  algorithm: "PBKDF2-SHA-256";
  salt: string;
  iterations: number;
  hash: string;
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
  encryptedData?: Bytes;
  storagePath?: string;
  storageProvider?: "firebase-storage" | "vercel-blob";
  blobPath?: string;
  blobUrl?: string;
  blobDownloadUrl?: string;
  blobEtag?: string;
  encryptedSize?: number;
  isReady?: boolean;
  iv: Bytes;
  uploadedBy: string;
  createdAt?: Timestamp;
}

export interface PublicNoteShareDocument {
  sourceNoteId: string;
  ownerUid: string;
  version: 1;
  encryptedTitle: EncryptedPayload;
  encryptedBody: EncryptedPayload;
  ownerWrappedShareKey?: WrappedNoteKey;
  attachmentCount: number;
  passwordHash?: PublicSharePasswordHash;
  ready: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  expiresAt: Timestamp;
  revokedAt?: Timestamp;
  revokedBy?: string;
}

export interface PublicNoteShareAttachmentDocument {
  version: 1;
  algorithm: "AES-GCM";
  fileName: string;
  extension: string;
  mimeType: string;
  originalSize: number;
  encryptedData?: Bytes;
  storagePath?: string;
  storageProvider?: "firebase-storage" | "vercel-blob";
  blobPath?: string;
  blobUrl?: string;
  blobDownloadUrl?: string;
  blobEtag?: string;
  encryptedSize?: number;
  isReady?: boolean;
  iv: Bytes;
  ownerUid?: string;
  sourceAttachmentId?: string;
  expiresAt: Timestamp;
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

export type NoteHistoryAction = "create" | "content" | "share" | "delete" | "restore";

export interface NoteHistoryDocument {
  noteId: string;
  actorUid: string;
  action: NoteHistoryAction;
  changedFields: string[];
  readerUids?: string[];
  encryptedSummary?: EncryptedPayload;
  encryptedSnapshot?: EncryptedPayload;
  createdAt?: Timestamp;
}

export interface ActiveNoteDocument {
  uid: string;
  noteId: string | null;
  updatedByClientId: string;
  updatedAt?: Timestamp;
}

export type ScheduleTaskStatus = "active" | "completed";

export interface ScheduleChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface ScheduleTaskDetails {
  description: string;
  checklist: ScheduleChecklistItem[];
}

export interface ScheduleTaskDocument {
  ownerUid: string;
  status: ScheduleTaskStatus;
  dueDate: string | null;
  dueTimeMinutes: number | null;
  startDate?: string | null;
  endDate?: string | null;
  startTimeMinutes?: number | null;
  endTimeMinutes?: number | null;
  color?: string | null;
  sortOrder?: number | null;
  progressPercent?: number | null;
  isImportant: boolean;
  isUrgent: boolean;
  encryptedTitle: EncryptedPayload;
  encryptedDetails: EncryptedPayload;
  wrappedKeys: Record<string, WrappedNoteKey>;
  createdBy: string;
  updatedBy: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  completedAt?: Timestamp | null;
}

export interface DecryptedScheduleTask extends ScheduleTaskDocument {
  id: string;
  title: string;
  details: ScheduleTaskDetails;
}

export type RecurringHabitSlot = "morning" | "afternoon" | "other";
export type RecurringHabitIcon =
  | "work"
  | "study"
  | "reading"
  | "exercise"
  | "health"
  | "cleanup"
  | "review"
  | "other";
export type RecurringHabitStatus = "active" | "archived";

export interface RecurringHabitDetails {
  description: string;
  checklist: ScheduleChecklistItem[];
}

export interface RecurringHabitDocument {
  ownerUid: string;
  status: RecurringHabitStatus;
  slot: RecurringHabitSlot;
  icon: RecurringHabitIcon;
  color: string;
  sortOrder?: number | null;
  encryptedTitle: EncryptedPayload;
  encryptedDetails: EncryptedPayload;
  wrappedKeys: Record<string, WrappedNoteKey>;
  createdBy: string;
  updatedBy: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface DecryptedRecurringHabit extends RecurringHabitDocument {
  id: string;
  title: string;
  details: RecurringHabitDetails;
}

export interface RecurringHabitCheckInDocument {
  ownerUid: string;
  habitId: string;
  date: string;
  completed?: boolean;
  progressPercent?: number | null;
  checkedItemIds?: string[];
  checkedAt?: Timestamp | null;
  createdAt?: Timestamp;
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
