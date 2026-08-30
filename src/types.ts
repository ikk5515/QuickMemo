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
export type ActiveScheduleView = Extract<ScheduleView, "calendar" | "matrix">;
export type ScheduleTaskCategory = "work" | "personal";
export type ScheduleCategoryFilter = "all" | ScheduleTaskCategory;
export type ThemePreference = "light" | "dark" | "system";
export type MatrixLabelKey = "todayOverdue" | "importantUrgent" | "urgent" | "important" | "waiting";
export type MatrixLabels = Record<MatrixLabelKey, string>;

export interface UserPreferencesDocument {
  uid: string;
  defaultHome: DefaultHomeView;
  matrixLabels: MatrixLabels;
  scheduleDefaultCategory: ScheduleCategoryFilter;
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
export type SecureShareCopyState = "copying" | "active" | "aborted";
export type VaultEntryKind = "markdown" | "legacy-html" | "canvas" | "base" | "asset";
export type VaultContentFormat = "markdown-v1" | "legacy-html-v1" | "json-canvas-v1" | "base-v1" | "asset-v1";

export interface NoteDocument {
  type: NoteKind;
  ownerUid: string;
  participantUids: string[];
  encryptedTitle: EncryptedPayload;
  encryptedBody: EncryptedPayload;
  /** Missing on historical TipTap notes; absence is interpreted as legacy-html-v1. */
  contentFormat?: VaultContentFormat;
  /** Missing on historical notes; inferred from contentFormat. */
  entryKind?: VaultEntryKind;
  /** Opaque, parent-scoped HMAC reservation for versioned Vault entries. */
  vaultNameClaimId?: string;
  vaultNameIndexVersion?: 1;
  /** Opaque durable ZIP-import job binding; never contains a Vault path/name. */
  vaultImportJobId?: string;
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
  secureShareCopyState?: SecureShareCopyState;
  secureShareCopyJobId?: string;
  secureShareCopyExpectedAttachmentCount?: number;
  secureShareCopyReservedAttachmentCount?: number;
  secureShareCopyReadyAttachmentCount?: number;
  secureShareCopyStartedAt?: Timestamp;
  secureShareCopyUpdatedAt?: Timestamp;
  secureShareCopyFinishedAt?: Timestamp;
  secureShareCopyCleanupClaimId?: string;
  secureShareCopyCleanupClaimedAt?: Timestamp;
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
  privacyVersion?: 1;
  algorithm: "AES-GCM" | "AES-GCM-CHUNKED";
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
  uploadedBy: string;
  secureShareCopyJobId?: string;
  createdAt?: Timestamp;
}

export interface PublicNoteShareDocument {
  schemaVersion?: 1 | 2;
  sourceNoteId: string;
  sourceRevision?: number;
  sourceAttachmentRevision?: number;
  contentRevision?: number;
  ownerUid: string;
  version: 1 | 2;
  currentGeneration?: string;
  encryptedTitle: EncryptedPayload;
  encryptedBody: EncryptedPayload;
  ownerWrappedShareKey?: WrappedNoteKey;
  attachmentCount: number;
  passwordHash?: PublicSharePasswordHash;
  ready: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  contentUpdatedAt?: Timestamp;
  expiresAt: Timestamp;
  revokedAt?: Timestamp;
  revokedBy?: string;
}

export interface PublicNoteShareAttachmentDocument {
  version: 1 | 2;
  privacyVersion?: 1;
  algorithm: "AES-GCM" | "AES-GCM-CHUNKED";
  generation?: string;
  generations?: string[];
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
  sourceAttachmentDigest?: string;
  sourceEncryptionVersion?: 1 | 2;
  expiresAt: Timestamp;
  createdAt?: Timestamp;
}

export type SecureShareOwnerStatus = "active" | "consumed" | "expired" | "pending" | "revoked";

export interface SecureShareOwnerSummary {
  accessMode: "allowed_emails" | "anyone_with_link" | "authenticated_users";
  attachmentCount: number;
  contentRevision: number;
  consumedAt: string | null;
  createdAt: string;
  currentGeneration: string;
  downloadAllowed: boolean;
  expiresAt: string;
  hasPassword: boolean;
  lastAccessAt: string | null;
  oneTimeEnabled: boolean;
  ownerWrappedShareKey?: WrappedNoteKey;
  permissionLevel: "comment" | "save_copy" | "view";
  policyVersion: number;
  quickCopyButtonVisible: boolean;
  ready: boolean;
  requiresEmailVerification: boolean;
  showCommenterIpPrefix: boolean;
  revokedAt: string | null;
  schemaVersion: 2;
  shareId: string;
  sourceAttachmentRevision?: number;
  sourceNoteId: string;
  sourceRevision?: number;
  sourceSyncMode?: "revision_bound";
  status: SecureShareOwnerStatus;
  successfulAccessCount: number;
  updatedAt: string;
}

export interface NoteFolderDocument {
  ownerUid: string;
  name: string;
  color: string;
  /** Encrypted-vault folders keep only a generic legacy name in `name`. */
  encryptedName?: EncryptedPayload;
  wrappedKey?: WrappedNoteKey;
  parentId?: string | null;
  order?: number;
  revision?: number;
  /** Opaque, parent-scoped HMAC reservation for encrypted Vault folders. */
  vaultNameClaimId?: string;
  vaultNameIndexVersion?: 1;
  /** Opaque durable ZIP-import job binding; never contains a folder name. */
  vaultImportJobId?: string;
  /**
   * Server-verifiable root-to-parent ids. Rules compare every id with the
   * authoritative folder documents; this is never trusted as a client claim.
   */
  vaultAncestorIds?: string[];
  /** Slash-delimited opaque root-to-self proof copied from the direct parent. */
  vaultLineagePath?: string;
  vaultLineageDepth?: number;
  vaultLineageGeneration?: number;
  vaultLineageVersion?: 1 | 2 | 3;
  /**
   * A single encrypted-folder tombstone hides its complete descendant subtree.
   * Descendants are not rewritten, so very large trees remain one atomic write.
   */
  isDeleted?: boolean;
  deletedAt?: Timestamp;
  deletedBy?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface VaultIntegrityDocument {
  ownerUid: string;
  indexVersion: 1;
  wrappedKey: WrappedNoteKey;
  /** Missing on the original marker; absence is treated as a pending cutover. */
  cutoverState?: "pending" | "ready";
  /** Versioned independently from the blinded-name index format. */
  cutoverVersion?: 1;
  /** Server timestamp written only after the authoritative bulk seal succeeds. */
  verifiedAt?: Timestamp;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface VaultNameClaimDocument {
  ownerUid: string;
  indexVersion: 1;
  parentId: string | null;
  targetId: string;
  targetType: "entry" | "folder";
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
  category: ScheduleTaskCategory;
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
  encryptedCategory?: string;
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
