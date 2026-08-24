/* global AbortController, Buffer, clearTimeout, console, process, setTimeout */

import { randomInt } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  attachmentGenerationIncludes,
  retainedAttachmentGenerations,
  sourceAttachmentFingerprintMatches,
  validSourceAttachmentFingerprint
} from "./_secure-share-attachment-reuse.js";
import { createGmailSmtpEmailAdapter } from "./_secure-share-gmail-smtp.js";
import {
  safeSecureShareEmailRuntimeSnapshot
} from "./_secure-share-email-settings.js";
import {
  HttpError,
  activeUserFromRequest,
  applySecureResponseHeaders,
  assertOnlyKeys,
  authorizationToken,
  browserBindingCookie,
  browserBindingFromRequest,
  clientNetworkIdentity,
  clientNetworkDigest,
  constantTimeStringEqual,
  configuredInteger,
  createResendEmailAdapter,
  createDocumentWrite,
  createFirestoreContext,
  csrfTokenDigest,
  emailDigest,
  ensureSameOrigin,
  firestoreBatchGetNewTransaction,
  firestoreBatchGet,
  firestoreCommit,
  deleteDocumentWrite,
  firestoreDocumentName,
  firestoreGet,
  firestoreIntegerValue,
  firestoreListCollection,
  firestoreReferenceValue,
  firestoreRollback,
  firestoreRunQuery,
  firestoreStringValue,
  firestoreTimestampValue,
  generateOtpCode,
  handleApiError,
  headerValue,
  hashSharePassword,
  hmacDigest,
  identityDigest,
  isPlainRecord,
  jsonResponse,
  loopbackEmulatorHost,
  normalizeAllowedEmails,
  normalizeEmail,
  oneTimeGraceSeconds,
  otpCodeDigest,
  otpTtlSeconds,
  participantCookie,
  participantTokenFromRequest,
  queryString,
  randomToken,
  rateLimitBucketDigest,
  readJsonBody,
  requestId,
  requestUrl,
  requireCsrf,
  requireSecureShareV2,
  requiredSecret,
  safeId,
  safeErrorSummary,
  safeUnlockAttemptId,
  secureShareEmailReadiness,
  secureShareCommentIpPrefixEnabled,
  secureShareParticipantIdentityEnabled,
  secureShareScryptParameters,
  secureShareV2Enabled,
  sendVerificationEmail,
  sessionCookie,
  sessionTokenDigest,
  sessionTokenFromRequest,
  sessionTtlSeconds,
  sha256Digest,
  signedOpaqueToken,
  unlockAttemptDigest,
  updateDocumentWrite,
  userAgentDigest,
  verifySecureShareAppCheck,
  verifySignedOpaqueToken,
  verifySharePassword,
  verificationEmailText
} from "./_secure-share-common.js";
import {
  GLOBAL_BLOB_USAGE_DOCUMENT_PATH,
  GLOBAL_BLOB_USAGE_SCHEMA_VERSION,
  evaluateFreeTierUpload,
  resolveFreeTierPolicy
} from "./_free-tier-policy.js";
import {
  storedBlobMetadataMatchesAttachment,
  streamedBlobMetadataMatchesAttachment
} from "./_blob-download-policy.js";

const accessModes = new Set(["anyone_with_link", "allowed_emails", "authenticated_users"]);
const permissionLevels = new Set(["view", "comment", "save_copy"]);
const expirationPresets = new Set(["one_hour", "one_day", "seven_days", "custom"]);
const ownerShareStatuses = new Set(["pending", "active", "consumed", "revoked", "expired"]);
const previewableExtensions = new Set([
  "pdf", "txt", "md", "csv", "json", "doc", "docx", "hwp", "hwpx", "xlsx",
  "png", "jpg", "jpeg", "webp", "gif"
]);
const maximumPreviewBytes = 25 * 1024 * 1024;
const maximumEncryptedAttachmentBytes = 151 * 1024 * 1024;
const userAttachmentQuotaBytes = 1024 * 1024 * 1024;
const userAttachmentCountLimit = 500;
const auditRetentionDays = configuredInteger("SHARE_AUDIT_RETENTION_DAYS", 90, 30, 365);
const auditRetentionMilliseconds = auditRetentionDays * 24 * 60 * 60 * 1000;
const defaultPageSize = 20;
const maximumPageSize = 50;
const maximumSourceShareHistory = 100;
const rateLimitTransactionMaximumAttempts = 8;
const sourceCreateTransactionMaximumAttempts = 8;
const maximumSourceFolderDepth = 32;
const sourceFolderIdPattern = /^[A-Za-z0-9_-]{1,120}$/u;
const unsafeSourceFolderIds = new Set(["__proto__", "constructor", "prototype"]);
const emailQuotaReservationMaximumAttempts = 8;
const optimisticRetryMaximumDelayMilliseconds = 250;
const copyGrantPurpose = "quickmemo/secure-share/copy-grant/v1";
const copyGrantTtlSeconds = 5 * 60;
const copyGrantReplayMinimumSeconds = 15;
const copyGrantRequestRetentionSeconds = 24 * 60 * 60;
const copyGrantRateWindowSeconds = 60;
const copyGrantRateLimit = 3;
const copyGrantTransactionMaximumAttempts = 8;
const copyGrantRetryMaximumDelayMilliseconds = 250;
const emailProviderRequestRateWindowSeconds = 1;
const emailProviderRequestRateLimit = 2;
const ownerContentUpdateMinimumIntervalMilliseconds = 500;
const sessionLastSeenWriteIntervalMilliseconds = 60 * 60 * 1000;
const participantAllocationMaximumAttempts = 32;
const participantAllocationQueueMaximumEntriesPerShare = 32;
const participantAllocationQueueMaximumShareKeys = 64;
const participantAllocationQueueMaximumTotalEntries = 256;
const participantAllocationQueueWaitMilliseconds = 15_000;
const supportedOwnerWrappedKeyByteLengths = new Set([256, 384]);
const participantRenameMaximumAttempts = 8;
const participantIpPrefixVersion = 1;
const participantTokenPartLength = 43;
const participantTokenV2Prefix = "p2_";
const maximumCommentPageSize = 20;
const maximumParticipantsPerShare = configuredInteger(
  "SECURE_SHARE_MAX_PARTICIPANTS_PER_SHARE",
  1000,
  1,
  1000
);
const participantAllocationQueues = new Map();
let participantAllocationQueueTotalEntries = 0;
const secureShareLiveContentSyncServerProductionDefault = true;
const legacyAutomaticSourceRevokePattern = /^source_changed_[0-9a-f]{32}$/u;
const validActions = new Set([
  "feature-status",
  "live-sync-status",
  "owner-list",
  "owner-details",
  "owner-create",
  "owner-update",
  "owner-content-update",
  "owner-activate",
  "owner-revoke",
  "metadata",
  "email-challenge",
  "access",
  "session",
  "revision",
  "content",
  "participant-me",
  "comments",
  "comment-delete",
  "copy-grant",
  "attachment-preview",
  "attachment-download"
]);

function configuredEmailProviderName(
  runtimeSnapshot = null,
  environment = process.env
) {
  if (runtimeSnapshot) {
    if (
      runtimeSnapshot.ready === true
      && runtimeSnapshot.environment
      && (
        runtimeSnapshot.provider === "gmail_smtp"
        || (
          runtimeSnapshot.provider === "resend"
          && runtimeSnapshot.environment.NODE_ENV === "test"
        )
      )
    ) {
      return runtimeSnapshot.provider;
    }
    throw new HttpError(
      503,
      "email_feature_unavailable",
      "Secure Share email provider is unavailable",
      { expose: false }
    );
  }
  const provider = typeof environment.SHARE_EMAIL_PROVIDER === "string"
    ? environment.SHARE_EMAIL_PROVIDER.trim().toLowerCase()
    : "";
  if (provider === "gmail_smtp") {
    return provider;
  }
  if (provider === "resend" && environment.NODE_ENV === "test") {
    return provider;
  }
  throw new HttpError(
    503,
    "email_feature_unavailable",
    "Secure Share email provider is unavailable",
    { expose: false }
  );
}

function createConfiguredEmailAdapter(
  context,
  runtimeSnapshot = null,
  environment = process.env
) {
  const provider = configuredEmailProviderName(runtimeSnapshot, environment);
  if (provider === "gmail_smtp") {
    return createGmailSmtpEmailAdapter({
      environment: runtimeSnapshot?.environment ?? environment
    });
  }
  return createResendEmailAdapter(
    undefined,
    delay,
    async () => {
      await consumeRateLimits(context, [
        {
          limitType: "email_provider_request_global_second",
          keyParts: ["resend_test_only"],
          shareId: "email_provider_global",
          ownerUid: "",
          windowSeconds: emailProviderRequestRateWindowSeconds,
          limit: emailProviderRequestRateLimit
        }
      ]);
    }
  );
}

function resolveSecureShareLiveContentSyncServerFlag(
  productionDefault,
  configuredValue
) {
  if (productionDefault !== true) {
    return false;
  }
  return configuredValue === undefined
    || configuredValue === "true";
}

function secureShareLiveContentSyncEmulatorHarnessEnabled(configuredValue) {
  if (
    configuredValue !== "true"
    || process.env.QUICKMEMO_SECURE_SHARE_EMULATOR_LIVE_SYNC !== "enabled"
    || process.env.NODE_ENV !== "test"
    || process.env.VERCEL_ENV === "production"
  ) {
    return false;
  }
  try {
    return Boolean(
      loopbackEmulatorHost("FIRESTORE_EMULATOR_HOST")
      && loopbackEmulatorHost("FIREBASE_AUTH_EMULATOR_HOST")
    );
  } catch {
    return false;
  }
}

function secureShareLiveContentSyncEnabled(
  configuredValue = process.env.SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED
) {
  return resolveSecureShareLiveContentSyncServerFlag(
    secureShareLiveContentSyncServerProductionDefault,
    configuredValue
  ) || secureShareLiveContentSyncEmulatorHarnessEnabled(configuredValue);
}

function requireSecureShareLiveContentSync() {
  if (!secureShareLiveContentSyncEnabled()) {
    throw new HttpError(404, "not_found", "Secure Share live content sync is disabled");
  }
}

function requireMethod(request, methods) {
  if (!methods.includes(request.method)) {
    throw new HttpError(405, "method_not_allowed", `Expected ${methods.join(", ")}`);
  }
}

function assertQueryKeys(url, allowedKeys) {
  const allowed = new Set(allowedKeys);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new HttpError(400, "invalid_request", "Unknown query field");
    }
  }
}

function isOptimisticConflict(error) {
  return error
    && typeof error === "object"
    && (
      [409, 412].includes(error.statusCode)
      || (
        error.statusCode === 400
        && error.upstreamCode === "FAILED_PRECONDITION"
      )
    );
}

function boundedInteger(value, fieldName, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

function optionalSafeInteger(value, fieldName, minimum, maximum) {
  return value === undefined ? undefined : boundedInteger(value, fieldName, minimum, maximum);
}

function requiredBoolean(value, fieldName) {
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

function optionalBoolean(value, fallback, fieldName) {
  return value === undefined ? fallback : requiredBoolean(value, fieldName);
}

function base64ByteLength(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    return -1;
  }
  try {
    return Buffer.from(value, "base64").byteLength;
  } catch {
    return -1;
  }
}

function encryptedPayload(value, fieldName, maximumCipherBytes) {
  assertOnlyKeys(value, ["version", "algorithm", "cipherText", "iv"]);
  const cipherBytes = base64ByteLength(value.cipherText);
  const ivBytes = base64ByteLength(value.iv);
  if (
    value.version !== 1
    || value.algorithm !== "AES-GCM"
    || cipherBytes < 16
    || cipherBytes > maximumCipherBytes
    || ivBytes !== 12
  ) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return {
    version: 1,
    algorithm: "AES-GCM",
    cipherText: value.cipherText,
    iv: value.iv
  };
}

function wrappedShareKey(value) {
  if (value === undefined) {
    throw new HttpError(400, "invalid_request", "ownerWrappedShareKey is required");
  }
  assertOnlyKeys(value, ["version", "algorithm", "wrappedKey"]);
  const wrappedKeyBytes = base64ByteLength(value.wrappedKey);
  if (
    value.version !== 1
    || value.algorithm !== "RSA-OAEP"
    || typeof value.wrappedKey !== "string"
    || !supportedOwnerWrappedKeyByteLengths.has(wrappedKeyBytes)
  ) {
    throw new HttpError(400, "invalid_request", "Invalid ownerWrappedShareKey");
  }
  return { version: 1, algorithm: "RSA-OAEP", wrappedKey: value.wrappedKey };
}

function safeDisplayName(value, fallback = "Guest", allowReserved = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", "Invalid displayName");
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    Array.from(normalized).length < 1
    || Array.from(normalized).length > 40
    || /[<>\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new HttpError(400, "invalid_request", "Invalid displayName");
  }
  if (
    !allowReserved
    && /^(?:관리자|소유자|quickmemo(?:\s+공식)?|admin|owner)$/iu.test(normalized)
  ) {
    throw new HttpError(400, "invalid_request", "Reserved displayName");
  }
  return normalized;
}

function unicodeGraphemeLength(value) {
  if (typeof Intl?.Segmenter === "function") {
    return Array.from(new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)).length;
  }
  return Array.from(value).length;
}

function normalizedParticipantName(value) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

function participantRoleSkeleton(value) {
  const substitutions = new Map([
    ["0", "o"],
    ["1", "i"],
    ["3", "e"],
    ["4", "a"],
    ["5", "s"],
    ["7", "t"],
    ["8", "b"],
    ["9", "g"],
    ["l", "i"],
    ["○", "o"],
    ["〇", "o"]
  ]);
  return Array.from(value.replace(/rn/gu, "m").replace(/vv/gu, "w"))
    .map((character) => substitutions.get(character) ?? character)
    .join("");
}

function isReservedParticipantRoleKey(value, anywhere = false) {
  if (
    anywhere
    && /(?:guest|quickmemo|admin(?:istrator)?|owner|official|support|system)/u.test(value)
  ) {
    return true;
  }
  return (
    /^guest/u.test(value)
    || /quickmemo/u.test(value)
    || /^(?:admin(?:istrator)?|owner|official|support)/u.test(value)
    || /^system/u.test(value)
  );
}

function hasLocalizedParticipantRolePrefix(value) {
  return /^(?:공식|公式|官方|管理员|管理員|系统|系統)/u.test(value);
}

function safeParticipantDisplayName(value) {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", "Invalid displayName");
  }
  const normalizedInput = value.normalize("NFKC");
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalizedInput)) {
    throw new HttpError(400, "invalid_display_name", "Invalid participant displayName");
  }
  const displayName = normalizedInput.trim().replace(/ +/gu, " ");
  const graphemeLength = unicodeGraphemeLength(displayName);
  const codePoints = Array.from(displayName);
  const combiningMarks = codePoints.filter((character) => /\p{M}/u.test(character)).length;
  const hasExcessiveCombiningSequence = /\p{M}{3,}/u.test(displayName);
  const hasAsciiLatin = /[A-Za-z]/u.test(displayName);
  const hasNonAsciiLatin = codePoints.some((character) =>
    /\p{Script=Latin}/u.test(character) && !/[A-Za-z]/u.test(character)
  );
  const scriptFamilyCount = [
    hasAsciiLatin,
    /\p{Script=Hangul}/u.test(displayName),
    /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script=Han}]/u.test(displayName)
  ].filter(Boolean).length;
  const hasMixedScripts = scriptFamilyCount > 1;
  const reservedKey = displayName
    .toLocaleLowerCase("und")
    .replace(/[ ._-]+/gu, "");
  const roleSkeleton = participantRoleSkeleton(reservedKey);
  if (
    graphemeLength < 1
    || graphemeLength > 24
    || codePoints.length > 72
    || combiningMarks > 8
    || hasNonAsciiLatin
    || (hasAsciiLatin && combiningMarks > 0)
    || hasExcessiveCombiningSequence
    || /[\p{Cc}\p{Cf}<>{}()\\:@]/u.test(displayName)
    || displayName.includes("[")
    || displayName.includes("]")
    || displayName.includes("/")
    || /\p{Default_Ignorable_Code_Point}/u.test(displayName)
    || /(?:^|\s)www\.|[\p{L}\p{N}][\p{L}\p{N}-]*\.[\p{L}\p{N}-]{2,}/iu.test(displayName)
    || /^(?:\p{N}{1,3}\.){3}\p{N}{1,3}$/u.test(displayName)
    || !/^[\p{Script=Hangul}\p{Script=Latin}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script=Han}\p{N}\p{M} ._-]+$/u.test(displayName)
    || !/[A-Za-z\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{N}]/u.test(displayName)
    || isReservedParticipantRoleKey(reservedKey)
    || isReservedParticipantRoleKey(roleSkeleton)
    || (
      hasMixedScripts
      && (
        isReservedParticipantRoleKey(reservedKey, true)
        || isReservedParticipantRoleKey(roleSkeleton, true)
      )
    )
    || /(?:소유자|관리자|운영자|시스템|퀵메모|오너|어드민|서포트)/u.test(reservedKey)
    || /(?:オーナー|所有者|管理者|運営者|システム|クイックメモ|アドミン|サポート)/u.test(reservedKey)
    || hasLocalizedParticipantRolePrefix(reservedKey)
    || /(?:quick|퀵|クイック)(?:memo|메모|メモ)/u.test(reservedKey)
  ) {
    throw new HttpError(400, "invalid_display_name", "Invalid participant displayName");
  }
  return {
    displayName,
    normalizedDisplayName: normalizedParticipantName(displayName)
  };
}

function participantIdentityHash(shareId, identityType, identityValue) {
  return hmacDigest(
    requiredSecret("SHARE_PARTICIPANT_HMAC_KEY"),
    "quickmemo/secure-share/participant-identity/v1",
    shareId,
    identityType,
    identityValue
  );
}

function participantIssuanceIdentity(shareId, browserBinding, unlockAttemptId) {
  return hmacDigest(
    requiredSecret("SHARE_PARTICIPANT_HMAC_KEY"),
    "quickmemo/secure-share/participant-issuance/v2",
    shareId,
    browserBinding,
    unlockAttemptId
  );
}

function participantTokenV2Signature(shareId, issuanceIdentity, nonce) {
  return hmacDigest(
    requiredSecret("SHARE_PARTICIPANT_HMAC_KEY"),
    "quickmemo/secure-share/participant-token-signature/v2",
    shareId,
    issuanceIdentity,
    nonce
  );
}

function issueAnonymousParticipantToken(shareId, browserBinding, unlockAttemptId) {
  const issuanceIdentity = participantIssuanceIdentity(
    shareId,
    browserBinding,
    unlockAttemptId
  );
  const nonce = randomToken(32);
  const signature = participantTokenV2Signature(
    shareId,
    issuanceIdentity,
    nonce
  );
  return {
    issuanceIdentity,
    token: `${participantTokenV2Prefix}${issuanceIdentity}${nonce}${signature}`,
    version: 2
  };
}

function verifiedAnonymousParticipantToken(shareId, token) {
  if (!token.startsWith(participantTokenV2Prefix)) {
    throw new HttpError(401, "participant_identity_invalid");
  }
  const expectedLength = participantTokenV2Prefix.length
    + participantTokenPartLength * 3;
  if (
    token.length !== expectedLength
    || !/^p2_[A-Za-z0-9_-]+$/u.test(token)
  ) {
    throw new HttpError(401, "participant_identity_invalid");
  }
  const issuanceStart = participantTokenV2Prefix.length;
  const nonceStart = issuanceStart + participantTokenPartLength;
  const signatureStart = nonceStart + participantTokenPartLength;
  const issuanceIdentity = token.slice(issuanceStart, nonceStart);
  const nonce = token.slice(nonceStart, signatureStart);
  const signature = token.slice(signatureStart);
  if (!constantTimeStringEqual(
    participantTokenV2Signature(
      shareId,
      issuanceIdentity,
      nonce
    ),
    signature
  )) {
    throw new HttpError(401, "participant_identity_invalid");
  }
  return {
    issuanceIdentity,
    version: 2
  };
}

function participantTokenIdentityDigest(shareId, issuanceIdentity) {
  return hmacDigest(
    requiredSecret("SHARE_PARTICIPANT_HMAC_KEY"),
    "quickmemo/secure-share/participant-token/v2",
    shareId,
    issuanceIdentity
  );
}

function participantIdFromIdentityHash(identityHash) {
  return `p_${identityHash.slice(0, 48)}`;
}

function participantNameRegistryId(shareId, normalizedDisplayName) {
  return `n_${hmacDigest(
    requiredSecret("SHARE_PARTICIPANT_HMAC_KEY"),
    "quickmemo/secure-share/participant-name/v1",
    shareId,
    normalizedDisplayName
  ).slice(0, 48)}`;
}

function participantDocumentPath(shareId, participantId) {
  return `publicShareParticipants/${shareId}/items/${participantId}`;
}

function participantCounterPath(shareId) {
  return `publicShareParticipantCounters/${shareId}`;
}

function participantNameRegistryPath(shareId, normalizedDisplayName) {
  return `publicShareParticipantNames/${shareId}/items/`
    + participantNameRegistryId(shareId, normalizedDisplayName);
}

function participantRenameRequestPath(shareId, participantId) {
  return `publicShareParticipantRenameRequests/${shareId}/items/${participantId}`;
}

function timestampMilliseconds(value) {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : Number.NaN;
  return Number.isFinite(milliseconds) ? milliseconds : Number.NaN;
}

function computeExpiresAt(body, currentExpiresAt = "") {
  const hasExpirationUpdate = body.expirationPreset !== undefined || body.customExpiresAt !== undefined;
  if (!hasExpirationUpdate && currentExpiresAt) {
    return new Date(currentExpiresAt);
  }
  if (!expirationPresets.has(body.expirationPreset)) {
    throw new HttpError(400, "invalid_request", "Invalid expirationPreset");
  }
  const now = Date.now();
  if (body.expirationPreset === "one_hour") {
    return new Date(now + 60 * 60 * 1000);
  }
  if (body.expirationPreset === "one_day") {
    return new Date(now + 24 * 60 * 60 * 1000);
  }
  if (body.expirationPreset === "seven_days") {
    return new Date(now + 7 * 24 * 60 * 60 * 1000);
  }
  const custom = timestampMilliseconds(body.customExpiresAt);
  if (custom < now + 5 * 60 * 1000 || custom > now + 365 * 24 * 60 * 60 * 1000) {
    throw new HttpError(400, "invalid_request", "Custom expiration must be 5 minutes to 365 days away");
  }
  return new Date(custom);
}

function sourceNoteActive(note) {
  return Boolean(note)
    && note.isDeleted !== true
    && note.isPurged !== true
    && typeof note.ownerUid === "string"
    && note.ownerUid;
}

class SourceFolderChainUnavailableError extends Error {
  constructor() {
    super("Secure Share source folder chain is unavailable");
    this.name = "SourceFolderChainUnavailableError";
  }
}

function sourceFolderChainUnavailable() {
  throw new SourceFolderChainUnavailableError();
}

function storedSourceFolderId(value) {
  if (
    typeof value !== "string"
    || !sourceFolderIdPattern.test(value)
    || unsafeSourceFolderIds.has(value)
  ) {
    sourceFolderChainUnavailable();
  }
  return value;
}

function sourceFolderLineageHint(folder, sourceFolderId) {
  if (folder?.vaultAncestorIds === undefined) {
    return null;
  }
  if (
    !Array.isArray(folder.vaultAncestorIds)
    || folder.vaultAncestorIds.length > maximumSourceFolderDepth
  ) {
    sourceFolderChainUnavailable();
  }
  const hint = folder.vaultAncestorIds.map(storedSourceFolderId);
  if (
    new Set(hint).size !== hint.length
    || hint.includes(sourceFolderId)
  ) {
    sourceFolderChainUnavailable();
  }
  return hint;
}

function activeOwnedSourceFolder(folder, ownerUid, folderId) {
  return Boolean(
    folder
    && folder.__id === folderId
    && folder.ownerUid === ownerUid
    && folder.isDeleted === false
    && folder.isPurged !== true
  );
}

async function sourceFolderChainSnapshot(
  context,
  note,
  ownerUid,
  transaction = ""
) {
  const rawFolderId = note?.folderId ?? null;
  if (rawFolderId === null) {
    return [];
  }
  const sourceFolderId = storedSourceFolderId(rawFolderId);
  const sourceFolderPath = `noteFolders/${sourceFolderId}`;
  const [sourceFolder] = await firestoreBatchGet(
    context,
    [sourceFolderPath],
    transaction
  );
  if (!activeOwnedSourceFolder(sourceFolder, ownerUid, sourceFolderId)) {
    sourceFolderChainUnavailable();
  }

  const lineageHint = sourceFolderLineageHint(sourceFolder, sourceFolderId);
  const foldersById = new Map([[sourceFolderId, sourceFolder]]);
  if (lineageHint?.length) {
    const hintedFolders = await firestoreBatchGet(
      context,
      lineageHint.map((folderId) => `noteFolders/${folderId}`),
      transaction
    );
    lineageHint.forEach((folderId, index) => {
      foldersById.set(folderId, hintedFolders[index]);
    });
  }

  const visited = new Set();
  const chain = [];
  let currentFolderId = sourceFolderId;
  while (currentFolderId !== null) {
    if (
      visited.has(currentFolderId)
      || visited.size > maximumSourceFolderDepth
    ) {
      sourceFolderChainUnavailable();
    }
    visited.add(currentFolderId);
    let folder = foldersById.get(currentFolderId);
    if (folder === undefined) {
      const [loaded] = await firestoreBatchGet(
        context,
        [`noteFolders/${currentFolderId}`],
        transaction
      );
      folder = loaded;
      foldersById.set(currentFolderId, folder);
    }
    if (!activeOwnedSourceFolder(folder, ownerUid, currentFolderId)) {
      sourceFolderChainUnavailable();
    }
    chain.push({
      document: folder,
      path: `noteFolders/${currentFolderId}`
    });
    if (folder.parentId === undefined || folder.parentId === null) {
      currentFolderId = null;
    } else {
      currentFolderId = storedSourceFolderId(folder.parentId);
    }
  }

  if (lineageHint) {
    const actualAncestors = chain
      .slice(1)
      .map(({ document }) => document.__id)
      .reverse();
    if (
      actualAncestors.length !== lineageHint.length
      || actualAncestors.some((folderId, index) => folderId !== lineageHint[index])
    ) {
      sourceFolderChainUnavailable();
    }
  }
  return chain;
}

function shareSummary(share) {
  return {
    id: share.__id,
    shareId: share.__id,
    schemaVersion: 2,
    sourceNoteId: share.sourceNoteId,
    sourceRevision: Number.isSafeInteger(share.sourceRevision) ? share.sourceRevision : 0,
    sourceAttachmentRevision: Number.isSafeInteger(share.sourceAttachmentRevision)
      ? share.sourceAttachmentRevision
      : 0,
    ...(share.sourceSyncMode === "revision_bound"
      ? { sourceSyncMode: "revision_bound" }
      : {}),
    contentRevision: Number.isSafeInteger(share.contentRevision) && share.contentRevision >= 1
      ? share.contentRevision
      : 1,
    currentGeneration: share.currentGeneration ?? "",
    status: share.status,
    ready: share.ready === true,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
    expiresAt: share.expiresAt,
    policyVersion: share.policyVersion,
    accessMode: share.accessModePublicHint,
    hasPassword: share.hasPassword === true,
    requiresEmailVerification: share.requiresEmailVerification === true,
    oneTimeEnabled: share.oneTimeEnabled === true,
    permissionLevel: share.permissionLevel,
    showCommenterIpPrefix: share.showCommenterIpPrefix === true,
    downloadAllowed: share.downloadAllowed === true,
    quickCopyButtonVisible: share.quickCopyButtonVisible !== false,
    attachmentCount: Number.isSafeInteger(share.attachmentCount) ? share.attachmentCount : 0,
    consumedAt: share.consumedAt ?? null,
    revokedAt: share.revokedAt ?? null,
    lastAccessAt: share.lastAccessAt ?? null,
    successfulAccessCount: Number.isSafeInteger(share.successfulAccessCount) ? share.successfulAccessCount : 0
  };
}

const ownerShareSummaryFieldPaths = [
  "schemaVersion",
  "sourceNoteId",
  "sourceRevision",
  "sourceAttachmentRevision",
  "sourceSyncMode",
  "contentRevision",
  "currentGeneration",
  "ownerUid",
  "status",
  "ready",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "policyVersion",
  "accessModePublicHint",
  "hasPassword",
  "requiresEmailVerification",
  "oneTimeEnabled",
  "permissionLevel",
  "showCommenterIpPrefix",
  "downloadAllowed",
  "quickCopyButtonVisible",
  "attachmentCount",
  "consumedAt",
  "revokedAt",
  "lastAccessAt",
  "successfulAccessCount"
];

function policySummary(policy) {
  return {
    accessMode: policy.accessMode,
    passwordEnabled: policy.passwordEnabled === true,
    emailVerificationRequired: policy.emailVerificationRequired === true,
    allowedEmailCount: Number.isSafeInteger(policy.allowedEmailCount) ? policy.allowedEmailCount : 0,
    oneTimeEnabled: policy.oneTimeEnabled === true,
    oneTimeScope: "global",
    permissionLevel: policy.permissionLevel,
    showCommenterIpPrefix:
      policy.permissionLevel === "comment"
      && policy.showCommenterIpPrefix === true,
    downloadAllowed: policy.downloadAllowed === true,
    quickCopyButtonVisible: policy.quickCopyButtonVisible !== false,
    policyVersion: policy.policyVersion,
    sessionTtlSeconds: policy.sessionTtlSeconds,
    oneTimeSessionTtlSeconds: policy.oneTimeSessionTtlSeconds
  };
}

function persistedPolicySettings(settings) {
  const persisted = { ...settings };
  delete persisted.allowedEmails;
  return persisted;
}

function emailPolicyRequiresRuntime(policy) {
  return Boolean(
    policy?.accessMode === "allowed_emails"
    || policy?.emailVerificationRequired === true
  );
}

function assertEmailPolicyAvailable(
  policy,
  runtimeSnapshot = secureShareEmailReadiness()
) {
  if (
    emailPolicyRequiresRuntime(policy)
    && runtimeSnapshot?.ready !== true
  ) {
    throw new HttpError(
      503,
      "email_feature_unavailable",
      "Secure Share email is unavailable"
    );
  }
}

async function emailRuntimeForPolicy(context, policy) {
  if (!emailPolicyRequiresRuntime(policy)) {
    return null;
  }
  const runtimeSnapshot = await safeSecureShareEmailRuntimeSnapshot(context, {
    allowCache: false
  });
  assertEmailPolicyAvailable(policy, runtimeSnapshot);
  return runtimeSnapshot;
}

async function secureContext(request) {
  const context = await createFirestoreContext();
  await verifySecureShareAppCheck(request, context);
  return context;
}

async function ownerContext(request) {
  const context = await secureContext(request);
  return activeUserFromRequest(request, context);
}

async function loadShareState(context, shareId) {
  const [share, policy] = await Promise.all([
    firestoreGet(context, `publicNoteShares/${shareId}`),
    firestoreGet(context, `publicSharePolicies/${shareId}`)
  ]);
  if (!share || !policy || share.schemaVersion !== 2 || policy.schemaVersion !== 2) {
    return null;
  }
  return { share, policy };
}

function sourceShareGuardId(ownerUid, sourceNoteId) {
  return `source_${hmacDigest(
    requiredSecret("SHARE_SESSION_HMAC_KEY"),
    "quickmemo/secure-share/source-guard/v1",
    safeId(ownerUid, "ownerUid"),
    safeId(sourceNoteId, "sourceNoteId")
  ).slice(0, 48)}`;
}

function sourceShareGuardPath(ownerUid, sourceNoteId) {
  return `publicShareSourceGuards/${sourceShareGuardId(ownerUid, sourceNoteId)}`;
}

function sourceShareBlocksCreation(share, ownerUid, sourceNoteId, now = Date.now()) {
  return Boolean(
    share
    && share.schemaVersion === 2
    && share.ownerUid === ownerUid
    && share.sourceNoteId === sourceNoteId
    && new Set(["pending", "active"]).has(share.status)
    && !share.revokedAt
    && timestampMilliseconds(share.expiresAt) > now
  );
}

async function waitBeforeOptimisticRetry(attempt) {
  const baseDelayMilliseconds = Math.min(
    optimisticRetryMaximumDelayMilliseconds,
    15 * (2 ** Math.min(attempt, 5))
  );
  await delay(
    baseDelayMilliseconds
      + randomInt(0, baseDelayMilliseconds + 1)
  );
}

function sourceShareGuardMatches(
  guard,
  ownerUid,
  sourceNoteId,
  shareId = ""
) {
  return Boolean(
    guard
    && guard.schemaVersion === 1
    && guard.ownerUid === ownerUid
    && guard.sourceNoteId === sourceNoteId
    && typeof guard.shareId === "string"
    && guard.shareId
    && (!shareId || guard.shareId === shareId)
  );
}

async function blockingSourceShareFromGuard(
  context,
  guardPath,
  ownerUid,
  sourceNoteId
) {
  const guard = await firestoreGet(context, guardPath);
  if (!sourceShareGuardMatches(guard, ownerUid, sourceNoteId)) {
    return null;
  }
  const state = await loadShareState(context, guard.shareId);
  return sourceShareBlocksCreation(state?.share, ownerUid, sourceNoteId)
    ? state.share
    : null;
}

async function beginShareMutationTransaction(context, shareId) {
  const { documents, transaction } = await firestoreBatchGetNewTransaction(
    context,
    [
      `publicNoteShares/${shareId}`,
      `publicSharePolicies/${shareId}`
    ]
  );
  const [share, policy] = documents;
  const state = share
    && policy
    && share.schemaVersion === 2
    && policy.schemaVersion === 2
      ? { share, policy }
      : null;
  return { state, transaction };
}

async function rollbackShareMutation(context, transaction) {
  await firestoreRollback(context, transaction).catch(() => undefined);
}

function shareMutationSnapshotMatches(current, expected) {
  return Boolean(
    current
    && expected
    && current.share.__id === expected.share.__id
    && current.share.ownerUid === expected.share.ownerUid
    && current.share.policyVersion === expected.share.policyVersion
    && current.policy.policyVersion === expected.policy.policyVersion
    && publicShareAvailable(current)
  );
}

function shareOwnedBy(state, user) {
  return Boolean(state && user && state.share.ownerUid === user.uid);
}

function shareManagedBy(state, user) {
  return Boolean(shareOwnedBy(state, user) || (state && user?.isAdmin === true));
}

function requireOwner(state, user) {
  if (!shareOwnedBy(state, user)) {
    throw new HttpError(404, "not_found", "Share owner check failed");
  }
}

function requireShareManager(state, user) {
  if (!shareManagedBy(state, user)) {
    throw new HttpError(404, "not_found", "Share manager check failed");
  }
}

function sourceLifecycleAvailable(share, note, ownerProfile) {
  return sourceNoteActive(note)
    && ownerProfile?.isActive === true
    && (
      ownerProfile?.isAdmin === true
      || !isPlainRecord(ownerProfile?.featureAccess)
      || ownerProfile.featureAccess.notes === true
    )
    && note.ownerUid === share?.ownerUid;
}

function legacyAutomaticSourceRevokeBlocked(
  idempotencyKey,
  share,
  note,
  ownerProfile,
  liveContentSyncEnabled = secureShareLiveContentSyncEnabled()
) {
  return liveContentSyncEnabled === true
    && legacyAutomaticSourceRevokePattern.test(idempotencyKey)
    && sourceLifecycleAvailable(share, note, ownerProfile);
}

function sourceRevisionMatches(share, note) {
  const noteRevision = Number.isSafeInteger(note?.revision) ? note.revision : 0;
  const noteAttachmentRevision = Number.isSafeInteger(note?.attachmentRevision) ? note.attachmentRevision : 0;
  const shareRevision = Number.isSafeInteger(share?.sourceRevision) ? share.sourceRevision : 0;
  const shareAttachmentRevision = Number.isSafeInteger(share?.sourceAttachmentRevision)
    ? share.sourceAttachmentRevision
    : 0;
  return noteRevision === shareRevision
    && noteAttachmentRevision === shareAttachmentRevision;
}

function storedSourceSyncMode(share) {
  if (!Object.prototype.hasOwnProperty.call(share ?? {}, "sourceSyncMode")) {
    return "live";
  }
  return share?.sourceSyncMode === "revision_bound"
    ? "revision_bound"
    : "invalid";
}

function sourceReadAvailable(
  share,
  note,
  ownerProfile,
  liveContentSyncEnabled = secureShareLiveContentSyncEnabled()
) {
  const sourceSyncMode = storedSourceSyncMode(share);
  return sourceLifecycleAvailable(share, note, ownerProfile)
    && sourceSyncMode !== "invalid"
    && (
      sourceSyncMode === "revision_bound"
        ? sourceRevisionMatches(share, note)
        : liveContentSyncEnabled === true
          || sourceRevisionMatches(share, note)
    );
}

// Retained as a compatibility export for lifecycle-only callers.
function sourceSnapshotAvailable(share, note, ownerProfile) {
  return sourceLifecycleAvailable(share, note, ownerProfile);
}

function contentRevisionValue(share) {
  return Number.isSafeInteger(share?.contentRevision) && share.contentRevision >= 1
    ? share.contentRevision
    : 1;
}

function contentUpdateRequestDigest(input) {
  return sha256Digest(JSON.stringify({
    idempotencyKey: input.idempotencyKey,
    expectedContentRevision: input.expectedContentRevision,
    expectedSourceRevision: input.expectedSourceRevision,
    expectedSourceAttachmentRevision: input.expectedSourceAttachmentRevision,
    sourceRevision: input.sourceRevision,
    sourceAttachmentRevision: input.sourceAttachmentRevision,
    generation: input.generation,
    attachmentCount: input.attachmentCount,
    retainedAttachmentIds: input.retainedAttachmentIds,
    encryptedTitle: input.encryptedTitle,
    encryptedBody: input.encryptedBody
  }));
}

function contentUpdateDisposition(share, input, requestDigest) {
  if (share?.lastContentMutationId === input.idempotencyKey) {
    return typeof share.lastContentMutationDigest === "string"
      && constantTimeStringEqual(share.lastContentMutationDigest, requestDigest)
      ? "replay"
      : "conflict";
  }
  if (
    contentRevisionValue(share) !== input.expectedContentRevision
    || (Number.isSafeInteger(share?.sourceRevision) ? share.sourceRevision : 0)
      !== input.expectedSourceRevision
    || (Number.isSafeInteger(share?.sourceAttachmentRevision)
      ? share.sourceAttachmentRevision
      : 0) !== input.expectedSourceAttachmentRevision
  ) {
    return "stale";
  }
  return "apply";
}

function secureShareRevisionEtag(share) {
  const policyVersion = Number.isSafeInteger(share?.policyVersion) && share.policyVersion >= 1
    ? share.policyVersion
    : 1;
  return `"ss2-r${contentRevisionValue(share)}-p${policyVersion}"`;
}

function etagMatches(value, expected) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) {
    return false;
  }
  const normalizedExpected = expected.replace(/^W\//u, "");
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//u, "");
    return normalized === "*" || constantTimeStringEqual(normalized, normalizedExpected);
  });
}

function ensureRevisionReadRequest(request) {
  if (headerValue(request, "x-quickmemo-secure-share-revision").trim() !== "1") {
    throw new HttpError(403, "request_rejected", "Revision request marker is missing");
  }
  if (headerValue(request, "sec-fetch-site").trim().toLowerCase() !== "same-origin") {
    throw new HttpError(403, "request_rejected", "Cross-site revision request rejected");
  }
  if (headerValue(request, "origin")) {
    ensureSameOrigin(request);
  }
}

async function requireSourceAvailable(context, share, validatedOwner = null) {
  const ownerAlreadyValidated = validatedOwner?.uid === share?.ownerUid;
  const sourceNoteId = safeId(share.sourceNoteId, "sourceNoteId");
  const ownerUid = safeId(share.ownerUid, "ownerUid");
  const sourcePaths = [
    `notes/${sourceNoteId}`,
    ...(ownerAlreadyValidated ? [] : [`users/${ownerUid}`])
  ];
  const sourceDocuments = await Promise.all(sourcePaths.map((path) =>
    firestoreGet(context, path)
  ));
  const note = sourceDocuments[0];
  const ownerProfile = ownerAlreadyValidated
    ? {
        isActive: true,
        isAdmin: validatedOwner.isAdmin === true,
        featureAccess: { notes: true }
      }
    : sourceDocuments[1];
  if (!sourceReadAvailable(share, note, ownerProfile)) {
    throw new HttpError(404, "share_unavailable", "Source note is unavailable");
  }
  let folderChain;
  try {
    folderChain = await sourceFolderChainSnapshot(
      context,
      note,
      ownerUid
    );
  } catch (error) {
    if (error instanceof SourceFolderChainUnavailableError) {
      throw new HttpError(404, "share_unavailable", "Source folder is unavailable");
    }
    throw error;
  }
  return {
    note,
    snapshotDocuments: [
      { document: note, path: `notes/${sourceNoteId}` },
      ...(
        ownerAlreadyValidated
          ? []
          : [{ document: ownerProfile, path: `users/${ownerUid}` }]
      ),
      ...folderChain
    ]
  };
}

function sourceAvailabilityVerifyWrites(context, sourceAvailability) {
  return sourceAvailability.snapshotDocuments.map(({ document, path }) =>
    verifyDocumentSnapshotWrite(
      context.projectId,
      path,
      document.__updateTime
    )
  );
}

function publicShareAvailable(state, now = Date.now()) {
  if (!state) {
    return false;
  }
  const { share, policy } = state;
  return share.schemaVersion === 2
    && policy.schemaVersion === 2
    && share.ready === true
    && new Set(["active", "consumed"]).has(share.status)
    && !share.revokedAt
    && timestampMilliseconds(share.expiresAt) > now
    && policy.policyVersion === share.policyVersion;
}

function assertPublicShareAvailable(state) {
  if (!publicShareAvailable(state)) {
    throw new HttpError(404, "share_unavailable", "Share is unavailable");
  }
}

function createAuditWrite(context, share, eventType, result, details = {}) {
  const id = details.eventId
    ? safeId(details.eventId, "eventId")
    : `evt_${randomToken(18)}`;
  const now = new Date();
  return createDocumentWrite(
    context.projectId,
    `publicShareAuditEvents/${share.__id}/items/${id}`,
    {
      shareId: share.__id,
      ownerUid: share.ownerUid,
      eventType,
      result,
      requestId: details.requestId ?? "",
      identityType: details.identityType ?? "none",
      identityHash: details.identityHash ?? "",
      ipHash: details.ipHash ?? "",
      userAgentHash: details.userAgentHash ?? "",
      reasonCode: details.reasonCode ?? "",
      policyVersion: share.policyVersion,
      createdAt: now,
      retentionExpiresAt: new Date(now.getTime() + auditRetentionMilliseconds)
    }
  );
}

function rateLimitWindowStarts(nowMilliseconds, definition) {
  if (
    !Number.isSafeInteger(nowMilliseconds)
    || nowMilliseconds < 0
    || !Number.isSafeInteger(definition?.windowSeconds)
    || definition.windowSeconds < 1
  ) {
    throw new HttpError(503, "service_unavailable", "Rate limit window is invalid", {
      expose: false
    });
  }
  const windowStartSeconds =
    Math.floor(nowMilliseconds / 1000 / definition.windowSeconds) * definition.windowSeconds;
  if (definition.rollingWindowHours === undefined) {
    return [windowStartSeconds];
  }
  if (
    definition.windowSeconds !== 60 * 60
    || !Number.isSafeInteger(definition.rollingWindowHours)
    || definition.rollingWindowHours < 1
    || definition.rollingWindowHours > 168
  ) {
    throw new HttpError(503, "service_unavailable", "Rolling rate limit window is invalid", {
      expose: false
    });
  }
  return Array.from(
    { length: definition.rollingWindowHours + 1 },
    (_, index) => windowStartSeconds - index * definition.windowSeconds
  );
}

async function consumeRateLimits(context, definitions) {
  if (!definitions.length) {
    return [];
  }
  for (let attempt = 0; attempt < rateLimitTransactionMaximumAttempts; attempt += 1) {
    const nowMilliseconds = Date.now();
    const states = await Promise.all(definitions.map(async (definition) => {
      const windowStarts = rateLimitWindowStarts(nowMilliseconds, definition);
      const buckets = await Promise.all(windowStarts.map(async (windowStartSeconds) => {
        const bucketId = rateLimitBucketDigest(
          definition.limitType,
          [...definition.keyParts, String(windowStartSeconds)]
        );
        const path = `publicShareRateLimits/${bucketId}`;
        const document = await firestoreGet(context, path);
        if (
          document
          && (
            !Number.isSafeInteger(document.count)
            || document.count < 0
          )
        ) {
          throw new HttpError(
            503,
            "service_unavailable",
            "Rate limit state is invalid",
            { expose: false }
          );
        }
        return {
          bucketId,
          count: document?.count ?? 0,
          document,
          path,
          windowStartSeconds
        };
      }));
      const current = buckets[0];
      const enforcementCount = buckets.reduce(
        (total, bucket) => total + bucket.count,
        0
      );
      if (enforcementCount >= definition.limit) {
        const retryAfter = Math.max(
          1,
          current.windowStartSeconds
            + definition.windowSeconds
            - Math.floor(nowMilliseconds / 1000)
        );
        throw new HttpError(429, "rate_limited", "Rate limit exceeded", { retryAfter });
      }
      return {
        buckets,
        current,
        definition,
        enforcementCount,
        previousWindowLock: definition.rollingWindowHours === undefined
          ? null
          : buckets[1]
      };
    }));
    const bucketWrite = (definition, bucket, count) => {
      const retentionWindows = definition.rollingWindowHours === undefined
        ? 2
        : definition.rollingWindowHours + 2;
      const fields = {
        shareId: definition.shareId,
        ownerUid: definition.ownerUid ?? "",
        limitType: definition.limitType,
        windowStart: new Date(bucket.windowStartSeconds * 1000),
        count,
        updatedAt: new Date(nowMilliseconds),
        expiresAt: new Date((
          bucket.windowStartSeconds + definition.windowSeconds * retentionWindows
        ) * 1000)
      };
      return bucket.document
        ? updateDocumentWrite(
          context.projectId,
          bucket.path,
          fields,
          ["shareId", "ownerUid", "limitType", "windowStart", "count", "updatedAt", "expiresAt"],
          bucket.document.__updateTime
        )
        : createDocumentWrite(context.projectId, bucket.path, fields);
    };
    const writes = states.flatMap(({ current, definition, previousWindowLock }) => [
      bucketWrite(definition, current, current.count + 1),
      ...(previousWindowLock
        ? [bucketWrite(definition, previousWindowLock, previousWindowLock.count)]
        : [])
    ]);
    try {
      await firestoreCommit(context, writes);
      return states.map(({ current }) => current.path);
    } catch (error) {
      if (!isOptimisticConflict(error)) {
        throw error;
      }
      if (attempt < rateLimitTransactionMaximumAttempts - 1) {
        await waitBeforeOptimisticRetry(attempt);
        continue;
      }
      throw new HttpError(
        503,
        "service_unavailable",
        "Rate limit update did not converge",
        { expose: false }
      );
    }
  }
  return [];
}

async function releaseRateLimitReservations(context, paths) {
  if (!paths.length) {
    return;
  }
  for (let attempt = 0; attempt < rateLimitTransactionMaximumAttempts; attempt += 1) {
    const documents = await Promise.all(paths.map((path) => firestoreGet(context, path)));
    const writes = documents.flatMap((document, index) => {
      if (!document) {
        return [];
      }
      const count = Number.isSafeInteger(document.count) ? document.count : 0;
      if (count <= 1) {
        return [deleteDocumentWrite(context.projectId, paths[index], document.__updateTime)];
      }
      return [updateDocumentWrite(
        context.projectId,
        paths[index],
        { count: count - 1, updatedAt: new Date() },
        ["count", "updatedAt"],
        document.__updateTime
      )];
    });
    if (!writes.length) {
      return;
    }
    try {
      await firestoreCommit(context, writes);
      return;
    } catch (error) {
      if (!isOptimisticConflict(error)) {
        throw error;
      }
      if (attempt < rateLimitTransactionMaximumAttempts - 1) {
        await waitBeforeOptimisticRetry(attempt);
        continue;
      }
      throw new HttpError(
        503,
        "service_unavailable",
        "Rate limit release did not converge",
        { expose: false }
      );
    }
  }
}

function policyInputKeys() {
  return [
    "accessMode",
    "password",
    "passwordEnabled",
    "emailVerificationRequired",
    "allowedEmails",
    "oneTimeEnabled",
    "expirationPreset",
    "customExpiresAt",
    "permissionLevel",
    "showCommenterIpPrefix",
    "downloadAllowed",
    "quickCopyButtonVisible",
    "oneTimeScope"
  ];
}

async function buildPolicySettings(body, existingPolicy = null, context = null) {
  const accessMode = body.accessMode ?? existingPolicy?.accessMode ?? "anyone_with_link";
  if (!accessModes.has(accessMode)) {
    throw new HttpError(400, "invalid_request", "Invalid accessMode");
  }
  const permissionLevel = body.permissionLevel ?? existingPolicy?.permissionLevel ?? "view";
  if (!permissionLevels.has(permissionLevel)) {
    throw new HttpError(400, "invalid_request", "Invalid permissionLevel");
  }
  const showCommenterIpPrefix = permissionLevel === "comment"
    && optionalBoolean(
      body.showCommenterIpPrefix,
      existingPolicy
        ? existingPolicy.showCommenterIpPrefix === true
        : true,
      "showCommenterIpPrefix"
    );
  const oneTimeEnabled = optionalBoolean(
    body.oneTimeEnabled,
    existingPolicy?.oneTimeEnabled === true,
    "oneTimeEnabled"
  );
  if (body.oneTimeScope !== undefined && body.oneTimeScope !== "global") {
    throw new HttpError(400, "invalid_request", "Only global one-time scope is supported");
  }
  const downloadAllowed = optionalBoolean(
    body.downloadAllowed,
    existingPolicy ? existingPolicy.downloadAllowed === true : true,
    "downloadAllowed"
  );
  const quickCopyButtonVisible = optionalBoolean(
    body.quickCopyButtonVisible,
    existingPolicy ? existingPolicy.quickCopyButtonVisible !== false : true,
    "quickCopyButtonVisible"
  );
  const emailVerificationRequired = accessMode === "allowed_emails"
    ? true
    : optionalBoolean(
      body.emailVerificationRequired,
      existingPolicy?.emailVerificationRequired === true,
      "emailVerificationRequired"
    );
  if (emailVerificationRequired) {
    if (!context) {
      throw new HttpError(
        503,
        "email_feature_unavailable",
        "Email verification is not configured"
      );
    }
    await emailRuntimeForPolicy(context, {
      accessMode,
      emailVerificationRequired
    });
  }

  let allowedEmails = null;
  let allowedEmailHashes = existingPolicy?.allowedEmailHashes ?? [];
  if (accessMode === "allowed_emails") {
    if (body.allowedEmails !== undefined) {
      allowedEmails = normalizeAllowedEmails(body.allowedEmails);
      allowedEmailHashes = allowedEmails.map((email) => emailDigest(email));
    }
    if (!Array.isArray(allowedEmailHashes) || allowedEmailHashes.length < 1 || allowedEmailHashes.length > 100) {
      throw new HttpError(400, "invalid_email_list");
    }
  } else {
    allowedEmails = [];
    allowedEmailHashes = [];
  }

  let passwordHashRecord = existingPolicy?.passwordHashRecord;
  let passwordEnabled = existingPolicy?.passwordEnabled === true;
  if (!existingPolicy) {
    const requested = body.passwordEnabled === true;
    if (requested) {
      passwordHashRecord = await hashSharePassword(body.password);
      passwordEnabled = true;
    } else {
      if (body.password !== undefined || (body.passwordEnabled !== undefined && body.passwordEnabled !== false)) {
        throw new HttpError(400, "invalid_request", "Invalid password settings");
      }
      passwordHashRecord = undefined;
      passwordEnabled = false;
    }
  } else {
    const requested = body.passwordEnabled ?? passwordEnabled;
    if (typeof requested !== "boolean") {
      throw new HttpError(400, "invalid_request", "Invalid passwordEnabled");
    }
    if (requested && body.password !== undefined) {
      passwordHashRecord = await hashSharePassword(body.password);
      passwordEnabled = true;
    } else if (!requested) {
      passwordHashRecord = undefined;
      passwordEnabled = false;
    } else if (!passwordEnabled || !passwordHashRecord) {
      throw new HttpError(400, "invalid_request", "A password is required when enabling password access");
    }
  }

  return {
    accessMode,
    passwordEnabled,
    passwordHashRecord,
    emailVerificationRequired,
    allowedEmailHashes,
    allowedEmails,
    allowedEmailCount: allowedEmailHashes.length,
    oneTimeEnabled,
    oneTimeScope: "global",
    permissionLevel,
    showCommenterIpPrefix,
    downloadAllowed,
    quickCopyButtonVisible,
    sessionTtlSeconds: sessionTtlSeconds(false),
    oneTimeSessionTtlSeconds: sessionTtlSeconds(true)
  };
}

function validateCreateBody(body) {
  assertOnlyKeys(body, [
    "sourceNoteId",
    "sourceRevision",
    "sourceAttachmentRevision",
    "sourceSyncMode",
    "encryptedTitle",
    "encryptedBody",
    "ownerWrappedShareKey",
    "currentGeneration",
    "attachmentCount",
    "idempotencyKey",
    "policy"
  ]);
  if (!isPlainRecord(body.policy)) {
    throw new HttpError(400, "invalid_request", "policy is required");
  }
  if (
    body.sourceSyncMode !== undefined
    && body.sourceSyncMode !== "revision_bound"
  ) {
    throw new HttpError(400, "invalid_request", "Invalid sourceSyncMode");
  }
  assertOnlyKeys(body.policy, policyInputKeys());
  return {
    sourceNoteId: safeId(body.sourceNoteId, "sourceNoteId"),
    sourceRevision: boundedInteger(body.sourceRevision, "sourceRevision", 0, 1_000_000_000),
    sourceAttachmentRevision: boundedInteger(
      body.sourceAttachmentRevision,
      "sourceAttachmentRevision",
      0,
      1_000_000_000
    ),
    sourceSyncMode: body.sourceSyncMode ?? "live",
    encryptedTitle: encryptedPayload(body.encryptedTitle, "encryptedTitle", 64 * 1024),
    encryptedBody: encryptedPayload(body.encryptedBody, "encryptedBody", 2 * 1024 * 1024),
    ownerWrappedShareKey: wrappedShareKey(body.ownerWrappedShareKey),
    currentGeneration: body.currentGeneration ? safeId(body.currentGeneration, "currentGeneration") : "",
    attachmentCount: optionalSafeInteger(body.attachmentCount, "attachmentCount", 0, 100) ?? 0,
    idempotencyKey: body.idempotencyKey === undefined
      ? ""
      : safeUnlockAttemptId(body.idempotencyKey)
  };
}

function sourceSyncModeMatchesCreate(share, input) {
  return storedSourceSyncMode(share) === input.sourceSyncMode;
}

function sourceShareHistoryQuery(ownerUid, sourceNoteId) {
  return {
    select: {
      fields: ownerShareSummaryFieldPaths.map((fieldPath) => ({ fieldPath }))
    },
    from: [{ collectionId: "publicNoteShares" }],
    where: {
      compositeFilter: {
        op: "AND",
        filters: [
          {
            fieldFilter: {
              field: { fieldPath: "ownerUid" },
              op: "EQUAL",
              value: firestoreStringValue(ownerUid)
            }
          },
          {
            fieldFilter: {
              field: { fieldPath: "sourceNoteId" },
              op: "EQUAL",
              value: firestoreStringValue(sourceNoteId)
            }
          }
        ]
      }
    },
    limit: maximumSourceShareHistory + 1
  };
}

async function readSourceShareHistory(
  context,
  ownerUid,
  sourceNoteId,
  transaction = ""
) {
  const documents = await firestoreRunQuery(
    context,
    sourceShareHistoryQuery(ownerUid, sourceNoteId),
    "",
    transaction
  );
  if (documents.length > maximumSourceShareHistory) {
    throw new HttpError(
      409,
      "source_share_history_too_large",
      "Source note share history exceeded its safe complete-read bound"
    );
  }
  return documents;
}

function ownedSourceShareHistory(documents, ownerUid, sourceNoteId, status = "") {
  return documents
    .filter((share) =>
      share.schemaVersion === 2
      && share.ownerUid === ownerUid
      && share.sourceNoteId === sourceNoteId
      && ownerShareStatuses.has(share.status)
      && (!status || share.status === status)
    )
    .sort((left, right) => {
      const createdDifference =
        timestampMilliseconds(right.createdAt) - timestampMilliseconds(left.createdAt);
      if (Number.isFinite(createdDifference) && createdDifference !== 0) {
        return createdDifference;
      }
      return String(right.__name).localeCompare(String(left.__name));
    });
}

function sourceNoteMatchesCreate(note, ownerUid, input) {
  const actualRevision = Number.isSafeInteger(note?.revision) ? note.revision : 0;
  const actualAttachmentRevision = Number.isSafeInteger(note?.attachmentRevision)
    ? note.attachmentRevision
    : 0;
  return sourceNoteActive(note)
    && note.ownerUid === ownerUid
    && actualRevision === input.sourceRevision
    && actualAttachmentRevision === input.sourceAttachmentRevision;
}

async function requireSourceCreateAvailable(
  context,
  note,
  ownerUid,
  input,
  transaction = ""
) {
  const concurrentCheck = Boolean(transaction);
  if (!sourceNoteMatchesCreate(note, ownerUid, input)) {
    throw new HttpError(
      concurrentCheck ? 409 : 404,
      concurrentCheck ? "source_state_changed" : "not_found",
      "Source note is unavailable for share creation"
    );
  }
  try {
    await sourceFolderChainSnapshot(context, note, ownerUid, transaction);
  } catch (error) {
    if (error instanceof SourceFolderChainUnavailableError) {
      throw new HttpError(
        concurrentCheck ? 409 : 404,
        concurrentCheck ? "source_state_changed" : "not_found",
        "Source folder is unavailable for share creation"
      );
    }
    throw error;
  }
}

async function handleOwnerCreate(request, response, id) {
  requireMethod(request, ["POST"]);
  ensureSameOrigin(request);
  const body = await readJsonBody(request);
  const input = validateCreateBody(body);
  const user = await ownerContext(request);
  const context = user.context;
  const note = await firestoreGet(context, `notes/${input.sourceNoteId}`);
  await requireSourceCreateAvailable(context, note, user.uid, input);
  const shareId = input.idempotencyKey
    ? `ss2_${hmacDigest(
      requiredSecret("SHARE_SESSION_HMAC_KEY"),
      "quickmemo/secure-share/create-idempotency/v1",
      user.uid,
      input.idempotencyKey
    ).slice(0, 24)}`
    : `ss2_${randomToken(18)}`;
  const existing = await loadShareState(context, shareId);
  if (existing) {
    requireOwner(existing, user);
    if (
      existing.share.sourceNoteId !== input.sourceNoteId
      || !sourceSyncModeMatchesCreate(existing.share, input)
    ) {
      throw new HttpError(
        409,
        "request_conflict",
        "Share creation idempotency key was reused for another request"
      );
    }
    jsonResponse(response, 200, {
      ok: true,
      created: false,
      share: shareSummary(existing.share),
      requestId: id
    });
    return;
  }
  const createRateLimitReservations = await consumeRateLimits(context, [
    {
      limitType: "share_create_owner_hour",
      keyParts: [user.uid],
      shareId: "owner_create",
      ownerUid: user.uid,
      windowSeconds: 60 * 60,
      limit: 20
    },
    {
      limitType: "share_create_owner_day",
      keyParts: [user.uid],
      shareId: "owner_create",
      ownerUid: user.uid,
      windowSeconds: 24 * 60 * 60,
      limit: 100
    }
  ]);
  const policySettings = await buildPolicySettings(body.policy, null, context);
  const expiresAt = computeExpiresAt(body.policy);

  const now = new Date();
  const policyVersion = 1;
  const share = {
    schemaVersion: 2,
    version: 2,
    sourceNoteId: input.sourceNoteId,
    sourceRevision: input.sourceRevision,
    sourceAttachmentRevision: input.sourceAttachmentRevision,
    ...(input.sourceSyncMode === "revision_bound"
      ? { sourceSyncMode: "revision_bound" }
      : {}),
    contentRevision: 1,
    ownerUid: user.uid,
    status: "pending",
    ready: false,
    createdAt: now,
    updatedAt: now,
    contentUpdatedAt: now,
    expiresAt,
    policyVersion,
    encryptedTitle: input.encryptedTitle,
    encryptedBody: input.encryptedBody,
    ownerWrappedShareKey: input.ownerWrappedShareKey,
    currentGeneration: input.currentGeneration,
    attachmentCount: input.attachmentCount,
    accessModePublicHint: policySettings.accessMode,
    hasPassword: policySettings.passwordEnabled,
    requiresEmailVerification: policySettings.emailVerificationRequired,
    oneTimeEnabled: policySettings.oneTimeEnabled,
    permissionLevel: policySettings.permissionLevel,
    showCommenterIpPrefix: policySettings.showCommenterIpPrefix,
    downloadAllowed: policySettings.downloadAllowed,
    quickCopyButtonVisible: policySettings.quickCopyButtonVisible,
    successfulAccessCount: 0
  };
  const policy = {
    schemaVersion: 2,
    shareId,
    ownerUid: user.uid,
    ...persistedPolicySettings(policySettings),
    policyVersion,
    createdAt: now,
    updatedAt: now,
    expiresAt
  };
  const writes = [
    createDocumentWrite(context.projectId, `publicNoteShares/${shareId}`, share),
    createDocumentWrite(context.projectId, `publicSharePolicies/${shareId}`, policy),
    createDocumentWrite(context.projectId, `publicShareCleanupQueue/${shareId}`, {
      shareId,
      ownerUid: user.uid,
      expiresAt,
      createdAt: now
    })
  ];
  for (const normalizedEmail of policySettings.allowedEmails ?? []) {
    const hashedEmail = emailDigest(normalizedEmail);
    writes.push(createDocumentWrite(
      context.projectId,
      `publicShareRecipients/${shareId}/items/em_${hashedEmail.slice(0, 40)}`,
      {
        shareId,
        ownerUid: user.uid,
        emailHash: hashedEmail,
        ownerVisibleEmail: normalizedEmail,
        createdAt: now,
        expiresAt
      }
    ));
  }

  const guardPath = sourceShareGuardPath(user.uid, input.sourceNoteId);
  for (
    let attempt = 0;
    attempt < sourceCreateTransactionMaximumAttempts;
    attempt += 1
  ) {
    let transaction = "";
    try {
      const snapshot = await firestoreBatchGetNewTransaction(context, [
        `notes/${input.sourceNoteId}`,
        guardPath
      ]);
      transaction = snapshot.transaction;
      const [currentNote, guard] = snapshot.documents;
      await requireSourceCreateAvailable(
        context,
        currentNote,
        user.uid,
        input,
        transaction
      );
      if (
        guard
        && !sourceShareGuardMatches(guard, user.uid, input.sourceNoteId)
      ) {
        throw new HttpError(
          409,
          "source_share_guard_invalid",
          "Source share guard state is invalid"
        );
      }

      const history = ownedSourceShareHistory(
        await readSourceShareHistory(
          context,
          user.uid,
          input.sourceNoteId,
          transaction
        ),
        user.uid,
        input.sourceNoteId
      );
      const blockingShares = history.filter((candidate) =>
        sourceShareBlocksCreation(candidate, user.uid, input.sourceNoteId)
      );
      if (blockingShares.length > 1) {
        throw new HttpError(
          409,
          "source_share_state_invalid",
          "Multiple active source shares require cleanup"
        );
      }
      const blockingShare = blockingShares[0] ?? null;
      if (blockingShare) {
        await rollbackShareMutation(context, transaction);
        transaction = "";
        if (input.idempotencyKey && blockingShare.__id === shareId) {
          const raced = await loadShareState(context, shareId);
          if (
            raced
            && raced.share.ownerUid === user.uid
            && raced.share.sourceNoteId === input.sourceNoteId
            && sourceSyncModeMatchesCreate(raced.share, input)
          ) {
            const latestNote = await firestoreGet(
              context,
              `notes/${input.sourceNoteId}`
            );
            await requireSourceCreateAvailable(
              context,
              latestNote,
              user.uid,
              input
            );
            await releaseRateLimitReservations(
              context,
              createRateLimitReservations
            );
            jsonResponse(response, 200, {
              ok: true,
              created: false,
              share: shareSummary(raced.share),
              requestId: id
            });
            return;
          }
          if (
            raced
            && raced.share.ownerUid === user.uid
            && raced.share.sourceNoteId === input.sourceNoteId
            && !sourceSyncModeMatchesCreate(raced.share, input)
          ) {
            throw new HttpError(
              409,
              "request_conflict",
              "Share creation idempotency key was reused for another request"
            );
          }
          if (attempt < sourceCreateTransactionMaximumAttempts - 1) {
            await waitBeforeOptimisticRetry(attempt);
            continue;
          }
        }
        throw new HttpError(
          409,
          "active_share_exists",
          "An active share already exists for the source note"
        );
      }

      const guardFields = {
        schemaVersion: 1,
        ownerUid: user.uid,
        sourceNoteId: input.sourceNoteId,
        shareId,
        updatedAt: now,
        expiresAt
      };
      const guardWrite = guard
        ? updateDocumentWrite(
          context.projectId,
          guardPath,
          guardFields,
          Object.keys(guardFields),
          guard.__updateTime
        )
        : createDocumentWrite(context.projectId, guardPath, {
          ...guardFields,
          createdAt: now
        });
      await firestoreCommit(context, [...writes, guardWrite], transaction);
      transaction = "";
      jsonResponse(response, 201, {
        ok: true,
        created: true,
        share: shareSummary({ ...share, __id: shareId }),
        requestId: id
      });
      return;
    } catch (error) {
      if (transaction) {
        await rollbackShareMutation(context, transaction);
      }
      if (error instanceof HttpError) {
        throw error;
      }
      if (isOptimisticConflict(error)) {
        let blockingShare;
        try {
          blockingShare = await blockingSourceShareFromGuard(
            context,
            guardPath,
            user.uid,
            input.sourceNoteId
          );
        } catch (recoveryError) {
          if (recoveryError instanceof HttpError) {
            throw recoveryError;
          }
          if (attempt < sourceCreateTransactionMaximumAttempts - 1) {
            await waitBeforeOptimisticRetry(attempt);
            continue;
          }
          throw new HttpError(
            503,
            "service_unavailable",
            "Source share conflict recovery did not converge",
            { expose: false }
          );
        }
        if (blockingShare) {
          const currentNote = await firestoreGet(
            context,
            `notes/${input.sourceNoteId}`
          );
          await requireSourceCreateAvailable(
            context,
            currentNote,
            user.uid,
            input
          );
          if (input.idempotencyKey && blockingShare.__id === shareId) {
            if (!sourceSyncModeMatchesCreate(blockingShare, input)) {
              throw new HttpError(
                409,
                "request_conflict",
                "Share creation idempotency key was reused for another request"
              );
            }
            await releaseRateLimitReservations(
              context,
              createRateLimitReservations
            );
            jsonResponse(response, 200, {
              ok: true,
              created: false,
              share: shareSummary(blockingShare),
              requestId: id
            });
            return;
          }
          throw new HttpError(
            409,
            "active_share_exists",
            "An active share already exists for the source note"
          );
        }
        if (attempt < sourceCreateTransactionMaximumAttempts - 1) {
          await waitBeforeOptimisticRetry(attempt);
          continue;
        }
        throw new HttpError(
          409,
          "request_conflict",
          "Concurrent share creation did not converge"
        );
      }
      throw error;
    }
  }
  throw new HttpError(409, "request_conflict");
}

function ownerListCursor(value) {
  if (!value) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof decoded?.createdAt !== "string"
      || !Number.isFinite(Date.parse(decoded.createdAt))
      || typeof decoded?.documentName !== "string"
      || !decoded.documentName.includes("/documents/publicNoteShares/")
    ) {
      throw new Error("invalid cursor");
    }
    return decoded;
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid cursor");
  }
}

function encodeOwnerListCursor(share) {
  return Buffer.from(JSON.stringify({
    createdAt: share.createdAt,
    documentName: share.__name
  }), "utf8").toString("base64url");
}

async function handleOwnerList(request, response, id, url) {
  requireMethod(request, ["GET"]);
  const user = await ownerContext(request);
  const status = queryString(url, "status", 20);
  if (status && !ownerShareStatuses.has(status)) {
    throw new HttpError(400, "invalid_request", "Invalid status filter");
  }
  const sourceNoteId = url.searchParams.has("sourceNoteId")
    ? safeId(queryString(url, "sourceNoteId", 160), "sourceNoteId")
    : "";
  const pageSizeText = queryString(url, "limit", 3);
  const pageSize = pageSizeText
    ? boundedInteger(
      Number.parseInt(pageSizeText, 10),
      "pageSize",
      1,
      sourceNoteId ? maximumSourceShareHistory : maximumPageSize
    )
    : defaultPageSize;
  const cursorText = queryString(url, "cursor", 1000);
  if (sourceNoteId) {
    if (url.searchParams.has("cursor")) {
      throw new HttpError(
        400,
        "invalid_request",
        "Source-specific share history does not accept a cursor"
      );
    }
    const shares = ownedSourceShareHistory(
      await readSourceShareHistory(user.context, user.uid, sourceNoteId),
      user.uid,
      sourceNoteId,
      status
    );
    jsonResponse(response, 200, {
      ok: true,
      shares: shares.map((share) => shareSummary(share)),
      nextCursor: null,
      requestId: id
    });
    return;
  }
  const cursor = ownerListCursor(cursorText);
  const filters = [
    {
      fieldFilter: {
        field: { fieldPath: "ownerUid" },
        op: "EQUAL",
        value: firestoreStringValue(user.uid)
      }
    },
    {
      fieldFilter: {
        field: { fieldPath: "schemaVersion" },
        op: "EQUAL",
        value: firestoreIntegerValue(2)
      }
    }
  ];
  if (status) {
    filters.push({
      fieldFilter: {
        field: { fieldPath: "status" },
        op: "EQUAL",
        value: firestoreStringValue(status)
      }
    });
  }
  const structuredQuery = {
    select: {
      fields: ownerShareSummaryFieldPaths.map((fieldPath) => ({ fieldPath }))
    },
    from: [{ collectionId: "publicNoteShares" }],
    where: filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters } },
    orderBy: [
      { field: { fieldPath: "createdAt" }, direction: "DESCENDING" },
      { field: { fieldPath: "__name__" }, direction: "DESCENDING" }
    ],
    limit: pageSize + 1
  };
  if (cursor) {
    structuredQuery.startAt = {
      before: false,
      values: [
        firestoreTimestampValue(cursor.createdAt),
        firestoreReferenceValue(cursor.documentName)
      ]
    };
  }
  const documents = await firestoreRunQuery(user.context, structuredQuery);
  const page = documents.slice(0, pageSize);
  const nextCursor = documents.length > pageSize && page.length
    ? encodeOwnerListCursor(page.at(-1))
    : null;
  jsonResponse(response, 200, {
    ok: true,
    shares: page.map((share) => shareSummary(share)),
    nextCursor,
    requestId: id
  });
}

async function handleOwnerDetails(request, response, id, shareId) {
  requireMethod(request, ["GET"]);
  const user = await ownerContext(request);
  const state = await loadShareState(user.context, shareId);
  requireOwner(state, user);
  await requireSourceAvailable(user.context, state.share);
  const [recipients, attachments] = await Promise.all([
    firestoreListCollection(
      user.context,
      `publicShareRecipients/${shareId}`,
      "items",
      110
    ),
    currentAttachments(user.context, state.share)
  ]);
  jsonResponse(response, 200, {
    ok: true,
    share: {
      ...shareSummary(state.share),
      ownerWrappedShareKey: state.share.ownerWrappedShareKey
    },
    policy: {
      ...policySummary(state.policy),
      allowedEmails: recipients
        .filter((recipient) =>
          recipient.shareId === shareId
          && recipient.ownerUid === state.share.ownerUid
          && typeof recipient.ownerVisibleEmail === "string"
        )
        .map((recipient) => recipient.ownerVisibleEmail)
        .sort()
    },
    attachmentReuseManifests: attachments.map(ownerAttachmentReuseManifest),
    requestId: id
  });
}

function ownerAttachmentReuseManifest(attachment) {
  const manifest = {
    id: safeId(attachment?.__id, "attachmentId")
  };
  if (!validSourceAttachmentFingerprint(attachment)) {
    return manifest;
  }
  return {
    ...manifest,
    sourceAttachmentId: attachment.sourceAttachmentId,
    digest: attachment.sourceAttachmentDigest,
    sourceEncryptionVersion: attachment.sourceEncryptionVersion
  };
}

function validateUpdateBody(body) {
  assertOnlyKeys(body, [
    "idempotencyKey",
    "policy"
  ]);
  if (!isPlainRecord(body.policy)) {
    throw new HttpError(400, "invalid_request", "policy is required");
  }
  assertOnlyKeys(body.policy, policyInputKeys());
  return {
    idempotencyKey: safeUnlockAttemptId(body.idempotencyKey),
    policy: body.policy
  };
}

async function handleOwnerUpdate(request, response, id, shareId) {
  requireMethod(request, ["PATCH", "POST"]);
  ensureSameOrigin(request);
  const body = await readJsonBody(request);
  const updateInput = validateUpdateBody(body);
  const user = await ownerContext(request);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await loadShareState(user.context, shareId);
    requireShareManager(state, user);
    if (
      state.share.status === "revoked"
      || state.share.revokedAt
      || state.share.cleanupStartedAt
      || timestampMilliseconds(state.share.expiresAt) <= Date.now()
    ) {
      throw new HttpError(409, "share_unavailable");
    }
    const sourceAvailability = await requireSourceAvailable(
      user.context,
      state.share
    );
    if (state.share.lastOwnerMutationId === updateInput.idempotencyKey) {
      jsonResponse(response, 200, {
        ok: true,
        share: shareSummary(state.share),
        policy: policySummary(state.policy),
        requestId: id
      });
      return;
    }
    if (state.share.status === "consumed" || state.policy.consumedAt) {
      throw new HttpError(409, "share_unavailable", "Consumed one-time shares cannot be edited");
    }
    const policySettings = await buildPolicySettings(
      updateInput.policy,
      state.policy,
      user.context
    );
    const expiresAt = computeExpiresAt(updateInput.policy, state.share.expiresAt);
    const policyVersion = boundedInteger(state.policy.policyVersion + 1, "policyVersion", 2, 1_000_000_000);
    const now = new Date();
    const shareFields = {
      updatedAt: now,
      expiresAt,
      policyVersion,
      lastOwnerMutationId: updateInput.idempotencyKey,
      accessModePublicHint: policySettings.accessMode,
      hasPassword: policySettings.passwordEnabled,
      requiresEmailVerification: policySettings.emailVerificationRequired,
      oneTimeEnabled: policySettings.oneTimeEnabled,
      permissionLevel: policySettings.permissionLevel,
      showCommenterIpPrefix: policySettings.showCommenterIpPrefix,
      downloadAllowed: policySettings.downloadAllowed,
      quickCopyButtonVisible: policySettings.quickCopyButtonVisible
    };
    const policyFields = {
      ...persistedPolicySettings(policySettings),
      policyVersion,
      updatedAt: now,
      expiresAt,
      consumedAt: undefined,
      consumedAttemptHash: undefined,
      consumedIdentityHash: undefined
    };
    const sharePaths = Object.keys(shareFields);
    const policyPaths = [
      ...Object.keys(policySettings),
      "passwordHashRecord",
      "policyVersion",
      "updatedAt",
      "expiresAt",
      "consumedAt",
      "consumedAttemptHash",
      "consumedIdentityHash"
    ];
    const guardPath = sourceShareGuardPath(user.uid, state.share.sourceNoteId);
    const guard = await firestoreGet(user.context, guardPath);
    const cleanupQueuePath = `publicShareCleanupQueue/${shareId}`;
    const cleanupQueue = await firestoreGet(user.context, cleanupQueuePath);
    if (
      !cleanupQueue
      || cleanupQueue.shareId !== shareId
      || cleanupQueue.ownerUid !== state.share.ownerUid
    ) {
      throw new HttpError(409, "cleanup_state_invalid");
    }
    const writes = [
      updateDocumentWrite(
        user.context.projectId,
        `publicNoteShares/${shareId}`,
        shareFields,
        sharePaths,
        state.share.__updateTime
      ),
      updateDocumentWrite(
        user.context.projectId,
        `publicSharePolicies/${shareId}`,
        policyFields,
        policyPaths,
        state.policy.__updateTime
      ),
      updateDocumentWrite(
        user.context.projectId,
        cleanupQueuePath,
        { expiresAt, updatedAt: now },
        ["expiresAt", "updatedAt"],
        cleanupQueue.__updateTime
      ),
      createAuditWrite(user.context, state.share, "owner_update", "success", {
        requestId: id,
        identityType: "quickmemo_user",
        identityHash: identityDigest("uid", user.uid)
      }),
      ...sourceAvailabilityVerifyWrites(user.context, sourceAvailability)
    ];
    if (
      sourceShareGuardMatches(
        guard,
        user.uid,
        state.share.sourceNoteId,
        shareId
      )
    ) {
      writes.push(updateDocumentWrite(
        user.context.projectId,
        guardPath,
        { expiresAt, updatedAt: now },
        ["expiresAt", "updatedAt"],
        guard.__updateTime
      ));
    }
    const recipients = await firestoreListCollection(
      user.context,
      `publicShareRecipients/${shareId}`,
      "items",
      110
    );
    if (policySettings.allowedEmails !== null) {
      const existingByHash = new Map();
      for (const recipient of recipients) {
        if (
          recipient.shareId !== shareId
          || recipient.ownerUid !== state.share.ownerUid
          || typeof recipient.emailHash !== "string"
          || existingByHash.has(recipient.emailHash)
        ) {
          throw new HttpError(409, "recipient_state_invalid");
        }
        existingByHash.set(recipient.emailHash, recipient);
      }
      const desiredByHash = new Map();
      for (const normalizedEmail of policySettings.allowedEmails) {
        const hashedEmail = emailDigest(normalizedEmail);
        desiredByHash.set(hashedEmail, normalizedEmail);
      }
      for (const [hashedEmail, recipient] of existingByHash) {
        if (!desiredByHash.has(hashedEmail)) {
          writes.push(deleteDocumentWrite(
            user.context.projectId,
            `publicShareRecipients/${shareId}/items/${safeId(recipient.__id, "recipientId")}`,
            recipient.__updateTime
          ));
        } else {
          writes.push(updateDocumentWrite(
            user.context.projectId,
            `publicShareRecipients/${shareId}/items/${safeId(recipient.__id, "recipientId")}`,
            { expiresAt, updatedAt: now },
            ["expiresAt", "updatedAt"],
            recipient.__updateTime
          ));
        }
      }
      for (const [hashedEmail, normalizedEmail] of desiredByHash) {
        if (!existingByHash.has(hashedEmail)) {
          writes.push(createDocumentWrite(
            user.context.projectId,
            `publicShareRecipients/${shareId}/items/em_${hashedEmail.slice(0, 40)}`,
            {
            shareId,
            ownerUid: state.share.ownerUid,
            emailHash: hashedEmail,
            ownerVisibleEmail: normalizedEmail,
            createdAt: now,
            expiresAt
            }
          ));
        }
      }
    }
    try {
      await firestoreCommit(user.context, writes);
      jsonResponse(response, 200, {
        ok: true,
        share: shareSummary({ ...state.share, ...shareFields, __id: shareId }),
        policy: policySummary({ ...state.policy, ...policyFields }),
        requestId: id
      });
      return;
    } catch (error) {
      if (!isOptimisticConflict(error) || attempt === 2) {
        throw error;
      }
    }
  }
}

function validateContentUpdateBody(body) {
  assertOnlyKeys(body, [
    "encryptedTitle",
    "encryptedBody",
    "attachmentCount",
    "generation",
    "sourceRevision",
    "sourceAttachmentRevision",
    "expectedContentRevision",
    "expectedSourceRevision",
    "expectedSourceAttachmentRevision",
    "retainedAttachmentIds",
    "idempotencyKey"
  ]);
  const attachmentCount = boundedInteger(
    body.attachmentCount,
    "attachmentCount",
    0,
    100
  );
  const generation = body.generation ? safeId(body.generation, "generation") : "";
  if (attachmentCount > 0 && !generation) {
    throw new HttpError(400, "invalid_request", "generation is required");
  }
  const retainedAttachmentIds = body.retainedAttachmentIds === undefined
    ? []
    : Array.isArray(body.retainedAttachmentIds)
      && body.retainedAttachmentIds.length <= 100
      ? body.retainedAttachmentIds.map((attachmentId) =>
          safeId(attachmentId, "retainedAttachmentId")
        )
      : null;
  if (
    !retainedAttachmentIds
    || new Set(retainedAttachmentIds).size !== retainedAttachmentIds.length
    || retainedAttachmentIds.length > attachmentCount
  ) {
    throw new HttpError(400, "invalid_request", "Invalid retainedAttachmentIds");
  }
  return {
    encryptedTitle: encryptedPayload(body.encryptedTitle, "encryptedTitle", 64 * 1024),
    encryptedBody: encryptedPayload(body.encryptedBody, "encryptedBody", 2 * 1024 * 1024),
    attachmentCount,
    generation,
    retainedAttachmentIds,
    sourceRevision: boundedInteger(
      body.sourceRevision,
      "sourceRevision",
      0,
      1_000_000_000
    ),
    sourceAttachmentRevision: boundedInteger(
      body.sourceAttachmentRevision,
      "sourceAttachmentRevision",
      0,
      1_000_000_000
    ),
    expectedContentRevision: boundedInteger(
      body.expectedContentRevision,
      "expectedContentRevision",
      1,
      1_000_000_000
    ),
    expectedSourceRevision: boundedInteger(
      body.expectedSourceRevision,
      "expectedSourceRevision",
      0,
      1_000_000_000
    ),
    expectedSourceAttachmentRevision: boundedInteger(
      body.expectedSourceAttachmentRevision,
      "expectedSourceAttachmentRevision",
      0,
      1_000_000_000
    ),
    idempotencyKey: safeUnlockAttemptId(body.idempotencyKey)
  };
}

function assertOwnerContentMutable(state) {
  if (
    !state
    || !new Set(["pending", "active", "consumed"]).has(state.share.status)
    || state.share.revokedAt
    || state.share.cleanupStartedAt
    || timestampMilliseconds(state.share.expiresAt) <= Date.now()
    || state.share.policyVersion !== state.policy.policyVersion
  ) {
    throw new HttpError(409, "share_unavailable");
  }
}

function contentUpdateReplayAttachmentIds(share) {
  if (
    !Array.isArray(share?.lastContentMutationRetiredAttachmentIds)
    || share.lastContentMutationRetiredAttachmentIds.length > 100
  ) {
    return [];
  }
  try {
    return share.lastContentMutationRetiredAttachmentIds.map((attachmentId) =>
      safeId(attachmentId, "attachmentId")
    );
  } catch {
    return [];
  }
}

function contentUpdateRetryAfterSeconds(share, nowMilliseconds = Date.now()) {
  const contentUpdatedAt = timestampMilliseconds(share?.contentUpdatedAt);
  if (
    !Number.isFinite(contentUpdatedAt)
    || contentUpdatedAt <= nowMilliseconds - ownerContentUpdateMinimumIntervalMilliseconds
  ) {
    return 0;
  }
  return Math.max(
    1,
    Math.ceil(
      (
        contentUpdatedAt
        + ownerContentUpdateMinimumIntervalMilliseconds
        - nowMilliseconds
      ) / 1_000
    )
  );
}

function assertContentUpdateRate(share) {
  const retryAfter = contentUpdateRetryAfterSeconds(share);
  if (retryAfter > 0) {
    throw new HttpError(
      429,
      "rate_limited",
      "Secure share content updates are too frequent",
      { retryAfter }
    );
  }
}

function assertContentUpdateDisposition(state, input, requestDigest) {
  const disposition = contentUpdateDisposition(state.share, input, requestDigest);
  if (disposition === "conflict") {
    throw new HttpError(
      409,
      "request_conflict",
      "Content update idempotency key was reused with another payload"
    );
  }
  if (disposition === "stale") {
    throw new HttpError(409, "content_revision_conflict", "Secure share content changed");
  }
  return disposition;
}

function sourceNoteMatchesContentUpdate(state, note, ownerProfile, input) {
  const noteRevision = Number.isSafeInteger(note?.revision) ? note.revision : 0;
  const noteAttachmentRevision = Number.isSafeInteger(note?.attachmentRevision)
    ? note.attachmentRevision
    : 0;
  return sourceLifecycleAvailable(state.share, note, ownerProfile)
    && noteRevision === input.sourceRevision
    && noteAttachmentRevision === input.sourceAttachmentRevision
    && input.sourceRevision >= input.expectedSourceRevision
    && input.sourceAttachmentRevision >= input.expectedSourceAttachmentRevision;
}

async function contentUpdateAttachmentSnapshot(context, state, input, transaction) {
  const currentGeneration = state.share.currentGeneration ?? "";
  if (
    input.sourceAttachmentRevision !== input.expectedSourceAttachmentRevision
    && input.generation === currentGeneration
  ) {
    throw new HttpError(
      409,
      "attachment_generation_required",
      "Attachment changes require a new generation"
    );
  }
  if (
    input.retainedAttachmentIds.length > 0
    && (!currentGeneration || input.generation === currentGeneration)
  ) {
    throw new HttpError(
      409,
      "attachment_generation_required",
      "Retained attachments require a new generation"
    );
  }
  const retainedIdSet = new Set(input.retainedAttachmentIds);
  const expectedCurrentAttachmentCount = Number.isSafeInteger(state.share.attachmentCount)
    ? state.share.attachmentCount
    : 0;
  if (
    expectedCurrentAttachmentCount < 0
    || expectedCurrentAttachmentCount > 100
  ) {
    throw new HttpError(409, "attachment_state_changed");
  }
  const currentCandidates = await attachmentGenerationSnapshot(
    context,
    state.share.__id,
    currentGeneration,
    transaction,
    expectedCurrentAttachmentCount
  );
  const current = currentCandidates.filter((attachment) =>
    attachmentCurrent(attachment, state.share)
  );
  if (current.length !== expectedCurrentAttachmentCount) {
    throw new HttpError(409, "attachment_state_changed");
  }
  const currentById = new Map(current.map((attachment) => [
    safeId(attachment.__id, "attachmentId"),
    attachment
  ]));
  const retained = input.retainedAttachmentIds.map((attachmentId) =>
    currentById.get(attachmentId)
  );
  if (retained.some((attachment) => !attachment)) {
    throw new HttpError(
      409,
      "attachment_state_changed",
      "A retained attachment is not in the current generation"
    );
  }
  const expectedUploadedAttachmentCount =
    input.attachmentCount - retained.length;
  const candidateCandidates = input.generation === currentGeneration
    ? currentCandidates
    : await attachmentGenerationSnapshot(
        context,
        state.share.__id,
        input.generation,
        transaction,
        expectedUploadedAttachmentCount
      );
  if (candidateCandidates.length !== expectedUploadedAttachmentCount) {
    throw new HttpError(409, "attachment_state_changed");
  }
  const candidateShare = {
    ...state.share,
    currentGeneration: input.generation,
    attachmentCount: input.attachmentCount
  };
  const uploaded = candidateCandidates.filter((attachment) =>
    !retainedIdSet.has(attachment.__id)
    && attachmentCurrent(attachment, candidateShare)
  );
  const target = [...uploaded, ...retained];
  if (target.length !== input.attachmentCount) {
    throw new HttpError(409, "attachment_state_changed", "Ready attachment count mismatch");
  }
  uploaded.forEach((attachment) => validateAttachmentRecord(attachment, candidateShare));
  retained.forEach((attachment) => {
    validateAttachmentRecord(attachment, state.share);
    validateAttachmentRecord({
      ...attachment,
      generations: retainedAttachmentGenerations(
        currentGeneration,
        input.generation
      )
    }, candidateShare);
  });

  const sourceAttachments = input.attachmentCount > 0
    ? await firestoreRunQuery(
        context,
        {
          from: [{ collectionId: "attachments" }],
          limit: 101
        },
        `notes/${safeId(state.share.sourceNoteId, "sourceNoteId")}`,
        transaction
      )
    : [];
  if (sourceAttachments.length > 100) {
    throw new HttpError(409, "attachment_state_changed", "Source attachment list is incomplete");
  }
  const readySourceAttachments = sourceAttachments.filter(
    (attachment) => attachment.isReady !== false
  );
  const sourceById = new Map(readySourceAttachments.map((attachment) => [
    safeId(attachment.__id, "sourceAttachmentId"),
    attachment
  ]));
  const targetSourceIds = target.map((attachment) =>
    safeId(attachment.sourceAttachmentId, "sourceAttachmentId")
  );
  if (
    readySourceAttachments.length !== input.attachmentCount
    || new Set(targetSourceIds).size !== targetSourceIds.length
    || targetSourceIds.some((sourceAttachmentId) => !sourceById.has(sourceAttachmentId))
  ) {
    throw new HttpError(
      409,
      "attachment_state_changed",
      "Target attachments do not match the source attachment manifest"
    );
  }
  retained.forEach((attachment) => {
    if (!sourceAttachmentFingerprintMatches(
      attachment,
      sourceById.get(attachment.sourceAttachmentId)
    )) {
      throw new HttpError(
        409,
        "attachment_source_changed",
        "A retained attachment no longer matches its source ciphertext"
      );
    }
  });

  const retiredAttachments = input.generation === currentGeneration
    ? []
    : current
      .filter((attachment) => !retainedIdSet.has(attachment.__id));
  if (retiredAttachments.length > 100) {
    throw new HttpError(409, "attachment_state_changed");
  }
  return {
    uploadedAttachments: uploaded.map((attachment) => ({
      attachmentId: safeId(attachment.__id, "attachmentId"),
      updateTime: attachment.__updateTime
    })),
    retainedAttachments: retained.map((attachment) => ({
      attachmentId: safeId(attachment.__id, "attachmentId"),
      generations: retainedAttachmentGenerations(
        currentGeneration,
        input.generation
      ),
      updateTime: attachment.__updateTime
    })),
    retiredAttachments: retiredAttachments.map((attachment) => ({
      attachmentId: safeId(attachment.__id, "attachmentId"),
      updateTime: attachment.__updateTime
    })),
    retiredAttachmentIds: retiredAttachments.map((attachment) =>
      safeId(attachment.__id, "attachmentId")
    )
  };
}

function verifyDocumentSnapshotWrite(projectId, documentPath, updateTime) {
  if (typeof updateTime !== "string" || !updateTime) {
    throw new TypeError("A verify precondition is required");
  }
  return {
    verify: firestoreDocumentName(projectId, documentPath),
    currentDocument: { updateTime }
  };
}

async function beginContentUpdateTransaction(context, state) {
  const sourceNoteId = safeId(state.share.sourceNoteId, "sourceNoteId");
  const ownerUid = safeId(state.share.ownerUid, "ownerUid");
  const { documents, transaction } = await firestoreBatchGetNewTransaction(
    context,
    [
      `publicNoteShares/${state.share.__id}`,
      `publicSharePolicies/${state.share.__id}`,
      `notes/${sourceNoteId}`,
      `users/${ownerUid}`
    ]
  );
  const [share, policy, note, ownerProfile] = documents;
  const transactionState = share
    && policy
    && share.schemaVersion === 2
    && policy.schemaVersion === 2
      ? { share, policy }
      : null;
  return { state: transactionState, note, ownerProfile, transaction };
}

async function handleOwnerContentUpdate(request, response, id, shareId) {
  requireMethod(request, ["PATCH"]);
  ensureSameOrigin(request);
  const body = await readJsonBody(request);
  const input = validateContentUpdateBody(body);
  const requestDigest = contentUpdateRequestDigest(input);
  const user = await ownerContext(request);

  // Do not add a distributed rate-limit write to this autosave path. The
  // committed share contentUpdatedAt provides a transaction-checked 500 ms
  // minimum interval after replay detection, while owner authentication,
  // same-origin/App Check, bounded payloads, CAS, and idempotency provide the
  // remaining boundary without another free-tier write per save.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const initialState = await loadShareState(user.context, shareId);
    requireOwner(initialState, user);
    assertOwnerContentMutable(initialState);
    const initialDisposition = assertContentUpdateDisposition(
      initialState,
      input,
      requestDigest
    );
    if (initialDisposition === "replay") {
      await requireSourceAvailable(user.context, initialState.share);
      jsonResponse(response, 200, {
        ok: true,
        share: shareSummary(initialState.share),
        retiredAttachmentIds: contentUpdateReplayAttachmentIds(initialState.share),
        requestId: id
      });
      return;
    }
    assertContentUpdateRate(initialState.share);

    const transactionSnapshot = await beginContentUpdateTransaction(
      user.context,
      initialState
    );
    try {
      const state = transactionSnapshot.state;
      requireOwner(state, user);
      assertOwnerContentMutable(state);
      if (
        state.share.sourceNoteId !== initialState.share.sourceNoteId
        || state.share.ownerUid !== initialState.share.ownerUid
      ) {
        throw new HttpError(409, "request_conflict", "Secure share source changed");
      }
      const disposition = assertContentUpdateDisposition(state, input, requestDigest);
      if (disposition === "replay") {
        await rollbackShareMutation(user.context, transactionSnapshot.transaction);
        jsonResponse(response, 200, {
          ok: true,
          share: shareSummary(state.share),
          retiredAttachmentIds: contentUpdateReplayAttachmentIds(state.share),
          requestId: id
        });
        return;
      }
      assertContentUpdateRate(state.share);
      if (!sourceNoteMatchesContentUpdate(
        state,
        transactionSnapshot.note,
        transactionSnapshot.ownerProfile,
        input
      )) {
        throw new HttpError(
          409,
          "source_revision_conflict",
          "Source note changed before secure share content update"
        );
      }
      try {
        await sourceFolderChainSnapshot(
          user.context,
          transactionSnapshot.note,
          state.share.ownerUid,
          transactionSnapshot.transaction
        );
      } catch (error) {
        if (error instanceof SourceFolderChainUnavailableError) {
          throw new HttpError(
            409,
            "source_revision_conflict",
            "Source folder changed before secure share content update"
          );
        }
        throw error;
      }
      const attachmentSnapshot = await contentUpdateAttachmentSnapshot(
        user.context,
        state,
        input,
        transactionSnapshot.transaction
      );
      const now = new Date();
      const fields = {
        encryptedTitle: input.encryptedTitle,
        encryptedBody: input.encryptedBody,
        attachmentCount: input.attachmentCount,
        currentGeneration: input.generation,
        sourceRevision: input.sourceRevision,
        sourceAttachmentRevision: input.sourceAttachmentRevision,
        contentRevision: boundedInteger(
          contentRevisionValue(state.share) + 1,
          "contentRevision",
          2,
          1_000_000_000
        ),
        contentUpdatedAt: now,
        updatedAt: now,
        lastContentMutationId: input.idempotencyKey,
        lastContentMutationDigest: requestDigest,
        lastContentMutationRetiredAttachmentIds: attachmentSnapshot.retiredAttachmentIds
      };
      await firestoreCommit(
        user.context,
        [
          updateDocumentWrite(
            user.context.projectId,
            `publicNoteShares/${shareId}`,
            fields,
            Object.keys(fields),
            state.share.__updateTime
          ),
          ...attachmentSnapshot.uploadedAttachments.map((attachment) =>
            verifyDocumentSnapshotWrite(
              user.context.projectId,
              `publicNoteShares/${shareId}/attachments/${attachment.attachmentId}`,
              attachment.updateTime
            )
          ),
          ...attachmentSnapshot.retainedAttachments.map((attachment) =>
            updateDocumentWrite(
              user.context.projectId,
              `publicNoteShares/${shareId}/attachments/${attachment.attachmentId}`,
              { generations: attachment.generations },
              ["generations"],
              attachment.updateTime
            )
          ),
          ...attachmentSnapshot.retiredAttachments.map((attachment) =>
            updateDocumentWrite(
              user.context.projectId,
              `publicNoteShares/${shareId}/attachments/${attachment.attachmentId}`,
              {
                deletionStarted: true,
                deletionStartedAt: now
              },
              ["deletionStarted", "deletionStartedAt"],
              attachment.updateTime
            )
          ),
          createAuditWrite(user.context, state.share, "owner_content_update", "success", {
            requestId: id,
            identityType: "quickmemo_user",
            identityHash: identityDigest("uid", user.uid)
          })
        ],
        transactionSnapshot.transaction
      );
      jsonResponse(response, 200, {
        ok: true,
        share: shareSummary({ ...state.share, ...fields, __id: shareId }),
        retiredAttachmentIds: attachmentSnapshot.retiredAttachmentIds,
        requestId: id
      });
      return;
    } catch (error) {
      await rollbackShareMutation(user.context, transactionSnapshot.transaction);
      if (!isOptimisticConflict(error) || attempt === 2) {
        throw error;
      }
      await waitBeforeOptimisticRetry(attempt);
    }
  }
}

async function handleOwnerActivate(request, response, id, shareId) {
  requireMethod(request, ["POST"]);
  ensureSameOrigin(request);
  const body = await readJsonBody(request, 8 * 1024);
  assertOnlyKeys(body, ["attachmentCount", "generation", "idempotencyKey"]);
  const attachmentCount = boundedInteger(body.attachmentCount ?? 0, "attachmentCount", 0, 100);
  const currentGeneration = body.generation ? safeId(body.generation, "generation") : "";
  const idempotencyKey = safeUnlockAttemptId(body.idempotencyKey);
  if (attachmentCount > 0 && !currentGeneration) {
    throw new HttpError(400, "invalid_request", "currentGeneration is required");
  }
  const user = await ownerContext(request);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await loadShareState(user.context, shareId);
    requireOwner(state, user);
    const sourceAvailability = await requireSourceAvailable(
      user.context,
      state.share
    );
    if (state.share.lastOwnerMutationId === idempotencyKey) {
      jsonResponse(response, 200, { ok: true, share: shareSummary(state.share), requestId: id });
      return;
    }
    if (state.share.status === "revoked" || timestampMilliseconds(state.share.expiresAt) <= Date.now()) {
      throw new HttpError(409, "share_unavailable");
    }
    const attachments = await firestoreListCollection(
      user.context,
      `publicNoteShares/${shareId}`,
      "attachments",
      150
    );
    const readyCount = attachments.filter((attachment) =>
      attachment.isReady === true
      && attachment.privacyVersion === 1
      && (currentGeneration ? attachment.generation === currentGeneration : !attachment.generation)
    ).length;
    if (readyCount !== attachmentCount) {
      throw new HttpError(409, "attachment_state_changed", "Ready attachment count mismatch");
    }
    if (state.share.status === "active" && state.share.ready === true) {
      jsonResponse(response, 200, { ok: true, share: shareSummary(state.share), requestId: id });
      return;
    }
    const fields = {
      status: "active",
      ready: true,
      attachmentCount,
      currentGeneration,
      lastOwnerMutationId: idempotencyKey,
      updatedAt: new Date()
    };
    try {
      await firestoreCommit(user.context, [
        updateDocumentWrite(
          user.context.projectId,
          `publicNoteShares/${shareId}`,
          fields,
          Object.keys(fields),
          state.share.__updateTime
        ),
        createAuditWrite(user.context, state.share, "owner_activate", "success", {
          requestId: id,
          identityType: "quickmemo_user",
          identityHash: identityDigest("uid", user.uid)
        }),
        ...sourceAvailabilityVerifyWrites(user.context, sourceAvailability)
      ]);
      jsonResponse(response, 200, {
        ok: true,
        share: shareSummary({ ...state.share, ...fields }),
        requestId: id
      });
      return;
    } catch (error) {
      if (!isOptimisticConflict(error) || attempt === 2) {
        throw error;
      }
    }
  }
}

async function handleOwnerRevoke(request, response, id, shareId) {
  requireMethod(request, ["POST"]);
  ensureSameOrigin(request);
  const body = await readJsonBody(request, 8 * 1024);
  assertOnlyKeys(body, ["idempotencyKey"]);
  const idempotencyKey = safeUnlockAttemptId(body.idempotencyKey);
  const user = await ownerContext(request);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await loadShareState(user.context, shareId);
    requireShareManager(state, user);
    const guardPath = sourceShareGuardPath(user.uid, state.share.sourceNoteId);
    const guard = await firestoreGet(user.context, guardPath);
    if (state.share.status === "revoked" || state.share.revokedAt) {
      if (
        sourceShareGuardMatches(
          guard,
          user.uid,
          state.share.sourceNoteId,
          shareId
        )
      ) {
        try {
          await firestoreCommit(user.context, [
            deleteDocumentWrite(
              user.context.projectId,
              guardPath,
              guard.__updateTime
            )
          ]);
        } catch (error) {
          if (isOptimisticConflict(error) && attempt < 2) {
            continue;
          }
          throw error;
        }
      }
      jsonResponse(response, 200, { ok: true, share: shareSummary(state.share), requestId: id });
      return;
    }
    if (
      secureShareLiveContentSyncEnabled()
      && legacyAutomaticSourceRevokePattern.test(idempotencyKey)
    ) {
      const ownerIsCaller = user.uid === state.share.ownerUid;
      const [sourceNote, ownerProfile] = await Promise.all([
        firestoreGet(
          user.context,
          `notes/${safeId(state.share.sourceNoteId, "sourceNoteId")}`
        ),
        ownerIsCaller
          ? Promise.resolve({
              isActive: true,
              isAdmin: user.isAdmin === true,
              featureAccess: { notes: true }
            })
          : firestoreGet(
              user.context,
              `users/${safeId(state.share.ownerUid, "ownerUid")}`
            )
      ]);
      if (legacyAutomaticSourceRevokeBlocked(
        idempotencyKey,
        state.share,
        sourceNote,
        ownerProfile,
        true
      )) {
        throw new HttpError(
          409,
          "content_sync_required",
          "Legacy automatic source-change revoke rejected"
        );
      }
    }
    const now = new Date();
    const policyVersion = state.policy.policyVersion + 1;
    const shareFields = {
      status: "revoked",
      ready: false,
      revokedAt: now,
      revokedBy: user.uid,
      policyVersion,
      lastOwnerMutationId: idempotencyKey,
      updatedAt: now
    };
    const policyFields = { policyVersion, updatedAt: now, revokedAt: now };
    const writes = [
        updateDocumentWrite(
          user.context.projectId,
          `publicNoteShares/${shareId}`,
          shareFields,
          Object.keys(shareFields),
          state.share.__updateTime
        ),
        updateDocumentWrite(
          user.context.projectId,
          `publicSharePolicies/${shareId}`,
          policyFields,
          Object.keys(policyFields),
          state.policy.__updateTime
        ),
        createAuditWrite(user.context, state.share, "owner_revoke", "success", {
          requestId: id,
          identityType: "quickmemo_user",
          identityHash: identityDigest("uid", user.uid)
        })
    ];
    if (
      sourceShareGuardMatches(
        guard,
        user.uid,
        state.share.sourceNoteId,
        shareId
      )
    ) {
      writes.push(deleteDocumentWrite(
        user.context.projectId,
        guardPath,
        guard.__updateTime
      ));
    }
    try {
      await firestoreCommit(user.context, writes);
      jsonResponse(response, 200, {
        ok: true,
        share: shareSummary({ ...state.share, ...shareFields }),
        requestId: id
      });
      return;
    } catch (error) {
      if (!isOptimisticConflict(error) || attempt === 2) {
        throw error;
      }
    }
  }
}

async function handleMetadata(request, response, id, shareId) {
  requireMethod(request, ["GET", "HEAD"]);
  const context = await secureContext(request);
  const state = await loadShareState(context, shareId);
  let sourceAlreadyValidated = false;
  let ownerPreview = false;
  if (authorizationToken(request)) {
    try {
      const user = await activeUserFromRequest(request, context);
      ownerPreview = shareManagedBy(state, user);
    } catch {
      ownerPreview = false;
    }
  }
  if (!ownerPreview) {
    assertPublicShareAvailable(state);
    await emailRuntimeForPolicy(context, state.policy);
  } else if (
    !state
    || state.share.revokedAt
    || state.share.status === "revoked"
    || timestampMilliseconds(state.share.expiresAt) <= Date.now()
    || state.policy.policyVersion !== state.share.policyVersion
  ) {
    throw new HttpError(404, "share_unavailable");
  }
  if (!ownerPreview && (state.share.status === "consumed" || state.policy.consumedAt)) {
    try {
      const { session } = await validatedSession(request, context, shareId);
      if (session.ownerPreview === true || session.oneTimeGrant !== true) {
        throw new HttpError(401, "session_expired");
      }
      sourceAlreadyValidated = true;
    } catch {
      throw new HttpError(404, "share_unavailable", "One-time share is already consumed");
    }
  }
  if (!sourceAlreadyValidated) {
    await requireSourceAvailable(context, state.share);
  }

  let binding = browserBindingFromRequest(request, shareId);
  const setCookies = [];
  if (!binding) {
    binding = randomToken(32);
    setCookies.push(browserBindingCookie(request, shareId, binding));
  }
  jsonResponse(response, 200, {
    ok: true,
    metadata: {
      schemaVersion: 2,
      accessMode: state.policy.accessMode,
      hasPassword: state.policy.passwordEnabled === true,
      requiresPassword: state.policy.passwordEnabled === true,
      requiresEmailVerification: state.policy.emailVerificationRequired === true,
      emailChallengeRequired:
        state.policy.emailVerificationRequired === true
        && state.policy.accessMode !== "authenticated_users",
      requiresAuthentication: state.policy.accessMode === "authenticated_users",
      oneTimeEnabled: state.policy.oneTimeEnabled === true,
      oneTimeScope: "global",
      ownerPreview,
      hasSessionCandidate: Boolean(sessionTokenFromRequest(request, shareId))
    },
    requestId: id
  }, { setCookies, head: request.method === "HEAD" });
}

async function emailChallengeEligibility(context, state, emailHash) {
  if (!publicShareAvailable(state) || state.share.status === "consumed" || state.policy.consumedAt) {
    return false;
  }
  if (
    state.policy.emailVerificationRequired !== true
    || state.policy.accessMode === "authenticated_users"
  ) {
    return false;
  }
  if (
    state.policy.accessMode === "allowed_emails"
    && !(state.policy.allowedEmailHashes ?? []).includes(emailHash)
  ) {
    return false;
  }
  try {
    await requireSourceAvailable(context, state.share);
    return true;
  } catch {
    return false;
  }
}

const gmailSmtpProviderHealthPath = "publicShareEmailProviderHealth/gmail-smtp";
const gmailProviderHealthReasonCodes = new Set([
  "ambiguous_delivery",
  "auth_error",
  "configuration_error",
  "connection_error",
  "invalid_recipient",
  "permanent_provider_error",
  "quota_exceeded",
  "rate_limited",
  "temporary_provider_error",
  "timeout",
  "tls_error"
]);
const gmailProviderHardBlockReasonCodes = new Set([
  "auth_error",
  "configuration_error",
  "quota_exceeded",
  "rate_limited"
]);

function gmailProviderFailureReason(error) {
  if (!error || typeof error !== "object") {
    return "permanent_provider_error";
  }
  try {
    return gmailProviderHealthReasonCodes.has(error.providerReasonCode)
      ? error.providerReasonCode
      : "permanent_provider_error";
  } catch {
    return "permanent_provider_error";
  }
}

function gmailProviderHealthStateAllowsSend(
  health,
  nowMilliseconds = Date.now(),
  settingsGeneration = ""
) {
  if (!health) {
    return !settingsGeneration;
  }
  if (
    !Number.isSafeInteger(nowMilliseconds)
    || nowMilliseconds < 0
    || (
      settingsGeneration
      && health.settingsGeneration !== settingsGeneration
    )
    || !new Set(["unknown", "healthy", "degraded", "blocked"]).has(health.status)
    || !Number.isSafeInteger(health.consecutiveFailures)
    || health.consecutiveFailures < 0
    || health.consecutiveFailures > 1_000
  ) {
    return false;
  }
  if (health.status !== "blocked") {
    return true;
  }
  const blockedUntilMilliseconds = timestampMilliseconds(health.blockedUntil);
  return (
    Number.isFinite(blockedUntilMilliseconds)
    && blockedUntilMilliseconds <= nowMilliseconds
  );
}

async function gmailProviderHealthAllowsSend(
  context,
  runtimeSnapshot,
  nowMilliseconds = Date.now()
) {
  if (configuredEmailProviderName(runtimeSnapshot) !== "gmail_smtp") {
    return true;
  }
  const health = await firestoreGet(context, gmailSmtpProviderHealthPath);
  return gmailProviderHealthStateAllowsSend(
    health,
    nowMilliseconds,
    runtimeSnapshot.generation
  );
}

function gmailProviderHealthTransition(
  existing,
  outcome,
  error = null,
  now = new Date(),
  settingsGeneration = ""
) {
  const nowMilliseconds = timestampMilliseconds(now);
  if (!Number.isFinite(nowMilliseconds)) {
    throw new HttpError(503, "service_unavailable", "Provider health time is invalid", {
      expose: false
    });
  }
  const sameGeneration =
    !settingsGeneration
    || existing?.settingsGeneration === settingsGeneration;
  const currentFailures = sameGeneration
    && Number.isSafeInteger(existing?.consecutiveFailures)
    ? Math.max(0, existing.consecutiveFailures)
    : 0;
  const reasonCode = outcome === "sent"
    ? ""
    : gmailProviderFailureReason(error);
  const invalidRecipient = reasonCode === "invalid_recipient";
  const consecutiveFailures = outcome === "sent"
    ? 0
    : invalidRecipient
      ? currentFailures
      : Math.min(currentFailures + 1, 1_000);
  const hardBlocked = gmailProviderHardBlockReasonCodes.has(reasonCode);
  const thresholdBlocked = !invalidRecipient && consecutiveFailures >= 3;
  const existingBlockedUntilMilliseconds = timestampMilliseconds(existing?.blockedUntil);
  const activeExistingBlock =
    outcome !== "sent"
    && sameGeneration
    && existing?.status === "blocked"
    && existingBlockedUntilMilliseconds > nowMilliseconds;
  const proposedStatus = outcome === "sent"
    ? "healthy"
    : invalidRecipient
      ? existing?.status === "blocked"
        ? "degraded"
        : existing?.status ?? "unknown"
      : hardBlocked || thresholdBlocked
        ? "blocked"
        : "degraded";
  const status = activeExistingBlock ? "blocked" : proposedStatus;
  const requestedBlockedSeconds =
    error && typeof error === "object" && Number.isSafeInteger(error.providerBlockedSeconds)
      ? error.providerBlockedSeconds
      : 0;
  const proposedBlockedSeconds = proposedStatus === "blocked"
    ? Math.max(
        requestedBlockedSeconds,
        hardBlocked ? 60 * 60 : 10 * 60
      )
    : 0;
  const proposedBlockedUntilMilliseconds = proposedBlockedSeconds
    ? nowMilliseconds + Math.min(proposedBlockedSeconds, 24 * 60 * 60) * 1000
    : 0;
  const blockedUntilMilliseconds = status === "blocked"
    ? Math.max(
        proposedBlockedUntilMilliseconds,
        activeExistingBlock ? existingBlockedUntilMilliseconds : 0
      )
    : 0;
  const existingReasonCode =
    sameGeneration
    && typeof existing?.lastReasonCode === "string"
    && gmailProviderHealthReasonCodes.has(existing.lastReasonCode)
      ? existing.lastReasonCode
      : "";
  return {
    schemaVersion: 1,
    ...(settingsGeneration ? { settingsGeneration } : {}),
    status,
    consecutiveFailures,
    blockedUntil: blockedUntilMilliseconds
      ? new Date(blockedUntilMilliseconds)
      : undefined,
    lastReasonCode: activeExistingBlock && !hardBlocked && existingReasonCode
      ? existingReasonCode
      : reasonCode,
    lastSuccessfulSendAt: outcome === "sent"
      ? new Date(nowMilliseconds)
      : sameGeneration ? existing?.lastSuccessfulSendAt : undefined,
    lastFailureAt: outcome === "sent"
      ? sameGeneration ? existing?.lastFailureAt : undefined
      : new Date(nowMilliseconds),
    updatedAt: new Date(nowMilliseconds)
  };
}

async function recordGmailProviderHealth(
  context,
  runtimeSnapshot,
  outcome,
  error = null
) {
  if (configuredEmailProviderName(runtimeSnapshot) !== "gmail_smtp") {
    return;
  }
  const legacyTestRuntime =
    !runtimeSnapshot.generation
    && runtimeSnapshot.environment?.NODE_ENV === "test";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = new Date();
    const existing = await firestoreGet(context, gmailSmtpProviderHealthPath);
    if (
      (!existing && !legacyTestRuntime)
      || (
        existing
        && runtimeSnapshot.generation
        && existing.settingsGeneration !== runtimeSnapshot.generation
      )
      || (
        existing
        && legacyTestRuntime
        && Boolean(existing.settingsGeneration)
      )
    ) {
      // A confirm/remove may rotate or delete provider health while an older
      // SMTP request is in flight. Never recreate the record or overwrite the
      // new generation with a stale delivery outcome. Empty-generation health
      // exists only for the local NODE_ENV=test compatibility provider.
      return;
    }
    const fields = gmailProviderHealthTransition(
      existing,
      outcome,
      error,
      now,
      runtimeSnapshot.generation
    );
    const write = existing
      ? updateDocumentWrite(
        context.projectId,
        gmailSmtpProviderHealthPath,
        fields,
        Object.keys(fields),
        existing.__updateTime
      )
      : createDocumentWrite(context.projectId, gmailSmtpProviderHealthPath, fields);
    try {
      await firestoreCommit(context, [write]);
      return;
    } catch (writeError) {
      if (!isOptimisticConflict(writeError) || attempt === 4) {
        throw writeError;
      }
    }
  }
}

function resolveEmailQuotaPolicy(environment = process.env) {
  const configured = (name, fallback, minimum, maximum) => {
    const parsed = Number.parseInt(environment[name], 10);
    if (Number.isSafeInteger(parsed) && parsed > maximum) {
      throw new HttpError(
        503,
        "email_feature_unavailable",
        "Secure Share email quota configuration exceeds the free-tier cap",
        { expose: false }
      );
    }
    return Number.isSafeInteger(parsed)
      ? Math.min(Math.max(parsed, minimum), maximum)
      : fallback;
  };
  const rolling24hHardLimit = configured(
    "SHARE_EMAIL_ROLLING_24H_HARD_LIMIT",
    30,
    1,
    30
  );
  const monthlyHardLimit = configured("SHARE_EMAIL_MONTHLY_HARD_LIMIT", 700, 1, 700);
  return {
    globalHourlyLimit: configured("SHARE_EMAIL_GLOBAL_HOURLY_LIMIT", 20, 1, 20),
    globalMinuteLimit: configured("SHARE_EMAIL_GLOBAL_MINUTE_LIMIT", 3, 1, 3),
    rolling24hHardLimit,
    rolling24hSoftLimit: Math.min(
      configured("SHARE_EMAIL_ROLLING_24H_SOFT_LIMIT", 20, 1, 20),
      rolling24hHardLimit
    ),
    monthlyHardLimit,
    monthlySoftLimit: Math.min(
      configured("SHARE_EMAIL_MONTHLY_SOFT_LIMIT", 500, 1, 500),
      monthlyHardLimit
    )
  };
}

function emailQuotaClockParts(nowMilliseconds) {
  const now = new Date(nowMilliseconds);
  if (!Number.isFinite(now.getTime())) {
    throw new HttpError(500, "internal_error", "Invalid email quota clock", { expose: false });
  }
  const utcHourStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours()
  );
  const utcMinuteStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes()
  );
  const seoul = new Date(nowMilliseconds + 9 * 60 * 60 * 1000);
  const seoulMonthKey = seoul.toISOString().slice(0, 7);
  const seoulNextMonthUtc = Date.UTC(
    seoul.getUTCFullYear(),
    seoul.getUTCMonth() + 1,
    1
  ) - 9 * 60 * 60 * 1000;
  return {
    now,
    seoulMonthKey,
    seoulNextMonthUtc,
    utcHourStart,
    utcMinuteStart
  };
}

function emailHourPeriod(hourStartMilliseconds, policy) {
  const key = new Date(hourStartMilliseconds).toISOString().slice(0, 13);
  return {
    bucketId: `hour_${key}`,
    expiresAt: new Date(hourStartMilliseconds + 32 * 24 * 60 * 60 * 1000),
    hardLimit: policy.globalHourlyLimit,
    periodKey: key,
    scope: "hourly",
    softLimit: policy.globalHourlyLimit
  };
}

function emailQuotaPeriods(nowMilliseconds = Date.now(), policy = resolveEmailQuotaPolicy()) {
  const parts = emailQuotaClockParts(nowMilliseconds);
  const minuteKey = parts.now.toISOString().slice(0, 16);
  return [
    {
      bucketId: `minute_${minuteKey}`,
      expiresAt: new Date(parts.utcMinuteStart + 72 * 60 * 60 * 1000),
      hardLimit: policy.globalMinuteLimit,
      periodKey: minuteKey,
      scope: "minute",
      softLimit: policy.globalMinuteLimit
    },
    emailHourPeriod(parts.utcHourStart, policy),
    {
      bucketId: `month_${parts.seoulMonthKey}`,
      expiresAt: new Date(parts.seoulNextMonthUtc + 400 * 24 * 60 * 60 * 1000),
      hardLimit: policy.monthlyHardLimit,
      periodKey: parts.seoulMonthKey,
      scope: "monthly",
      softLimit: policy.monthlySoftLimit
    }
  ];
}

function emailQuotaCount(document) {
  const reservedCount = document
    ? document.reservedCount
    : 0;
  const sentCount = document
    ? document.sentCount
    : 0;
  const ambiguousCount = document
    ? document.ambiguousCount ?? 0
    : 0;
  const failedCount = document
    ? document.failedCount ?? 0
    : 0;
  if (
    !Number.isSafeInteger(reservedCount)
    || reservedCount < 0
    || !Number.isSafeInteger(sentCount)
    || sentCount < 0
    || !Number.isSafeInteger(ambiguousCount)
    || ambiguousCount < 0
    || !Number.isSafeInteger(failedCount)
    || failedCount < 0
  ) {
    throw new HttpError(503, "email_feature_unavailable", "Email quota state is invalid", {
      expose: false
    });
  }
  return {
    ambiguousCount,
    failedCount,
    reservedCount,
    sentCount,
    total: reservedCount + sentCount + ambiguousCount
  };
}

function emailQuotaEnforcementTotal(counts, period) {
  const deliveryTotal =
    counts.reservedCount + counts.sentCount + counts.ambiguousCount;
  return deliveryTotal + (
    new Set(["minute", "hourly"]).has(period.scope)
      ? counts.failedCount
      : 0
  );
}

function emailQuotaExceeded(document, period) {
  const counts = emailQuotaCount(document);
  const total = emailQuotaEnforcementTotal(counts, period);
  return {
    ...counts,
    total,
    exceeded: total >= period.hardLimit,
    softLimitReached: total >= period.softLimit
  };
}

async function readEmailQuotaStates(context, nowMilliseconds) {
  const policy = resolveEmailQuotaPolicy();
  const periods = emailQuotaPeriods(nowMilliseconds, policy);
  const currentStates = await Promise.all(periods.map(async (period) => {
    const document = await firestoreGet(
      context,
      `publicShareEmailQuotaBuckets/${period.bucketId}`
    );
    return {
      document,
      path: `publicShareEmailQuotaBuckets/${period.bucketId}`,
      period,
      ...emailQuotaExceeded(document, period)
    };
  }));
  const currentHourStart = emailQuotaClockParts(nowMilliseconds).utcHourStart;
  const historicalHourPeriods = Array.from({ length: 24 }, (_, index) =>
    emailHourPeriod(currentHourStart - (index + 1) * 60 * 60 * 1000, policy)
  );
  const historicalHourDocuments = await Promise.all(
    historicalHourPeriods.map((period) =>
      firestoreGet(context, `publicShareEmailQuotaBuckets/${period.bucketId}`)
    )
  );
  const historicalHourStates = historicalHourPeriods.map((period, index) => {
    const document = historicalHourDocuments[index];
    return {
      document,
      path: `publicShareEmailQuotaBuckets/${period.bucketId}`,
      period,
      ...emailQuotaExceeded(document, period)
    };
  });
  const rollingCounts = [
    currentStates[1],
    ...historicalHourStates
  ].reduce((totals, state) => ({
    ambiguousCount: totals.ambiguousCount + state.ambiguousCount,
    failedCount: totals.failedCount + state.failedCount,
    reservedCount: totals.reservedCount + state.reservedCount,
    sentCount: totals.sentCount + state.sentCount,
    total:
      totals.total
      + state.reservedCount
      + state.sentCount
      + state.ambiguousCount
  }), {
    ambiguousCount: 0,
    failedCount: 0,
    reservedCount: 0,
    sentCount: 0,
    total: 0
  });
  const rollingPeriod = {
    bucketId: "rolling_24h",
    expiresAt: new Date(currentHourStart + 60 * 60 * 1000),
    hardLimit: policy.rolling24hHardLimit,
    periodKey: new Date(currentHourStart).toISOString(),
    scope: "rolling24h",
    softLimit: policy.rolling24hSoftLimit
  };
  return {
    enforcementStates: [
      ...currentStates,
      {
        document: null,
        path: "",
        period: rollingPeriod,
        ...rollingCounts,
        exceeded: rollingCounts.total >= rollingPeriod.hardLimit,
        softLimitReached: rollingCounts.total >= rollingPeriod.softLimit
      }
    ],
    lockStates: historicalHourStates.slice(0, 1),
    writeStates: currentStates
  };
}

function storedEmailQuotaState(document, bucketId) {
  const expectedScope = bucketId.startsWith("minute_")
    ? "minute"
    : bucketId.startsWith("hour_")
      ? "hourly"
      : bucketId.startsWith("month_")
        ? "monthly"
        : "";
  const expectedPeriodKey = expectedScope === "minute"
    ? bucketId.slice("minute_".length)
    : expectedScope === "hourly"
      ? bucketId.slice("hour_".length)
      : bucketId.slice("month_".length);
  if (
    !document
    || !new Set(["minute", "hourly", "monthly"]).has(document.scope)
    || document.scope !== expectedScope
    || typeof document.periodKey !== "string"
    || document.periodKey !== expectedPeriodKey
    || (
      document.scope === "minute"
        ? !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(document.periodKey)
        : document.scope === "hourly"
          ? !/^\d{4}-\d{2}-\d{2}T\d{2}$/u.test(document.periodKey)
          : !/^\d{4}-\d{2}$/u.test(document.periodKey)
    )
    || !Number.isSafeInteger(document.softLimit)
    || !Number.isSafeInteger(document.hardLimit)
    || document.softLimit < 1
    || document.hardLimit < document.softLimit
    || timestampMilliseconds(document.expiresAt) <= 0
  ) {
    throw new HttpError(503, "email_feature_unavailable", "Email quota bucket is invalid", {
      expose: false
    });
  }
  const counts = emailQuotaCount(document);
  const total = emailQuotaEnforcementTotal(counts, {
    scope: document.scope
  });
  return {
    document,
    path: `publicShareEmailQuotaBuckets/${bucketId}`,
    period: {
      bucketId,
      expiresAt: new Date(timestampMilliseconds(document.expiresAt)),
      hardLimit: document.hardLimit,
      periodKey: document.periodKey,
      scope: document.scope,
      softLimit: document.softLimit
    },
    ...counts,
    total,
    exceeded: total >= document.hardLimit,
    softLimitReached: total >= document.softLimit
  };
}

function assertEmailQuotaAvailable(states) {
  if (states.some((state) => state.exceeded)) {
    throw new HttpError(429, "rate_limited", "Secure Share email quota is exhausted", {
      retryAfter: 60 * 60
    });
  }
}

function emailQuotaBucketWrite(context, state, deltas, now) {
  const reservedCount = state.reservedCount + (deltas.reserved ?? 0);
  const sentCount = state.sentCount + (deltas.sent ?? 0);
  const failedCount = state.failedCount + (deltas.failed ?? 0);
  const ambiguousCount = state.ambiguousCount + (deltas.ambiguous ?? 0);
  if (
    reservedCount < 0
    || sentCount < 0
    || failedCount < 0
    || ambiguousCount < 0
  ) {
    throw new HttpError(503, "email_feature_unavailable", "Email quota release underflow", {
      expose: false
    });
  }
  const enforcementTotal = emailQuotaEnforcementTotal(
    { ambiguousCount, failedCount, reservedCount, sentCount },
    state.period
  );
  const fields = {
    scope: state.period.scope,
    periodKey: state.period.periodKey,
    reservedCount,
    sentCount,
    failedCount,
    ambiguousCount,
    softLimit: state.period.softLimit,
    hardLimit: state.period.hardLimit,
    softLimitReached: enforcementTotal >= state.period.softLimit,
    updatedAt: now,
    expiresAt: state.period.expiresAt
  };
  return state.document
    ? updateDocumentWrite(
      context.projectId,
      state.path,
      fields,
      [
        "scope",
        "periodKey",
        "reservedCount",
        "sentCount",
        "failedCount",
        "ambiguousCount",
        "softLimit",
        "hardLimit",
        "softLimitReached",
        "updatedAt",
        "expiresAt"
      ],
      state.document.__updateTime
    )
    : createDocumentWrite(context.projectId, state.path, fields);
}

function emailDeliveryId(challengeId, codeDigest, sendAttemptId) {
  return `mail_${hmacDigest(
    requiredSecret("SHARE_OTP_HMAC_KEY"),
    "quickmemo/secure-share/email-delivery/v1",
    challengeId,
    codeDigest,
    safeId(sendAttemptId, "sendAttemptId")
  ).slice(0, 48)}`;
}

async function commitEmailChallenge({
  challenge,
  challengePath,
  context,
  emailRuntime,
  eligible,
  existing,
  sendAttemptPath,
  state
}) {
  const deliveryId = eligible
    ? emailDeliveryId(
        challenge.__challengeId,
        challenge.codeDigest,
        challenge.sendAttemptId
      )
    : "";
  const deliveryPath = deliveryId ? `publicShareEmailDeliveries/${deliveryId}` : "";
  if (
    !eligible
    && state?.policy?.oneTimeEnabled === true
    && (
      state.share.status === "consumed"
      || Boolean(state.policy.consumedAt)
    )
  ) {
    return { committed: false, deliveryId, deliveryPath, duplicate: true };
  }
  for (
    let attempt = 0;
    attempt < emailQuotaReservationMaximumAttempts;
    attempt += 1
  ) {
    const now = new Date();
    const [quotaStateSet, delivery, sendAttempt] = await Promise.all([
      readEmailQuotaStates(context, now.getTime()),
      deliveryPath ? firestoreGet(context, deliveryPath) : Promise.resolve(null),
      eligible ? firestoreGet(context, sendAttemptPath) : Promise.resolve(null)
    ]);
    if (delivery || sendAttempt) {
      return { committed: false, deliveryId, deliveryPath, duplicate: true };
    }
    assertEmailQuotaAvailable(quotaStateSet.enforcementStates);
    const challengeFields = { ...challenge };
    delete challengeFields.__challengeId;
    const challengeWrite = existing
      ? updateDocumentWrite(
        context.projectId,
        challengePath,
        challengeFields,
        Object.keys(challengeFields),
        existing.__updateTime
      )
      : createDocumentWrite(context.projectId, challengePath, challengeFields);
    const writes = [challengeWrite];
    if (eligible) {
      writes.push(
        createDocumentWrite(context.projectId, deliveryPath, {
          shareId: state.share.__id,
          ownerUid: state.share.ownerUid,
          challengeId: challenge.__challengeId,
          emailHash: challenge.emailHash,
          policyVersion: state.policy.policyVersion,
          provider: configuredEmailProviderName(emailRuntime),
          settingsGeneration: emailRuntime.generation,
          status: "reserved",
          quotaBucketIds: quotaStateSet.writeStates.map(
            (quotaState) => quotaState.period.bucketId
          ),
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000)
        }),
        createDocumentWrite(context.projectId, sendAttemptPath, {
          challengeId: challenge.__challengeId,
          ownerUid: state.share.ownerUid,
          shareId: state.share.__id,
          requestIdHash: challenge.clientRequestIdHash,
          state: "reserved",
          reservedAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000)
        }),
        ...quotaStateSet.writeStates.map((quotaState) =>
          emailQuotaBucketWrite(context, quotaState, { reserved: 1 }, now)
        ),
        ...quotaStateSet.lockStates.map((quotaState) =>
          emailQuotaBucketWrite(context, quotaState, {}, now)
        )
      );
    }
    let transaction = "";
    if (state) {
      const transactionSnapshot = await beginShareMutationTransaction(
        context,
        state.share.__id
      );
      const currentState = transactionSnapshot.state;
      const validSnapshot =
        shareMutationSnapshotMatches(currentState, state)
        && currentState.share.status !== "consumed"
        && !currentState.policy.consumedAt;
      if (!validSnapshot) {
        await rollbackShareMutation(context, transactionSnapshot.transaction);
        return { committed: false, deliveryId, deliveryPath, duplicate: true };
      }
      transaction = transactionSnapshot.transaction;
    }
    try {
      await firestoreCommit(context, writes, transaction);
      if (eligible) {
        for (const quotaState of quotaStateSet.enforcementStates) {
          if (quotaState.total + 1 === quotaState.period.softLimit) {
            console.warn("secure share email quota soft limit reached", {
              hardLimit: quotaState.period.hardLimit,
              scope: quotaState.period.scope,
              total: quotaState.total + 1
            });
          }
        }
      }
      return {
        committed: true,
        deliveryId,
        deliveryPath,
        duplicate: false,
        sendAttemptPath
      };
    } catch (error) {
      if (transaction) {
        await rollbackShareMutation(context, transaction);
      }
      if (!isOptimisticConflict(error)) {
        throw error;
      }
      const latest = await firestoreGet(context, challengePath);
      const latestAttempt = eligible
        ? await firestoreGet(context, sendAttemptPath)
        : null;
      if (latestAttempt) {
        return { committed: false, deliveryId, deliveryPath, duplicate: true };
      }
      if (
        latest
        && (
          latest.codeDigest !== challenge.codeDigest
          || latest.policyVersion !== challenge.policyVersion
          || latest.sendAttemptId !== challenge.sendAttemptId
        )
      ) {
        return { committed: false, deliveryId, deliveryPath, duplicate: true };
      }
      if (attempt === emailQuotaReservationMaximumAttempts - 1) {
        throw new HttpError(409, "request_conflict", "Email challenge reservation conflict");
      }
      await waitBeforeOptimisticRetry(attempt);
    }
  }
  throw new HttpError(409, "request_conflict");
}

async function finalizeEmailDelivery(
  context,
  challengePath,
  challenge,
  reservation,
  outcome,
  providerMessageId = ""
) {
  if (!reservation?.committed || !reservation.deliveryPath) {
    return;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = new Date();
    const [delivery, latestChallenge, sendAttempt] = await Promise.all([
      firestoreGet(context, reservation.deliveryPath),
      firestoreGet(context, challengePath),
      reservation.sendAttemptPath
        ? firestoreGet(context, reservation.sendAttemptPath)
        : Promise.resolve(null)
    ]);
    if (!delivery || delivery.status !== "reserved") {
      return;
    }
    const bucketIds = delivery.quotaBucketIds;
    if (
      !Array.isArray(bucketIds)
      || bucketIds.length !== 3
      || new Set(bucketIds).size !== 3
      || bucketIds.some((bucketId) =>
        typeof bucketId !== "string"
        || !/^(?:minute_\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|hour_\d{4}-\d{2}-\d{2}T\d{2}|month_\d{4}-\d{2})$/u.test(bucketId)
      )
    ) {
      throw new HttpError(503, "email_feature_unavailable", "Email delivery bucket is invalid", {
        expose: false
      });
    }
    const quotaDocuments = await Promise.all(bucketIds.map((bucketId) =>
      firestoreGet(context, `publicShareEmailQuotaBuckets/${bucketId}`)
    ));
    const quotaStates = quotaDocuments.map((document, index) =>
      storedEmailQuotaState(document, bucketIds[index])
    );
    const challengeMatches =
      latestChallenge
      && latestChallenge.status === "pending"
      && latestChallenge.deliveryStatus === "reserved"
      && latestChallenge.codeDigest === challenge.codeDigest
      && latestChallenge.policyVersion === challenge.policyVersion
      && latestChallenge.sendAttemptId === challenge.sendAttemptId;
    const accepted = outcome === "sent";
    const providerMessageIdHash = accepted && providerMessageId
      ? sha256Digest(providerMessageId)
      : "";
    const writes = [
      updateDocumentWrite(
        context.projectId,
        reservation.deliveryPath,
        {
          status: outcome,
          providerMessageIdHash,
          updatedAt: now,
          completedAt: now
        },
        ["status", "providerMessageIdHash", "updatedAt", "completedAt"],
        delivery.__updateTime
      )
    ];
    if (sendAttempt) {
      writes.push(updateDocumentWrite(
        context.projectId,
        reservation.sendAttemptPath,
        {
          state: outcome,
          providerMessageIdHash,
          updatedAt: now,
          completedAt: now
        },
        ["state", "providerMessageIdHash", "updatedAt", "completedAt"],
        sendAttempt.__updateTime
      ));
    }
    writes.push(...quotaStates.map((quotaState) =>
      emailQuotaBucketWrite(context, quotaState, {
        reserved: -1,
        sent: accepted ? 1 : 0,
        failed: outcome === "failed" ? 1 : 0,
        ambiguous: outcome === "ambiguous" ? 1 : 0
      }, now)
    ));
    if (challengeMatches) {
      writes.push(updateDocumentWrite(
        context.projectId,
        challengePath,
        {
          status: accepted
            ? "pending"
            : outcome === "ambiguous"
              ? "ambiguous"
              : "send_failed",
          deliveryStatus: outcome,
          providerMessageIdHash,
          updatedAt: now
        },
        ["status", "deliveryStatus", "providerMessageIdHash", "updatedAt"],
        latestChallenge.__updateTime
      ));
    }
    try {
      await firestoreCommit(context, writes);
      return;
    } catch (error) {
      if (!isOptimisticConflict(error) || attempt === 4) {
        throw error;
      }
    }
  }
}

function emailChallengeMinimumResponseMilliseconds(random = randomInt) {
  const milliseconds = random(2_800, 3_201);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 2_800 || milliseconds > 3_200) {
    throw new HttpError(500, "internal_error", "Invalid challenge response delay", { expose: false });
  }
  return milliseconds;
}

async function padEmailChallengeResponse(
  timingStartedAt,
  minimumResponseMilliseconds,
  now = Date.now,
  wait = delay
) {
  if (
    !Number.isSafeInteger(minimumResponseMilliseconds)
    || minimumResponseMilliseconds < 2_800
    || minimumResponseMilliseconds > 3_200
  ) {
    throw new HttpError(500, "internal_error", "Invalid challenge response delay", { expose: false });
  }
  const elapsed = Math.max(0, now() - timingStartedAt);
  await wait(Math.max(0, minimumResponseMilliseconds - elapsed));
  return minimumResponseMilliseconds;
}

function otpVerificationFailureMinimumResponseMilliseconds(random = randomInt) {
  const milliseconds = random(2_800, 3_201);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 2_800 || milliseconds > 3_200) {
    throw new HttpError(500, "internal_error", "Invalid OTP verification response delay", {
      expose: false
    });
  }
  return milliseconds;
}

async function padOtpVerificationFailureResponse(
  timingStartedAt,
  minimumResponseMilliseconds,
  now = Date.now,
  wait = delay
) {
  if (
    !Number.isSafeInteger(minimumResponseMilliseconds)
    || minimumResponseMilliseconds < 2_800
    || minimumResponseMilliseconds > 3_200
  ) {
    throw new HttpError(500, "internal_error", "Invalid OTP verification response delay", {
      expose: false
    });
  }
  const elapsed = Math.max(0, now() - timingStartedAt);
  await wait(Math.max(0, minimumResponseMilliseconds - elapsed));
  return minimumResponseMilliseconds;
}

async function handleEmailChallenge(request, response, id, shareId) {
  requireMethod(request, ["POST"]);
  ensureSameOrigin(request);
  const context = await secureContext(request);
  const emailRuntime = await safeSecureShareEmailRuntimeSnapshot(context, {
    allowCache: false
  });
  if (emailRuntime.ready !== true) {
    throw new HttpError(503, "email_feature_unavailable", "Secure Share email is unavailable");
  }
  const body = await readJsonBody(request, 16 * 1024);
  assertOnlyKeys(body, ["clientRequestId", "email"]);
  const normalizedEmail = normalizeEmail(body.email);
  if (
    typeof body.clientRequestId !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/u.test(body.clientRequestId)
  ) {
    throw new HttpError(400, "invalid_request", "Invalid email challenge request");
  }
  const timingStartedAt = Date.now();
  const minimumResponseMilliseconds = emailChallengeMinimumResponseMilliseconds();
  const challengeTtlSeconds = otpTtlSeconds();
  const hashedEmail = emailDigest(normalizedEmail);
  const state = await loadShareState(context, shareId);
  const ownerUid = state?.share?.ownerUid ?? "";
  const networkHash = clientNetworkDigest(request);
  const challengeId = `ch_${hmacDigest(
    requiredSecret("SHARE_OTP_HMAC_KEY"),
    "quickmemo/secure-share/challenge-id/v1",
    shareId,
    hashedEmail
  ).slice(0, 40)}`;
  const clientRequestIdHash = hmacDigest(
    requiredSecret("SHARE_OTP_HMAC_KEY"),
    "quickmemo/secure-share/email-client-request/v1",
    shareId,
    hashedEmail,
    body.clientRequestId
  );
  const path = `publicShareEmailChallenges/${challengeId}`;
  const sendAttemptPath =
    `publicShareEmailSendAttempts/attempt_${clientRequestIdHash.slice(0, 48)}`;
  const [existing, existingSendAttempt] = await Promise.all([
    firestoreGet(context, path),
    firestoreGet(context, sendAttemptPath)
  ]);
  if (existingSendAttempt || existing?.clientRequestIdHash === clientRequestIdHash) {
    await padEmailChallengeResponse(timingStartedAt, minimumResponseMilliseconds);
    jsonResponse(response, 202, {
      ok: true,
      challengeId,
      resendAfterSeconds: Math.max(
        1,
        Math.min(
          60,
          Math.ceil((timestampMilliseconds(existing?.resendNotBefore) - Date.now()) / 1000)
        )
      ),
      requestId: id
    });
    return;
  }

  await consumeRateLimits(context, [
    {
      limitType: "otp_share_email_15m",
      keyParts: [shareId, hashedEmail],
      shareId,
      ownerUid,
      windowSeconds: 15 * 60,
      limit: 3
    },
    {
      limitType: "otp_share_email_rolling_24h",
      keyParts: [shareId, hashedEmail],
      shareId,
      ownerUid,
      windowSeconds: 60 * 60,
      rollingWindowHours: 24,
      limit: 10
    },
    {
      limitType: "otp_network_hour",
      keyParts: [networkHash],
      shareId,
      ownerUid,
      windowSeconds: 60 * 60,
      limit: 20
    },
    {
      limitType: "otp_share_hour",
      keyParts: [shareId],
      shareId,
      ownerUid,
      windowSeconds: 60 * 60,
      limit: 20
    }
  ]);

  const now = Date.now();
  if (timestampMilliseconds(existing?.resendNotBefore) > now) {
    throw new HttpError(429, "rate_limited", "Challenge resend cooldown", {
      retryAfter: Math.max(1, Math.ceil((timestampMilliseconds(existing.resendNotBefore) - now) / 1000))
    });
  }

  const code = generateOtpCode();
  const [policyEligible, providerHealthy] = await Promise.all([
    emailChallengeEligibility(context, state, hashedEmail),
    gmailProviderHealthAllowsSend(context, emailRuntime)
  ]);
  const eligible = policyEligible && providerHealthy;
  const challenge = {
    __challengeId: challengeId,
    shareId,
    ownerUid,
    policyVersion: state?.policy?.policyVersion ?? 0,
    emailHash: hashedEmail,
    codeDigest: eligible ? otpCodeDigest(challengeId, shareId, hashedEmail, code) : "",
    attempts: 0,
    maxAttempts: 5,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    expiresAt: new Date(now + challengeTtlSeconds * 1000),
    resendNotBefore: new Date(now + 60 * 1000),
    requestIpHash: networkHash,
    clientRequestIdHash,
    status: eligible ? "pending" : "suppressed",
    deliveryStatus: eligible ? "reserved" : "suppressed",
    sendAttemptId: `send_${hmacDigest(
      requiredSecret("SHARE_OTP_HMAC_KEY"),
      "quickmemo/secure-share/email-send-attempt/v1",
      shareId,
      hashedEmail,
      body.clientRequestId
    ).slice(0, 40)}`,
    providerMessageIdHash: "",
    verifiedAt: undefined,
    consumedAt: undefined,
    consumedAttemptHash: undefined
  };
  const reservation = await commitEmailChallenge({
    challenge,
    challengePath: path,
    context,
    emailRuntime,
    eligible,
    existing,
    sendAttemptPath,
    state
  });

  if (eligible && reservation.committed) {
    let delivery = null;
    let providerRuntimeValidated = false;
    try {
      const elapsedMilliseconds = Math.max(0, Date.now() - timingStartedAt);
      const deliveryBudgetMilliseconds = Math.max(
        1,
        Math.min(2_500, minimumResponseMilliseconds - elapsedMilliseconds - 250)
      );
      const currentEmailRuntime =
        await safeSecureShareEmailRuntimeSnapshot(context, {
          allowCache: false
        });
      if (
        currentEmailRuntime.ready !== true
        || currentEmailRuntime.generation !== emailRuntime.generation
      ) {
        throw new HttpError(
          503,
          "email_feature_unavailable",
          "Secure Share email settings changed before delivery"
        );
      }
      providerRuntimeValidated = true;
      const providerAdapter = createConfiguredEmailAdapter(
        context,
        currentEmailRuntime
      );
      delivery = await sendVerificationEmail(
        normalizedEmail,
        code,
        challengeTtlSeconds,
        reservation.deliveryId,
        providerAdapter,
        deliveryBudgetMilliseconds,
        {
          enabled: emailRuntime.ready === true,
          from: currentEmailRuntime.configuration.fromAddress
        }
      );
    } catch (error) {
      if (providerRuntimeValidated) {
        try {
          await recordGmailProviderHealth(
            context,
            emailRuntime,
            "failed",
            error
          );
        } catch (healthError) {
          console.error(
            "secure share email provider health update failed",
            safeErrorSummary(healthError)
          );
        }
      }
      try {
        await finalizeEmailDelivery(
          context,
          path,
          challenge,
          reservation,
          error instanceof HttpError && error.deliveryAmbiguous ? "ambiguous" : "failed"
        );
      } catch (finalizeError) {
        console.error(
          "secure share email delivery finalization failed",
          safeErrorSummary(finalizeError)
        );
      }
    }
    if (delivery) {
      try {
        await recordGmailProviderHealth(
          context,
          emailRuntime,
          "sent"
        );
      } catch (healthError) {
        console.error(
          "secure share email provider health update failed",
          safeErrorSummary(healthError)
        );
      }
      try {
        await finalizeEmailDelivery(
          context,
          path,
          challenge,
          reservation,
          "sent",
          delivery.messageId
        );
      } catch (error) {
        console.error(
          "secure share accepted email accounting finalization failed",
          safeErrorSummary(error)
        );
      }
    }
  }
  await padEmailChallengeResponse(timingStartedAt, minimumResponseMilliseconds);

  jsonResponse(response, 202, {
    ok: true,
    challengeId,
    resendAfterSeconds: 60,
    requestId: id
  });
}

async function incrementChallengeFailure(context, challengeId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const challenge = await firestoreGet(context, `publicShareEmailChallenges/${challengeId}`);
    if (
      !challenge
      || !new Set(["pending", "suppressed", "send_failed"]).has(challenge.status)
    ) {
      return;
    }
    const attempts = Math.min(
      (Number.isSafeInteger(challenge.attempts) ? challenge.attempts : 0) + 1,
      5
    );
    const status = attempts >= 5 ? "locked" : challenge.status;
    try {
      await firestoreCommit(context, [
        updateDocumentWrite(
          context.projectId,
          `publicShareEmailChallenges/${challengeId}`,
          { attempts, status, updatedAt: new Date() },
          ["attempts", "status", "updatedAt"],
          challenge.__updateTime
        )
      ]);
      return;
    } catch (error) {
      if (!isOptimisticConflict(error) || attempt === 4) {
        throw error;
      }
    }
  }
}

async function verifiedChallengeIdentity(context, shareId, policy, body, timing = {}) {
  const now = typeof timing.now === "function" ? timing.now : Date.now;
  const wait = typeof timing.wait === "function" ? timing.wait : delay;
  const random = typeof timing.random === "function" ? timing.random : randomInt;
  const timingStartedAt = now();
  const minimumResponseMilliseconds = otpVerificationFailureMinimumResponseMilliseconds(random);
  const rejectVerification = async () => {
    await padOtpVerificationFailureResponse(
      timingStartedAt,
      minimumResponseMilliseconds,
      now,
      wait
    );
    throw new HttpError(403, "access_denied", "Email challenge validation failed");
  };
  if (
    typeof body.challengeId !== "string"
    || typeof body.otp !== "string"
    || !/^\d{6}$/u.test(body.otp)
  ) {
    return rejectVerification();
  }
  let challengeId;
  try {
    challengeId = safeId(body.challengeId, "challengeId");
  } catch {
    return rejectVerification();
  }
  const challenge = await firestoreGet(context, `publicShareEmailChallenges/${challengeId}`);
  const attempts = Number.isSafeInteger(challenge?.attempts) ? challenge.attempts : 0;
  const validShape = Boolean(challenge)
    && challenge.shareId === shareId
    && challenge.policyVersion === policy.policyVersion
    && typeof challenge.emailHash === "string"
    && typeof challenge.sendAttemptId === "string"
    && /^[A-Za-z0-9_-]{1,160}$/u.test(challenge.sendAttemptId)
    && timestampMilliseconds(challenge.expiresAt) > Date.now()
    && attempts < 5
    && new Set(["pending", "consumed"]).has(challenge.status);
  const comparisonEmailHash = typeof challenge?.emailHash === "string"
    ? challenge.emailHash
    : hmacDigest(
      requiredSecret("SHARE_OTP_HMAC_KEY"),
      "quickmemo/secure-share/missing-challenge-email/v1",
      challengeId,
      shareId
    );
  const digestMatches = constantTimeStringEqual(
    otpCodeDigest(challengeId, shareId, comparisonEmailHash, body.otp),
    typeof challenge?.codeDigest === "string" ? challenge.codeDigest : ""
  );
  const allowed = policy.accessMode !== "allowed_emails"
    || (policy.allowedEmailHashes ?? []).includes(challenge?.emailHash);
  if (!validShape || !digestMatches || !allowed) {
    try {
      await incrementChallengeFailure(context, challengeId);
    } catch (error) {
      console.error(
        "secure share challenge failure update failed",
        safeErrorSummary(error)
      );
    }
    return rejectVerification();
  }
  return {
    identityType: "verified_email",
    identityHash: identityDigest("email", challenge.emailHash),
    participantIdentityHash:
      secureShareParticipantIdentityEnabled() && policy.permissionLevel === "comment"
      ? participantIdentityHash(shareId, "verified_email", challenge.emailHash)
      : "",
    participantToken: "",
    participantTokenDigest: "",
    setParticipantCookie: false,
    displayName: safeDisplayName(body.displayName, "Verified guest"),
    challenge
  };
}

async function resolveAccessIdentity(
  request,
  context,
  shareId,
  stateOrPolicy,
  body,
  otpVerificationTiming,
  preverifiedCaller
) {
  const state = stateOrPolicy?.share && stateOrPolicy?.policy
    ? stateOrPolicy
    : null;
  const policy = state?.policy ?? stateOrPolicy;
  await emailRuntimeForPolicy(context, policy);
  let caller = preverifiedCaller === undefined ? null : preverifiedCaller;
  if (preverifiedCaller === undefined && authorizationToken(request)) {
    caller = await activeUserFromRequest(request, context);
  }
  if (caller && state && shareManagedBy(state, caller)) {
    throw new HttpError(
      409,
      "owner_preview_required",
      "Share managers must use owner preview"
    );
  }
  if (policy.accessMode === "authenticated_users") {
    if (!caller) {
      throw new HttpError(401, "authentication_required");
    }
    if (policy.emailVerificationRequired === true && (!caller.email || caller.emailVerified !== true)) {
      throw new HttpError(403, "access_denied", "A verified account email is required");
    }
    return {
      identityType: "quickmemo_user",
      identityHash: identityDigest("uid", caller.uid),
      participantIdentityHash:
        secureShareParticipantIdentityEnabled() && policy.permissionLevel === "comment"
        ? participantIdentityHash(shareId, "quickmemo_user", caller.uid)
        : "",
      participantToken: "",
      participantTokenDigest: "",
      setParticipantCookie: false,
      authorUid: caller.uid,
      displayName: safeDisplayName(caller.profileDisplayName || caller.displayName, "QuickMemo user"),
      caller,
      challenge: null
    };
  }

  if (policy.emailVerificationRequired === true) {
    const verifiedIdentity = await verifiedChallengeIdentity(
      context,
      shareId,
      policy,
      body,
      otpVerificationTiming
    );
    if (caller) {
      return {
        ...verifiedIdentity,
        identityType: "quickmemo_user",
        identityHash: identityDigest("uid", caller.uid),
        participantIdentityHash:
          secureShareParticipantIdentityEnabled() && policy.permissionLevel === "comment"
            ? participantIdentityHash(shareId, "quickmemo_user", caller.uid)
            : "",
        authorUid: caller.uid,
        displayName: safeDisplayName(
          caller.profileDisplayName || caller.displayName,
          "QuickMemo user"
        ),
        caller
      };
    }
    return {
      ...verifiedIdentity,
      authorUid: "",
      caller: null
    };
  }

  if (caller) {
    return {
      identityType: "quickmemo_user",
      identityHash: identityDigest("uid", caller.uid),
      participantIdentityHash:
        secureShareParticipantIdentityEnabled() && policy.permissionLevel === "comment"
        ? participantIdentityHash(shareId, "quickmemo_user", caller.uid)
        : "",
      participantToken: "",
      participantTokenDigest: "",
      setParticipantCookie: false,
      authorUid: caller.uid,
      displayName: safeDisplayName(caller.profileDisplayName || caller.displayName, "QuickMemo user"),
      caller,
      challenge: null
    };
  }
  const binding = browserBindingFromRequest(request, shareId);
  if (!binding) {
    throw new HttpError(428, "metadata_required", "Browser binding is missing");
  }
  const participantEnabled = secureShareParticipantIdentityEnabled()
    && policy.permissionLevel === "comment";
  const existingParticipantToken = participantEnabled
    ? participantTokenFromRequest(request, shareId)
    : "";
  const issuedParticipant = participantEnabled && !existingParticipantToken
    ? issueAnonymousParticipantToken(
        shareId,
        binding,
        safeUnlockAttemptId(body.unlockAttemptId)
      )
    : null;
  const participantToken = participantEnabled
    ? existingParticipantToken || issuedParticipant.token
    : "";
  const verifiedParticipant = participantEnabled
    ? issuedParticipant ?? verifiedAnonymousParticipantToken(
        shareId,
        participantToken
      )
    : null;
  const participantIdentityValue = verifiedParticipant?.issuanceIdentity ?? "";
  return {
    identityType: "browser",
    identityHash: participantEnabled
      ? identityDigest("participant-token", participantIdentityValue)
      : identityDigest("browser", binding),
    participantIdentityHash: participantEnabled
      ? participantIdentityHash(shareId, "browser", participantIdentityValue)
      : "",
    participantToken,
    participantTokenDigest: participantEnabled
      ? participantTokenIdentityDigest(
          shareId,
          participantIdentityValue
        )
      : "",
    setParticipantCookie: participantEnabled && !existingParticipantToken,
    authorUid: "",
    displayName: safeDisplayName(body.displayName, "Guest"),
    caller: null,
    challenge: null
  };
}

function allocatedParticipantMatches(
  participant,
  expectedState,
  identity,
  participantId
) {
  return Boolean(
    participant
    && participant.schemaVersion === 1
    && participant.shareId === expectedState.share.__id
    && participant.ownerUid === expectedState.share.ownerUid
    && participant.participantId === participantId
    && participant.identityHash === identity.participantIdentityHash
    && participant.identityType === identity.identityType
    && typeof participant.participantTokenDigest === "string"
    && (
      identity.identityType === "browser"
        ? participant.participantTokenDigest === identity.participantTokenDigest
        : participant.participantTokenDigest === ""
    )
    && participant.status === "active"
    && typeof participant.displayName === "string"
    && typeof participant.systemDefaultName === "string"
    && typeof participant.normalizedDisplayName === "string"
    && Number.isSafeInteger(participant.guestNumber)
    && participant.guestNumber >= 1
    && participant.guestNumber <= 1_000_000_000
    && participant.systemDefaultName === `guest${participant.guestNumber}`
  );
}

function participantLastSeenWrites(context, participantPath, participant) {
  const lastSeenAt = timestampMilliseconds(participant.lastSeenAt);
  if (
    Number.isFinite(lastSeenAt)
    && lastSeenAt > Date.now() - sessionLastSeenWriteIntervalMilliseconds
  ) {
    return [];
  }
  const now = new Date();
  return [updateDocumentWrite(
    context.projectId,
    participantPath,
    { lastSeenAt: now, updatedAt: now },
    ["lastSeenAt", "updatedAt"],
    participant.__updateTime
  )];
}

async function beginParticipantAllocation(context, expectedState, identity) {
  const shareId = expectedState.share.__id;
  if (
    !secureShareParticipantIdentityEnabled()
    || expectedState.policy.permissionLevel !== "comment"
  ) {
    return {
      enabled: false,
      limitReached: false,
      participant: null,
      transaction: "",
      writes: []
    };
  }
  if (
    typeof identity.participantIdentityHash !== "string"
    || !/^[A-Za-z0-9_-]{40,128}$/u.test(identity.participantIdentityHash)
  ) {
    throw new HttpError(503, "service_unavailable", "Participant identity is unavailable", {
      expose: false
    });
  }
  const participantId = participantIdFromIdentityHash(identity.participantIdentityHash);
  const participantPath = participantDocumentPath(shareId, participantId);
  const counterPath = participantCounterPath(shareId);
  const reusableParticipant = await firestoreGet(context, participantPath);
  if (reusableParticipant) {
    if (!allocatedParticipantMatches(
      reusableParticipant,
      expectedState,
      identity,
      participantId
    )) {
      throw new HttpError(409, "participant_state_invalid");
    }
    return {
      enabled: true,
      limitReached: false,
      participant: reusableParticipant,
      transaction: "",
      writes: participantLastSeenWrites(
        context,
        participantPath,
        reusableParticipant
      )
    };
  }
  const snapshot = await firestoreBatchGetNewTransaction(context, [
    `publicNoteShares/${shareId}`,
    `publicSharePolicies/${shareId}`,
    participantPath,
    counterPath
  ]);
  const [share, policy, participant, counter] = snapshot.documents;
  const transactionState = share
    && policy
    && share.schemaVersion === 2
    && policy.schemaVersion === 2
      ? { share, policy }
      : null;
  if (!shareMutationSnapshotMatches(transactionState, expectedState)) {
    await rollbackShareMutation(context, snapshot.transaction);
    throw new HttpError(409, "request_conflict", "Share changed before participant allocation");
  }
  if (participant) {
    if (
      !counter
      || counter.schemaVersion !== 1
      || counter.shareId !== shareId
      || counter.ownerUid !== expectedState.share.ownerUid
      || !Number.isSafeInteger(counter.nextGuestNumber)
      || !Number.isSafeInteger(counter.participantCount)
      || counter.nextGuestNumber <= participant.guestNumber
      || counter.participantCount < 1
      || counter.participantCount > 1000
      || !allocatedParticipantMatches(participant, expectedState, identity, participantId)
    ) {
      await rollbackShareMutation(context, snapshot.transaction);
      throw new HttpError(409, "participant_state_invalid");
    }
    return {
      enabled: true,
      limitReached: false,
      participant,
      transaction: snapshot.transaction,
      writes: participantLastSeenWrites(context, participantPath, participant)
    };
  }

  const nextGuestNumber = counter
    ? counter.nextGuestNumber
    : 1;
  const participantCount = counter
    ? counter.participantCount
    : 0;
  if (
    !Number.isSafeInteger(nextGuestNumber)
    || !Number.isSafeInteger(participantCount)
    || nextGuestNumber < 1
    || nextGuestNumber > 1_000_000_000
    || participantCount < 0
    || participantCount > 1000
    || (counter && (
      counter.schemaVersion !== 1
      || counter.shareId !== shareId
      || counter.ownerUid !== expectedState.share.ownerUid
    ))
  ) {
    await rollbackShareMutation(context, snapshot.transaction);
    throw new HttpError(409, "participant_state_invalid");
  }
  if (participantCount >= maximumParticipantsPerShare) {
    return {
      enabled: true,
      limitReached: true,
      participant: null,
      transaction: snapshot.transaction,
      writes: []
    };
  }
  const now = new Date();
  const systemDefaultName = `guest${nextGuestNumber}`;
  const createdParticipant = {
    schemaVersion: 1,
    shareId,
    ownerUid: expectedState.share.ownerUid,
    participantId,
    guestNumber: nextGuestNumber,
    systemDefaultName,
    displayName: systemDefaultName,
    normalizedDisplayName: systemDefaultName,
    identityType: identity.identityType,
    identityHash: identity.participantIdentityHash,
    participantTokenDigest: identity.participantTokenDigest || "",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    lastRenamedAt: undefined,
    renameCount: 0,
    status: "active",
    policyVersionAtCreation: expectedState.policy.policyVersion
  };
  const counterFields = {
    schemaVersion: 1,
    shareId,
    ownerUid: expectedState.share.ownerUid,
    nextGuestNumber: nextGuestNumber + 1,
    participantCount: participantCount + 1,
    createdAt: counter?.createdAt ?? now,
    updatedAt: now
  };
  return {
    enabled: true,
    limitReached: false,
    participant: { ...createdParticipant, __id: participantId },
    transaction: snapshot.transaction,
    writes: [
      counter
        ? updateDocumentWrite(
            context.projectId,
            counterPath,
            counterFields,
            Object.keys(counterFields),
            counter.__updateTime
          )
        : createDocumentWrite(context.projectId, counterPath, counterFields),
      createDocumentWrite(context.projectId, participantPath, createdParticipant)
    ]
  };
}

function sessionCapabilities(
  policy,
  ownerPreview = false,
  participantAvailable = true,
  participantIdentitySessionEnabled = secureShareParticipantIdentityEnabled(),
  participantLimitReached = false
) {
  const participantIdentityEnabled =
    !ownerPreview
    && policy.permissionLevel === "comment"
    && secureShareParticipantIdentityEnabled()
    && participantIdentitySessionEnabled;
  return {
    permissionLevel: policy.permissionLevel,
    canComment:
      ownerPreview
      || (
        policy.permissionLevel === "comment"
        && (
          !participantIdentityEnabled
          || participantAvailable
        )
      ),
    canSaveCopy: !ownerPreview && policy.permissionLevel === "save_copy",
    downloadAllowed: policy.downloadAllowed === true,
    quickCopyButtonVisible: policy.quickCopyButtonVisible !== false,
    participantIdentityEnabled,
    participantLimitReached:
      participantIdentityEnabled && participantLimitReached,
    commentIpPrefixEnabled:
      (ownerPreview || participantIdentityEnabled)
      && policy.showCommenterIpPrefix === true
      && secureShareCommentIpPrefixEnabled()
  };
}

function sessionFields({
  share,
  policy,
  sessionDigest,
  identity,
  browserBindingHash,
  attemptHash,
  csrfDigest,
  expiresAt,
  ownerPreview = false
}) {
  return {
    shareId: share.__id,
    ownerUid: share.ownerUid,
    policyVersion: policy.policyVersion,
    identityType: identity.identityType,
    identityHash: identity.identityHash,
    browserBindingHash,
    authorUid: identity.authorUid || "",
    authorDisplayName: identity.displayName,
    permissionLevel: policy.permissionLevel,
    downloadAllowed: policy.downloadAllowed === true,
    quickCopyButtonVisible: policy.quickCopyButtonVisible !== false,
    oneTimeGrant: !ownerPreview && policy.oneTimeEnabled === true,
    ownerPreview,
    unlockAttemptHash: attemptHash,
    challengeSendAttemptId: identity.challenge
      ? safeId(identity.challenge.sendAttemptId, "sendAttemptId")
      : "",
    csrfDigest,
    createdAt: new Date(),
    expiresAt,
    revokedAt: undefined,
    lastSeenAt: new Date(),
    sessionReferenceHash: hmacDigest(
      requiredSecret("SHARE_SESSION_HMAC_KEY"),
      "quickmemo/secure-share/session-reference/v1",
      sessionDigest
    )
  };
}

async function issueOwnerPreviewSession(
  request,
  context,
  state,
  owner,
  browserBindingHash,
  unlockAttemptId,
  networkHash,
  id
) {
  const identity = {
    identityType: shareOwnedBy(state, owner) ? "owner_preview" : "admin_preview",
    identityHash: identityDigest("uid", owner.uid),
    authorUid: owner.uid,
    displayName: safeDisplayName(
      owner.profileDisplayName || owner.displayName,
      shareOwnedBy(state, owner) ? "Owner" : "Administrator",
      true
    )
  };
  const attemptHash = unlockAttemptDigest(
    state.share.__id,
    unlockAttemptId,
    hmacDigest(
      requiredSecret("SHARE_SESSION_HMAC_KEY"),
      "quickmemo/secure-share/owner-preview-binding/v1",
      identity.identityHash,
      browserBindingHash
    )
  );
  const sessionToken = randomToken(32);
  const digest = sessionTokenDigest(sessionToken);
  const csrfToken = randomToken(32);
  const expiresAt = new Date(Math.min(
    timestampMilliseconds(state.share.expiresAt),
    Date.now() + 30 * 60 * 1000
  ));
  const session = sessionFields({
    share: state.share,
    policy: state.policy,
    sessionDigest: digest,
    identity,
    browserBindingHash,
    attemptHash,
    csrfDigest: csrfTokenDigest(csrfToken, digest),
    expiresAt,
    ownerPreview: true
  });
  const transactionSnapshot = await beginShareMutationTransaction(
    context,
    state.share.__id
  );
  if (!shareMutationSnapshotMatches(transactionSnapshot.state, state)) {
    await rollbackShareMutation(context, transactionSnapshot.transaction);
    throw new HttpError(409, "request_conflict", "Share changed before owner preview");
  }
  try {
    await firestoreCommit(context, [
      createDocumentWrite(context.projectId, `publicShareAccessSessions/${digest}`, session),
      createAuditWrite(context, state.share, "owner_preview", "success", {
        requestId: id,
        identityType: identity.identityType,
        identityHash: identity.identityHash,
        ipHash: networkHash,
        userAgentHash: userAgentDigest(request)
      })
    ], transactionSnapshot.transaction);
  } catch (error) {
    await rollbackShareMutation(context, transactionSnapshot.transaction);
    if (isOptimisticConflict(error)) {
      throw new HttpError(409, "request_conflict", "Share changed before owner preview");
    }
    throw error;
  }
  return { sessionToken, csrfToken, expiresAt: expiresAt.toISOString() };
}

function participantAllocationQueueRetryAfter() {
  return randomInt(2, 6);
}

function participantAllocationQueueError(message) {
  return new HttpError(429, "rate_limited", message, {
    retryAfter: participantAllocationQueueRetryAfter()
  });
}

function participantAllocationRequestDisconnected(request, response) {
  return (
    request?.aborted === true
    && request?.complete !== true
  )
    || (
      request?.destroyed === true
      && request?.complete !== true
    )
    || (
      request?.signal?.aborted === true
      && request?.complete !== true
    )
    || (
      response?.destroyed === true
      && response?.writableEnded !== true
    );
}

function removeParticipantAllocationRequestListeners(entry) {
  for (const remove of entry.removeRequestListeners) {
    remove();
  }
  entry.removeRequestListeners = [];
}

function participantAllocationQueueSnapshot() {
  return {
    liveShareKeys: participantAllocationQueues.size,
    totalEntries: participantAllocationQueueTotalEntries
  };
}

function deleteParticipantAllocationQueueIfEmpty(queueKey, queue) {
  if (
    queue.entryCount === 0
    && queue.active === null
    && queue.pending.length === 0
    && participantAllocationQueues.get(queueKey) === queue
  ) {
    participantAllocationQueues.delete(queueKey);
  }
}

function settleParticipantAllocationEntry(entry, disposition, value) {
  if (entry.publicSettled) {
    return;
  }
  entry.publicSettled = true;
  if (disposition === "resolve") {
    entry.resolve(value);
  } else {
    entry.reject(value);
  }
}

function removePendingParticipantAllocationEntry(queueKey, queue, entry, error) {
  if (entry.started || entry.removed) {
    return false;
  }
  const index = queue.pending.indexOf(entry);
  if (index < 0) {
    return false;
  }
  queue.pending.splice(index, 1);
  entry.removed = true;
  clearTimeout(entry.waitTimer);
  entry.abortController.abort();
  removeParticipantAllocationRequestListeners(entry);
  queue.entryCount -= 1;
  participantAllocationQueueTotalEntries -= 1;
  settleParticipantAllocationEntry(entry, "reject", error);
  deleteParticipantAllocationQueueIfEmpty(queueKey, queue);
  return true;
}

function startNextParticipantAllocationEntry(queueKey, queue) {
  if (queue.active !== null) {
    return;
  }
  const entry = queue.pending.shift();
  if (!entry) {
    deleteParticipantAllocationQueueIfEmpty(queueKey, queue);
    return;
  }
  if (entry.removed) {
    startNextParticipantAllocationEntry(queueKey, queue);
    return;
  }
  entry.started = true;
  queue.active = entry;
  clearTimeout(entry.waitTimer);
  removeParticipantAllocationRequestListeners(entry);

  // This queue only suppresses same-isolate contention. Every operation keeps
  // its Firestore transaction as the cross-isolate authorization authority.
  Promise.resolve()
    .then(() => entry.operation({
      enqueuedAt: entry.enqueuedAt,
      signal: entry.abortController.signal
    }))
    .then(
      (value) => settleParticipantAllocationEntry(entry, "resolve", value),
      (error) => settleParticipantAllocationEntry(entry, "reject", error)
    )
    .finally(() => {
      queue.active = null;
      queue.entryCount -= 1;
      participantAllocationQueueTotalEntries -= 1;
      startNextParticipantAllocationEntry(queueKey, queue);
    });
}

function withParticipantAllocationQueue(shareId, operation, request, response) {
  const queueKey = safeId(shareId, "shareId");
  if (typeof operation !== "function") {
    throw new TypeError("Participant allocation operation is required");
  }
  if (participantAllocationRequestDisconnected(request, response)) {
    return Promise.reject(
      participantAllocationQueueError("Participant allocation request disconnected")
    );
  }

  let queue = participantAllocationQueues.get(queueKey);
  if (
    queue
    && queue.entryCount >= participantAllocationQueueMaximumEntriesPerShare
  ) {
    return Promise.reject(
      participantAllocationQueueError("Participant allocation queue is full")
    );
  }
  if (
    !queue
    && participantAllocationQueues.size >= participantAllocationQueueMaximumShareKeys
  ) {
    return Promise.reject(
      participantAllocationQueueError("Participant allocation share capacity is full")
    );
  }
  if (
    participantAllocationQueueTotalEntries
      >= participantAllocationQueueMaximumTotalEntries
  ) {
    return Promise.reject(
      participantAllocationQueueError("Participant allocation capacity is full")
    );
  }

  if (!queue) {
    queue = {
      active: null,
      entryCount: 0,
      pending: []
    };
    participantAllocationQueues.set(queueKey, queue);
  }

  const enqueuedAt = Date.now();
  let resolveEntry = () => undefined;
  let rejectEntry = () => undefined;
  const promise = new Promise((resolve, reject) => {
    resolveEntry = resolve;
    rejectEntry = reject;
  });
  const entry = {
    abortController: new AbortController(),
    enqueuedAt,
    operation,
    publicSettled: false,
    reject: rejectEntry,
    removeRequestListeners: [],
    removed: false,
    resolve: resolveEntry,
    started: false,
    waitTimer: null
  };
  queue.pending.push(entry);
  queue.entryCount += 1;
  participantAllocationQueueTotalEntries += 1;

  const cancelPending = () => {
    removePendingParticipantAllocationEntry(
      queueKey,
      queue,
      entry,
      participantAllocationQueueError("Participant allocation request disconnected")
    );
  };
  if (request && typeof request.once === "function") {
    const onAborted = () => cancelPending();
    const onClose = () => {
      if (participantAllocationRequestDisconnected(request)) {
        cancelPending();
      }
    };
    request.once("aborted", onAborted);
    request.once("close", onClose);
    const removeListener = typeof request.removeListener === "function"
      ? request.removeListener.bind(request)
      : typeof request.off === "function"
        ? request.off.bind(request)
        : null;
    if (removeListener) {
      entry.removeRequestListeners.push(
        () => removeListener("aborted", onAborted),
        () => removeListener("close", onClose)
      );
    }
  }
  if (request?.signal && typeof request.signal.addEventListener === "function") {
    const onSignalAbort = () => cancelPending();
    request.signal.addEventListener("abort", onSignalAbort, { once: true });
    entry.removeRequestListeners.push(() =>
      request.signal.removeEventListener("abort", onSignalAbort)
    );
  }
  if (response && typeof response.once === "function") {
    const onResponseClose = () => {
      if (response.writableEnded !== true) {
        cancelPending();
      }
    };
    response.once("close", onResponseClose);
    const removeResponseListener = typeof response.removeListener === "function"
      ? response.removeListener.bind(response)
      : typeof response.off === "function"
        ? response.off.bind(response)
        : null;
    if (removeResponseListener) {
      entry.removeRequestListeners.push(
        () => removeResponseListener("close", onResponseClose)
      );
    }
  }

  entry.waitTimer = setTimeout(() => {
    removePendingParticipantAllocationEntry(
      queueKey,
      queue,
      entry,
      participantAllocationQueueError("Participant allocation queue wait exceeded")
    );
  }, participantAllocationQueueWaitMilliseconds);

  if (participantAllocationRequestDisconnected(request, response)) {
    cancelPending();
  } else {
    startNextParticipantAllocationEntry(queueKey, queue);
  }
  return promise;
}

function requireParticipantAllocationExecution(execution) {
  if (execution?.signal?.aborted === true) {
    throw participantAllocationQueueError("Participant allocation request cancelled");
  }
}

async function revalidateParticipantAllocationChallenge(
  context,
  shareId,
  verifiedPolicyVersion,
  identity,
  attemptHash
) {
  if (!identity.challenge) {
    return identity;
  }
  const original = identity.challenge;
  const challengeId = safeId(original.__id, "challengeId");
  const challenge = await firestoreGet(
    context,
    `publicShareEmailChallenges/${challengeId}`
  );
  const attempts = Number.isSafeInteger(challenge?.attempts) ? challenge.attempts : 0;
  const immutableFieldsMatch = Boolean(challenge)
    && challenge.shareId === shareId
    && challenge.policyVersion === verifiedPolicyVersion
    && challenge.emailHash === original.emailHash
    && challenge.codeDigest === original.codeDigest
    && challenge.sendAttemptId === original.sendAttemptId;
  const statusAllowsAttempt = challenge?.status === "pending"
    || (
      challenge?.status === "consumed"
      && challenge.consumedAttemptHash === attemptHash
    );
  if (
    !immutableFieldsMatch
    || !statusAllowsAttempt
    || attempts >= 5
    || timestampMilliseconds(challenge.expiresAt) <= Date.now()
  ) {
    throw new HttpError(409, "access_denied", "Challenge was already consumed");
  }
  return {
    ...identity,
    challenge
  };
}

function idempotentChallengeSessionCredentials(
  shareId,
  policyVersion,
  identityHash,
  browserBindingHash,
  attemptHash,
  challengeSendAttemptId
) {
  const issuanceId = safeId(challengeSendAttemptId, "sendAttemptId");
  const sessionToken = hmacDigest(
    requiredSecret("SHARE_SESSION_HMAC_KEY"),
    "quickmemo/secure-share/idempotent-challenge-session/v2",
    shareId,
    policyVersion,
    identityHash,
    browserBindingHash,
    attemptHash,
    issuanceId
  );
  const sessionDigest = sessionTokenDigest(sessionToken);
  const csrfToken = hmacDigest(
    requiredSecret("SHARE_CSRF_HMAC_KEY"),
    "quickmemo/secure-share/idempotent-challenge-csrf/v2",
    shareId,
    policyVersion,
    identityHash,
    browserBindingHash,
    attemptHash,
    issuanceId,
    sessionDigest
  );
  return {
    csrfToken,
    sessionDigest,
    sessionToken
  };
}

async function recoverConsumedChallengeSession(
  context,
  state,
  identity,
  browserBindingHash,
  attemptHash,
  credentials
) {
  const session = await firestoreGet(
    context,
    `publicShareAccessSessions/${credentials.sessionDigest}`
  );
  const expectedCsrfDigest = csrfTokenDigest(
    credentials.csrfToken,
    credentials.sessionDigest
  );
  const validSession = Boolean(session)
    && session.shareId === state.share.__id
    && session.policyVersion === state.policy.policyVersion
    && session.ownerPreview !== true
    && !session.revokedAt
    && timestampMilliseconds(session.expiresAt) > Date.now()
    && typeof session.identityHash === "string"
    && constantTimeStringEqual(session.identityHash, identity.identityHash)
    && typeof session.browserBindingHash === "string"
    && constantTimeStringEqual(session.browserBindingHash, browserBindingHash)
    && typeof session.unlockAttemptHash === "string"
    && constantTimeStringEqual(session.unlockAttemptHash, attemptHash)
    && typeof session.challengeSendAttemptId === "string"
    && constantTimeStringEqual(
      session.challengeSendAttemptId,
      identity.challenge.sendAttemptId
    )
    && typeof session.csrfDigest === "string"
    && constantTimeStringEqual(session.csrfDigest, expectedCsrfDigest);
  if (!validSession) {
    throw new HttpError(
      409,
      "access_denied",
      "Consumed challenge has no recoverable access session"
    );
  }
  return {
    sessionToken: credentials.sessionToken,
    csrfToken: credentials.csrfToken,
    expiresAt: new Date(timestampMilliseconds(session.expiresAt)).toISOString(),
    policy: state.policy,
    participantId: typeof session.participantId === "string"
      ? session.participantId
      : "",
    participantIdentityEnabled: session.participantIdentityEnabled === true,
    participantLimitReached: session.participantLimitReached === true
  };
}

async function issueAccessSession(
  request,
  context,
  shareId,
  verifiedPolicyVersion,
  identity,
  browserBindingHash,
  attemptHash,
  networkHash,
  id,
  participantAllocationExecution
) {
  requireParticipantAllocationExecution(participantAllocationExecution);
  identity = await revalidateParticipantAllocationChallenge(
    context,
    shareId,
    verifiedPolicyVersion,
    identity,
    attemptHash
  );
  const idempotentCredentials = identity.challenge
    ? idempotentChallengeSessionCredentials(
        shareId,
        verifiedPolicyVersion,
        identity.identityHash,
        browserBindingHash,
        attemptHash,
        identity.challenge.sendAttemptId
      )
    : null;
  for (let attempt = 0; attempt < participantAllocationMaximumAttempts; attempt += 1) {
    requireParticipantAllocationExecution(participantAllocationExecution);
    const state = await loadShareState(context, shareId);
    assertPublicShareAvailable(state);
    await emailRuntimeForPolicy(context, state.policy);
    if (state.policy.policyVersion !== verifiedPolicyVersion) {
      throw new HttpError(409, "policy_changed");
    }
    await requireSourceAvailable(context, state.share);
    const now = Date.now();
    const sessionToken = idempotentCredentials?.sessionToken ?? randomToken(32);
    const digest = idempotentCredentials?.sessionDigest ?? sessionTokenDigest(sessionToken);
    const csrfToken = idempotentCredentials?.csrfToken ?? randomToken(32);
    const csrfDigest = csrfTokenDigest(csrfToken, digest);
    if (identity.challenge?.status === "consumed") {
      return recoverConsumedChallengeSession(
        context,
        state,
        identity,
        browserBindingHash,
        attemptHash,
        idempotentCredentials
      );
    }
    const ttlSeconds = sessionTtlSeconds(state.policy.oneTimeEnabled === true);
    const expiresAtMilliseconds = Math.min(
      timestampMilliseconds(state.share.expiresAt),
      now + ttlSeconds * 1000
    );
    if (expiresAtMilliseconds <= now) {
      throw new HttpError(404, "share_unavailable");
    }
    const expiresAt = new Date(expiresAtMilliseconds);
    const session = sessionFields({
      share: state.share,
      policy: state.policy,
      sessionDigest: digest,
      identity,
      browserBindingHash,
      attemptHash,
      csrfDigest,
      expiresAt
    });
    const writes = [];
    const consumed = Boolean(state.policy.consumedAt);

    if (state.policy.oneTimeEnabled === true && consumed) {
      const grant = await firestoreGet(context, `publicShareUnlockGrants/${attemptHash}`);
      if (
        !grant
        || grant.shareId !== shareId
        || grant.identityHash !== identity.identityHash
        || grant.browserBindingHash !== browserBindingHash
        || grant.policyVersion !== state.policy.policyVersion
        || grant.status !== "active"
        || timestampMilliseconds(grant.graceExpiresAt) <= now
      ) {
        throw new HttpError(409, "share_unavailable", "One-time share is already consumed");
      }
      const previousDigest = grant.activeSessionDigest;
      const previousSession = previousDigest
        ? await firestoreGet(context, `publicShareAccessSessions/${safeId(previousDigest, "sessionDigest")}`)
        : null;
      writes.push(
        createDocumentWrite(context.projectId, `publicShareAccessSessions/${digest}`, session),
        updateDocumentWrite(
          context.projectId,
          `publicShareUnlockGrants/${attemptHash}`,
          {
            activeSessionDigest: digest,
            updatedAt: new Date(now),
            expiresAt
          },
          ["activeSessionDigest", "updatedAt", "expiresAt"],
          grant.__updateTime
        )
      );
      if (previousSession) {
        writes.push(updateDocumentWrite(
          context.projectId,
          `publicShareAccessSessions/${previousDigest}`,
          { revokedAt: new Date(now), updatedAt: new Date(now) },
          ["revokedAt", "updatedAt"],
          previousSession.__updateTime
        ));
      }
    } else {
      if (state.share.status === "consumed") {
        throw new HttpError(409, "share_unavailable");
      }
      const shareFields = {
        status: state.policy.oneTimeEnabled === true ? "consumed" : "active",
        lastAccessAt: new Date(now),
        successfulAccessCount: (Number.isSafeInteger(state.share.successfulAccessCount)
          ? state.share.successfulAccessCount
          : 0) + 1,
        updatedAt: new Date(now),
        consumedAt: state.policy.oneTimeEnabled === true ? new Date(now) : undefined
      };
      const sharePaths = ["status", "lastAccessAt", "successfulAccessCount", "updatedAt"];
      if (state.policy.oneTimeEnabled === true) {
        sharePaths.push("consumedAt");
      }
      const policyFields = {
        lastAccessAt: new Date(now),
        updatedAt: new Date(now),
        consumedAt: state.policy.oneTimeEnabled === true ? new Date(now) : undefined,
        consumedAttemptHash: state.policy.oneTimeEnabled === true ? attemptHash : undefined,
        consumedIdentityHash: state.policy.oneTimeEnabled === true ? identity.identityHash : undefined
      };
      const policyPaths = ["lastAccessAt", "updatedAt"];
      if (state.policy.oneTimeEnabled === true) {
        policyPaths.push("consumedAt", "consumedAttemptHash", "consumedIdentityHash");
      }
      writes.push(
        updateDocumentWrite(
          context.projectId,
          `publicNoteShares/${shareId}`,
          shareFields,
          sharePaths,
          state.share.__updateTime
        ),
        updateDocumentWrite(
          context.projectId,
          `publicSharePolicies/${shareId}`,
          policyFields,
          policyPaths,
          state.policy.__updateTime
        ),
        createDocumentWrite(context.projectId, `publicShareAccessSessions/${digest}`, session)
      );
      if (state.policy.oneTimeEnabled === true) {
        writes.push(createDocumentWrite(
          context.projectId,
          `publicShareUnlockGrants/${attemptHash}`,
          {
            shareId,
            ownerUid: state.share.ownerUid,
            identityHash: identity.identityHash,
            browserBindingHash,
            createdAt: new Date(now),
            updatedAt: new Date(now),
            graceExpiresAt: new Date(now + oneTimeGraceSeconds() * 1000),
            expiresAt,
            status: "active",
            activeSessionDigest: digest,
            policyVersion: state.policy.policyVersion
          }
        ));
        const guardPath = sourceShareGuardPath(
          state.share.ownerUid,
          state.share.sourceNoteId
        );
        const guard = await firestoreGet(context, guardPath);
        if (
          sourceShareGuardMatches(
            guard,
            state.share.ownerUid,
            state.share.sourceNoteId,
            shareId
          )
        ) {
          writes.push(deleteDocumentWrite(
            context.projectId,
            guardPath,
            guard.__updateTime
          ));
        }
      }
      if (identity.challenge) {
        const challengeCanBeConsumed = identity.challenge.status === "pending";
        const challengeWasConsumedByThisAttempt = (
          identity.challenge.status === "consumed"
          && identity.challenge.consumedAttemptHash === attemptHash
        );
        if (!challengeCanBeConsumed && !challengeWasConsumedByThisAttempt) {
          throw new HttpError(409, "access_denied", "Challenge was already consumed");
        }
        if (challengeCanBeConsumed) {
          writes.push(updateDocumentWrite(
            context.projectId,
            `publicShareEmailChallenges/${identity.challenge.__id}`,
            {
              status: "consumed",
              verifiedAt: new Date(now),
              consumedAt: new Date(now),
              consumedAttemptHash: attemptHash,
              updatedAt: new Date(now)
            },
            ["status", "verifiedAt", "consumedAt", "consumedAttemptHash", "updatedAt"],
            identity.challenge.__updateTime
          ));
        }
      }
    }
    const participantAllocation = await beginParticipantAllocation(
      context,
      state,
      identity
    );
    try {
      requireParticipantAllocationExecution(participantAllocationExecution);
    } catch (error) {
      await rollbackShareMutation(context, participantAllocation.transaction);
      throw error;
    }
    if (
      state.policy.oneTimeEnabled === true
      && consumed
      && !participantAllocation.transaction
    ) {
      const transactionSnapshot = await beginShareMutationTransaction(
        context,
        shareId
      );
      if (!shareMutationSnapshotMatches(transactionSnapshot.state, state)) {
        await rollbackShareMutation(context, transactionSnapshot.transaction);
        throw new HttpError(
          409,
          "request_conflict",
          "Share changed before one-time grace access"
        );
      }
      participantAllocation.transaction = transactionSnapshot.transaction;
    }
    if (participantAllocation.participant) {
      session.participantId = participantAllocation.participant.participantId;
      session.authorDisplayName = participantAllocation.participant.displayName;
    }
    session.participantIdentityEnabled = participantAllocation.enabled;
    session.participantLimitReached = participantAllocation.limitReached;
    const sessionDocumentSuffix = `/documents/publicShareAccessSessions/${digest}`;
    const sessionWriteIndex = writes.findIndex((write) =>
      write?.update?.name?.endsWith(sessionDocumentSuffix)
      && write?.currentDocument?.exists === false
    );
    if (sessionWriteIndex < 0) {
      await rollbackShareMutation(context, participantAllocation.transaction);
      throw new HttpError(503, "service_unavailable", "Session write is unavailable", {
        expose: false
      });
    }
    writes[sessionWriteIndex] = createDocumentWrite(
      context.projectId,
      `publicShareAccessSessions/${digest}`,
      session
    );
    writes.push(...participantAllocation.writes);
    writes.push(createAuditWrite(context, state.share, "viewer_access", "success", {
      requestId: id,
      identityType: identity.identityType,
      identityHash: identity.identityHash,
      ipHash: networkHash,
      userAgentHash: userAgentDigest(request)
    }));
    try {
      requireParticipantAllocationExecution(participantAllocationExecution);
      await firestoreCommit(context, writes, participantAllocation.transaction);
      return {
        sessionToken,
        csrfToken,
        expiresAt: expiresAt.toISOString(),
        policy: state.policy,
        participantId: participantAllocation.participant?.participantId ?? "",
        participantIdentityEnabled: participantAllocation.enabled,
        participantLimitReached: participantAllocation.limitReached
      };
    } catch (error) {
      if (participantAllocation.transaction) {
        await rollbackShareMutation(context, participantAllocation.transaction);
      }
      if (
        !isOptimisticConflict(error)
        || attempt === participantAllocationMaximumAttempts - 1
      ) {
        throw error;
      }
      requireParticipantAllocationExecution(participantAllocationExecution);
      identity = await revalidateParticipantAllocationChallenge(
        context,
        shareId,
        verifiedPolicyVersion,
        identity,
        attemptHash
      );
      await waitBeforeOptimisticRetry(Math.min(attempt, 8));
    }
  }
  throw new HttpError(409, "request_conflict");
}

async function handleAccess(request, response, id, shareId) {
  requireMethod(request, ["POST"]);
  ensureSameOrigin(request);
  const body = await readJsonBody(request, 32 * 1024);
  assertOnlyKeys(body, [
    "password",
    "challengeId",
    "otp",
    "unlockAttemptId",
    "displayName",
    "oneTimeOpenConfirmed",
    "ownerPreview"
  ]);
  const unlockAttemptId = safeUnlockAttemptId(body.unlockAttemptId);
  const context = await secureContext(request);
  const state = await loadShareState(context, shareId);
  const binding = browserBindingFromRequest(request, shareId);
  if (!binding) {
    throw new HttpError(428, "metadata_required", "Browser binding is missing");
  }
  const browserBindingHash = identityDigest("browser-binding", binding);
  const networkIdentity = clientNetworkIdentity(request);

  if (body.ownerPreview === true) {
    await consumeRateLimits(context, [
      {
        limitType: "owner_preview_share_network_15m",
        keyParts: [shareId, networkIdentity.digest],
        shareId,
        ownerUid: state.share?.ownerUid ?? "",
        windowSeconds: 15 * 60,
        limit: 20
      },
      {
        limitType: "owner_preview_network_hour",
        keyParts: [networkIdentity.digest],
        shareId,
        ownerUid: state.share?.ownerUid ?? "",
        windowSeconds: 60 * 60,
        limit: 60
      }
    ]);
    const owner = await activeUserFromRequest(request, context);
    requireShareManager(state, owner);
    if (
      !state
      || state.share.revokedAt
      || state.share.status === "revoked"
      || timestampMilliseconds(state.share.expiresAt) <= Date.now()
      || state.policy.policyVersion !== state.share.policyVersion
    ) {
      throw new HttpError(404, "share_unavailable");
    }
    await requireSourceAvailable(context, state.share);
    const grant = await issueOwnerPreviewSession(
      request,
      context,
      state,
      owner,
      browserBindingHash,
      unlockAttemptId,
      networkIdentity.digest,
      id
    );
    jsonResponse(response, 200, {
      ok: true,
      ownerPreview: true,
      csrfToken: grant.csrfToken,
      sessionExpiresAt: grant.expiresAt,
      capabilities: sessionCapabilities(state.policy, true),
      requestId: id
    }, {
      setCookies: [
        sessionCookie(
          request,
          shareId,
          grant.sessionToken,
          Math.max(1, Math.floor((Date.parse(grant.expiresAt) - Date.now()) / 1000))
        )
      ]
    });
    return;
  }

  assertPublicShareAvailable(state);
  await emailRuntimeForPolicy(context, state.policy);
  await requireSourceAvailable(context, state.share);
  const networkHash = networkIdentity.digest;
  const accessLimits = [
    {
      limitType: "access_share_network_15m",
      keyParts: [shareId, networkHash],
      shareId,
      ownerUid: state.share.ownerUid,
      windowSeconds: 15 * 60,
      limit: 20
    },
    {
      limitType: "access_network_hour",
      keyParts: [networkHash],
      shareId,
      ownerUid: state.share.ownerUid,
      windowSeconds: 60 * 60,
      limit: 60
    }
  ];
  const passwordLimits = state.policy.passwordEnabled === true
    ? [
      {
        limitType: "password_share_network_15m",
        keyParts: [shareId, networkHash],
        shareId,
        ownerUid: state.share.ownerUid,
        windowSeconds: 15 * 60,
        limit: 5
      },
      {
        limitType: "password_network_hour",
        keyParts: [networkHash],
        shareId,
        ownerUid: state.share.ownerUid,
        windowSeconds: 60 * 60,
        limit: 20
      }
    ]
    : [];
  if (state.policy.emailVerificationRequired === true) {
    accessLimits.push(
      {
        limitType: "otp_verify_challenge_10m",
        keyParts: [shareId, typeof body.challengeId === "string" ? body.challengeId : "missing"],
        shareId,
        ownerUid: state.share.ownerUid,
        windowSeconds: 10 * 60,
        limit: 5
      },
      {
        limitType: "otp_verify_network_hour",
        keyParts: [networkHash],
        shareId,
        ownerUid: state.share.ownerUid,
        windowSeconds: 60 * 60,
        limit: 20
      }
    );
  }
  await consumeRateLimits(context, accessLimits);
  const passwordReservations = await consumeRateLimits(context, passwordLimits);

  if (state.policy.passwordEnabled === true) {
    const validPassword = await verifySharePassword(body.password, state.policy.passwordHashRecord);
    if (!validPassword) {
      throw new HttpError(403, "access_denied", "Password verification failed");
    }
    await releaseRateLimitReservations(context, passwordReservations);
  } else if (body.password !== undefined) {
    throw new HttpError(400, "invalid_request", "Password was not requested");
  }

  let signedInUser = null;
  if (authorizationToken(request)) {
    signedInUser = await activeUserFromRequest(request, context);
    if (shareManagedBy(state, signedInUser)) {
      throw new HttpError(409, "owner_preview_required");
    }
  }

  const identity = await resolveAccessIdentity(
    request,
    context,
    shareId,
    state,
    body,
    undefined,
    signedInUser
  );
  const boundIdentityHash = hmacDigest(
    requiredSecret("SHARE_SESSION_HMAC_KEY"),
    "quickmemo/secure-share/bound-identity/v1",
    identity.identityHash,
    browserBindingHash
  );
  const attemptHash = unlockAttemptDigest(shareId, unlockAttemptId, boundIdentityHash);
  if (
    identity.challenge?.status === "consumed"
    && identity.challenge.consumedAttemptHash !== attemptHash
  ) {
    throw new HttpError(409, "access_denied", "Challenge was already consumed");
  }
  const issueSession = (participantAllocationExecution) => issueAccessSession(
    request,
    context,
    shareId,
    state.policy.policyVersion,
    identity,
    browserBindingHash,
    attemptHash,
    networkHash,
    id,
    participantAllocationExecution
  );
  const grant = (
    secureShareParticipantIdentityEnabled()
    && state.policy.permissionLevel === "comment"
  )
    ? await withParticipantAllocationQueue(shareId, issueSession, request, response)
    : await issueSession();
  jsonResponse(response, 200, {
    ok: true,
    csrfToken: grant.csrfToken,
    sessionExpiresAt: grant.expiresAt,
    ownerPreview: false,
    capabilities: sessionCapabilities(
      grant.policy,
      false,
      Boolean(grant.participantId) && !grant.participantLimitReached,
      grant.participantIdentityEnabled,
      grant.participantLimitReached
    ),
    requestId: id
  }, {
    setCookies: [
      sessionCookie(
        request,
        shareId,
        grant.sessionToken,
        Math.max(1, Math.floor((Date.parse(grant.expiresAt) - Date.now()) / 1000))
      ),
      ...(
        grant.participantId && identity.setParticipantCookie
          ? [participantCookie(request, shareId, identity.participantToken)]
          : []
      )
    ]
  });
}

async function validatedSession(request, context, shareId) {
  const session = await validatedBoundSession(request, context, shareId);
  const state = await loadShareState(context, shareId);
  if (session.ownerPreview === true) {
    const owner = await activeUserFromRequest(request, context);
    requireShareManager(state, owner);
    if (
      !state
      || state.share.revokedAt
      || state.share.status === "revoked"
      || timestampMilliseconds(state.share.expiresAt) <= Date.now()
      || session.policyVersion !== state.policy.policyVersion
    ) {
      throw new HttpError(401, "session_expired");
    }
  } else {
    if (
      !publicShareAvailable(state)
      || session.policyVersion !== state.policy.policyVersion
      || (
        state.share.status === "consumed"
        && (state.policy.oneTimeEnabled !== true || session.oneTimeGrant !== true)
      )
    ) {
      throw new HttpError(401, "session_expired");
    }
    await emailRuntimeForPolicy(context, state.policy);
  }
  await requireSourceAvailable(context, state.share);
  return { session, state };
}

async function validatedBoundSession(request, context, shareId) {
  const token = sessionTokenFromRequest(request, shareId);
  if (!token) {
    throw new HttpError(401, "session_required");
  }
  const digest = sessionTokenDigest(token);
  const session = await firestoreGet(context, `publicShareAccessSessions/${digest}`);
  if (
    !session
    || session.shareId !== shareId
    || session.revokedAt
    || timestampMilliseconds(session.expiresAt) <= Date.now()
  ) {
    throw new HttpError(401, "session_expired");
  }
  const binding = browserBindingFromRequest(request, shareId);
  if (
    !binding
    || typeof session.browserBindingHash !== "string"
    || !constantTimeStringEqual(identityDigest("browser-binding", binding), session.browserBindingHash)
  ) {
    throw new HttpError(401, "session_expired");
  }
  session.__sessionDigest = digest;
  return session;
}

async function validatedRevisionSession(request, context, shareId) {
  const session = await validatedBoundSession(request, context, shareId);
  const share = await firestoreGet(context, `publicNoteShares/${shareId}`);
  let validatedOwner = null;
  if (session.ownerPreview === true) {
    const owner = await activeUserFromRequest(request, context);
    requireShareManager(share ? { share } : null, owner);
    if (owner.uid === share?.ownerUid) {
      validatedOwner = owner;
    }
    if (
      !share
      || share.schemaVersion !== 2
      || share.revokedAt
      || share.status === "revoked"
      || timestampMilliseconds(share.expiresAt) <= Date.now()
      || session.policyVersion !== share.policyVersion
    ) {
      throw new HttpError(401, "session_expired");
    }
  } else {
    if (
      !share
      || share.schemaVersion !== 2
      || share.ready !== true
      || !new Set(["active", "consumed"]).has(share.status)
      || share.revokedAt
      || timestampMilliseconds(share.expiresAt) <= Date.now()
      || session.policyVersion !== share.policyVersion
      || (
        share.status === "consumed"
        && (share.oneTimeEnabled !== true || session.oneTimeGrant !== true)
      )
    ) {
      throw new HttpError(401, "session_expired");
    }
    await emailRuntimeForPolicy(context, {
      accessMode: share.accessModePublicHint,
      emailVerificationRequired: share.requiresEmailVerification === true
    });
  }
  // The high-frequency revision path intentionally avoids a policy-document
  // read. Every authorization-affecting policy mutation mirrors policyVersion
  // and public gate hints onto the share in the same atomic commit. The
  // session, share, source note, and source-owner lifecycle checks remain
  // mandatory; an already validated owner profile is reused when possible.
  await requireSourceAvailable(context, share, validatedOwner);
  return { session, share };
}

async function handleSession(request, response, id, shareId) {
  requireMethod(request, ["GET"]);
  const context = await secureContext(request);
  const { session, state } = await validatedSession(request, context, shareId);
  const csrfToken = randomToken(32);
  const csrfDigest = csrfTokenDigest(csrfToken, session.__sessionDigest);
  const sessionUpdateFields = { csrfDigest };
  const sessionUpdateFieldPaths = ["csrfDigest"];
  const lastSeenAt = timestampMilliseconds(session.lastSeenAt);

  if (
    !Number.isFinite(lastSeenAt)
    || lastSeenAt <= Date.now() - sessionLastSeenWriteIntervalMilliseconds
  ) {
    sessionUpdateFields.lastSeenAt = new Date();
    sessionUpdateFieldPaths.push("lastSeenAt");
  }
  await firestoreCommit(context, [
    updateDocumentWrite(
      context.projectId,
      `publicShareAccessSessions/${session.__sessionDigest}`,
      sessionUpdateFields,
      sessionUpdateFieldPaths,
      session.__updateTime
    )
  ]);
  jsonResponse(response, 200, {
    ok: true,
    csrfToken,
    sessionExpiresAt: session.expiresAt,
    ownerPreview: session.ownerPreview === true,
    capabilities: sessionCapabilities(
      state.policy,
      session.ownerPreview === true,
      Boolean(session.participantId) && session.participantLimitReached !== true,
      session.participantIdentityEnabled === true,
      session.participantLimitReached === true
    ),
    requestId: id
  });
}

function safeAttachmentMetadata(attachment, currentGeneration) {
  return {
    id: attachment.__id,
    version: attachment.version,
    algorithm: attachment.algorithm,
    generation: currentGeneration,
    encryptedFileName: attachment.encryptedFileName,
    extension: attachment.extension,
    mimeType: attachment.mimeType,
    originalSize: attachment.originalSize,
    encryptedSize: attachment.encryptedSize,
    iv: attachment.iv,
    chunkSize: attachment.chunkSize,
    chunkCount: attachment.chunkCount,
    chunkIvs: attachment.chunkIvs,
    previewAllowed:
      previewableExtensions.has(attachment.extension)
      && Number.isSafeInteger(attachment.encryptedSize)
      && attachment.encryptedSize <= maximumPreviewBytes
  };
}

function attachmentCurrent(attachment, share) {
  return attachment?.isReady === true
    && attachment.privacyVersion === 1
    && attachmentGenerationIncludes(attachment, share.currentGeneration ?? "");
}

async function attachmentGenerationSnapshot(
  context,
  shareId,
  generation,
  transaction = "",
  maximumCount = 100
) {
  if (
    !Number.isSafeInteger(maximumCount)
    || maximumCount < 0
    || maximumCount > 100
  ) {
    throw new TypeError("Invalid attachment generation read bound");
  }
  if (!generation) {
    return [];
  }
  const safeShareId = safeId(shareId, "shareId");
  const safeGeneration = safeId(generation, "generation");
  const parentPath = `publicNoteShares/${safeShareId}`;
  const generationQuery = (fieldPath, op) => ({
    from: [{ collectionId: "attachments" }],
    where: {
      fieldFilter: {
        field: { fieldPath },
        op,
        value: firestoreStringValue(safeGeneration)
      }
    },
    limit: maximumCount + 1
  });
  const [direct, membership] = await Promise.all([
    firestoreRunQuery(
      context,
      generationQuery("generation", "EQUAL"),
      parentPath,
      transaction
    ),
    firestoreRunQuery(
      context,
      generationQuery("generations", "ARRAY_CONTAINS"),
      parentPath,
      transaction
    )
  ]);
  if (direct.length > maximumCount || membership.length > maximumCount) {
    throw new HttpError(
      409,
      "attachment_state_changed",
      "Current attachment generation exceeded its complete-read bound"
    );
  }
  const attachmentsById = new Map();
  [...direct, ...membership].forEach((attachment) => {
    const attachmentId = safeId(attachment.__id, "attachmentId");
    const existing = attachmentsById.get(attachmentId);
    if (
      typeof attachment.__updateTime !== "string"
      || !attachment.__updateTime
      || !attachmentGenerationIncludes(attachment, safeGeneration)
      || attachment.isReady !== true
      || attachment.privacyVersion !== 1
      || (
        existing
        && (
          existing.__name !== attachment.__name
          || existing.__updateTime !== attachment.__updateTime
        )
      )
    ) {
      throw new HttpError(409, "attachment_state_changed");
    }
    attachmentsById.set(attachmentId, attachment);
  });
  if (attachmentsById.size > maximumCount) {
    throw new HttpError(409, "attachment_state_changed");
  }
  return [...attachmentsById.values()];
}

async function currentAttachments(context, share) {
  const expectedAttachmentCount = Number.isSafeInteger(share.attachmentCount)
    ? share.attachmentCount
    : 0;
  if (expectedAttachmentCount < 0 || expectedAttachmentCount > 100) {
    throw new HttpError(409, "attachment_state_changed");
  }
  const attachments = await attachmentGenerationSnapshot(
    context,
    share.__id,
    share.currentGeneration ?? "",
    "",
    expectedAttachmentCount
  );
  const current = attachments.filter((attachment) => attachmentCurrent(attachment, share));
  if (
    current.length > 100
    || current.length !== expectedAttachmentCount
  ) {
    throw new HttpError(409, "attachment_state_changed");
  }
  return current;
}

async function handleRevision(request, response, id, shareId) {
  requireMethod(request, ["GET"]);
  ensureRevisionReadRequest(request);
  const context = await secureContext(request);
  const { share } = await validatedRevisionSession(request, context, shareId);
  const etag = secureShareRevisionEtag(share);
  response.setHeader("etag", etag);
  if (etagMatches(headerValue(request, "if-none-match"), etag)) {
    response.statusCode = 304;
    response.end();
    return;
  }
  jsonResponse(response, 200, {
    ok: true,
    contentRevision: contentRevisionValue(share),
    policyVersion: share.policyVersion,
    requestId: id
  });
}

async function handleContent(request, response, id, shareId) {
  requireMethod(request, ["GET"]);
  const context = await secureContext(request);
  const { state } = await validatedSession(request, context, shareId);
  response.setHeader("etag", secureShareRevisionEtag(state.share));
  const attachments = await currentAttachments(context, state.share);
  attachments.forEach((attachment) => validateAttachmentRecord(attachment, state.share));
  jsonResponse(response, 200, {
    ok: true,
    schemaVersion: 2,
    contentRevision: contentRevisionValue(state.share),
    policyVersion: state.policy.policyVersion,
    encryptedTitle: state.share.encryptedTitle,
    encryptedBody: state.share.encryptedBody,
    attachments: attachments.map((attachment) =>
      safeAttachmentMetadata(attachment, state.share.currentGeneration ?? "")
    ),
    requestId: id
  });
}

function participantPublicDto(participant, state, currentIpPrefix) {
  const lastRenamedAt = timestampMilliseconds(participant.lastRenamedAt);
  const cooldownMilliseconds = Number.isFinite(lastRenamedAt)
    ? lastRenamedAt + 60_000
    : Number.NaN;
  const prefixVisible =
    state.policy.permissionLevel === "comment"
    && state.policy.showCommenterIpPrefix === true
    && secureShareCommentIpPrefixEnabled();
  const prefix = prefixVisible
    ? safeIpPrefixSnapshot(currentIpPrefix)
    : null;
  return {
    participantId: participant.participantId,
    guestNumber: participant.guestNumber,
    displayName: participant.displayName,
    isSystemDefaultName:
      participant.displayName === participant.systemDefaultName,
    canRename: participant.status === "active",
    renameCooldownEndsAt:
      Number.isFinite(cooldownMilliseconds) && cooldownMilliseconds > Date.now()
        ? new Date(cooldownMilliseconds).toISOString()
        : null,
    capabilities: {
      canRename: participant.status === "active",
      showsCommenterIpPrefix: prefixVisible
    },
    ...(prefix ? { currentIpPrefix: prefix } : {})
  };
}

function validParticipantForSession(participant, shareId, participantId) {
  return Boolean(
    participant
    && participant.schemaVersion === 1
    && participant.shareId === shareId
    && participant.participantId === participantId
    && participant.status === "active"
    && typeof participant.displayName === "string"
    && typeof participant.systemDefaultName === "string"
    && Number.isSafeInteger(participant.guestNumber)
    && participant.guestNumber >= 1
  );
}

function participantRenameSnapshotMatches(preReadParticipant, transactionParticipant) {
  return Boolean(
    preReadParticipant
    && transactionParticipant
    && preReadParticipant.__updateTime === transactionParticipant.__updateTime
    && preReadParticipant.displayName === transactionParticipant.displayName
    && preReadParticipant.normalizedDisplayName
      === transactionParticipant.normalizedDisplayName
  );
}

function renameWindowState(participant, nowMilliseconds) {
  const hourStartMilliseconds = Math.floor(nowMilliseconds / 3_600_000) * 3_600_000;
  const dayStartMilliseconds = Math.floor(nowMilliseconds / 86_400_000) * 86_400_000;
  const storedHourStart = timestampMilliseconds(participant.renameHourWindowStart);
  const storedDayStart = timestampMilliseconds(participant.renameDayWindowStart);
  return {
    hourStartMilliseconds,
    dayStartMilliseconds,
    hourCount:
      storedHourStart === hourStartMilliseconds && Number.isSafeInteger(participant.renameHourCount)
        ? participant.renameHourCount
        : 0,
    dayCount:
      storedDayStart === dayStartMilliseconds && Number.isSafeInteger(participant.renameDayCount)
        ? participant.renameDayCount
        : 0
  };
}

function renameRequestHistory(requestDocument) {
  if (!requestDocument) {
    return [];
  }
  const legacyLatest = {
    requestHash: requestDocument.requestHash,
    requestedNameHash: requestDocument.requestedNameHash,
    status: requestDocument.status,
    noChange: requestDocument.noChange === true,
    completedAt: requestDocument.updatedAt
  };
  const history = Array.isArray(requestDocument.recentRequests)
    ? requestDocument.recentRequests
    : [legacyLatest];
  if (
    history.length < 1
    || history.length > 10
    || history.some((entry) =>
      !isPlainRecord(entry)
      || typeof entry.requestHash !== "string"
      || !/^[A-Za-z0-9_-]{40,128}$/u.test(entry.requestHash)
      || typeof entry.requestedNameHash !== "string"
      || !/^[A-Za-z0-9_-]{40,128}$/u.test(entry.requestedNameHash)
      || entry.status !== "succeeded"
      || typeof entry.noChange !== "boolean"
      || !Number.isFinite(timestampMilliseconds(entry.completedAt))
    )
  ) {
    return null;
  }
  return history;
}

async function renameParticipant(
  request,
  context,
  state,
  session,
  participantId,
  displayName,
  clientRequestId,
  networkIdentity,
  requestIdentifier
) {
  const name = safeParticipantDisplayName(displayName);
  const participantPath = participantDocumentPath(state.share.__id, participantId);
  const ownerProfilePath = `users/${safeId(state.share.ownerUid, "ownerUid")}`;
  const requestHash = hmacDigest(
    requiredSecret("SHARE_PARTICIPANT_HMAC_KEY"),
    "quickmemo/secure-share/participant-rename-request/v1",
    state.share.__id,
    participantId,
    clientRequestId
  );
  const requestedNameHash = hmacDigest(
    requiredSecret("SHARE_PARTICIPANT_HMAC_KEY"),
    "quickmemo/secure-share/participant-rename-value/v1",
    state.share.__id,
    name.normalizedDisplayName
  );
  const renameRequestPath = participantRenameRequestPath(
    state.share.__id,
    participantId
  );

  for (let attempt = 0; attempt < participantRenameMaximumAttempts; attempt += 1) {
    const currentParticipant = await firestoreGet(context, participantPath);
    if (!validParticipantForSession(
      currentParticipant,
      state.share.__id,
      participantId
    )) {
      throw new HttpError(409, "participant_unavailable");
    }
    const newRegistryPath = participantNameRegistryPath(
      state.share.__id,
      name.normalizedDisplayName
    );
    const hasCustomCurrentName =
      currentParticipant.displayName !== currentParticipant.systemDefaultName;
    const oldRegistryPath = hasCustomCurrentName
      ? participantNameRegistryPath(
          state.share.__id,
          normalizedParticipantName(currentParticipant.displayName)
        )
      : "";
    const readPaths = [
      `publicNoteShares/${state.share.__id}`,
      `publicSharePolicies/${state.share.__id}`,
      ownerProfilePath,
      participantPath,
      renameRequestPath,
      newRegistryPath,
      ...(oldRegistryPath && oldRegistryPath !== newRegistryPath ? [oldRegistryPath] : [])
    ];
    const snapshot = await firestoreBatchGetNewTransaction(context, readPaths);
    const byPath = new Map(readPaths.map((path, index) => [path, snapshot.documents[index]]));
    const transactionState = byPath.get(`publicNoteShares/${state.share.__id}`)
      && byPath.get(`publicSharePolicies/${state.share.__id}`)
      ? {
          share: byPath.get(`publicNoteShares/${state.share.__id}`),
          policy: byPath.get(`publicSharePolicies/${state.share.__id}`)
        }
      : null;
    const participant = byPath.get(participantPath);
    const ownerProfile = byPath.get(ownerProfilePath);
    const renameRequest = byPath.get(renameRequestPath);
    let recentRenameRequests = [];
    if (
      !shareMutationSnapshotMatches(transactionState, state)
      || !validParticipantForSession(participant, state.share.__id, participantId)
      || session.policyVersion !== transactionState?.policy?.policyVersion
    ) {
      await rollbackShareMutation(context, snapshot.transaction);
      throw new HttpError(409, "request_conflict", "Share changed before participant rename");
    }
    if (!participantRenameSnapshotMatches(currentParticipant, participant)) {
      await rollbackShareMutation(context, snapshot.transaction);
      if (attempt === participantRenameMaximumAttempts - 1) {
        throw new HttpError(
          409,
          "request_conflict",
          "Participant changed before participant rename"
        );
      }
      await waitBeforeOptimisticRetry(attempt);
      continue;
    }
    const ownerDisplayName =
      typeof ownerProfile?.displayName === "string"
      && ownerProfile.displayName.length <= 256
        ? ownerProfile.displayName
        : "";
    if (
      ownerDisplayName
      && normalizedParticipantName(ownerDisplayName)
        === name.normalizedDisplayName
    ) {
      await rollbackShareMutation(context, snapshot.transaction);
      throw new HttpError(409, "display_name_unavailable");
    }
    if (renameRequest) {
      recentRenameRequests = renameRequestHistory(renameRequest);
      if (
        renameRequest.schemaVersion !== 1
        || renameRequest.shareId !== state.share.__id
        || renameRequest.ownerUid !== state.share.ownerUid
        || renameRequest.participantId !== participantId
        || !recentRenameRequests
      ) {
        await rollbackShareMutation(context, snapshot.transaction);
        throw new HttpError(409, "participant_state_invalid");
      }
      const replay = recentRenameRequests.find((entry) =>
        entry.requestHash === requestHash
      );
      if (replay) {
        await rollbackShareMutation(context, snapshot.transaction);
        if (
          replay.requestedNameHash === requestedNameHash
          && replay.status === "succeeded"
        ) {
          return participant;
        }
        throw new HttpError(409, "request_conflict", "Rename idempotency key was reused");
      }
    }
    const nowMilliseconds = Date.now();
    const lastRenamedAt = timestampMilliseconds(participant.lastRenamedAt);
    if (Number.isFinite(lastRenamedAt) && nowMilliseconds < lastRenamedAt + 60_000) {
      await rollbackShareMutation(context, snapshot.transaction);
      throw new HttpError(429, "rate_limited", "Rename cooldown is active", {
        retryAfter: Math.max(1, Math.ceil((lastRenamedAt + 60_000 - nowMilliseconds) / 1000))
      });
    }
    const window = renameWindowState(participant, nowMilliseconds);
    if (window.hourCount >= 3) {
      await rollbackShareMutation(context, snapshot.transaction);
      throw new HttpError(429, "rate_limited", "Hourly rename limit exceeded", {
        retryAfter: Math.max(
          1,
          Math.ceil((window.hourStartMilliseconds + 3_600_000 - nowMilliseconds) / 1000)
        )
      });
    }
    if (window.dayCount >= 10) {
      await rollbackShareMutation(context, snapshot.transaction);
      throw new HttpError(429, "rate_limited", "Daily rename limit exceeded", {
        retryAfter: Math.max(
          1,
          Math.ceil((window.dayStartMilliseconds + 86_400_000 - nowMilliseconds) / 1000)
        )
      });
    }
    if (participant.normalizedDisplayName === name.normalizedDisplayName) {
      const now = new Date(nowMilliseconds);
      const participantFields = {
        updatedAt: now,
        lastRenamedAt: now,
        renameCount: (Number.isSafeInteger(participant.renameCount)
          ? participant.renameCount
          : 0) + 1,
        renameHourWindowStart: new Date(window.hourStartMilliseconds),
        renameHourCount: window.hourCount + 1,
        renameDayWindowStart: new Date(window.dayStartMilliseconds),
        renameDayCount: window.dayCount + 1,
        lastRenameRequestHash: requestHash,
        lastRenameRequestedNameHash: requestedNameHash
      };
      try {
        await firestoreCommit(context, [
          updateDocumentWrite(
            context.projectId,
            participantPath,
            participantFields,
            Object.keys(participantFields),
            participant.__updateTime
          ),
          (
            renameRequest
              ? updateDocumentWrite(
                  context.projectId,
                  renameRequestPath,
                  {
                    schemaVersion: 1,
                    shareId: state.share.__id,
                    ownerUid: state.share.ownerUid,
                    participantId,
                    requestHash,
                    requestedNameHash,
                    status: "succeeded",
                    noChange: true,
                    recentRequests: [
                      ...recentRenameRequests,
                      {
                        requestHash,
                        requestedNameHash,
                        status: "succeeded",
                        noChange: true,
                        completedAt: now
                      }
                    ].slice(-10),
                    createdAt: renameRequest.createdAt ?? now,
                    updatedAt: now
                  },
                  [
                    "schemaVersion",
                    "shareId",
                    "ownerUid",
                    "participantId",
                    "requestHash",
                    "requestedNameHash",
                    "status",
                    "noChange",
                    "recentRequests",
                    "createdAt",
                    "updatedAt"
                  ],
                  renameRequest.__updateTime
                )
              : createDocumentWrite(context.projectId, renameRequestPath, {
                  schemaVersion: 1,
                  shareId: state.share.__id,
                  ownerUid: state.share.ownerUid,
                  participantId,
                  requestHash,
                  requestedNameHash,
                  status: "succeeded",
                  noChange: true,
                  recentRequests: [{
                    requestHash,
                    requestedNameHash,
                    status: "succeeded",
                    noChange: true,
                    completedAt: now
                  }],
                  createdAt: now,
                  updatedAt: now
                })
          ),
          createAuditWrite(context, state.share, "participant_rename_noop", "success", {
            eventId: `evt_rename_${requestHash.slice(0, 40)}`,
            requestId: requestIdentifier,
            identityType: session.identityType,
            identityHash: session.identityHash,
            ipHash: networkIdentity.digest,
            userAgentHash: userAgentDigest(request)
          })
        ], snapshot.transaction);
        return { ...participant, ...participantFields };
      } catch (error) {
        await rollbackShareMutation(context, snapshot.transaction);
        if (
          !isOptimisticConflict(error)
          || attempt === participantRenameMaximumAttempts - 1
        ) {
          throw error;
        }
        await waitBeforeOptimisticRetry(attempt);
        continue;
      }
    }
    const newRegistry = byPath.get(newRegistryPath);
    if (newRegistry) {
      if (newRegistry.participantId !== participantId) {
        await rollbackShareMutation(context, snapshot.transaction);
        throw new HttpError(409, "display_name_unavailable");
      }
      if (
        newRegistry.schemaVersion !== 1
        || newRegistry.shareId !== state.share.__id
        || newRegistry.ownerUid !== state.share.ownerUid
      ) {
        await rollbackShareMutation(context, snapshot.transaction);
        throw new HttpError(409, "participant_state_invalid");
      }
    }
    const oldRegistry = oldRegistryPath ? byPath.get(oldRegistryPath) : null;
    if (
      oldRegistryPath
      && oldRegistryPath !== newRegistryPath
      && (
        !oldRegistry
        || oldRegistry.schemaVersion !== 1
        || oldRegistry.shareId !== state.share.__id
        || oldRegistry.ownerUid !== state.share.ownerUid
        || oldRegistry.participantId !== participantId
      )
    ) {
      await rollbackShareMutation(context, snapshot.transaction);
      throw new HttpError(409, "participant_state_invalid");
    }
    const now = new Date(nowMilliseconds);
    const participantFields = {
      displayName: name.displayName,
      normalizedDisplayName: name.normalizedDisplayName,
      updatedAt: now,
      lastRenamedAt: now,
      renameCount: (Number.isSafeInteger(participant.renameCount)
        ? participant.renameCount
        : 0) + 1,
      renameHourWindowStart: new Date(window.hourStartMilliseconds),
      renameHourCount: window.hourCount + 1,
      renameDayWindowStart: new Date(window.dayStartMilliseconds),
      renameDayCount: window.dayCount + 1,
      lastRenameRequestHash: requestHash,
      lastRenameRequestedNameHash: requestedNameHash
    };
    const registryFields = {
      schemaVersion: 1,
      shareId: state.share.__id,
      ownerUid: state.share.ownerUid,
      participantId,
      createdAt: newRegistry?.createdAt ?? now,
      updatedAt: now
    };
    const writes = [
      updateDocumentWrite(
        context.projectId,
        participantPath,
        participantFields,
        Object.keys(participantFields),
        participant.__updateTime
      ),
      newRegistry
        ? updateDocumentWrite(
            context.projectId,
            newRegistryPath,
            registryFields,
            Object.keys(registryFields),
            newRegistry.__updateTime
          )
        : createDocumentWrite(context.projectId, newRegistryPath, registryFields),
      createAuditWrite(context, state.share, "participant_rename", "success", {
        eventId: `evt_rename_${requestHash.slice(0, 40)}`,
        requestId: requestIdentifier,
        identityType: session.identityType,
        identityHash: session.identityHash,
        ipHash: networkIdentity.digest,
        userAgentHash: userAgentDigest(request)
      }),
      renameRequest
        ? updateDocumentWrite(
            context.projectId,
            renameRequestPath,
            {
              schemaVersion: 1,
              shareId: state.share.__id,
              ownerUid: state.share.ownerUid,
              participantId,
              requestHash,
              requestedNameHash,
              status: "succeeded",
              noChange: false,
              recentRequests: [
                ...recentRenameRequests,
                {
                  requestHash,
                  requestedNameHash,
                  status: "succeeded",
                  noChange: false,
                  completedAt: now
                }
              ].slice(-10),
              createdAt: renameRequest.createdAt ?? now,
              updatedAt: now
            },
            [
              "schemaVersion",
              "shareId",
              "ownerUid",
              "participantId",
              "requestHash",
              "requestedNameHash",
              "status",
              "noChange",
              "recentRequests",
              "createdAt",
              "updatedAt"
            ],
            renameRequest.__updateTime
          )
        : createDocumentWrite(context.projectId, renameRequestPath, {
            schemaVersion: 1,
            shareId: state.share.__id,
            ownerUid: state.share.ownerUid,
            participantId,
            requestHash,
            requestedNameHash,
            status: "succeeded",
            noChange: false,
            recentRequests: [{
              requestHash,
              requestedNameHash,
              status: "succeeded",
              noChange: false,
              completedAt: now
            }],
            createdAt: now,
            updatedAt: now
          })
    ];
    if (oldRegistryPath && oldRegistryPath !== newRegistryPath) {
      writes.push(deleteDocumentWrite(
        context.projectId,
        oldRegistryPath,
        oldRegistry.__updateTime
      ));
    }
    try {
      await firestoreCommit(context, writes, snapshot.transaction);
      return { ...participant, ...participantFields };
    } catch (error) {
      await rollbackShareMutation(context, snapshot.transaction);
      if (
        !isOptimisticConflict(error)
        || attempt === participantRenameMaximumAttempts - 1
      ) {
        throw error;
      }
      await waitBeforeOptimisticRetry(attempt);
    }
  }
  throw new HttpError(409, "request_conflict");
}

async function handleParticipantMe(request, response, id, shareId) {
  requireMethod(request, ["GET", "PATCH"]);
  if (!secureShareParticipantIdentityEnabled()) {
    throw new HttpError(404, "not_found");
  }
  const context = await secureContext(request);
  const access = await commentAccess(request, context, shareId, request.method === "PATCH");
  if (
    access.session?.ownerPreview === true
    || access.state.policy.permissionLevel !== "comment"
  ) {
    throw new HttpError(403, "access_denied");
  }
  const participantId = safeId(access.session?.participantId, "participantId");
  const networkIdentity = clientNetworkIdentity(request);
  if (request.method === "GET") {
    const participant = await firestoreGet(
      context,
      participantDocumentPath(shareId, participantId)
    );
    if (!validParticipantForSession(participant, shareId, participantId)) {
      throw new HttpError(409, "participant_unavailable");
    }
    jsonResponse(response, 200, {
      ok: true,
      participant: participantPublicDto(
        participant,
        access.state,
        networkIdentity.prefix
      ),
      requestId: id
    });
    return;
  }
  await consumeRateLimits(context, [
    {
      limitType: "participant_rename_identity_hour",
      keyParts: [shareId, access.session.identityHash],
      shareId,
      ownerUid: access.state.share.ownerUid,
      windowSeconds: 60 * 60,
      limit: 30
    },
    {
      limitType: "participant_rename_share_network_hour",
      keyParts: [shareId, networkIdentity.digest],
      shareId,
      ownerUid: access.state.share.ownerUid,
      windowSeconds: 60 * 60,
      limit: 120
    }
  ]);
  const body = await readJsonBody(request, 8 * 1024);
  assertOnlyKeys(body, ["displayName", "clientRequestId"]);
  const clientRequestId = safeUnlockAttemptId(body.clientRequestId);
  const participant = await renameParticipant(
    request,
    context,
    access.state,
    access.session,
    participantId,
    body.displayName,
    clientRequestId,
    networkIdentity,
    id
  );
  jsonResponse(response, 200, {
    ok: true,
    participant: participantPublicDto(
      participant,
      access.state,
      networkIdentity.prefix
    ),
    requestId: id
  });
}

function validateCommentBody(value) {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", "Comment body must be text");
  }
  const body = value.trim();
  const hasForbiddenControl = [...body].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      (codePoint <= 31 && !new Set([9, 10, 13]).has(codePoint))
      || codePoint === 127
      || (codePoint >= 0x80 && codePoint <= 0x9f)
      || codePoint === 0x061c
      || (codePoint >= 0x200b && codePoint <= 0x200f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2060 && codePoint <= 0x206f)
      || codePoint === 0xfeff
    );
  });
  if (
    Array.from(body).length < 1
    || Array.from(body).length > 2000
    || body.includes("<")
    || body.includes(">")
    || hasForbiddenControl
  ) {
    throw new HttpError(400, "invalid_request", "Comment body is invalid");
  }
  return body;
}

function safeIpPrefixSnapshot(value) {
  if (typeof value !== "string" || value.length > 16) {
    return null;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})$/u.exec(value);
  if (ipv4) {
    const first = Number.parseInt(ipv4[1], 10);
    const second = Number.parseInt(ipv4[2], 10);
    const reserved = (
      first > 255
      || second > 255
      || first === 0
      || first === 10
      || first === 127
      || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && new Set([0, 88, 168]).has(second))
      || (first === 198 && new Set([18, 19, 51]).has(second))
      || (first === 203 && second === 0)
    );
    return reserved ? null : `${first}.${second}`;
  }
  const ipv6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(value);
  if (!ipv6) {
    return null;
  }
  const first = Number.parseInt(ipv6[1], 16);
  const second = Number.parseInt(ipv6[2], 16);
  const reserved = (
    (first & 0xe000) !== 0x2000
    || (first === 0x2001 && new Set([0x0002, 0x0db8]).has(second))
    || (first === 0x3fff && (second & 0xf000) === 0)
  );
  return reserved ? null : `${first.toString(16)}:${second.toString(16)}`;
}

function publicComment(comment, participant = null, includeIpPrefix = false) {
  const displayName =
    participant?.status === "active"
    && participant?.shareId === comment.shareId
    && participant?.participantId === comment.authorParticipantId
    && typeof participant?.displayName === "string"
      ? participant.displayName
      : (
          comment.authorDisplayNameSnapshot
          || comment.authorDisplayName
          || "Guest"
        );
  const ipPrefix = includeIpPrefix
    ? safeIpPrefixSnapshot(comment.ipPrefixSnapshot)
    : null;
  return {
    id: comment.__id,
    displayName,
    badge: comment.authorBadge,
    body: comment.deletedAt ? "(삭제된 댓글)" : comment.body,
    createdAt: comment.createdAt,
    canDelete: false,
    ...(
      typeof comment.authorParticipantId === "string"
        ? { authorParticipantId: comment.authorParticipantId }
        : {}
    ),
    ...(ipPrefix ? { ipPrefix } : {})
  };
}

function commentsCursor(value, shareId, projectId) {
  if (!value) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const expectedPrefix =
      `projects/${projectId}/databases/(default)/documents/publicShareComments/${shareId}/items/`;
    const commentId = typeof decoded?.documentName === "string"
      && decoded.documentName.startsWith(expectedPrefix)
      ? decoded.documentName.slice(expectedPrefix.length)
      : "";
    if (
      typeof decoded?.createdAt !== "string"
      || !Number.isFinite(Date.parse(decoded.createdAt))
      || !commentId
      || commentId.includes("/")
      || safeId(commentId, "commentId") !== commentId
    ) {
      throw new Error("invalid cursor");
    }
    return decoded;
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid cursor");
  }
}

function encodeCommentsCursor(comment) {
  return Buffer.from(JSON.stringify({
    createdAt: comment.createdAt,
    documentName: comment.__name
  }), "utf8").toString("base64url");
}

async function commentAccess(request, context, shareId, mutation = false) {
  if (mutation) {
    ensureSameOrigin(request);
    const validated = await validatedSession(request, context, shareId);
    requireCsrf(request, validated.session);
    return {
      owner: validated.session.ownerPreview === true
        ? {
            uid: validated.session.authorUid,
            isAdmin: validated.session.identityType === "admin_preview"
          }
        : null,
      ...validated
    };
  }
  if (authorizationToken(request)) {
    const owner = await activeUserFromRequest(request, context);
    const state = await loadShareState(context, shareId);
    requireShareManager(state, owner);
    await requireSourceAvailable(context, state.share);
    return { owner, state, session: null };
  }
  const validated = await validatedSession(request, context, shareId);
  return { owner: null, ...validated };
}

async function handleComments(request, response, id, shareId, url) {
  if (request.method === "GET") {
    const context = await secureContext(request);
    const access = await commentAccess(request, context, shareId);
    if (
      !access.owner
      && access.session?.ownerPreview !== true
      && access.state.policy.permissionLevel !== "comment"
    ) {
      throw new HttpError(403, "access_denied");
    }
    const pageSizeText = queryString(url, "limit", 3);
    const pageSize = pageSizeText
      ? boundedInteger(Number.parseInt(pageSizeText, 10), "limit", 1, maximumCommentPageSize)
      : defaultPageSize;
    const cursor = commentsCursor(queryString(url, "cursor", 1000), shareId, context.projectId);
    const structuredQuery = {
      from: [{ collectionId: "items" }],
      orderBy: [
        { field: { fieldPath: "createdAt" }, direction: "DESCENDING" },
        { field: { fieldPath: "__name__" }, direction: "DESCENDING" }
      ],
      limit: pageSize + 1
    };
    if (cursor) {
      structuredQuery.startAt = {
        before: false,
        values: [
          firestoreTimestampValue(cursor.createdAt),
          firestoreReferenceValue(cursor.documentName)
        ]
      };
    }
    const documents = await firestoreRunQuery(
      context,
      structuredQuery,
      `publicShareComments/${shareId}`
    );
    const filtered = documents.filter((comment) => comment.shareId === shareId);
    const page = filtered.slice(0, pageSize);
    const nextCursor = filtered.length > pageSize && page.length
      ? encodeCommentsCursor(page.at(-1))
      : null;
    const participantIds = [...new Set(
      page
        .map((comment) => comment.authorParticipantId)
        .filter((participantId) =>
          typeof participantId === "string"
          && /^[A-Za-z0-9_-]{1,160}$/u.test(participantId)
        )
    )].slice(0, maximumCommentPageSize);
    const participantDocuments = participantIds.length
      ? await firestoreBatchGet(
          context,
          participantIds.map((participantId) =>
            participantDocumentPath(shareId, participantId)
          )
        )
      : [];
    const participantsById = new Map(
      participantDocuments.flatMap((participant, index) =>
        validParticipantForSession(participant, shareId, participantIds[index])
          ? [[participantIds[index], participant]]
          : []
      )
    );
    const includeIpPrefix =
      access.state.policy.permissionLevel === "comment"
      && access.state.policy.showCommenterIpPrefix === true
      && secureShareCommentIpPrefixEnabled()
      && Boolean(
        access.owner
        || access.session?.ownerPreview === true
        || access.session?.participantIdentityEnabled === true
      );
    const items = page.map((comment) => {
      const result = publicComment(
        comment,
        participantsById.get(comment.authorParticipantId) ?? null,
        includeIpPrefix
      );
      result.canDelete = Boolean(
        access.owner
        || access.session?.ownerPreview === true
        || (
          access.session
          && (
            (
              typeof comment.authorParticipantId === "string"
              && comment.authorParticipantId === access.session.participantId
            )
            || (
              !comment.authorParticipantId
              && comment.authorIdentityHash === access.session.identityHash
            )
          )
          && !comment.deletedAt
        )
      );
      return result;
    });
    jsonResponse(response, 200, { ok: true, items, nextCursor, requestId: id });
    return;
  }

  requireMethod(request, ["POST"]);
  ensureSameOrigin(request);
  const body = await readJsonBody(request, 16 * 1024);
  assertOnlyKeys(body, ["body", "clientRequestId"]);
  const text = validateCommentBody(body.body);
  const clientRequestId = safeUnlockAttemptId(body.clientRequestId);
  const context = await secureContext(request);
  const { session, state } = await validatedSession(request, context, shareId);
  if (session.ownerPreview !== true && state.policy.permissionLevel !== "comment") {
    throw new HttpError(403, "access_denied");
  }
  requireCsrf(request, session);
  let participant = null;
  if (
    session.ownerPreview !== true
    && secureShareParticipantIdentityEnabled()
    && session.participantIdentityEnabled === true
  ) {
    if (session.participantLimitReached === true || !session.participantId) {
      throw new HttpError(403, "participant_limit_reached");
    }
    const participantId = safeId(session.participantId, "participantId");
    participant = await firestoreGet(
      context,
      participantDocumentPath(shareId, participantId)
    );
    if (!validParticipantForSession(participant, shareId, participantId)) {
      throw new HttpError(409, "participant_unavailable");
    }
  }
  const commentId = `c_${hmacDigest(
    requiredSecret("SHARE_SESSION_HMAC_KEY"),
    "quickmemo/secure-share/comment-idempotency/v1",
    shareId,
    session.identityHash,
    clientRequestId
  ).slice(0, 48)}`;
  const commentPath = `publicShareComments/${shareId}/items/${commentId}`;
  const existingComment = await firestoreGet(context, commentPath);
  if (existingComment) {
    if (
      existingComment.shareId === shareId
      && (
        participant
          ? existingComment.authorParticipantId === participant.participantId
          : existingComment.authorIdentityHash === session.identityHash
      )
      && existingComment.body === text
      && !existingComment.deletedAt
    ) {
      jsonResponse(response, 200, {
        ok: true,
        comment: {
          ...publicComment(
            existingComment,
            participant,
            state.policy.showCommenterIpPrefix === true
              && secureShareCommentIpPrefixEnabled()
          ),
          canDelete: true
        },
        requestId: id
      });
      return;
    }
    throw new HttpError(409, "request_conflict", "Comment idempotency key was reused");
  }
  const networkIdentity = clientNetworkIdentity(request);
  const networkHash = networkIdentity.digest;
  const rateLimitReservations = await consumeRateLimits(context, [
    {
      limitType: "comment_session_minute",
      keyParts: [shareId, session.__sessionDigest],
      shareId,
      ownerUid: state.share.ownerUid,
      windowSeconds: 60,
      limit: 5
    },
    {
      limitType: "comment_identity_day",
      keyParts: [shareId, session.identityHash],
      shareId,
      ownerUid: state.share.ownerUid,
      windowSeconds: 24 * 60 * 60,
      limit: 50
    },
    {
      limitType: "comment_network_hour",
      keyParts: [networkHash],
      shareId,
      ownerUid: state.share.ownerUid,
      windowSeconds: 60 * 60,
      limit: 30
    }
  ]);
  const now = new Date();
  const authorBadge = session.identityType === "admin_preview"
    ? "admin"
    : session.ownerPreview === true
      ? "owner"
      : session.identityType === "quickmemo_user"
        ? "quickmemo_user"
        : session.identityType === "verified_email"
          ? "email_verified"
          : "guest";
  const showCommenterIpPrefix =
    session.ownerPreview !== true
    && Boolean(participant)
    && state.policy.showCommenterIpPrefix === true
    && secureShareCommentIpPrefixEnabled();
  const ipPrefixSnapshot = showCommenterIpPrefix
    ? safeIpPrefixSnapshot(networkIdentity.prefix)
    : null;
  const authorDisplayName = participant?.displayName
    ?? safeDisplayName(
      session.authorDisplayName,
      session.identityType === "admin_preview"
        ? "Administrator"
        : session.ownerPreview === true
          ? "Owner"
          : "Guest",
      session.ownerPreview === true
    );
  const comment = {
    shareId,
    ownerUid: state.share.ownerUid,
    authorType: session.identityType,
    authorUid: participant ? undefined : session.authorUid || "",
    authorIdentityHash: participant ? undefined : session.identityHash,
    authorDisplayName,
    authorDisplayNameSnapshot: authorDisplayName,
    authorParticipantId: participant?.participantId ?? undefined,
    authorBadge,
    ipPrefixSnapshot: ipPrefixSnapshot ?? undefined,
    ipPrefixVersion: ipPrefixSnapshot ? participantIpPrefixVersion : undefined,
    body: text,
    createdAt: now,
    expiresAt: new Date(timestampMilliseconds(state.share.expiresAt)),
    retentionExpiresAt: new Date(Math.max(
      timestampMilliseconds(state.share.expiresAt),
      now.getTime() + auditRetentionMilliseconds
    )),
    sessionDigestReference: session.sessionReferenceHash,
    clientRequestHash: hmacDigest(
      requiredSecret("SHARE_SESSION_HMAC_KEY"),
      "quickmemo/secure-share/comment-request/v1",
      clientRequestId
    )
  };
  const transactionSnapshot = await beginShareMutationTransaction(context, shareId);
  if (!shareMutationSnapshotMatches(transactionSnapshot.state, state)) {
    await rollbackShareMutation(context, transactionSnapshot.transaction);
    throw new HttpError(409, "request_conflict", "Share changed before comment creation");
  }
  try {
    await firestoreCommit(context, [
      createDocumentWrite(context.projectId, commentPath, comment),
      createAuditWrite(context, state.share, "comment_create", "success", {
        eventId: `evt_comment_${commentId}`,
        requestId: id,
        identityType: session.identityType,
        identityHash: session.identityHash,
        ipHash: networkHash,
        userAgentHash: userAgentDigest(request)
      })
    ], transactionSnapshot.transaction);
  } catch (error) {
    await rollbackShareMutation(context, transactionSnapshot.transaction);
    if (isOptimisticConflict(error)) {
      const duplicate = await firestoreGet(context, commentPath);
      if (
        duplicate
        && (
          participant
            ? duplicate.authorParticipantId === participant.participantId
            : duplicate.authorIdentityHash === session.identityHash
        )
        && duplicate.body === text
        && !duplicate.deletedAt
      ) {
        await releaseRateLimitReservations(context, rateLimitReservations);
        jsonResponse(response, 200, {
          ok: true,
          comment: {
            ...publicComment(
              duplicate,
              participant,
              showCommenterIpPrefix
            ),
            canDelete: true
          },
          requestId: id
        });
        return;
      }
      throw new HttpError(409, "request_conflict", "Comment creation raced a share change");
    }
    throw error;
  }
  jsonResponse(response, 201, {
    ok: true,
    comment: {
      ...publicComment(
        { ...comment, __id: commentId },
        participant,
        showCommenterIpPrefix
      ),
      canDelete: true
    },
    requestId: id
  });
}

async function handleCommentDelete(request, response, id, shareId) {
  requireMethod(request, ["DELETE"]);
  ensureSameOrigin(request);
  const body = await readJsonBody(request, 8 * 1024);
  assertOnlyKeys(body, ["commentId"]);
  const commentId = safeId(body.commentId, "commentId");
  const context = await secureContext(request);
  const access = await commentAccess(request, context, shareId, true);
  const comment = await firestoreGet(
    context,
    `publicShareComments/${shareId}/items/${commentId}`
  );
  if (!comment || comment.shareId !== shareId) {
    throw new HttpError(404, "not_found");
  }
  if (
    !access.owner
    && (
      !access.session
      || (
        access.session.ownerPreview !== true
        && !(
          (
            typeof comment.authorParticipantId === "string"
            && comment.authorParticipantId === access.session.participantId
          )
          || (
            !comment.authorParticipantId
            && comment.authorIdentityHash === access.session.identityHash
          )
        )
      )
    )
  ) {
    throw new HttpError(403, "access_denied");
  }
  if (comment.deletedAt) {
    jsonResponse(response, 200, { ok: true, deleted: true, requestId: id });
    return;
  }
  const actor = access.owner ? access.owner.uid : access.session.identityHash;
  const managerRole = access.owner?.isAdmin === true ? "admin" : "owner";
  const transactionSnapshot = await beginShareMutationTransaction(context, shareId);
  if (!shareMutationSnapshotMatches(transactionSnapshot.state, access.state)) {
    await rollbackShareMutation(context, transactionSnapshot.transaction);
    throw new HttpError(409, "request_conflict", "Share changed before comment deletion");
  }
  try {
    await firestoreCommit(context, [
      updateDocumentWrite(
        context.projectId,
        `publicShareComments/${shareId}/items/${commentId}`,
        {
          body: "",
          deletedAt: new Date(),
          deletedBy: access.owner ? managerRole : "author",
          deletedByHash: identityDigest(access.owner ? "uid" : "comment-author", actor)
        },
        ["body", "deletedAt", "deletedBy", "deletedByHash"],
        comment.__updateTime
      ),
      createAuditWrite(context, access.state.share, "comment_delete", "success", {
        requestId: id,
        identityType: access.owner
          ? access.owner.isAdmin === true
            ? "admin_preview"
            : "quickmemo_user"
          : access.session.identityType,
        identityHash: access.owner ? identityDigest("uid", access.owner.uid) : access.session.identityHash,
        ipHash: clientNetworkDigest(request),
        userAgentHash: userAgentDigest(request)
      })
    ], transactionSnapshot.transaction);
  } catch (error) {
    await rollbackShareMutation(context, transactionSnapshot.transaction);
    if (isOptimisticConflict(error)) {
      const latest = await firestoreGet(
        context,
        `publicShareComments/${shareId}/items/${commentId}`
      );
      if (latest?.deletedAt) {
        jsonResponse(response, 200, { ok: true, deleted: true, requestId: id });
        return;
      }
      throw new HttpError(409, "request_conflict", "Comment deletion raced a share change");
    }
    throw error;
  }
  jsonResponse(response, 200, { ok: true, deleted: true, requestId: id });
}

function copyGrantRequestId(shareId, requesterUid, idempotencyKey) {
  return `copy_${hmacDigest(
    requiredSecret("SHARE_SESSION_HMAC_KEY"),
    "quickmemo/secure-share/copy-grant-request/v1",
    safeId(shareId, "shareId"),
    safeId(requesterUid, "requesterUid"),
    safeUnlockAttemptId(idempotencyKey)
  )}`;
}

function copyGrantRequestKeyHash(
  shareId,
  requesterUid,
  idempotencyKey,
  secret = requiredSecret("SHARE_SESSION_HMAC_KEY")
) {
  return hmacDigest(
    secret,
    "quickmemo/secure-share/copy-grant-request-key/v1",
    shareId,
    requesterUid,
    idempotencyKey
  );
}

function copyGrantTokenHash(
  copyGrant,
  secret = requiredSecret("SHARE_SESSION_HMAC_KEY")
) {
  return hmacDigest(
    secret,
    "quickmemo/secure-share/copy-grant-token-record/v1",
    copyGrant
  );
}

function copyGrantAuditEventId(
  requestDocumentId,
  copyGrant,
  secret = requiredSecret("SHARE_SESSION_HMAC_KEY")
) {
  return `evt_cg_${hmacDigest(
    secret,
    "quickmemo/secure-share/copy-grant-audit/v1",
    requestDocumentId,
    copyGrant
  )}`;
}

function exactTimestampSeconds(value) {
  const milliseconds = timestampMilliseconds(value);
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
    || milliseconds % 1000 !== 0
  ) {
    return -1;
  }
  return milliseconds / 1000;
}

function copyGrantRequestDisposition(
  requestDocument,
  expected,
  nowSeconds = Math.floor(Date.now() / 1000),
  secret = requiredSecret("SHARE_SESSION_HMAC_KEY")
) {
  if (!requestDocument) {
    return { status: "issue" };
  }
  if (
    requestDocument.schemaVersion !== 1
    || requestDocument.shareId !== expected.shareId
    || requestDocument.ownerUid !== expected.ownerUid
    || requestDocument.requesterUid !== expected.requesterUid
    || typeof requestDocument.requestKeyHash !== "string"
    || !constantTimeStringEqual(
      requestDocument.requestKeyHash,
      expected.requestKeyHash
    )
    || !Number.isSafeInteger(requestDocument.issuanceGeneration)
    || requestDocument.issuanceGeneration < 1
    || typeof requestDocument.grantToken !== "string"
    || typeof requestDocument.grantTokenHash !== "string"
    || typeof requestDocument.sessionReferenceHash !== "string"
    || !Number.isSafeInteger(requestDocument.policyVersion)
  ) {
    return { status: "conflict" };
  }
  if (
    !constantTimeStringEqual(
      requestDocument.grantTokenHash,
      copyGrantTokenHash(requestDocument.grantToken, secret)
    )
  ) {
    return { status: "conflict" };
  }
  const issuedAtSeconds = exactTimestampSeconds(requestDocument.grantIssuedAt);
  const expiresAtSeconds = exactTimestampSeconds(requestDocument.grantExpiresAt);
  const retentionExpiresAtSeconds = exactTimestampSeconds(requestDocument.expiresAt);
  if (
    issuedAtSeconds < 0
    || expiresAtSeconds <= issuedAtSeconds
    || retentionExpiresAtSeconds !== expiresAtSeconds + copyGrantRequestRetentionSeconds
  ) {
    return { status: "conflict" };
  }
  const grant = verifySignedOpaqueToken(
    requestDocument.grantToken,
    copyGrantPurpose,
    secret,
    issuedAtSeconds
  );
  if (
    !grant
    || grant.kind !== "secure_share_copy_grant"
    || grant.shareId !== expected.shareId
    || grant.uid !== expected.requesterUid
    || grant.policyVersion !== requestDocument.policyVersion
    || grant.iat !== issuedAtSeconds
    || grant.exp !== expiresAtSeconds
    || typeof grant.idempotencyHash !== "string"
    || !constantTimeStringEqual(grant.idempotencyHash, expected.requestKeyHash)
    || typeof grant.sessionReferenceHash !== "string"
    || !constantTimeStringEqual(
      grant.sessionReferenceHash,
      requestDocument.sessionReferenceHash
    )
  ) {
    return { status: "conflict" };
  }
  if (
    requestDocument.policyVersion !== expected.policyVersion
    || !constantTimeStringEqual(
      requestDocument.sessionReferenceHash,
      expected.sessionReferenceHash
    )
    || expiresAtSeconds <= nowSeconds + copyGrantReplayMinimumSeconds
  ) {
    return { status: "renew" };
  }
  return {
    status: "replay",
    copyGrant: requestDocument.grantToken,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString()
  };
}

function createCopyGrantCandidate(
  expected,
  session,
  state,
  nowSeconds = Math.floor(Date.now() / 1000),
  secret = requiredSecret("SHARE_SESSION_HMAC_KEY")
) {
  const sessionExpiresAtSeconds = Math.floor(
    timestampMilliseconds(session.expiresAt) / 1000
  );
  const shareExpiresAtSeconds = Math.floor(
    timestampMilliseconds(state.share.expiresAt) / 1000
  );
  const expiresAtSeconds = Math.min(
    nowSeconds + copyGrantTtlSeconds,
    sessionExpiresAtSeconds,
    shareExpiresAtSeconds
  );
  const ttlSeconds = expiresAtSeconds - nowSeconds;
  if (
    !Number.isSafeInteger(expiresAtSeconds)
    || ttlSeconds <= copyGrantReplayMinimumSeconds
  ) {
    throw new HttpError(
      401,
      "session_expired",
      "Session lifetime is too short for a copy grant"
    );
  }
  const copyGrant = signedOpaqueToken(
    {
      kind: "secure_share_copy_grant",
      shareId: expected.shareId,
      uid: expected.requesterUid,
      policyVersion: expected.policyVersion,
      idempotencyHash: expected.requestKeyHash,
      sessionReferenceHash: expected.sessionReferenceHash
    },
    copyGrantPurpose,
    ttlSeconds,
    secret,
    nowSeconds
  );
  const grant = verifySignedOpaqueToken(
    copyGrant,
    copyGrantPurpose,
    secret,
    nowSeconds
  );
  if (
    !grant
    || grant.iat !== nowSeconds
    || grant.exp !== expiresAtSeconds
  ) {
    throw new HttpError(503, "service_unavailable", "Copy grant generation failed", {
      expose: false
    });
  }
  return {
    copyGrant,
    grantTokenHash: copyGrantTokenHash(copyGrant, secret),
    grantIssuedAt: new Date(nowSeconds * 1000),
    grantExpiresAt: new Date(expiresAtSeconds * 1000),
    expiresAt: new Date(
      (expiresAtSeconds + copyGrantRequestRetentionSeconds) * 1000
    )
  };
}

function copyGrantRateBucket(shareId, sessionDigest, nowSeconds) {
  const windowStartSeconds =
    Math.floor(nowSeconds / copyGrantRateWindowSeconds) * copyGrantRateWindowSeconds;
  const bucketId = rateLimitBucketDigest(
    "copy_grant_session_minute",
    [shareId, sessionDigest, String(windowStartSeconds)]
  );
  return {
    bucketId,
    path: `publicShareRateLimits/${bucketId}`,
    windowStartSeconds
  };
}

function copyGrantRateWrite(
  context,
  bucket,
  rateState,
  share,
  nowSeconds
) {
  const count = rateState?.count ?? 0;
  if (
    rateState
    && (
      rateState.limitType !== "copy_grant_session_minute"
      || rateState.shareId !== share.__id
      || rateState.ownerUid !== share.ownerUid
      || timestampMilliseconds(rateState.windowStart)
        !== bucket.windowStartSeconds * 1000
      || !Number.isSafeInteger(rateState.count)
      || rateState.count < 0
    )
  ) {
    throw new HttpError(409, "rate_limit_state_invalid");
  }
  if (count >= copyGrantRateLimit) {
    throw new HttpError(429, "rate_limited", "Rate limit exceeded", {
      retryAfter: Math.max(
        1,
        bucket.windowStartSeconds + copyGrantRateWindowSeconds - nowSeconds
      )
    });
  }
  const fields = {
    shareId: share.__id,
    ownerUid: share.ownerUid,
    limitType: "copy_grant_session_minute",
    windowStart: new Date(bucket.windowStartSeconds * 1000),
    count: count + 1,
    updatedAt: new Date(nowSeconds * 1000),
    expiresAt: new Date(
      (bucket.windowStartSeconds + copyGrantRateWindowSeconds * 2) * 1000
    )
  };
  return rateState
    ? updateDocumentWrite(
      context.projectId,
      bucket.path,
      fields,
      Object.keys(fields),
      rateState.__updateTime
    )
    : createDocumentWrite(context.projectId, bucket.path, fields);
}

function copyGrantRequestWrite(
  context,
  requestPath,
  requestDocument,
  expected,
  candidate
) {
  const fields = {
    schemaVersion: 1,
    shareId: expected.shareId,
    ownerUid: expected.ownerUid,
    requesterUid: expected.requesterUid,
    requestKeyHash: expected.requestKeyHash,
    sessionReferenceHash: expected.sessionReferenceHash,
    policyVersion: expected.policyVersion,
    grantToken: candidate.copyGrant,
    grantTokenHash: candidate.grantTokenHash,
    grantIssuedAt: candidate.grantIssuedAt,
    grantExpiresAt: candidate.grantExpiresAt,
    issuanceGeneration: requestDocument
      ? requestDocument.issuanceGeneration + 1
      : 1,
    updatedAt: candidate.grantIssuedAt,
    expiresAt: candidate.expiresAt
  };
  return requestDocument
    ? updateDocumentWrite(
      context.projectId,
      requestPath,
      fields,
      Object.keys(fields),
      requestDocument.__updateTime
    )
    : createDocumentWrite(context.projectId, requestPath, {
      ...fields,
      createdAt: candidate.grantIssuedAt
    });
}

async function beginCopyGrantRequestTransaction(
  context,
  shareId,
  requestPath,
  ratePath
) {
  const snapshot = await firestoreBatchGetNewTransaction(context, [
    `publicNoteShares/${shareId}`,
    `publicSharePolicies/${shareId}`,
    requestPath,
    ratePath
  ]);
  const [share, policy, requestDocument, rateState] = snapshot.documents;
  const state = share
    && policy
    && share.schemaVersion === 2
    && policy.schemaVersion === 2
      ? { share, policy }
      : null;
  return {
    state,
    requestDocument,
    rateState,
    transaction: snapshot.transaction
  };
}

function copyGrantCommitCanRetry(error) {
  if (error instanceof HttpError) {
    return false;
  }
  const statusCode = Number.isInteger(error?.statusCode)
    ? error.statusCode
    : 0;
  return isOptimisticConflict(error)
    || statusCode === 408
    || statusCode === 429
    || statusCode >= 500
    || statusCode === 0;
}

async function waitBeforeCopyGrantRetry(attempt) {
  const baseDelayMilliseconds = Math.min(
    copyGrantRetryMaximumDelayMilliseconds,
    15 * (2 ** Math.min(attempt, 5))
  );
  await delay(
    baseDelayMilliseconds
      + randomInt(0, baseDelayMilliseconds + 1)
  );
}

function sendCopyGrantResponse(response, id, replay) {
  jsonResponse(response, 200, {
    ok: true,
    copyGrant: replay.copyGrant,
    expiresAt: replay.expiresAt,
    requestId: id
  });
}

async function handleCopyGrant(request, response, id, shareId) {
  requireMethod(request, ["POST"]);
  ensureSameOrigin(request);
  const body = await readJsonBody(request, 8 * 1024);
  assertOnlyKeys(body, ["idempotencyKey"]);
  const idempotencyKey = safeUnlockAttemptId(body.idempotencyKey);
  const context = await secureContext(request);
  const { session, state } = await validatedSession(request, context, shareId);
  if (session.ownerPreview === true || state.policy.permissionLevel !== "save_copy") {
    throw new HttpError(403, "access_denied");
  }
  requireCsrf(request, session);
  const user = await activeUserFromRequest(request, context);
  const requestDocumentId = copyGrantRequestId(
    shareId,
    user.uid,
    idempotencyKey
  );
  const requestPath = `publicShareCopyGrantRequests/${requestDocumentId}`;
  const expected = {
    shareId,
    ownerUid: state.share.ownerUid,
    requesterUid: user.uid,
    requestKeyHash: copyGrantRequestKeyHash(
      shareId,
      user.uid,
      idempotencyKey
    ),
    policyVersion: state.policy.policyVersion,
    sessionReferenceHash: session.sessionReferenceHash
  };
  const fastReplay = copyGrantRequestDisposition(
    await firestoreGet(context, requestPath),
    expected
  );
  if (fastReplay.status === "conflict") {
    throw new HttpError(409, "request_conflict", "Copy grant request state is invalid");
  }
  if (fastReplay.status === "replay") {
    sendCopyGrantResponse(response, id, fastReplay);
    return;
  }

  await preflightCopyAttachmentQuota(context, user.uid, state.share);
  const candidate = createCopyGrantCandidate(
    expected,
    session,
    state
  );
  const networkHash = clientNetworkDigest(request);
  const agentHash = userAgentDigest(request);

  for (
    let attempt = 0;
    attempt < copyGrantTransactionMaximumAttempts;
    attempt += 1
  ) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rateBucket = copyGrantRateBucket(
      shareId,
      session.__sessionDigest,
      nowSeconds
    );
    let transaction = "";
    let commitAttempted = false;
    try {
      const transactionSnapshot = await beginCopyGrantRequestTransaction(
        context,
        shareId,
        requestPath,
        rateBucket.path
      );
      transaction = transactionSnapshot.transaction;
      if (
        !shareMutationSnapshotMatches(transactionSnapshot.state, state)
        || transactionSnapshot.state.policy.permissionLevel !== "save_copy"
      ) {
        throw new HttpError(
          409,
          "request_conflict",
          "Share changed before copy grant"
        );
      }
      const disposition = copyGrantRequestDisposition(
        transactionSnapshot.requestDocument,
        expected,
        nowSeconds
      );
      if (disposition.status === "conflict") {
        throw new HttpError(
          409,
          "request_conflict",
          "Copy grant request state is invalid"
        );
      }
      if (disposition.status === "replay") {
        await rollbackShareMutation(context, transaction);
        transaction = "";
        sendCopyGrantResponse(response, id, disposition);
        return;
      }
      const requestWrite = copyGrantRequestWrite(
        context,
        requestPath,
        transactionSnapshot.requestDocument,
        expected,
        candidate
      );
      const rateWrite = copyGrantRateWrite(
        context,
        rateBucket,
        transactionSnapshot.rateState,
        transactionSnapshot.state.share,
        nowSeconds
      );
      const auditWrite = createAuditWrite(
        context,
        transactionSnapshot.state.share,
        "copy_grant",
        "success",
        {
          eventId: copyGrantAuditEventId(
            requestDocumentId,
            candidate.copyGrant
          ),
          requestId: id,
          identityType: "quickmemo_user",
          identityHash: identityDigest("uid", user.uid),
          ipHash: networkHash,
          userAgentHash: agentHash
        }
      );
      commitAttempted = true;
      await firestoreCommit(
        context,
        [requestWrite, rateWrite, auditWrite],
        transaction
      );
      transaction = "";
      sendCopyGrantResponse(response, id, {
        copyGrant: candidate.copyGrant,
        expiresAt: candidate.grantExpiresAt.toISOString()
      });
      return;
    } catch (error) {
      if (transaction) {
        await rollbackShareMutation(context, transaction);
      }
      if (!commitAttempted) {
        if (
          copyGrantCommitCanRetry(error)
          && attempt < copyGrantTransactionMaximumAttempts - 1
        ) {
          await waitBeforeCopyGrantRetry(attempt);
          continue;
        }
        throw error;
      }

      let recovered;
      try {
        recovered = copyGrantRequestDisposition(
          await firestoreGet(context, requestPath),
          expected
        );
      } catch (recoveryError) {
        if (
          copyGrantCommitCanRetry(error)
          && attempt < copyGrantTransactionMaximumAttempts - 1
        ) {
          await waitBeforeCopyGrantRetry(attempt);
          continue;
        }
        throw recoveryError;
      }
      if (recovered.status === "conflict") {
        throw new HttpError(
          409,
          "request_conflict",
          "Copy grant recovery state is invalid"
        );
      }
      if (recovered.status === "replay") {
        sendCopyGrantResponse(response, id, recovered);
        return;
      }
      if (
        copyGrantCommitCanRetry(error)
        && attempt < copyGrantTransactionMaximumAttempts - 1
      ) {
        await waitBeforeCopyGrantRetry(attempt);
        continue;
      }
      if (isOptimisticConflict(error)) {
        throw new HttpError(
          409,
          "request_conflict",
          "Copy grant raced a share change"
        );
      }
      throw error;
    }
  }
  throw new HttpError(409, "request_conflict");
}

function evaluateCopyAttachmentQuota({
  additionalBytes,
  additionalCount,
  usedBytes,
  usedCount
}) {
  const values = [additionalBytes, additionalCount, usedBytes, usedCount];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return { allowed: false, reason: "invalid_usage" };
  }
  if (usedCount + additionalCount > userAttachmentCountLimit) {
    return { allowed: false, reason: "count_exceeded" };
  }
  if (usedBytes + additionalBytes > userAttachmentQuotaBytes) {
    return { allowed: false, reason: "bytes_exceeded" };
  }
  return {
    allowed: true,
    reason: "ok",
    remainingBytes: userAttachmentQuotaBytes - usedBytes - additionalBytes,
    remainingCount: userAttachmentCountLimit - usedCount - additionalCount
  };
}

async function preflightCopyAttachmentQuota(context, uid, share) {
  const freeTierPolicy = resolveFreeTierPolicy(process.env);
  const [attachments, usage] = await Promise.all([
    currentAttachments(context, share),
    firestoreGet(context, `userAttachmentUsage/${safeId(uid, "uid")}`)
  ]);
  let additionalBytes = 0;
  for (const attachment of attachments) {
    const { encryptedSize } = validateAttachmentRecord(attachment, share);
    additionalBytes += encryptedSize;
    if (!Number.isSafeInteger(additionalBytes)) {
      throw new HttpError(503, "service_unavailable", "Attachment quota calculation overflow", {
        expose: false
      });
    }
  }
  const decision = evaluateCopyAttachmentQuota({
    additionalBytes,
    additionalCount: attachments.length,
    usedBytes: usage ? usage.usedBytes : 0,
    usedCount: usage ? usage.attachmentCount : 0
  });
  if (decision.reason === "invalid_usage") {
    throw new HttpError(503, "service_unavailable", "Attachment quota state is invalid", {
      expose: false
    });
  }
  if (!decision.allowed) {
    throw new HttpError(413, "attachment_quota_exceeded", "Attachment quota preflight failed");
  }
  // A copy grant for a note without attachments does not reserve or upload any
  // Blob bytes. Requiring the global Blob counter in that case turns a missing
  // storage document into an unrelated Secure Share outage. Keep the counter
  // fail-closed for every positive-byte copy while allowing metadata-only
  // grants to avoid an unnecessary Firestore read.
  if (freeTierPolicy.enabled && additionalBytes > 0) {
    const globalUsage = await firestoreGet(context, GLOBAL_BLOB_USAGE_DOCUMENT_PATH);
    if (
      !globalUsage
      || globalUsage.schemaVersion !== GLOBAL_BLOB_USAGE_SCHEMA_VERSION
      || !Number.isSafeInteger(globalUsage.usedBytes)
      || globalUsage.usedBytes < 0
    ) {
      throw new HttpError(503, "service_unavailable", "Global Blob usage counter is missing or invalid", {
        expose: false
      });
    }
    const globalDecision = evaluateFreeTierUpload({
      usedBytes: globalUsage.usedBytes,
      reservedBytes: 0,
      requestedBytes: additionalBytes
    }, freeTierPolicy);
    if (!globalDecision.allowUpload) {
      throw new HttpError(507, "attachment_quota_exceeded", "Global Blob free-tier hard stop");
    }
    return { ...decision, globalDecision };
  }
  return decision;
}

function copyGrantAuthorizesDownload(grant, {
  ownerPreview,
  permissionLevel,
  policyVersion,
  sessionReferenceHash,
  shareId,
  uid
}) {
  return Boolean(
    grant
    && ownerPreview !== true
    && permissionLevel === "save_copy"
    && grant.kind === "secure_share_copy_grant"
    && grant.shareId === shareId
    && grant.uid === uid
    && grant.policyVersion === policyVersion
    && typeof grant.sessionReferenceHash === "string"
    && typeof sessionReferenceHash === "string"
    && constantTimeStringEqual(grant.sessionReferenceHash, sessionReferenceHash)
  );
}

function secureShareAttachmentBlobPath(ownerUid, shareId, attachmentId) {
  return `users/${safeId(ownerUid, "ownerUid")}/publicNoteShares/${safeId(
    shareId,
    "shareId"
  )}/attachments/${safeId(attachmentId, "attachmentId")}/data`;
}

async function headPrivateBlobIfPresent(blobPath) {
  const { head } = await import("@vercel/blob");

  try {
    return await head(blobPath);
  } catch (error) {
    if (error?.constructor?.name === "BlobNotFoundError") {
      return null;
    }

    throw error;
  }
}

const attachmentMimeTypes = new Map([
  ["csv", "text/csv"],
  ["doc", "application/msword"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["gif", "image/gif"],
  ["hwp", "application/x-hwp"],
  ["hwpx", "application/vnd.hancom.hwpx"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["json", "application/json"],
  ["md", "text/markdown"],
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["ppt", "application/vnd.ms-powerpoint"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["txt", "text/plain"],
  ["webp", "image/webp"],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["zip", "application/zip"]
]);

function validateAttachmentRecord(attachment, share) {
  const encryptedSize = Number.isSafeInteger(attachment?.encryptedSize)
    ? attachment.encryptedSize
    : -1;
  const originalSize = Number.isSafeInteger(attachment?.originalSize)
    ? attachment.originalSize
    : -1;
  const expectedMime = attachmentMimeTypes.get(attachment?.extension);
  const validAlgorithm = (
    attachment?.version === 1
    && attachment?.algorithm === "AES-GCM"
    && typeof attachment?.iv === "string"
    && base64ByteLength(attachment.iv) === 12
    && encryptedSize === originalSize + 16
  ) || (
    attachment?.version === 2
    && attachment?.algorithm === "AES-GCM-CHUNKED"
    && Number.isSafeInteger(attachment?.chunkSize)
    && attachment.chunkSize > 0
    && attachment.chunkSize <= 4 * 1024 * 1024
    && Number.isSafeInteger(attachment?.chunkCount)
    && attachment.chunkCount === Math.ceil(originalSize / attachment.chunkSize)
    && Array.isArray(attachment?.chunkIvs)
    && attachment.chunkIvs.length === attachment.chunkCount
    && attachment.chunkIvs.every((iv) => base64ByteLength(iv) === 12)
    && encryptedSize === originalSize + attachment.chunkCount * 16
  );
  if (
    !attachmentCurrent(attachment, share)
    || !expectedMime
    || attachment.mimeType !== expectedMime
    || originalSize <= 0
    || originalSize > 150 * 1024 * 1024
    || encryptedSize < 16
    || encryptedSize > maximumEncryptedAttachmentBytes
    || !validAlgorithm
  ) {
    throw new HttpError(404, "not_found", "Attachment metadata is invalid");
  }
  encryptedPayload(attachment.encryptedFileName, "encryptedFileName", 16 * 1024);
  return { encryptedSize, originalSize };
}

async function streamAttachment(request, response, id, shareId, attachmentId, disposition) {
  requireMethod(request, ["GET"]);
  const context = await secureContext(request);
  const { session, state } = await validatedSession(request, context, shareId);
  if (disposition === "attachment" && state.policy.downloadAllowed !== true) {
    const copyGrant = verifySignedOpaqueToken(
      headerValue(request, "x-secure-share-copy-grant"),
      "quickmemo/secure-share/copy-grant/v1"
    );
    const user = copyGrant ? await activeUserFromRequest(request, context) : null;
    if (
      !user
      || !copyGrantAuthorizesDownload(copyGrant, {
        ownerPreview: session.ownerPreview,
        permissionLevel: state.policy.permissionLevel,
        policyVersion: state.policy.policyVersion,
        sessionReferenceHash: session.sessionReferenceHash,
        shareId,
        uid: user.uid
      })
    ) {
      throw new HttpError(403, "download_disabled");
    }
  }
  const attachment = await firestoreGet(
    context,
    `publicNoteShares/${shareId}/attachments/${attachmentId}`
  );
  const { encryptedSize } = validateAttachmentRecord(attachment, state.share);
  if (
    disposition === "inline"
    && (!previewableExtensions.has(attachment.extension) || encryptedSize > maximumPreviewBytes)
  ) {
    throw new HttpError(403, "preview_unavailable");
  }

  let inlineBytes = null;
  let privateBlobStream = null;
  if (typeof attachment.encryptedData === "string") {
    inlineBytes = Buffer.from(attachment.encryptedData, "base64");
    if (inlineBytes.byteLength !== encryptedSize) {
      throw new HttpError(404, "not_found", "Inline attachment size mismatch");
    }
  } else {
    const expectedBlobPath = secureShareAttachmentBlobPath(
      state.share.ownerUid,
      shareId,
      attachmentId
    );
    if (attachment.blobPath !== expectedBlobPath) {
      throw new HttpError(404, "not_found", "Private Blob attachment is unavailable");
    }
    const blobMetadata = await headPrivateBlobIfPresent(attachment.blobPath);
    if (!storedBlobMetadataMatchesAttachment(blobMetadata, attachment.blobPath, encryptedSize)) {
      throw new HttpError(404, "not_found", "Private Blob metadata mismatch");
    }
    const { get } = await import("@vercel/blob");
    const blob = await get(attachment.blobPath, { access: "private", useCache: false });
    if (!blob || blob.statusCode !== 200 || !blob.stream) {
      throw new HttpError(404, "not_found", "Private Blob is unavailable");
    }
    if (!streamedBlobMetadataMatchesAttachment(blob.blob, attachment.blobPath, encryptedSize)) {
      await blob.stream.cancel().catch(() => undefined);
      throw new HttpError(404, "not_found", "Private Blob stream metadata mismatch");
    }
    privateBlobStream = blob.stream;
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/octet-stream");
  response.setHeader("content-disposition", `${disposition}; filename="quickmemo-encrypted-attachment.bin"`);
  response.setHeader("content-length", String(encryptedSize));
  response.setHeader("x-request-id", id);
  if (inlineBytes) {
    response.end(inlineBytes);
    return;
  }
  try {
    await pipeline(Readable.fromWeb(privateBlobStream), response);
  } catch {
    throw new HttpError(502, "upstream_stream_failed", "Private Blob stream failed", {
      expose: false
    });
  }
}

async function dispatch(request, response, id) {
  const url = requestUrl(request);
  const action = queryString(url, "action", 40);
  if (!validActions.has(action)) {
    throw new HttpError(404, "not_found");
  }
  if (action === "feature-status") {
    assertQueryKeys(url, ["action"]);
    requireMethod(request, ["GET"]);
    let emailEnabled = false;
    if (secureShareV2Enabled()) {
      try {
        const context = await createFirestoreContext();
        const emailRuntime = await safeSecureShareEmailRuntimeSnapshot(context);
        emailEnabled = emailRuntime.ready === true;
      } catch {
        emailEnabled = false;
      }
    }
    jsonResponse(response, 200, {
      v2Enabled: secureShareV2Enabled(),
      emailEnabled
    });
    return;
  }
  if (action === "live-sync-status") {
    assertQueryKeys(url, ["action"]);
    requireMethod(request, ["GET"]);
    jsonResponse(response, 200, {
      enabled:
        secureShareV2Enabled()
        && secureShareLiveContentSyncEnabled()
    });
    return;
  }

  requireSecureShareV2();
  if (action === "owner-content-update" || action === "revision") {
    requireSecureShareLiveContentSync();
  }
  if (action === "owner-list") {
    assertQueryKeys(url, ["action", "cursor", "limit", "sourceNoteId", "status"]);
  } else if (action === "comments" && request.method === "GET") {
    assertQueryKeys(url, ["action", "shareId", "cursor", "limit"]);
  } else if (action === "attachment-preview" || action === "attachment-download") {
    assertQueryKeys(url, ["action", "shareId", "attachmentId"]);
  } else {
    assertQueryKeys(url, ["action", "shareId"]);
  }
  const shareId = new Set(["owner-list", "owner-create"]).has(action)
    ? ""
    : safeId(queryString(url, "shareId"), "shareId");

  if (action === "owner-list") {
    await handleOwnerList(request, response, id, url);
  } else if (action === "owner-details") {
    await handleOwnerDetails(request, response, id, shareId);
  } else if (action === "owner-create") {
    await handleOwnerCreate(request, response, id);
  } else if (action === "owner-update") {
    await handleOwnerUpdate(request, response, id, shareId);
  } else if (action === "owner-content-update") {
    await handleOwnerContentUpdate(request, response, id, shareId);
  } else if (action === "owner-activate") {
    await handleOwnerActivate(request, response, id, shareId);
  } else if (action === "owner-revoke") {
    await handleOwnerRevoke(request, response, id, shareId);
  } else if (action === "metadata") {
    await handleMetadata(request, response, id, shareId);
  } else if (action === "email-challenge") {
    await handleEmailChallenge(request, response, id, shareId);
  } else if (action === "access") {
    await handleAccess(request, response, id, shareId);
  } else if (action === "session") {
    await handleSession(request, response, id, shareId);
  } else if (action === "revision") {
    await handleRevision(request, response, id, shareId);
  } else if (action === "content") {
    await handleContent(request, response, id, shareId);
  } else if (action === "participant-me") {
    await handleParticipantMe(request, response, id, shareId);
  } else if (action === "comments") {
    await handleComments(request, response, id, shareId, url);
  } else if (action === "comment-delete") {
    await handleCommentDelete(request, response, id, shareId);
  } else if (action === "copy-grant") {
    await handleCopyGrant(request, response, id, shareId);
  } else if (action === "attachment-preview" || action === "attachment-download") {
    await streamAttachment(
      request,
      response,
      id,
      shareId,
      safeId(queryString(url, "attachmentId"), "attachmentId"),
      action === "attachment-preview" ? "inline" : "attachment"
    );
  }
}

export {
  HttpError,
  auditRetentionDays,
  assertEmailPolicyAvailable,
  assertOnlyKeys,
  buildPolicySettings,
  copyGrantAuthorizesDownload,
  copyGrantAuditEventId,
  copyGrantRequestId,
  copyGrantRequestDisposition,
  copyGrantRequestKeyHash,
  copyGrantTokenHash,
  contentUpdateDisposition,
  contentUpdateRetryAfterSeconds,
  contentUpdateRequestDigest,
  consumeRateLimits,
  createResendEmailAdapter,
  emailQuotaExceeded,
  emailQuotaPeriods,
  emailDigest,
  emailChallengeMinimumResponseMilliseconds,
  etagMatches,
  ensureRevisionReadRequest,
  ensureSameOrigin,
  evaluateCopyAttachmentQuota,
  gmailProviderHealthStateAllowsSend,
  gmailProviderHealthTransition,
  recordGmailProviderHealth,
  hashSharePassword,
  handleApiError,
  issueAccessSession,
  participantAllocationQueueSnapshot,
  revalidateParticipantAllocationChallenge,
  withParticipantAllocationQueue,
  normalizeAllowedEmails,
  normalizeEmail,
  ownerAttachmentReuseManifest,
  otpCodeDigest,
  otpVerificationFailureMinimumResponseMilliseconds,
  padEmailChallengeResponse,
  padOtpVerificationFailureResponse,
  readJsonBody,
  rateLimitBucketDigest,
  rateLimitWindowStarts,
  resolveEmailQuotaPolicy,
  resolveSecureShareLiveContentSyncServerFlag,
  resolveAccessIdentity,
  safeDisplayName,
  safeIpPrefixSnapshot,
  safeParticipantDisplayName,
  secureShareScryptParameters,
  secureShareAttachmentBlobPath,
  secureShareEmailReadiness,
  secureShareLiveContentSyncEnabled,
  secureShareLiveContentSyncServerProductionDefault,
  sessionTokenDigest,
  shareOwnedBy,
  shareManagedBy,
  signedOpaqueToken,
  sourceShareGuardId,
  sourceLifecycleAvailable,
  sourceReadAvailable,
  sourceRevisionMatches,
  sourceSnapshotAvailable,
  secureShareRevisionEtag,
  participantIdentityHash,
  issueAnonymousParticipantToken,
  legacyAutomaticSourceRevokeBlocked,
  participantNameRegistryId,
  participantRenameSnapshotMatches,
  renameParticipant,
  verifiedAnonymousParticipantToken,
  unlockAttemptDigest,
  validateCommentBody,
  verifyDocumentSnapshotWrite,
  verificationEmailText,
  verifySignedOpaqueToken,
  verifySharePassword
};

export default async function handler(request, response) {
  const id = requestId();
  applySecureResponseHeaders(response, id);
  try {
    await dispatch(request, response, id);
  } catch (error) {
    handleApiError(error, response, id);
  }
}
