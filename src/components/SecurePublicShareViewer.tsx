import {
  Check,
  Copy,
  Download,
  Eye,
  File,
  Loader2,
  LockKeyhole,
  LogIn,
  MessageCircle,
  Pencil,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  X
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent
} from "react";
import {
  attachmentDownloadName,
  formatFileSize,
  isAllowedAttachmentExtension,
  isPublicShareRasterImageExtension,
  maxAttachmentFileBytes,
  maxAttachmentPreviewBytes,
  publicShareAttachmentMimeMatchesExtension,
  safePublicShareAttachmentMimeType
} from "../lib/attachments";
import {
  decryptAttachmentToBlob,
  decryptAttachmentToBytes,
  type AttachmentCryptoDocument
} from "../lib/attachmentCrypto";
import { decryptText, importAesKeyBase64Url } from "../lib/crypto";
import {
  linkifyEditorHtml,
  parseEditorContent,
  previewTextFromHtml,
  sanitizeEditorHtml,
  serializeEditorContent
} from "../lib/editorContent";
import {
  decodeTextAttachmentPreview,
  legacyBinaryPreviewAttachmentExtensions,
  legacyBinaryPreviewMessage,
  previewableAttachmentExtensions,
  textPreviewAttachmentExtensions,
  type PublicAttachmentPreviewState
} from "../lib/publicAttachmentPreview";
import { safeRasterImageBytes } from "../lib/safeRasterImage";
import {
  SecureShareApiError,
  createSecureShareComment,
  deleteSecureShareComment,
  getSecureShareAttachmentDownload,
  getSecureShareAttachmentForCopy,
  getSecureShareAttachmentPreview,
  getSecureShareContent,
  getSecureShareMetadata,
  getSecureShareParticipant,
  listSecureShareComments,
  normalizeSecureShareParticipantDisplayName,
  parseSecureShareIpPrefix,
  refreshSecureShareSession,
  renameSecureShareParticipant,
  requestSecureShareCopyGrant,
  requestSecureShareEmailChallenge,
  unlockSecureShare,
  type SecureShareParticipantDto
} from "../services/secureShares";
import type { EncryptedPayload } from "../types";

const PublicAttachmentPreviewModal = lazy(() => import("./PublicAttachmentPreviewModal"));

const shareIdentifierPattern = /^[A-Za-z0-9_-]{6,128}$/u;
const contentKeyPattern = /^[A-Za-z0-9_-]{43}$/u;
const otpPattern = /^\d{6}$/u;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const accessModes = new Set(["anyone_with_link", "allowed_emails", "authenticated_users"]);
const permissionLevels = new Set(["view", "comment", "save_copy"]);
const commentBadges = new Set(["guest", "email_verified", "quickmemo_user", "owner", "admin"]);
const commentDateFormatter = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short"
});
const previewExtensions = new Set([
  ...previewableAttachmentExtensions,
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif"
]);

type SecureShareViewerPhase =
  | "access"
  | "loading"
  | "loading_content"
  | "ready"
  | "unavailable";

interface SecureShareViewerLifecycle {
  contentKey: string;
  generation: number;
  idToken?: string;
  isAuthenticated: boolean;
  shareId: string;
  signal?: AbortSignal;
}

export interface SecurePublicShareViewerProps {
  contentKey: string;
  idToken?: string;
  isAuthenticated: boolean;
  onRequireLogin: () => void;
  onSaveCopy?: (payload: SecurePublicShareCopyPayload) => Promise<void> | void;
  shareId: string;
}

export interface SecureShareViewerMetadataDto {
  accessMode: "allowed_emails" | "anyone_with_link" | "authenticated_users";
  emailChallengeRequired: boolean;
  hasPassword: boolean;
  oneTimeEnabled: boolean;
  oneTimeScope: "global";
  ownerPreview: boolean;
  requiresAuthentication: boolean;
  requiresEmailVerification: boolean;
  requiresPassword: boolean;
  schemaVersion: 2;
}

export interface SecurePublicShareCapabilities {
  canComment: boolean;
  canSaveCopy: boolean;
  downloadAllowed: boolean;
  permissionLevel: "comment" | "save_copy" | "view";
  quickCopyButtonVisible: boolean;
}

export interface SecureShareViewerCapabilities extends SecurePublicShareCapabilities {
  commentIpPrefixEnabled: boolean;
  participantIdentityEnabled: boolean;
  participantLimitReached: boolean;
}

export interface SecureShareViewerSessionDto {
  capabilities: SecureShareViewerCapabilities;
  ownerPreview: boolean;
  sessionExpiresAt: string;
}

export interface SecurePublicShareAttachmentMetadata {
  encryption: AttachmentCryptoDocument;
  extension: string;
  fileName: string;
  id: string;
  mimeType: string;
  originalSize: number;
  previewAllowed: boolean;
}

export interface SecureShareViewerContentDto {
  attachments: unknown[];
  encryptedBody: EncryptedPayload;
  encryptedTitle: EncryptedPayload;
  schemaVersion: 2;
}

export interface SecurePublicShareCopyPayload {
  attachments: SecurePublicShareAttachmentMetadata[];
  body: string;
  bodyHtml: string;
  capabilities: SecurePublicShareCapabilities;
  copyAttachment: (
    attachment: SecurePublicShareAttachmentMetadata,
    signal?: AbortSignal
  ) => Promise<Blob>;
  copyGrantExpiresAt: string;
  title: string;
}

interface DecryptedSecureShareContent {
  attachments: SecurePublicShareAttachmentMetadata[];
  body: string;
  bodyHtml: string;
  bodyPlainText: string;
  fontSize: number;
  title: string;
}

interface SecureShareComment {
  authorParticipantId?: string;
  badge: "admin" | "email_verified" | "guest" | "owner" | "quickmemo_user";
  body: string;
  canDelete: boolean;
  createdAt: string;
  displayName: string;
  id: string;
  ipPrefix?: string;
}

interface InternalAttachment extends SecurePublicShareAttachmentMetadata {
  encryptedFileName: EncryptedPayload;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeString(value: unknown, maximumLength: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength
    ? value
    : null;
}

function unicodeLength(value: string) {
  return Array.from(value).length;
}

function safeUnicodeString(value: unknown, maximumLength: number) {
  return typeof value === "string"
    && value.length > 0
    && unicodeLength(value) <= maximumLength
    ? value
    : null;
}

function safeDateString(value: unknown) {
  const text = safeString(value, 64);
  const date = text ? new Date(text) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseEncryptedPayload(value: unknown): EncryptedPayload | null {
  if (!isPlainRecord(value)) {
    return null;
  }

  const cipherText = safeString(value.cipherText, 32 * 1024 * 1024);
  const iv = safeString(value.iv, 128);

  if (
    value.version !== 1
    || value.algorithm !== "AES-GCM"
    || !cipherText
    || !iv
    || !base64Pattern.test(cipherText)
    || !base64Pattern.test(iv)
  ) {
    return null;
  }

  return {
    version: 1,
    algorithm: "AES-GCM",
    cipherText,
    iv
  };
}

function base64Bytes(value: unknown, expectedLength: number) {
  if (typeof value !== "string" || value.length > 128 || !base64Pattern.test(value)) {
    return null;
  }

  try {
    const decoded = atob(value);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    return bytes.byteLength === expectedLength ? bytes : null;
  } catch {
    return null;
  }
}

function parseAttachmentEncryption(
  value: Record<string, unknown>,
  originalSize: number
): AttachmentCryptoDocument | null {
  const encryptedSize = value.encryptedSize;

  if (
    typeof encryptedSize !== "number"
    || !Number.isSafeInteger(encryptedSize)
    || encryptedSize <= originalSize
  ) {
    return null;
  }

  if (value.version === 1 && value.algorithm === "AES-GCM") {
    const iv = base64Bytes(value.iv, 12);

    if (!iv || encryptedSize !== originalSize + 16) {
      return null;
    }
    return {
      version: 1,
      algorithm: "AES-GCM",
      encryptedSize,
      iv,
      originalSize
    };
  }

  if (value.version === 2 && value.algorithm === "AES-GCM-CHUNKED") {
    const chunkSize = value.chunkSize;
    const chunkCount = value.chunkCount;
    const rawChunkIvs = value.chunkIvs;

    if (
      typeof chunkSize !== "number"
      || !Number.isSafeInteger(chunkSize)
      || chunkSize <= 0
      || chunkSize > 4 * 1024 * 1024
      || typeof chunkCount !== "number"
      || !Number.isSafeInteger(chunkCount)
      || chunkCount !== Math.ceil(originalSize / chunkSize)
      || !Array.isArray(rawChunkIvs)
      || rawChunkIvs.length !== chunkCount
      || encryptedSize !== originalSize + chunkCount * 16
    ) {
      return null;
    }

    const chunkIvs = rawChunkIvs.map((iv) => base64Bytes(iv, 12));

    if (chunkIvs.some((iv) => !iv)) {
      return null;
    }

    return {
      version: 2,
      algorithm: "AES-GCM-CHUNKED",
      chunkSize,
      chunkCount,
      chunkIvs: chunkIvs as Uint8Array[],
      encryptedSize,
      originalSize
    };
  }

  return null;
}

function parseMetadataDto(value: unknown): SecureShareViewerMetadataDto | null {
  if (
    !isPlainRecord(value)
    || value.ok !== true
    || !safeString(value.requestId, 128)
    || !isPlainRecord(value.metadata)
  ) {
    return null;
  }

  const metadata = value.metadata;
  const accessMode = metadata.accessMode;
  const hasPassword = metadata.hasPassword;
  const requiresPassword = metadata.requiresPassword;
  const requiresEmailVerification = metadata.requiresEmailVerification;
  const emailChallengeRequired = metadata.emailChallengeRequired;
  const requiresAuthentication = metadata.requiresAuthentication;
  const oneTimeEnabled = metadata.oneTimeEnabled;
  const ownerPreview = metadata.ownerPreview;

  if (
    metadata.schemaVersion !== 2
    || typeof accessMode !== "string"
    || !accessModes.has(accessMode)
    || typeof hasPassword !== "boolean"
    || typeof requiresPassword !== "boolean"
    || hasPassword !== requiresPassword
    || typeof requiresEmailVerification !== "boolean"
    || typeof emailChallengeRequired !== "boolean"
    || typeof requiresAuthentication !== "boolean"
    || requiresAuthentication !== (accessMode === "authenticated_users")
    || typeof oneTimeEnabled !== "boolean"
    || metadata.oneTimeScope !== "global"
    || typeof ownerPreview !== "boolean"
    || emailChallengeRequired !== (
      requiresEmailVerification && accessMode !== "authenticated_users"
    )
    || (accessMode === "allowed_emails" && (!requiresEmailVerification || !emailChallengeRequired))
  ) {
    return null;
  }

  return {
    schemaVersion: 2,
    accessMode: accessMode as SecureShareViewerMetadataDto["accessMode"],
    hasPassword,
    requiresPassword,
    requiresEmailVerification,
    emailChallengeRequired,
    requiresAuthentication,
    oneTimeEnabled,
    oneTimeScope: "global",
    ownerPreview
  };
}

function parseSessionDto(value: unknown): SecureShareViewerSessionDto | null {
  if (
    !isPlainRecord(value)
    || value.ok !== true
    || !safeString(value.requestId, 128)
    || !isPlainRecord(value.capabilities)
  ) {
    return null;
  }

  const capabilities = value.capabilities;
  const permissionLevel = capabilities.permissionLevel;
  const sessionExpiresAt = safeDateString(value.sessionExpiresAt);
  const participantIdentityEnabled =
    capabilities.participantIdentityEnabled === undefined
      ? false
      : capabilities.participantIdentityEnabled;
  const commentIpPrefixEnabled =
    capabilities.commentIpPrefixEnabled === undefined
      ? false
      : capabilities.commentIpPrefixEnabled;
  const participantLimitReached =
    capabilities.participantLimitReached === undefined
      ? false
      : capabilities.participantLimitReached;

  if (
    typeof permissionLevel !== "string"
    || !permissionLevels.has(permissionLevel)
    || typeof capabilities.canComment !== "boolean"
    || typeof capabilities.canSaveCopy !== "boolean"
    || typeof capabilities.downloadAllowed !== "boolean"
    || typeof capabilities.quickCopyButtonVisible !== "boolean"
    || typeof participantIdentityEnabled !== "boolean"
    || typeof commentIpPrefixEnabled !== "boolean"
    || typeof participantLimitReached !== "boolean"
    || typeof value.ownerPreview !== "boolean"
    || !sessionExpiresAt
    || (participantIdentityEnabled && permissionLevel !== "comment")
    || (
      commentIpPrefixEnabled
      && (
        permissionLevel !== "comment"
        || (!value.ownerPreview && !participantIdentityEnabled)
      )
    )
    || (
      participantLimitReached
      && (!participantIdentityEnabled || capabilities.canComment)
    )
    || (
      value.ownerPreview
      && (
        participantIdentityEnabled
        || participantLimitReached
      )
    )
    || (
      value.ownerPreview
        ? capabilities.canComment !== true || capabilities.canSaveCopy !== false
        : (
          capabilities.canComment !== (
            permissionLevel === "comment" && !participantLimitReached
          )
          || capabilities.canSaveCopy !== (permissionLevel === "save_copy")
        )
    )
  ) {
    return null;
  }

  return {
    capabilities: {
      permissionLevel: permissionLevel as SecurePublicShareCapabilities["permissionLevel"],
      canComment: capabilities.canComment,
      canSaveCopy: capabilities.canSaveCopy,
      commentIpPrefixEnabled,
      downloadAllowed: capabilities.downloadAllowed,
      participantIdentityEnabled,
      participantLimitReached,
      quickCopyButtonVisible: capabilities.quickCopyButtonVisible
    },
    ownerPreview: value.ownerPreview,
    sessionExpiresAt
  };
}

function parseInternalAttachment(value: unknown): InternalAttachment | null {
  if (!isPlainRecord(value)) {
    return null;
  }

  const id = safeString(value.id, 128);
  const extension = typeof value.extension === "string"
    ? value.extension.toLowerCase()
    : "";
  const mimeType = typeof value.mimeType === "string"
    ? value.mimeType.toLowerCase()
    : "";
  const originalSize = value.originalSize;
  const encryptedFileName = parseEncryptedPayload(value.encryptedFileName);

  if (
    !id
    || !shareIdentifierPattern.test(id)
    || !isAllowedAttachmentExtension(extension)
    || !publicShareAttachmentMimeMatchesExtension(extension, mimeType)
    || typeof originalSize !== "number"
    || !Number.isSafeInteger(originalSize)
    || originalSize <= 0
    || originalSize > maxAttachmentFileBytes
    || typeof value.previewAllowed !== "boolean"
    || !encryptedFileName
  ) {
    return null;
  }

  const encryption = parseAttachmentEncryption(value, originalSize);

  if (!encryption) {
    return null;
  }

  return {
    id,
    encryptedFileName,
    encryption,
    extension,
    fileName: "",
    mimeType,
    originalSize,
    previewAllowed: value.previewAllowed
  };
}

function parseContentDto(value: unknown) {
  if (
    !isPlainRecord(value)
    || value.ok !== true
    || !safeString(value.requestId, 128)
    || value.schemaVersion !== 2
    || !Array.isArray(value.attachments)
    || value.attachments.length > 200
  ) {
    return null;
  }

  const encryptedTitle = parseEncryptedPayload(value.encryptedTitle);
  const encryptedBody = parseEncryptedPayload(value.encryptedBody);
  const attachments = value.attachments.map(parseInternalAttachment);

  if (!encryptedTitle || !encryptedBody || attachments.some((attachment) => !attachment)) {
    return null;
  }

  return {
    schemaVersion: 2 as const,
    encryptedTitle,
    encryptedBody,
    attachments: attachments as InternalAttachment[]
  };
}

function parseEmailChallengeDto(value: unknown) {
  if (
    !isPlainRecord(value)
    || value.ok !== true
    || !safeString(value.requestId, 128)
  ) {
    return null;
  }

  const challengeId = safeString(value.challengeId, 128);
  const resendAfterSeconds = value.resendAfterSeconds;

  if (
    !challengeId
    || !shareIdentifierPattern.test(challengeId)
    || typeof resendAfterSeconds !== "number"
    || !Number.isSafeInteger(resendAfterSeconds)
    || resendAfterSeconds < 1
    || resendAfterSeconds > 3_600
  ) {
    return null;
  }

  return { challengeId, resendAfterSeconds };
}

function parseCommentsDto(value: unknown, allowIpPrefix = false) {
  if (
    !isPlainRecord(value)
    || !hasOnlyKeys(value, ["ok", "items", "nextCursor", "requestId"])
    || value.ok !== true
    || !safeString(value.requestId, 128)
    || !Array.isArray(value.items)
    || value.items.length > 20
  ) {
    return null;
  }

  const items: SecureShareComment[] = [];

  for (const rawItem of value.items) {
    if (!isPlainRecord(rawItem)) {
      return null;
    }
    if (!hasOnlyKeys(rawItem, [
      "id",
      "displayName",
      "badge",
      "body",
      "createdAt",
      "canDelete",
      "authorParticipantId",
      "ipPrefix"
    ])) {
      return null;
    }

    const id = safeString(rawItem.id, 128);
    const body = safeUnicodeString(rawItem.body, 2_000);
    const displayName = safeUnicodeString(rawItem.displayName, 72);
    const createdAt = safeDateString(rawItem.createdAt);
    const badge = rawItem.badge;
    const authorParticipantId = Object.prototype.hasOwnProperty.call(
      rawItem,
      "authorParticipantId"
    )
      ? safeString(rawItem.authorParticipantId, 128)
      : undefined;
    const ipPrefix = Object.prototype.hasOwnProperty.call(rawItem, "ipPrefix")
      ? parseSecureShareIpPrefix(rawItem.ipPrefix)
      : undefined;

    if (
      !id
      || !shareIdentifierPattern.test(id)
      || !body
      || !displayName
      || !createdAt
      || typeof badge !== "string"
      || !commentBadges.has(badge)
      || typeof rawItem.canDelete !== "boolean"
      || (
        Object.prototype.hasOwnProperty.call(rawItem, "authorParticipantId")
        && (!authorParticipantId || !shareIdentifierPattern.test(authorParticipantId))
      )
      || (
        Object.prototype.hasOwnProperty.call(rawItem, "ipPrefix")
        && (!allowIpPrefix || !ipPrefix)
      )
    ) {
      return null;
    }

    items.push({
      id,
      body,
      displayName,
      createdAt,
      badge: badge as SecureShareComment["badge"],
      canDelete: rawItem.canDelete,
      ...(authorParticipantId ? { authorParticipantId } : {}),
      ...(ipPrefix ? { ipPrefix } : {})
    });
  }

  const nextCursor = value.nextCursor === null
    ? null
    : safeString(value.nextCursor, 256);

  if (value.nextCursor !== null && !nextCursor) {
    return null;
  }

  return { items, nextCursor };
}

function parseCommentMutationDto(value: unknown, allowIpPrefix = false) {
  if (
    !isPlainRecord(value)
    || !hasOnlyKeys(value, ["ok", "comment", "requestId"])
    || value.ok !== true
    || !safeString(value.requestId, 128)
  ) {
    return null;
  }
  const parsed = parseCommentsDto({
    ok: true,
    items: [value.comment],
    nextCursor: null,
    requestId: value.requestId
  }, allowIpPrefix);
  return parsed?.items[0] ?? null;
}

function mergeCommentPage(
  current: SecureShareComment[],
  incoming: SecureShareComment[],
  append: boolean
) {
  const incomingIds = new Set<string>();
  const uniqueIncoming = incoming.filter((comment) => {
    if (incomingIds.has(comment.id)) {
      return false;
    }
    incomingIds.add(comment.id);
    return true;
  });

  if (append) {
    const currentIds = new Set(current.map((comment) => comment.id));
    return [
      ...current,
      ...uniqueIncoming.filter((comment) => !currentIds.has(comment.id))
    ];
  }

  return [
    ...current.filter((comment) => !incomingIds.has(comment.id)),
    ...uniqueIncoming
  ];
}

function parseCopyGrantDto(value: unknown) {
  if (
    !isPlainRecord(value)
    || value.ok !== true
    || !safeString(value.requestId, 128)
  ) {
    return null;
  }

  const copyGrant = safeString(value.copyGrant, 2_048);
  const expiresAt = safeDateString(value.expiresAt);

  if (
    !copyGrant
    || !/^[A-Za-z0-9_-]{20,2000}\.[A-Za-z0-9_-]{40,64}$/u.test(copyGrant)
    || !expiresAt
  ) {
    return null;
  }

  return { copyGrant, expiresAt };
}

async function decryptContent(
  payload: ReturnType<typeof parseContentDto>,
  key: CryptoKey
): Promise<DecryptedSecureShareContent> {
  if (!payload) {
    throw new Error("invalid_content");
  }

  const [titleValue, bodyValue] = await Promise.all([
    decryptText(payload.encryptedTitle, key),
    decryptText(payload.encryptedBody, key)
  ]);
  const attachments: SecurePublicShareAttachmentMetadata[] = [];

  for (const attachment of payload.attachments) {
    const decryptedFileName = await decryptText(attachment.encryptedFileName, key);
    const fileName = attachmentDownloadName({
      fileName: decryptedFileName,
      extension: attachment.extension
    });

    attachments.push({
      id: attachment.id,
      fileName,
      extension: attachment.extension,
      mimeType: attachment.mimeType,
      originalSize: attachment.originalSize,
      previewAllowed: attachment.previewAllowed,
      encryption: attachment.encryption
    });
  }

  const parsedBody = parseEditorContent(bodyValue);
  const bodyHtml = linkifyEditorHtml(
    sanitizeEditorHtml(parsedBody.html || "<p>내용 없음</p>")
  );

  return {
    title: titleValue || "제목 없음",
    body: serializeEditorContent(bodyHtml, parsedBody.fontSize),
    bodyHtml,
    bodyPlainText: previewTextFromHtml(bodyHtml),
    fontSize: parsedBody.fontSize,
    attachments
  };
}

function isSessionMissing(caught: unknown) {
  return caught instanceof SecureShareApiError
    && (
      caught.status === 401
      || caught.code === "session_required"
      || caught.code === "session_expired"
      || caught.code === "login_required"
    );
}

function viewerErrorMessage(caught: unknown) {
  if (caught instanceof SecureShareApiError) {
    if (caught.status === 429) {
      return "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.";
    }
    if (caught.code === "network_error") {
      return "네트워크 연결을 확인한 뒤 다시 시도해주세요.";
    }
  }

  return "이 공유 링크를 사용할 수 없습니다.";
}

function participantRenameErrorMessage(caught: unknown) {
  if (caught instanceof SecureShareApiError) {
    if (caught.code === "display_name_unavailable") {
      return "이미 사용 중인 이름입니다. 다른 이름을 입력해주세요.";
    }
    if (caught.code === "invalid_display_name") {
      return "한글·영문·일본어·숫자와 공백, 점, 밑줄, 하이픈만 1~24자로 입력해주세요.";
    }
    if (caught.status === 429) {
      return caught.retryAfterSeconds && caught.retryAfterSeconds > 0
        ? `${caught.retryAfterSeconds}초 후 다시 변경할 수 있습니다.`
        : "이름 변경 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.";
    }
    if (caught.code === "network_error") {
      return "네트워크 연결을 확인한 뒤 같은 이름으로 다시 시도해주세요.";
    }
  }
  return "표시 이름을 변경하지 못했습니다. 다시 시도해주세요.";
}

function badgeLabel(badge: SecureShareComment["badge"]) {
  if (badge === "admin") {
    return "관리자";
  }
  if (badge === "owner") {
    return "소유자";
  }
  if (badge === "quickmemo_user") {
    return "QuickMemo 사용자";
  }
  if (badge === "email_verified") {
    return "이메일 인증됨";
  }
  return "게스트";
}

function ParticipantDisplay({
  displayName,
  ipPrefix
}: {
  displayName: string;
  ipPrefix?: string;
}) {
  if (!ipPrefix) {
    return <strong>{displayName}</strong>;
  }

  return (
    <span className="secure-public-share-author-identity">
      <span className="sr-only">{displayName}, 네트워크 대역 {ipPrefix}</span>
      <strong aria-hidden="true">{displayName}</strong>
      <span
        aria-hidden="true"
        className="secure-public-share-ip-prefix"
      >
        ({ipPrefix})
      </span>
    </span>
  );
}

function canPreviewAttachment(attachment: SecurePublicShareAttachmentMetadata) {
  return attachment.previewAllowed
    && attachment.originalSize <= maxAttachmentPreviewBytes
    && previewExtensions.has(attachment.extension);
}

export function SecurePublicShareViewer({
  contentKey,
  idToken,
  isAuthenticated,
  onRequireLogin,
  onSaveCopy,
  shareId
}: SecurePublicShareViewerProps) {
  const [phase, setPhase] = useState<SecureShareViewerPhase>("loading");
  const [metadata, setMetadata] = useState<SecureShareViewerMetadataDto | null>(null);
  const [session, setSession] = useState<SecureShareViewerSessionDto | null>(null);
  const [content, setContent] = useState<DecryptedSecureShareContent | null>(null);
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [oneTimeConfirmed, setOneTimeConfirmed] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [accessError, setAccessError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [preview, setPreview] = useState<PublicAttachmentPreviewState | null>(null);
  const [attachmentPreviewReturnFocus, setAttachmentPreviewReturnFocus] =
    useState<HTMLButtonElement | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [comments, setComments] = useState<SecureShareComment[]>([]);
  const [commentCursor, setCommentCursor] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [commentError, setCommentError] = useState("");
  const [participant, setParticipant] = useState<SecureShareParticipantDto | null>(null);
  const [participantError, setParticipantError] = useState("");
  const [participantStatus, setParticipantStatus] = useState("");
  const [participantLoading, setParticipantLoading] = useState(false);
  const [renameEditing, setRenameEditing] = useState(false);
  const [renameDisplayName, setRenameDisplayName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [restoreRenameFocus, setRestoreRenameFocus] = useState(false);
  const [participantClock, setParticipantClock] = useState(() => Date.now());
  const commentRequestRef = useRef<{ body: string; clientRequestId: string } | null>(null);
  const renameRequestRef = useRef<{
    clientRequestId: string;
    displayName: string;
  } | null>(null);
  const renameButtonRef = useRef<HTMLButtonElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const saveCopyRequestRef = useRef<{
    clientRequestId: string;
    shareId: string;
  } | null>(null);
  const accessErrorRef = useRef<HTMLParagraphElement | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const lifecycleControllerRef = useRef<AbortController | null>(null);
  const lifecycleIdentityRef = useRef({
    contentKey,
    idToken,
    isAuthenticated,
    shareId
  });
  const objectUrlsRef = useRef(new Set<string>());
  const cleanupTimersRef = useRef(new Set<number>());
  const [unlockAttemptId] = useState(() => crypto.randomUUID());
  const requiresLogin = metadata?.accessMode === "authenticated_users"
    && !metadata.ownerPreview
    && (!isAuthenticated || !idToken);
  const requiresPassword = Boolean(metadata?.hasPassword && !metadata.ownerPreview);
  const requiresEmailChallenge = Boolean(metadata?.emailChallengeRequired && !metadata.ownerPreview);
  const requiresOneTimeConfirmation = Boolean(metadata?.oneTimeEnabled && !metadata.ownerPreview);
  const canSubmitAccess = Boolean(
    metadata
    && !requiresLogin
    && (
      !requiresPassword
      || (unicodeLength(password) >= 8 && unicodeLength(password) <= 128)
    )
    && (!requiresEmailChallenge || (challengeId && otpPattern.test(otp)))
    && (!requiresOneTimeConfirmation || oneTimeConfirmed)
  );
  const renameCooldownMilliseconds = participant?.renameCooldownEndsAt
    ? Date.parse(participant.renameCooldownEndsAt)
    : Number.NaN;
  const renameCooldownActive =
    Number.isFinite(renameCooldownMilliseconds)
    && renameCooldownMilliseconds > participantClock;

  useLayoutEffect(() => {
    lifecycleIdentityRef.current = {
      contentKey,
      idToken,
      isAuthenticated,
      shareId
    };
  }, [contentKey, idToken, isAuthenticated, shareId]);

  function captureLifecycle(): SecureShareViewerLifecycle {
    return {
      contentKey,
      generation: loadGenerationRef.current,
      idToken,
      isAuthenticated,
      shareId,
      signal: lifecycleControllerRef.current?.signal
    };
  }

  function lifecycleIsCurrent(lifecycle: SecureShareViewerLifecycle) {
    const current = lifecycleIdentityRef.current;

    return mountedRef.current
      && !lifecycle.signal?.aborted
      && lifecycle.generation === loadGenerationRef.current
      && lifecycle.contentKey === current.contentKey
      && lifecycle.idToken === current.idToken
      && lifecycle.isAuthenticated === current.isAuthenticated
      && lifecycle.shareId === current.shareId;
  }

  const revokeObjectUrls = useCallback(() => {
    cleanupTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    cleanupTimersRef.current.clear();
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    saveCopyRequestRef.current = null;
    renameRequestRef.current = null;
  }, [shareId]);

  useEffect(() => {
    if (renameEditing) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renameEditing]);

  useEffect(() => {
    if (!renameEditing && restoreRenameFocus) {
      renameButtonRef.current?.focus();
      setRestoreRenameFocus(false);
    }
  }, [renameEditing, restoreRenameFocus]);

  useEffect(() => {
    if (!Number.isFinite(renameCooldownMilliseconds)) {
      return undefined;
    }
    const remaining = renameCooldownMilliseconds - Date.now();

    if (remaining <= 0) {
      setParticipantClock(Date.now());
      return undefined;
    }
    const timer = window.setTimeout(
      () => setParticipantClock(Date.now()),
      Math.min(remaining + 50, 1_000)
    );
    return () => window.clearTimeout(timer);
  }, [participantClock, renameCooldownMilliseconds]);

  useEffect(() => {
    if (resendSeconds <= 0) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setResendSeconds((current) => Math.max(0, current - 1));
    }, 1_000);

    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  useEffect(() => {
    if (accessError) {
      accessErrorRef.current?.focus();
    }
  }, [accessError, phase]);

  async function loadComments(cursor: string | null = null, append = false) {
    if (
      !session
      || (
        !session.capabilities.canComment
        && !session.capabilities.participantLimitReached
      )
    ) {
      return;
    }

    const generation = loadGenerationRef.current;

    try {
      const parsed = parseCommentsDto(
        await listSecureShareComments(shareId, {
          cursor: cursor ?? undefined,
          idToken: session.ownerPreview ? idToken : undefined,
          limit: 20
        }),
        session.capabilities.commentIpPrefixEnabled
      );

      if (
        !parsed
        || !mountedRef.current
        || generation !== loadGenerationRef.current
      ) {
        if (
          !parsed
          && mountedRef.current
          && generation === loadGenerationRef.current
        ) {
          setCommentError("댓글 응답을 확인하지 못했습니다.");
        }
        return;
      }

      setComments((current) => mergeCommentPage(current, parsed.items, append));
      setCommentCursor(parsed.nextCursor);
      setCommentError("");
    } catch {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setCommentError("댓글을 불러오지 못했습니다.");
      }
    }
  }

  const loadGrantedContent = useCallback(async function loadGrantedContent(
    knownSession?: SecureShareViewerSessionDto,
    signal?: AbortSignal,
    ownerPreviewAuth = false,
    expectedGeneration = loadGenerationRef.current
  ) {
    const generation = expectedGeneration;

    if (
      !mountedRef.current
      || signal?.aborted
      || generation !== loadGenerationRef.current
    ) {
      return;
    }
    setPhase("loading_content");
    setAccessError("");

    try {
      const nextSession = knownSession
        ?? parseSessionDto(await refreshSecureShareSession(shareId, {
          idToken: ownerPreviewAuth ? idToken : undefined,
          signal
        }));

      if (!nextSession) {
        throw new Error("invalid_session");
      }
      if (nextSession.ownerPreview !== ownerPreviewAuth) {
        throw new Error("session_mode_mismatch");
      }
      if (
        !mountedRef.current
        || signal?.aborted
        || generation !== loadGenerationRef.current
      ) {
        return;
      }

      const contentPayload = parseContentDto(await getSecureShareContent(shareId, {
        idToken: nextSession.ownerPreview ? idToken : undefined,
        signal
      }));
      const key = keyRef.current;

      if (!contentPayload || !key) {
        throw new Error("invalid_content");
      }

      const decrypted = await decryptContent(contentPayload, key);

      if (
        !mountedRef.current
        || signal?.aborted
        || generation !== loadGenerationRef.current
      ) {
        return;
      }

      setSession(nextSession);
      setContent(decrypted);
      setPhase("ready");
      setPassword("");
      setOtp("");
      setNotice("");

      const postLoadTasks: Promise<void>[] = [];

      if (
        nextSession.capabilities.canComment
        && nextSession.capabilities.participantIdentityEnabled
        && !nextSession.ownerPreview
      ) {
        setParticipantLoading(true);
        postLoadTasks.push((async () => {
          try {
            const nextParticipant = await getSecureShareParticipant(shareId, { signal });

            if (
              mountedRef.current
              && !signal?.aborted
              && generation === loadGenerationRef.current
            ) {
              setParticipant(nextParticipant);
              setParticipantClock(Date.now());
              setParticipantError("");
            }
          } catch {
            if (
              mountedRef.current
              && !signal?.aborted
              && generation === loadGenerationRef.current
            ) {
              setParticipant(null);
              setParticipantError("댓글 참여자 정보를 불러오지 못했습니다.");
            }
          } finally {
            if (
              mountedRef.current
              && !signal?.aborted
              && generation === loadGenerationRef.current
            ) {
              setParticipantLoading(false);
            }
          }
        })());
      } else {
        setParticipant(null);
        setParticipantLoading(false);
        setParticipantError("");
      }

      if (
        nextSession.capabilities.canComment
        || nextSession.capabilities.participantLimitReached
      ) {
        postLoadTasks.push((async () => {
          try {
            const parsedComments = parseCommentsDto(
              await listSecureShareComments(shareId, {
                idToken: nextSession.ownerPreview ? idToken : undefined,
                limit: 20,
                signal
              }),
              nextSession.capabilities.commentIpPrefixEnabled
            );

            if (
              parsedComments
              && mountedRef.current
              && !signal?.aborted
              && generation === loadGenerationRef.current
            ) {
              setComments((current) =>
                mergeCommentPage(current, parsedComments.items, false)
              );
              setCommentCursor(parsedComments.nextCursor);
              setCommentError("");
            } else if (
              !parsedComments
              && mountedRef.current
              && !signal?.aborted
              && generation === loadGenerationRef.current
            ) {
              setCommentError("댓글 응답을 확인하지 못했습니다.");
            }
          } catch {
            if (
              mountedRef.current
              && !signal?.aborted
              && generation === loadGenerationRef.current
            ) {
              setCommentError("댓글을 불러오지 못했습니다.");
            }
          }
        })());
      }
      await Promise.all(postLoadTasks);
    } catch (caught) {
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }

      setContent(null);
      setSession(null);
      if (isSessionMissing(caught)) {
        setPhase("access");
        setAccessError("공유 세션이 만료되었습니다. 다시 인증해주세요.");
      } else {
        setPhase("unavailable");
        setAccessError(viewerErrorMessage(caught));
      }
    }
  }, [idToken, shareId]);

  useLayoutEffect(() => {
    const controller = new AbortController();
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    lifecycleControllerRef.current = controller;

    async function initialize() {
      setPhase("loading");
      setMetadata(null);
      setSession(null);
      setContent(null);
      setComments([]);
      setCommentCursor(null);
      setCommentBody("");
      setCommentError("");
      setParticipant(null);
      setParticipantError("");
      setParticipantStatus("");
      setParticipantLoading(false);
      setRenameEditing(false);
      setRenameDisplayName("");
      setRenameError("");
      setRestoreRenameFocus(false);
      setParticipantClock(Date.now());
      setBusyAction(null);
      commentRequestRef.current = null;
      renameRequestRef.current = null;
      saveCopyRequestRef.current = null;
      setChallengeId(null);
      setPassword("");
      setEmail("");
      setOtp("");
      setOneTimeConfirmed(false);
      setAccessError("");
      setNotice("");
      setAttachmentError("");
      revokeObjectUrls();
      keyRef.current = null;

      if (!shareIdentifierPattern.test(shareId) || !contentKeyPattern.test(contentKey)) {
        setPhase("unavailable");
        setAccessError("이 공유 링크를 사용할 수 없습니다.");
        return;
      }

      try {
        const importedKey = await importAesKeyBase64Url(contentKey);
        const parsedMetadata = parseMetadataDto(await getSecureShareMetadata(shareId, {
          idToken,
          signal: controller.signal
        }));

        if (!parsedMetadata) {
          throw new Error("invalid_metadata");
        }
        if (!mountedRef.current || controller.signal.aborted) {
          return;
        }

        keyRef.current = importedKey;
        setMetadata(parsedMetadata);

        if (
          parsedMetadata.accessMode === "authenticated_users"
          && !parsedMetadata.ownerPreview
          && (!isAuthenticated || !idToken)
        ) {
          setPhase("access");
          return;
        }

        try {
          const existingSession = parseSessionDto(
            await refreshSecureShareSession(shareId, {
              idToken: parsedMetadata.ownerPreview ? idToken : undefined,
              signal: controller.signal
            })
          );

          if (!existingSession) {
            throw new Error("invalid_session");
          }
          if (existingSession.ownerPreview !== parsedMetadata.ownerPreview) {
            setPhase("access");
            return;
          }
          await loadGrantedContent(
            existingSession,
            controller.signal,
            existingSession.ownerPreview,
            generation
          );
        } catch (caught) {
          if (!mountedRef.current || controller.signal.aborted) {
            return;
          }
          if (isSessionMissing(caught)) {
            setPhase("access");
          } else {
            setPhase("unavailable");
            setAccessError(viewerErrorMessage(caught));
          }
        }
      } catch (caught) {
        if (!mountedRef.current || controller.signal.aborted) {
          return;
        }
        setPhase("unavailable");
        setAccessError(viewerErrorMessage(caught));
      }
    }

    void initialize();

    return () => {
      controller.abort();
      if (lifecycleControllerRef.current === controller) {
        lifecycleControllerRef.current = null;
      }
      loadGenerationRef.current += 1;
      keyRef.current = null;
      revokeObjectUrls();
    };
  }, [contentKey, idToken, isAuthenticated, loadGrantedContent, revokeObjectUrls, shareId]);

  async function sendEmailChallenge() {
    if (!metadata || !email.trim() || resendSeconds > 0) {
      return;
    }

    const lifecycle = captureLifecycle();
    setBusyAction("email");
    setAccessError("");
    try {
      const challenge = parseEmailChallengeDto(
        await requestSecureShareEmailChallenge(shareId, email, lifecycle.signal)
      );

      if (!lifecycleIsCurrent(lifecycle)) {
        return;
      }
      if (!challenge) {
        throw new Error("invalid_challenge");
      }
      setChallengeId(challenge.challengeId);
      setResendSeconds(challenge.resendAfterSeconds);
      setNotice("인증 가능한 이메일인 경우 코드를 전송했습니다.");
      setOtp("");
    } catch (caught) {
      if (!lifecycleIsCurrent(lifecycle)) {
        return;
      }
      if (
        caught instanceof SecureShareApiError
        && caught.retryAfterSeconds
        && caught.retryAfterSeconds > 0
      ) {
        setResendSeconds(Math.min(3_600, caught.retryAfterSeconds));
      }
      setAccessError(viewerErrorMessage(caught));
    } finally {
      if (lifecycleIsCurrent(lifecycle)) {
        setBusyAction(null);
      }
    }
  }

  async function submitAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!metadata || !canSubmitAccess) {
      setAccessError("필요한 인증 항목을 모두 확인해주세요.");
      return;
    }

    const lifecycle = captureLifecycle();
    setBusyAction("access");
    setAccessError("");
    try {
      const accessSession = parseSessionDto(await unlockSecureShare(
        shareId,
        {
          ...(requiresEmailChallenge
            ? { challengeId: challengeId ?? undefined, otp }
            : {}),
          ...(requiresOneTimeConfirmation
            ? { oneTimeOpenConfirmed: oneTimeConfirmed }
            : {}),
          ...(metadata.ownerPreview ? { ownerPreview: true } : {}),
          ...(requiresPassword ? { password } : {}),
          unlockAttemptId
        },
        { idToken, signal: lifecycle.signal }
      ));
      if (!accessSession) {
        throw new Error("invalid_session");
      }
      if (!lifecycleIsCurrent(lifecycle)) {
        return;
      }
      await loadGrantedContent(
        accessSession,
        lifecycle.signal,
        metadata.ownerPreview,
        lifecycle.generation
      );
    } catch (caught) {
      if (lifecycleIsCurrent(lifecycle)) {
        setAccessError(viewerErrorMessage(caught));
      }
    } finally {
      if (lifecycleIsCurrent(lifecycle)) {
        setBusyAction(null);
      }
    }
  }

  async function openAttachmentPreview(attachment: SecurePublicShareAttachmentMetadata) {
    const key = keyRef.current;

    if (!canPreviewAttachment(attachment) || !key) {
      setAttachmentError("이 첨부파일은 안전한 미리보기를 지원하지 않습니다.");
      return;
    }

    const lifecycle = captureLifecycle();
    setBusyAction(`preview:${attachment.id}`);
    setAttachmentError("");
    revokeObjectUrls();

    try {
      const response = await getSecureShareAttachmentPreview(shareId, attachment.id, {
        idToken: session?.ownerPreview ? idToken : undefined,
        signal: lifecycle.signal
      });

      if (!lifecycleIsCurrent(lifecycle)) {
        return;
      }
      if (!response.ok) {
        throw new Error("preview_denied");
      }

      const bytes = await decryptAttachmentToBytes(
        attachment.encryption,
        key,
        { response }
      );

      if (!lifecycleIsCurrent(lifecycle)) {
        return;
      }
      if (isPublicShareRasterImageExtension(attachment.extension)) {
        const mimeType = safePublicShareAttachmentMimeType(attachment.extension);

        if (!safeRasterImageBytes(bytes, mimeType)) {
          throw new Error("unsafe_image");
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        objectUrlsRef.current.add(url);
        setPreview({
          fileName: attachment.fileName,
          kind: "image",
          label: "이미지 미리보기",
          url,
          downloadAllowed: false
        });
      } else if (attachment.extension === "pdf") {
        setPreview({
          bytes,
          fileName: attachment.fileName,
          kind: "pdf",
          label: "PDF 미리보기",
          downloadAllowed: false
        });
      } else if (attachment.extension === "docx") {
        const { renderSafeDocxPreviewSrcDoc } = await import("../lib/documentPreview");
        if (!lifecycleIsCurrent(lifecycle)) {
          return;
        }
        const srcDoc = await renderSafeDocxPreviewSrcDoc(bytes);
        if (!lifecycleIsCurrent(lifecycle)) {
          return;
        }
        setPreview(srcDoc
          ? {
              fileName: attachment.fileName,
              kind: "docx",
              label: "DOCX 양식 미리보기",
              srcDoc,
              downloadAllowed: false
            }
          : {
              fileName: attachment.fileName,
              kind: "unsupported",
              label: "DOCX 미리보기 안내",
              text: "DOCX 양식 미리보기를 안전하게 만들지 못했습니다.",
              downloadAllowed: false
            });
      } else if (attachment.extension === "hwp") {
        const { extractHwpPreviewHtml } = await import("../lib/documentPreview");
        if (!lifecycleIsCurrent(lifecycle)) {
          return;
        }
        const documentPreview = await extractHwpPreviewHtml(bytes);
        if (!lifecycleIsCurrent(lifecycle)) {
          return;
        }
        setPreview(documentPreview.html
          ? {
              fileName: attachment.fileName,
              html: documentPreview.html,
              kind: "html",
              label: "HWP 안전 본문 미리보기",
              downloadAllowed: false
            }
          : {
              fileName: attachment.fileName,
              kind: "unsupported",
              label: "HWP 미리보기 안내",
              text: "HWP 미리보기가 안전 제한을 초과했거나 지원하지 않는 문서입니다.",
              downloadAllowed: false
            });
      } else if (attachment.extension === "hwpx") {
        const { extractHwpxPreviewHtml } = await import("../lib/documentPreview");
        if (!lifecycleIsCurrent(lifecycle)) {
          return;
        }
        const html = extractHwpxPreviewHtml(bytes);
        setPreview({
          fileName: attachment.fileName,
          html,
          kind: html ? "html" : "unsupported",
          label: "HWPX 문서 미리보기",
          text: html ? undefined : "HWPX 문서에서 안전하게 표시할 본문을 찾지 못했습니다.",
          downloadAllowed: false
        });
      } else if (attachment.extension === "xlsx") {
        const { extractXlsxPreviewHtml } = await import("../lib/documentPreview");
        if (!lifecycleIsCurrent(lifecycle)) {
          return;
        }
        const html = extractXlsxPreviewHtml(bytes);
        setPreview({
          fileName: attachment.fileName,
          html,
          kind: html ? "html" : "unsupported",
          label: "XLSX 스프레드시트 미리보기",
          text: html ? undefined : "XLSX 파일에서 안전하게 표시할 시트 내용을 찾지 못했습니다.",
          downloadAllowed: false
        });
      } else if (textPreviewAttachmentExtensions.has(attachment.extension)) {
        setPreview({
          fileName: attachment.fileName,
          kind: "text",
          label: "텍스트 미리보기",
          text: decodeTextAttachmentPreview(bytes, attachment.extension),
          downloadAllowed: false
        });
      } else if (legacyBinaryPreviewAttachmentExtensions.has(attachment.extension)) {
        setPreview({
          fileName: attachment.fileName,
          kind: "unsupported",
          label: `${attachment.extension.toUpperCase()} 미리보기 안내`,
          text: legacyBinaryPreviewMessage(attachment.extension),
          downloadAllowed: false
        });
      } else {
        throw new Error("unsupported_preview");
      }
    } catch {
      if (lifecycleIsCurrent(lifecycle)) {
        setAttachmentError("첨부파일 미리보기를 열지 못했습니다.");
      }
    } finally {
      if (lifecycleIsCurrent(lifecycle)) {
        setBusyAction(null);
      }
    }
  }

  function closeAttachmentPreview() {
    setPreview(null);
    revokeObjectUrls();
  }

  async function downloadAttachment(attachment: SecurePublicShareAttachmentMetadata) {
    const key = keyRef.current;

    if (!session?.capabilities.downloadAllowed || !key) {
      setAttachmentError("첨부파일 다운로드가 허용되지 않았습니다.");
      return;
    }

    const lifecycle = captureLifecycle();
    setBusyAction(`download:${attachment.id}`);
    setAttachmentError("");
    try {
      const response = await getSecureShareAttachmentDownload(shareId, attachment.id, {
        idToken: session.ownerPreview ? idToken : undefined,
        signal: lifecycle.signal
      });

      if (!lifecycleIsCurrent(lifecycle)) {
        return;
      }
      if (!response.ok) {
        throw new Error("download_denied");
      }

      const blob = await decryptAttachmentToBlob(
        attachment.encryption,
        key,
        { response }
      );
      if (!lifecycleIsCurrent(lifecycle)) {
        return;
      }
      const url = URL.createObjectURL(new Blob([blob], {
        type: safePublicShareAttachmentMimeType(attachment.extension)
      }));
      objectUrlsRef.current.add(url);
      const anchor = document.createElement("a");

      anchor.href = url;
      anchor.download = attachment.fileName;
      anchor.rel = "noopener noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      const timer = window.setTimeout(() => {
        cleanupTimersRef.current.delete(timer);
        if (objectUrlsRef.current.delete(url)) {
          URL.revokeObjectURL(url);
        }
      }, 1_000);
      cleanupTimersRef.current.add(timer);
    } catch {
      if (lifecycleIsCurrent(lifecycle)) {
        setAttachmentError("첨부파일을 다운로드하지 못했습니다.");
      }
    } finally {
      if (lifecycleIsCurrent(lifecycle)) {
        setBusyAction(null);
      }
    }
  }

  async function copyBody() {
    if (!content || !session?.capabilities.quickCopyButtonVisible) {
      return;
    }

    const lifecycle = captureLifecycle();
    const bodyPlainText = content.bodyPlainText;

    try {
      await navigator.clipboard.writeText(bodyPlainText);
      if (lifecycleIsCurrent(lifecycle)) {
        setNotice("본문을 복사했습니다.");
      }
    } catch {
      if (lifecycleIsCurrent(lifecycle)) {
        setNotice("본문을 복사하지 못했습니다. 직접 선택해 복사해주세요.");
      }
    }
  }

  function beginParticipantRename() {
    if (busyAction !== null) {
      return;
    }
    if (!participant || !participant.canRename) {
      setParticipantStatus("현재 표시 이름을 변경할 수 없습니다.");
      return;
    }
    if (renameCooldownActive) {
      setParticipantStatus("이름 변경 후 60초 동안 다시 변경할 수 없습니다.");
      return;
    }
    setRenameDisplayName(participant.displayName);
    setRenameError("");
    setParticipantStatus("");
    setRenameEditing(true);
  }

  function cancelParticipantRename() {
    setRenameDisplayName(participant?.displayName ?? "");
    setRenameError("");
    renameRequestRef.current = null;
    setRenameEditing(false);
    setRestoreRenameFocus(true);
  }

  async function submitParticipantRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !participant
      || !session?.capabilities.participantIdentityEnabled
      || !participant.capabilities.canRename
      || renameCooldownActive
      || busyAction !== null
    ) {
      return;
    }

    let displayName: string;
    try {
      displayName = normalizeSecureShareParticipantDisplayName(renameDisplayName);
    } catch (caught) {
      setRenameError(participantRenameErrorMessage(caught));
      return;
    }
    if (displayName === participant.displayName) {
      cancelParticipantRename();
      return;
    }

    const generation = loadGenerationRef.current;
    const pendingRequest = renameRequestRef.current?.displayName === displayName
      ? renameRequestRef.current
      : {
          clientRequestId: crypto.randomUUID(),
          displayName
        };
    renameRequestRef.current = pendingRequest;
    setBusyAction("participant-rename");
    setRenameError("");
    setParticipantStatus("");

    try {
      const nextParticipant = await renameSecureShareParticipant(
        shareId,
        pendingRequest,
        { signal: lifecycleControllerRef.current?.signal }
      );
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }

      setParticipant(nextParticipant);
      setParticipantClock(Date.now());
      setComments((current) => current.map((comment) =>
        comment.authorParticipantId === nextParticipant.participantId
          ? { ...comment, displayName: nextParticipant.displayName }
          : comment
      ));
      renameRequestRef.current = null;
      setRenameDisplayName(nextParticipant.displayName);
      setRenameError("");
      setParticipantStatus("댓글 표시 이름을 변경했습니다.");
      setRenameEditing(false);
      setRestoreRenameFocus(true);
    } catch (caught) {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setRenameError(participantRenameErrorMessage(caught));
      }
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setBusyAction(null);
      }
    }
  }

  async function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = commentBody.trim();

    const bodyLength = unicodeLength(body);

    if (body.includes("<") || body.includes(">")) {
      setCommentError("댓글에는 HTML 태그를 입력할 수 없습니다.");
      return;
    }

    if (
      !session?.capabilities.canComment
      || !body
      || bodyLength > 2_000
    ) {
      setCommentError("댓글은 1자 이상 2,000자 이하로 입력해주세요.");
      return;
    }

    setBusyAction("comment");
    setCommentError("");
    const generation = loadGenerationRef.current;
    const pendingRequest = commentRequestRef.current?.body === body
      ? commentRequestRef.current
      : {
          body,
          clientRequestId: crypto.randomUUID()
        };
    commentRequestRef.current = pendingRequest;
    try {
      const createdComment = parseCommentMutationDto(
        await createSecureShareComment(shareId, pendingRequest, {
          idToken: session.ownerPreview ? idToken : undefined
        }),
        session.capabilities.commentIpPrefixEnabled
      );
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }
      if (!createdComment) {
        throw new Error("Invalid comment response");
      }
      setComments((current) => [
        createdComment,
        ...current.filter((comment) => comment.id !== createdComment.id)
      ]);
      commentRequestRef.current = null;
      setCommentBody("");
    } catch {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setCommentError("댓글을 저장하지 못했습니다.");
      }
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setBusyAction(null);
      }
    }
  }

  async function removeComment(commentId: string) {
    setBusyAction(`comment-delete:${commentId}`);
    setCommentError("");
    const generation = loadGenerationRef.current;
    try {
      await deleteSecureShareComment(shareId, commentId, {
        idToken: session?.ownerPreview ? idToken : undefined
      });
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }
      setComments((current) => current.filter((comment) => comment.id !== commentId));
    } catch {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setCommentError("댓글을 삭제하지 못했습니다.");
      }
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setBusyAction(null);
      }
    }
  }

  async function saveCopy() {
    const copyContent = content;
    const copySession = session;
    const key = keyRef.current;

    if (!copyContent || !copySession?.capabilities.canSaveCopy || !onSaveCopy || !key) {
      return;
    }
    if (!isAuthenticated || !idToken) {
      onRequireLogin();
      return;
    }

    const lifecycle = captureLifecycle();
    setBusyAction("copy");
    setNotice("");
    const pendingRequest = saveCopyRequestRef.current?.shareId === shareId
      ? saveCopyRequestRef.current
      : {
          clientRequestId: crypto.randomUUID(),
          shareId
        };
    saveCopyRequestRef.current = pendingRequest;
    try {
      const grant = parseCopyGrantDto(
        await requestSecureShareCopyGrant(
          shareId,
          idToken,
          pendingRequest.clientRequestId,
          lifecycle.signal
        )
      );

      if (!lifecycleIsCurrent(lifecycle)) {
        return;
      }
      if (!grant) {
        throw new Error("invalid_copy_grant");
      }

      const copyAttachment = async (
        attachment: SecurePublicShareAttachmentMetadata,
        signal?: AbortSignal
      ) => {
        if (!lifecycleIsCurrent(lifecycle) || signal?.aborted) {
          throw new DOMException("복사 첨부파일 요청이 취소되었습니다.", "AbortError");
        }
        const currentAttachment = copyContent.attachments.find(
          (candidate) => candidate.id === attachment.id
        );

        if (!currentAttachment) {
          throw new Error("copy_attachment_unavailable");
        }

        const requestController = new AbortController();
        const abortRequest = () => requestController.abort();
        const requestSignals = [lifecycle.signal, signal].filter(
          (candidate): candidate is AbortSignal => Boolean(candidate)
        );

        requestSignals.forEach((requestSignal) => {
          if (requestSignal.aborted) {
            requestController.abort();
          } else {
            requestSignal.addEventListener("abort", abortRequest, { once: true });
          }
        });

        try {
          const response = await getSecureShareAttachmentForCopy(
            shareId,
            currentAttachment.id,
            idToken,
            grant.copyGrant,
            requestController.signal
          );

          if (
            !lifecycleIsCurrent(lifecycle)
            || signal?.aborted
            || requestController.signal.aborted
          ) {
            throw new DOMException("복사 첨부파일 요청이 취소되었습니다.", "AbortError");
          }
          if (!response.ok) {
            throw new Error("copy_attachment_denied");
          }

          const decrypted = await decryptAttachmentToBlob(
            currentAttachment.encryption,
            key,
            { response }
          );

          if (
            !lifecycleIsCurrent(lifecycle)
            || signal?.aborted
            || requestController.signal.aborted
          ) {
            throw new DOMException("복사 첨부파일 요청이 취소되었습니다.", "AbortError");
          }

          return new Blob([decrypted], {
            type: safePublicShareAttachmentMimeType(currentAttachment.extension)
          });
        } finally {
          requestSignals.forEach((requestSignal) =>
            requestSignal.removeEventListener("abort", abortRequest)
          );
        }
      };

      await onSaveCopy({
        title: copyContent.title,
        body: copyContent.body,
        bodyHtml: copyContent.bodyHtml,
        attachments: copyContent.attachments,
        capabilities: copySession.capabilities,
        copyAttachment,
        copyGrantExpiresAt: grant.expiresAt
      });
      if (!lifecycleIsCurrent(lifecycle)) {
        return;
      }
      if (saveCopyRequestRef.current === pendingRequest) {
        saveCopyRequestRef.current = null;
      }
      setNotice("QuickMemo 복사본 저장 작업을 시작했습니다.");
    } catch {
      if (lifecycleIsCurrent(lifecycle)) {
        setNotice("복사본 저장을 시작하지 못했습니다.");
      }
    } finally {
      if (lifecycleIsCurrent(lifecycle)) {
        setBusyAction(null);
      }
    }
  }

  if (phase === "loading" || phase === "loading_content") {
    return (
      <section className="secure-public-share-state" aria-live="polite">
        <Loader2 aria-hidden="true" className="spin" size={22} />
        <h1>{phase === "loading" ? "보안 공유 확인 중" : "암호화된 내용 여는 중"}</h1>
        <p>잠시만 기다려주세요.</p>
      </section>
    );
  }

  if (phase === "unavailable" || !metadata) {
    return (
      <section className="secure-public-share-state error" role="alert">
        <LockKeyhole aria-hidden="true" size={24} />
        <h1>이 공유 링크를 사용할 수 없습니다.</h1>
        <p ref={accessErrorRef} tabIndex={-1}>
          {accessError || "만료, 공유 해제 또는 일회성 링크 사용 완료 여부를 확인해주세요."}
        </p>
      </section>
    );
  }

  if (phase === "access") {
    return (
      <section className="secure-public-share-access">
        <header>
          <span className="section-kicker">
            <ShieldCheck aria-hidden="true" size={17} />
            Secure Share v2
          </span>
          <h1>보안 공유 열기</h1>
          <p>필요한 조건을 확인한 뒤 암호화된 내용을 브라우저에서 엽니다.</p>
          {metadata.ownerPreview && (
            <span className="secure-public-share-owner-badge">소유자/관리자 미리보기 · 일회성 링크 미소비</span>
          )}
        </header>

        {requiresLogin ? (
          <div className="secure-public-share-login">
            <p>이 공유는 로그인한 QuickMemo 사용자만 열 수 있습니다.</p>
            <button onClick={() => onRequireLogin()} type="button">
              <LogIn aria-hidden="true" size={17} />
              QuickMemo 로그인
            </button>
          </div>
        ) : (
          <form onSubmit={submitAccess}>
            {requiresPassword && (
              <label>
                공유 비밀번호
                <input
                  autoComplete="current-password"
                  disabled={busyAction !== null}
                  maxLength={256}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  value={password}
                />
                <small>공백을 포함해 전달받은 비밀번호 그대로 입력해주세요.</small>
              </label>
            )}

            {requiresEmailChallenge && (
              <div className="secure-public-share-email-gate">
                <label>
                  인증 이메일
                  <input
                    autoComplete="email"
                    disabled={busyAction !== null}
                    inputMode="email"
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setChallengeId(null);
                      setOtp("");
                    }}
                    type="email"
                    value={email}
                  />
                </label>
                <button
                  className="secondary-button"
                  disabled={busyAction !== null || !email.trim() || resendSeconds > 0}
                  onClick={() => void sendEmailChallenge()}
                  type="button"
                >
                  <Send aria-hidden="true" size={15} />
                  {resendSeconds > 0 ? `${resendSeconds}초 후 재전송` : "인증 코드 보내기"}
                </button>
                {challengeId && (
                  <label>
                    6자리 인증 코드
                    <input
                      autoComplete="one-time-code"
                      disabled={busyAction !== null}
                      inputMode="numeric"
                      maxLength={6}
                      onChange={(event) => setOtp(event.target.value.replace(/\D/gu, "").slice(0, 6))}
                      pattern="[0-9]{6}"
                      value={otp}
                    />
                  </label>
                )}
              </div>
            )}

            {requiresOneTimeConfirmation && (
              <label className="secure-public-share-one-time">
                <input
                  checked={oneTimeConfirmed}
                  disabled={busyAction !== null}
                  onChange={(event) => setOneTimeConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <strong>이 링크를 지금 한 번 열겠습니다.</strong>
                  <small>
                    인증에 성공하면 이 브라우저 세션에만 접근 권한이 발급되고 다른 사람은 새로 열 수 없습니다.
                  </small>
                </span>
              </label>
            )}

            {notice && <p className="secure-public-share-notice" role="status">{notice}</p>}
            {accessError && (
              <p
                className="secure-public-share-error"
                id="secure-public-share-access-error"
                ref={accessErrorRef}
                role="alert"
                tabIndex={-1}
              >
                {accessError}
              </p>
            )}
            <button disabled={busyAction !== null || !canSubmitAccess} type="submit">
              {busyAction === "access"
                ? <Loader2 aria-hidden="true" className="spin" size={17} />
                : <Eye aria-hidden="true" size={17} />}
              {metadata.ownerPreview ? "소유자/관리자 미리보기 열기" : "보안 공유 열기"}
            </button>
          </form>
        )}
      </section>
    );
  }

  if (!content || !session) {
    return null;
  }

  return (
    <article className="secure-public-share-viewer">
      <header className="secure-public-share-document-header">
        <div>
          {session.ownerPreview && (
            <span className="secure-public-share-owner-badge">소유자/관리자 미리보기</span>
          )}
          <h1>{content.title}</h1>
        </div>
        <div className="secure-public-share-document-actions">
          {session.capabilities.quickCopyButtonVisible && (
            <button
              className="secondary-button"
              disabled={busyAction !== null}
              onClick={() => void copyBody()}
              type="button"
            >
              <Copy aria-hidden="true" size={15} />
              본문 빠른 복사
            </button>
          )}
          {session.capabilities.canSaveCopy && onSaveCopy && (
            <button
              disabled={busyAction !== null}
              onClick={() => void saveCopy()}
              type="button"
            >
              {busyAction === "copy"
                ? <Loader2 aria-hidden="true" className="spin" size={15} />
                : <Save aria-hidden="true" size={15} />}
              QuickMemo에 복사본 저장
            </button>
          )}
        </div>
      </header>

      {notice && <p className="secure-public-share-notice" role="status">{notice}</p>}

      <div
        className="note-preview-body public-share-body secure-public-share-body"
        style={{ "--editor-font-size": `${content.fontSize}px` } as React.CSSProperties}
        dangerouslySetInnerHTML={{ __html: content.bodyHtml }}
      />

      {content.attachments.length > 0 && (
        <section className="secure-public-share-attachments">
          <h2><File aria-hidden="true" size={17} /> 첨부파일</h2>
          {attachmentError && <p className="secure-public-share-error" role="alert">{attachmentError}</p>}
          <div>
            {content.attachments.map((attachment) => (
              <article className="secure-public-share-attachment" key={attachment.id}>
                <span className="secure-public-share-file-icon"><File aria-hidden="true" size={18} /></span>
                <div>
                  <strong>{attachment.fileName}</strong>
                  <span>{formatFileSize(attachment.originalSize)}</span>
                </div>
                <div className="secure-public-share-attachment-actions">
                  {canPreviewAttachment(attachment) && (
                    <button
                      className="secondary-button"
                      disabled={busyAction !== null}
                      onClick={(event) => {
                        setAttachmentPreviewReturnFocus(event.currentTarget);
                        void openAttachmentPreview(attachment);
                      }}
                      type="button"
                    >
                      {busyAction === `preview:${attachment.id}`
                        ? <Loader2 aria-hidden="true" className="spin" size={14} />
                        : <Eye aria-hidden="true" size={14} />}
                      미리보기
                    </button>
                  )}
                  {session.capabilities.downloadAllowed && (
                    <button
                      className="secondary-button"
                      disabled={busyAction !== null}
                      onClick={() => void downloadAttachment(attachment)}
                      type="button"
                    >
                      {busyAction === `download:${attachment.id}`
                        ? <Loader2 aria-hidden="true" className="spin" size={14} />
                        : <Download aria-hidden="true" size={14} />}
                      다운로드
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {!session.capabilities.downloadAllowed && (
            <p className="secure-public-share-helper">
              직접 다운로드 요청은 제한됩니다. 화면에 표시된 콘텐츠의 캡처나 수동 복제까지 완전히 막는 기능은 아닙니다.
            </p>
          )}
        </section>
      )}

      {(session.capabilities.canComment
        || session.capabilities.participantLimitReached) && (
        <section className="secure-public-share-comments">
          <h2><MessageCircle aria-hidden="true" size={17} /> 댓글</h2>
          {session.capabilities.participantLimitReached && (
            <p
              aria-live="polite"
              className="secure-public-share-notice"
              role="status"
            >
              이 공유의 댓글 참여 인원이 많아 새 댓글 작성이 제한되었습니다.
            </p>
          )}
          {session.capabilities.canComment
            && session.capabilities.participantIdentityEnabled && (
            <section
              aria-labelledby="secure-public-share-participant-heading"
              className="secure-public-share-participant-card"
            >
              <header>
                <div>
                  <span id="secure-public-share-participant-heading">내 댓글 이름</span>
                  {participant && (
                    <ParticipantDisplay
                      displayName={participant.displayName}
                      ipPrefix={
                        session.capabilities.commentIpPrefixEnabled
                        && participant.capabilities.showsCommenterIpPrefix
                          ? participant.currentIpPrefix
                          : undefined
                      }
                    />
                  )}
                  {participantLoading && (
                    <span className="secure-public-share-participant-loading" role="status">
                      <Loader2 aria-hidden="true" className="spin" size={14} />
                      참여자 정보 확인 중
                    </span>
                  )}
                </div>
                {participant && !renameEditing && (
                  <button
                    aria-describedby="secure-public-share-participant-help"
                    aria-disabled={
                      !participant.canRename
                      || renameCooldownActive
                      || busyAction !== null
                    }
                    className="secondary-button"
                    disabled={busyAction !== null}
                    onClick={beginParticipantRename}
                    ref={renameButtonRef}
                    type="button"
                  >
                    <Pencil aria-hidden="true" size={14} />
                    이름 변경
                  </button>
                )}
              </header>

              {renameEditing && participant && (
                <form
                  className="secure-public-share-participant-rename"
                  noValidate
                  onSubmit={submitParticipantRename}
                >
                  <label htmlFor="secure-public-share-participant-name">표시 이름</label>
                  <div>
                    <input
                      aria-describedby={[
                        "secure-public-share-participant-name-help",
                        renameError ? "secure-public-share-participant-name-error" : ""
                      ].filter(Boolean).join(" ")}
                      aria-invalid={Boolean(renameError)}
                      autoComplete="off"
                      disabled={busyAction !== null}
                      id="secure-public-share-participant-name"
                      maxLength={72}
                      onChange={(event) => {
                        const nextDisplayName = event.target.value;
                        if (renameRequestRef.current?.displayName !== nextDisplayName) {
                          renameRequestRef.current = null;
                        }
                        setRenameDisplayName(nextDisplayName);
                        setRenameError("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelParticipantRename();
                        }
                      }}
                      ref={renameInputRef}
                      spellCheck={false}
                      value={renameDisplayName}
                    />
                    <button
                      disabled={
                        busyAction !== null
                        || !renameDisplayName.trim()
                        || renameDisplayName.trim() === participant.displayName
                      }
                      type="submit"
                    >
                      {busyAction === "participant-rename"
                        ? <Loader2 aria-hidden="true" className="spin" size={14} />
                        : <Check aria-hidden="true" size={14} />}
                      저장
                    </button>
                    <button
                      className="secondary-button"
                      disabled={busyAction !== null}
                      onClick={cancelParticipantRename}
                      type="button"
                    >
                      <X aria-hidden="true" size={14} />
                      취소
                    </button>
                  </div>
                  <p
                    className="secure-public-share-participant-name-help"
                    id="secure-public-share-participant-name-help"
                  >
                    1~24자. 한글·영문·일본어·숫자와 공백, 점, 밑줄, 하이픈을 사용할 수 있습니다.
                  </p>
                  {renameError && (
                    <p
                      className="secure-public-share-error"
                      id="secure-public-share-participant-name-error"
                      role="alert"
                    >
                      {renameError}
                    </p>
                  )}
                </form>
              )}

              {participantError && (
                <p className="secure-public-share-error" role="alert">{participantError}</p>
              )}
              {participantStatus && (
                <p
                  aria-live="polite"
                  className="secure-public-share-notice"
                  role="status"
                >
                  {participantStatus}
                </p>
              )}
              <p
                className="secure-public-share-participant-help"
                id="secure-public-share-participant-help"
              >
                {renameCooldownActive
                  ? "이름 변경 후 60초 동안 다시 변경할 수 없습니다."
                  : "이 공유에서 작성하는 댓글에 같은 이름이 표시됩니다."}
              </p>
              {session.capabilities.commentIpPrefixEnabled && (
                <p className="secure-public-share-participant-help">
                  전체 IP 주소가 아닌 일부 네트워크 대역만 표시됩니다.
                </p>
              )}
            </section>
          )}
          {session.capabilities.canComment && (
            <form onSubmit={submitComment}>
              <label>
                새 댓글
                <textarea
                  disabled={busyAction !== null}
                  maxLength={4_000}
                  onChange={(event) => {
                    const nextBody = Array.from(event.target.value).slice(0, 2_000).join("");
                    if (commentRequestRef.current?.body !== nextBody.trim()) {
                      commentRequestRef.current = null;
                    }
                    setCommentBody(nextBody);
                  }}
                  placeholder="평문 댓글을 입력하세요."
                  rows={3}
                  value={commentBody}
                />
              </label>
              <div>
                <span>{unicodeLength(commentBody)}/2,000</span>
                <button disabled={busyAction !== null || !commentBody.trim()} type="submit">
                  {busyAction === "comment"
                    ? <Loader2 aria-hidden="true" className="spin" size={15} />
                    : <Send aria-hidden="true" size={15} />}
                  댓글 작성
                </button>
              </div>
            </form>
          )}
          {commentError && <p className="secure-public-share-error" role="alert">{commentError}</p>}
          <div className="secure-public-share-comment-list">
            {comments.map((comment) => (
              <article key={comment.id}>
                <header>
                  <div>
                    <ParticipantDisplay
                      displayName={comment.displayName}
                      ipPrefix={
                        session.capabilities.commentIpPrefixEnabled
                          ? comment.ipPrefix
                          : undefined
                      }
                    />
                    <span className="secure-public-share-author-badge">
                      {badgeLabel(comment.badge)}
                    </span>
                  </div>
                  <time dateTime={comment.createdAt}>
                    {commentDateFormatter.format(new Date(comment.createdAt))}
                  </time>
                </header>
                <p>{comment.body}</p>
                {session.capabilities.canComment && comment.canDelete && (
                  <button
                    aria-label={`${comment.displayName} 댓글 삭제`}
                    className="secondary-button danger"
                    disabled={busyAction !== null}
                    onClick={() => void removeComment(comment.id)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    삭제
                  </button>
                )}
              </article>
            ))}
            {comments.length === 0 && <p className="secure-public-share-helper">아직 댓글이 없습니다.</p>}
          </div>
          {commentCursor && (
            <button
              className="secondary-button"
              disabled={busyAction !== null}
              onClick={() => void loadComments(commentCursor, true)}
              type="button"
            >
              댓글 더 보기
            </button>
          )}
        </section>
      )}

      <footer className="secure-public-share-session-note">
        <Check aria-hidden="true" size={15} />
        암호화된 내용은 이 브라우저에서만 복호화되었습니다.
      </footer>

      {preview && (
        <Suspense fallback={<p className="secure-public-share-notice" role="status">미리보기 준비 중…</p>}>
          <PublicAttachmentPreviewModal
            onClose={closeAttachmentPreview}
            preview={preview}
            returnFocus={attachmentPreviewReturnFocus}
          />
        </Suspense>
      )}
    </article>
  );
}
