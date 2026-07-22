import type { Bytes, Timestamp } from "firebase/firestore";

export type UserRole = "admin" | "user";
export type AppFeature = "notes" | "library" | "schedule";
export type FeatureAccess = Record<AppFeature, boolean>;

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
  featureAccess?: FeatureAccess;
  allowedShareTargetUids?: string[];
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  needsKeyRecovery?: boolean;
}

export type DefaultHomeView = "notes" | "library" | "schedule";
export type ScheduleView = "todo" | "calendar" | "matrix" | "recurring" | "completed";
export type ThemePreference = "light" | "dark" | "system";
export type MatrixLabelKey = "todayOverdue" | "importantUrgent" | "urgent" | "important" | "waiting";
export type MatrixLabels = Record<MatrixLabelKey, string>;

export interface UserPreferencesDocument {
  uid: string;
  defaultHome: DefaultHomeView;
  matrixLabels: MatrixLabels;
  scheduleDefaultView: ScheduleView;
  theme: ThemePreference;
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
  revision?: number;
  lastMutationId?: string;
  attachmentRevision?: number;
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
  version: 1 | 2;
  algorithm: "AES-GCM" | "AES-GCM-CHUNKED";
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
  quotaReserved?: boolean;
  isReady?: boolean;
  iv?: Bytes;
  chunkSize?: number;
  chunkCount?: number;
  chunkIvs?: Bytes[];
  uploadedBy: string;
  createdAt?: Timestamp;
}

export interface PublicNoteShareDocument {
  sourceNoteId: string;
  sourceRevision?: number;
  sourceAttachmentRevision?: number;
  ownerUid: string;
  version: 1;
  currentGeneration?: string;
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
  version: 1 | 2;
  privacyVersion?: 1;
  algorithm: "AES-GCM" | "AES-GCM-CHUNKED";
  generation?: string;
  fileName: string;
  encryptedFileName?: EncryptedPayload;
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
  quotaReserved?: boolean;
  isReady?: boolean;
  iv?: Bytes;
  chunkSize?: number;
  chunkCount?: number;
  chunkIvs?: Bytes[];
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
  revision?: number;
  createdAt?: Timestamp;
}

export interface ActiveNoteDocument {
  uid: string;
  noteId: string | null;
  updatedByClientId: string;
  updatedAt?: Timestamp;
}

export type LibraryItemKind = "link" | "clip" | "attachment";
export type LibraryItemStatus = "inbox" | "reading" | "archived";
export type LibraryCaptureSource = "manual" | "browser-extension" | "bookmarklet" | "attachment-ocr";
export type LibraryReaderBlockKind = "heading" | "paragraph" | "quote" | "list-item" | "code";
export type LibraryHighlightColor = "yellow" | "green" | "blue" | "pink";

export interface LibraryReaderBlock {
  id: string;
  kind: LibraryReaderBlockKind;
  text: string;
}

export interface LibraryHighlight {
  id: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  note: string;
  color: LibraryHighlightColor;
  createdAt: string;
}

export interface LibraryItemContent {
  version: 1;
  title: string;
  url: string;
  description: string;
  siteName: string;
  collection: string;
  tags: string[];
  selectionText: string;
  readerBlocks: LibraryReaderBlock[];
  highlights: LibraryHighlight[];
  ocrText: string;
  sourceFileName: string;
  archivedAt: string | null;
}

export interface LibraryVaultDocument {
  ownerUid: string;
  wrappedKey: WrappedNoteKey;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface LibraryItemDocument {
  ownerUid: string;
  generationId: string;
  kind: LibraryItemKind;
  status: LibraryItemStatus;
  captureSource: LibraryCaptureSource;
  isFavorite: boolean;
  encryptedContent: EncryptedPayload;
  wrappedKeys: Record<string, WrappedNoteKey>;
  urlFingerprint: string | null;
  sourceNoteId: string | null;
  sourceAttachmentId: string | null;
  revision: number;
  lastMutationId: string;
  reviewCount: number;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  lastOpenedAt?: Timestamp | null;
  lastReviewedAt?: Timestamp | null;
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
  calendarUpdatedAt?: Timestamp;
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
  featureAccess?: FeatureAccess;
  allowedShareTargetUids?: string[];
  keyBundle: UserKeyBundle;
}
