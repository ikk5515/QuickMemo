/* global Buffer, console */

import { get, head } from "@vercel/blob";
import { randomInt } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  HttpError,
  activeUserFromRequest,
  applySecureResponseHeaders,
  assertOnlyKeys,
  authorizationToken,
  browserBindingCookie,
  browserBindingFromRequest,
  clientNetworkDigest,
  constantTimeStringEqual,
  configuredInteger,
  createResendEmailAdapter,
  createDocumentWrite,
  createFirestoreContext,
  csrfTokenDigest,
  emailDigest,
  ensureSameOrigin,
  firestoreCommit,
  deleteDocumentWrite,
  firestoreGet,
  firestoreIntegerValue,
  firestoreListCollection,
  firestoreReferenceValue,
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
  normalizeAllowedEmails,
  normalizeEmail,
  oneTimeGraceSeconds,
  otpCodeDigest,
  otpTtlSeconds,
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
  safeUnlockAttemptId,
  secureShareEmailEnabled,
  secureShareEmailReadiness,
  secureShareScryptParameters,
  secureShareV2Enabled,
  sendVerificationEmail,
  sessionCookie,
  sessionTokenDigest,
  sessionTokenFromRequest,
  sessionTtlSeconds,
  signedOpaqueToken,
  unlockAttemptDigest,
  updateDocumentWrite,
  userAgentDigest,
  verifySecureShareAppCheck,
  verifySignedOpaqueToken,
  verifySharePassword,
  verificationEmailText
} from "./_secure-share-common.js";

const accessModes = new Set(["anyone_with_link", "allowed_emails", "authenticated_users"]);
const permissionLevels = new Set(["view", "comment", "save_copy"]);
const expirationPresets = new Set(["one_hour", "one_day", "seven_days", "custom"]);
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
const validActions = new Set([
  "feature-status",
  "owner-list",
  "owner-details",
  "owner-create",
  "owner-update",
  "owner-activate",
  "owner-revoke",
  "metadata",
  "email-challenge",
  "access",
  "session",
  "content",
  "comments",
  "comment-delete",
  "copy-grant",
  "attachment-preview",
  "attachment-download"
]);

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
    && [400, 409, 412].includes(error.statusCode);
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
    || wrappedKeyBytes !== 256
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

function timestampMilliseconds(value) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
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
    downloadAllowed: share.downloadAllowed === true,
    quickCopyButtonVisible: share.quickCopyButtonVisible !== false,
    attachmentCount: Number.isSafeInteger(share.attachmentCount) ? share.attachmentCount : 0,
    consumedAt: share.consumedAt ?? null,
    revokedAt: share.revokedAt ?? null,
    lastAccessAt: share.lastAccessAt ?? null,
    successfulAccessCount: Number.isSafeInteger(share.successfulAccessCount) ? share.successfulAccessCount : 0
  };
}

function policySummary(policy) {
  return {
    accessMode: policy.accessMode,
    passwordEnabled: policy.passwordEnabled === true,
    emailVerificationRequired: policy.emailVerificationRequired === true,
    allowedEmailCount: Number.isSafeInteger(policy.allowedEmailCount) ? policy.allowedEmailCount : 0,
    oneTimeEnabled: policy.oneTimeEnabled === true,
    oneTimeScope: "global",
    permissionLevel: policy.permissionLevel,
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

function sourceSnapshotAvailable(share, note, ownerProfile) {
  const noteRevision = Number.isSafeInteger(note?.revision) ? note.revision : 0;
  const noteAttachmentRevision = Number.isSafeInteger(note?.attachmentRevision) ? note.attachmentRevision : 0;
  const shareRevision = Number.isSafeInteger(share?.sourceRevision) ? share.sourceRevision : 0;
  const shareAttachmentRevision = Number.isSafeInteger(share?.sourceAttachmentRevision)
    ? share.sourceAttachmentRevision
    : 0;
  return sourceNoteActive(note)
    && ownerProfile?.isActive === true
    && (
      ownerProfile?.isAdmin === true
      || !isPlainRecord(ownerProfile?.featureAccess)
      || ownerProfile.featureAccess.notes === true
    )
    && note.ownerUid === share?.ownerUid
    && noteRevision === shareRevision
    && noteAttachmentRevision === shareAttachmentRevision;
}

async function requireSourceAvailable(context, share) {
  const [note, ownerProfile] = await Promise.all([
    firestoreGet(context, `notes/${safeId(share.sourceNoteId, "sourceNoteId")}`),
    firestoreGet(context, `users/${safeId(share.ownerUid, "ownerUid")}`)
  ]);
  if (!sourceSnapshotAvailable(share, note, ownerProfile)) {
    throw new HttpError(404, "share_unavailable", "Source note is unavailable");
  }
  return note;
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
  const id = `evt_${randomToken(18)}`;
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

async function consumeRateLimits(context, definitions) {
  if (!definitions.length) {
    return [];
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const nowMilliseconds = Date.now();
    const states = await Promise.all(definitions.map(async (definition) => {
      const windowStartSeconds =
        Math.floor(nowMilliseconds / 1000 / definition.windowSeconds) * definition.windowSeconds;
      const bucketId = rateLimitBucketDigest(
        definition.limitType,
        [...definition.keyParts, String(windowStartSeconds)]
      );
      const path = `publicShareRateLimits/${bucketId}`;
      const document = await firestoreGet(context, path);
      const count = Number.isSafeInteger(document?.count) ? document.count : 0;
      if (count >= definition.limit) {
        const retryAfter = Math.max(1, windowStartSeconds + definition.windowSeconds - Math.floor(nowMilliseconds / 1000));
        throw new HttpError(429, "rate_limited", "Rate limit exceeded", { retryAfter });
      }
      return { definition, windowStartSeconds, bucketId, path, document, count };
    }));
    const writes = states.map(({ definition, windowStartSeconds, path, document, count }) => {
      const fields = {
        shareId: definition.shareId,
        ownerUid: definition.ownerUid ?? "",
        limitType: definition.limitType,
        windowStart: new Date(windowStartSeconds * 1000),
        count: count + 1,
        updatedAt: new Date(nowMilliseconds),
        expiresAt: new Date((windowStartSeconds + definition.windowSeconds * 2) * 1000)
      };
      return document
        ? updateDocumentWrite(
          context.projectId,
          path,
          fields,
          ["shareId", "ownerUid", "limitType", "windowStart", "count", "updatedAt", "expiresAt"],
          document.__updateTime
        )
        : createDocumentWrite(context.projectId, path, fields);
    });
    try {
      await firestoreCommit(context, writes);
      return states.map(({ path }) => path);
    } catch (error) {
      if (!isOptimisticConflict(error) || attempt === 3) {
        throw error;
      }
    }
  }
  return [];
}

async function releaseRateLimitReservations(context, paths) {
  if (!paths.length) {
    return;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
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
      if (!isOptimisticConflict(error) || attempt === 3) {
        throw error;
      }
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
    "downloadAllowed",
    "quickCopyButtonVisible",
    "oneTimeScope"
  ];
}

async function buildPolicySettings(body, existingPolicy = null) {
  const accessMode = body.accessMode ?? existingPolicy?.accessMode ?? "anyone_with_link";
  if (!accessModes.has(accessMode)) {
    throw new HttpError(400, "invalid_request", "Invalid accessMode");
  }
  const permissionLevel = body.permissionLevel ?? existingPolicy?.permissionLevel ?? "view";
  if (!permissionLevels.has(permissionLevel)) {
    throw new HttpError(400, "invalid_request", "Invalid permissionLevel");
  }
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
  if (emailVerificationRequired && !secureShareEmailEnabled()) {
    throw new HttpError(503, "email_unavailable", "Email verification is not configured");
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

async function handleOwnerCreate(request, response, id) {
  requireMethod(request, ["POST"]);
  ensureSameOrigin(request);
  const body = await readJsonBody(request);
  const input = validateCreateBody(body);
  const user = await ownerContext(request);
  const context = user.context;
  const note = await firestoreGet(context, `notes/${input.sourceNoteId}`);
  const actualRevision = Number.isSafeInteger(note?.revision) ? note.revision : 0;
  const actualAttachmentRevision = Number.isSafeInteger(note?.attachmentRevision) ? note.attachmentRevision : 0;
  if (
    !sourceNoteActive(note)
    || note.ownerUid !== user.uid
    || actualRevision !== input.sourceRevision
    || actualAttachmentRevision !== input.sourceAttachmentRevision
  ) {
    throw new HttpError(404, "not_found", "Source note is not owned by caller");
  }
  const shareId = input.idempotencyKey
    ? `ss2_${hmacDigest(
      requiredSecret("SHARE_SESSION_HMAC_KEY"),
      "quickmemo/secure-share/create-idempotency/v1",
      user.uid,
      input.idempotencyKey
    ).slice(0, 40)}`
    : `ss2_${randomToken(30)}`;
  const existing = await loadShareState(context, shareId);
  if (existing) {
    requireOwner(existing, user);
    jsonResponse(response, 200, {
      ok: true,
      created: false,
      share: shareSummary(existing.share),
      requestId: id
    });
    return;
  }
  await consumeRateLimits(context, [
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
  const policySettings = await buildPolicySettings(body.policy);
  const expiresAt = computeExpiresAt(body.policy);

  const now = new Date();
  const policyVersion = 1;
  const share = {
    schemaVersion: 2,
    version: 2,
    sourceNoteId: input.sourceNoteId,
    sourceRevision: input.sourceRevision,
    sourceAttachmentRevision: input.sourceAttachmentRevision,
    ownerUid: user.uid,
    status: "pending",
    ready: false,
    createdAt: now,
    updatedAt: now,
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
  try {
    await firestoreCommit(context, writes);
  } catch (error) {
    if (!isOptimisticConflict(error) || !input.idempotencyKey) {
      throw error;
    }
    const raced = await loadShareState(context, shareId);
    requireOwner(raced, user);
    jsonResponse(response, 200, {
      ok: true,
      created: false,
      share: shareSummary(raced.share),
      requestId: id
    });
    return;
  }
  jsonResponse(response, 201, {
    ok: true,
    created: true,
    share: shareSummary({ ...share, __id: shareId }),
    requestId: id
  });
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
  if (status && !new Set(["pending", "active", "consumed", "revoked", "expired"]).has(status)) {
    throw new HttpError(400, "invalid_request", "Invalid status filter");
  }
  const pageSizeText = queryString(url, "limit", 3);
  const pageSize = pageSizeText
    ? boundedInteger(Number.parseInt(pageSizeText, 10), "pageSize", 1, maximumPageSize)
    : defaultPageSize;
  const cursor = ownerListCursor(queryString(url, "cursor", 1000));
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
      fields: [
        "schemaVersion",
        "sourceNoteId",
        "sourceRevision",
        "sourceAttachmentRevision",
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
        "downloadAllowed",
        "quickCopyButtonVisible",
        "attachmentCount",
        "consumedAt",
        "revokedAt",
        "lastAccessAt",
        "successfulAccessCount"
      ].map((fieldPath) => ({ fieldPath }))
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
  const recipients = await firestoreListCollection(
    user.context,
    `publicShareRecipients/${shareId}`,
    "items",
    110
  );
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
    requestId: id
  });
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

async function deleteEmailChallengesForShare(context, shareId) {
  let deleted = 0;
  for (let page = 0; page < 50; page += 1) {
    const challenges = await firestoreRunQuery(context, {
      from: [{ collectionId: "publicShareEmailChallenges" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "shareId" },
          op: "EQUAL",
          value: firestoreStringValue(shareId)
        }
      },
      limit: 200
    });
    if (!challenges.length) {
      return deleted;
    }
    await firestoreCommit(
      context,
      challenges.map((challenge) =>
        deleteDocumentWrite(
          context.projectId,
          `publicShareEmailChallenges/${safeId(challenge.__id, "challengeId")}`,
          challenge.__updateTime
        ))
    );
    deleted += challenges.length;
  }
  throw new HttpError(503, "service_unavailable", "Challenge cleanup exceeded its safe bound", {
    expose: false
  });
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
    if (state.share.status === "revoked" || state.share.revokedAt) {
      throw new HttpError(409, "share_unavailable");
    }
    if (state.share.lastOwnerMutationId === updateInput.idempotencyKey) {
      await deleteEmailChallengesForShare(user.context, shareId);
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
    await requireSourceAvailable(user.context, state.share);
    const policySettings = await buildPolicySettings(updateInput.policy, state.policy);
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
      createAuditWrite(user.context, state.share, "owner_update", "success", {
        requestId: id,
        identityType: "quickmemo_user",
        identityHash: identityDigest("uid", user.uid)
      })
    ];
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
      await deleteEmailChallengesForShare(user.context, shareId);
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
    if (state.share.lastOwnerMutationId === idempotencyKey) {
      jsonResponse(response, 200, { ok: true, share: shareSummary(state.share), requestId: id });
      return;
    }
    await requireSourceAvailable(user.context, state.share);
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
        })
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
    if (state.share.status === "revoked" || state.share.revokedAt) {
      jsonResponse(response, 200, { ok: true, share: shareSummary(state.share), requestId: id });
      return;
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
    try {
      await firestoreCommit(user.context, [
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
      ]);
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
      ownerPreview
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

async function updateChallengeAfterSendFailure(context, path, challenge) {
  try {
    const latest = await firestoreGet(context, path);
    if (!latest || latest.status !== "pending" || latest.codeDigest !== challenge.codeDigest) {
      return;
    }
    await firestoreCommit(context, [
      updateDocumentWrite(
        context.projectId,
        path,
        { status: "send_failed", updatedAt: new Date() },
        ["status", "updatedAt"],
        latest.__updateTime
      )
    ]);
  } catch (error) {
    console.error("secure share challenge status update failed", {
      error: error instanceof Error ? error.name : "unknown"
    });
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
  if (!secureShareEmailEnabled()) {
    throw new HttpError(503, "email_unavailable", "Secure Share email is unavailable");
  }
  const body = await readJsonBody(request, 16 * 1024);
  assertOnlyKeys(body, ["email"]);
  const normalizedEmail = normalizeEmail(body.email);
  const code = generateOtpCode();
  const timingStartedAt = Date.now();
  const minimumResponseMilliseconds = emailChallengeMinimumResponseMilliseconds();
  const challengeTtlSeconds = otpTtlSeconds();
  const hashedEmail = emailDigest(normalizedEmail);
  const context = await secureContext(request);
  const state = await loadShareState(context, shareId);
  const ownerUid = state?.share?.ownerUid ?? "";
  const networkHash = clientNetworkDigest(request);

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
      limitType: "otp_share_email_day",
      keyParts: [shareId, hashedEmail],
      shareId,
      ownerUid,
      windowSeconds: 24 * 60 * 60,
      limit: 10
    },
    {
      limitType: "otp_network_hour",
      keyParts: [networkHash],
      shareId,
      ownerUid,
      windowSeconds: 60 * 60,
      limit: 20
    }
  ]);

  const challengeId = `ch_${hmacDigest(
    requiredSecret("SHARE_OTP_HMAC_KEY"),
    "quickmemo/secure-share/challenge-id/v1",
    shareId,
    hashedEmail
  ).slice(0, 40)}`;
  const path = `publicShareEmailChallenges/${challengeId}`;
  const existing = await firestoreGet(context, path);
  const now = Date.now();
  if (timestampMilliseconds(existing?.resendNotBefore) > now) {
    throw new HttpError(429, "rate_limited", "Challenge resend cooldown", {
      retryAfter: Math.max(1, Math.ceil((timestampMilliseconds(existing.resendNotBefore) - now) / 1000))
    });
  }

  const eligible = await emailChallengeEligibility(context, state, hashedEmail);
  const challenge = {
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
    status: eligible ? "pending" : "suppressed",
    verifiedAt: undefined,
    consumedAt: undefined,
    consumedAttemptHash: undefined
  };
  const write = existing
    ? updateDocumentWrite(
      context.projectId,
      path,
      challenge,
      [
        "shareId",
        "ownerUid",
        "policyVersion",
        "emailHash",
        "codeDigest",
        "attempts",
        "maxAttempts",
        "createdAt",
        "updatedAt",
        "expiresAt",
        "resendNotBefore",
        "requestIpHash",
        "status",
        "verifiedAt",
        "consumedAt",
        "consumedAttemptHash"
      ],
      existing.__updateTime
    )
    : createDocumentWrite(context.projectId, path, challenge);
  await firestoreCommit(context, [write]);

  if (eligible) {
    try {
      const elapsedMilliseconds = Math.max(0, Date.now() - timingStartedAt);
      const deliveryBudgetMilliseconds = Math.max(
        1,
        Math.min(2_500, minimumResponseMilliseconds - elapsedMilliseconds - 250)
      );
      await sendVerificationEmail(
        normalizedEmail,
        code,
        challengeTtlSeconds,
        undefined,
        deliveryBudgetMilliseconds
      );
    } catch {
      await updateChallengeAfterSendFailure(context, path, challenge);
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
      console.error("secure share challenge failure update failed", {
        error: error instanceof Error ? error.name : "unknown"
      });
    }
    return rejectVerification();
  }
  return {
    identityType: "verified_email",
    identityHash: identityDigest("email", challenge.emailHash),
    displayName: safeDisplayName(body.displayName, "Verified guest"),
    challenge
  };
}

async function resolveAccessIdentity(request, context, shareId, policy, body, otpVerificationTiming) {
  let caller = null;
  if (authorizationToken(request)) {
    caller = await activeUserFromRequest(request, context);
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
      authorUid: caller.uid,
      displayName: safeDisplayName(caller.profileDisplayName || caller.displayName, "QuickMemo user"),
      caller,
      challenge: null
    };
  }

  if (policy.emailVerificationRequired === true) {
    return {
      ...(await verifiedChallengeIdentity(
        context,
        shareId,
        policy,
        body,
        otpVerificationTiming
      )),
      authorUid: "",
      caller: null
    };
  }

  if (caller) {
    return {
      identityType: "quickmemo_user",
      identityHash: identityDigest("uid", caller.uid),
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
  return {
    identityType: "browser",
    identityHash: identityDigest("browser", binding),
    authorUid: "",
    displayName: safeDisplayName(body.displayName, "Guest"),
    caller: null,
    challenge: null
  };
}

function sessionCapabilities(policy, ownerPreview = false) {
  return {
    permissionLevel: policy.permissionLevel,
    canComment: ownerPreview || policy.permissionLevel === "comment",
    canSaveCopy: !ownerPreview && policy.permissionLevel === "save_copy",
    downloadAllowed: policy.downloadAllowed === true,
    quickCopyButtonVisible: policy.quickCopyButtonVisible !== false
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
  await firestoreCommit(context, [
    createDocumentWrite(context.projectId, `publicShareAccessSessions/${digest}`, session),
    createAuditWrite(context, state.share, "owner_preview", "success", {
      requestId: id,
      identityType: identity.identityType,
      identityHash: identity.identityHash,
      ipHash: clientNetworkDigest(request),
      userAgentHash: userAgentDigest(request)
    })
  ]);
  return { sessionToken, csrfToken, expiresAt: expiresAt.toISOString() };
}

async function issueAccessSession(
  request,
  context,
  shareId,
  verifiedPolicyVersion,
  identity,
  browserBindingHash,
  attemptHash,
  id
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await loadShareState(context, shareId);
    assertPublicShareAvailable(state);
    if (state.policy.policyVersion !== verifiedPolicyVersion) {
      throw new HttpError(409, "policy_changed");
    }
    await requireSourceAvailable(context, state.share);
    const now = Date.now();
    const sessionToken = randomToken(32);
    const digest = sessionTokenDigest(sessionToken);
    const csrfToken = randomToken(32);
    const csrfDigest = csrfTokenDigest(csrfToken, digest);
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
      }
      if (identity.challenge) {
        if (identity.challenge.status !== "pending") {
          throw new HttpError(409, "access_denied", "Challenge was already consumed");
        }
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
    writes.push(createAuditWrite(context, state.share, "viewer_access", "success", {
      requestId: id,
      identityType: identity.identityType,
      identityHash: identity.identityHash,
      ipHash: clientNetworkDigest(request),
      userAgentHash: userAgentDigest(request)
    }));
    try {
      await firestoreCommit(context, writes);
      return {
        sessionToken,
        csrfToken,
        expiresAt: expiresAt.toISOString(),
        policy: state.policy
      };
    } catch (error) {
      if (!isOptimisticConflict(error) || attempt === 3) {
        throw error;
      }
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

  if (body.ownerPreview === true) {
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
  await requireSourceAvailable(context, state.share);
  if (state.policy.oneTimeEnabled === true && body.oneTimeOpenConfirmed !== true) {
    throw new HttpError(400, "one_time_confirmation_required");
  }
  const networkHash = clientNetworkDigest(request);
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

  const identity = await resolveAccessIdentity(request, context, shareId, state.policy, body);
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
  const grant = await issueAccessSession(
    request,
    context,
    shareId,
    state.policy.policyVersion,
    identity,
    browserBindingHash,
    attemptHash,
    id
  );
  jsonResponse(response, 200, {
    ok: true,
    csrfToken: grant.csrfToken,
    sessionExpiresAt: grant.expiresAt,
    ownerPreview: false,
    capabilities: sessionCapabilities(grant.policy, false),
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
}

async function validatedSession(request, context, shareId) {
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
  }
  await requireSourceAvailable(context, state.share);
  session.__sessionDigest = digest;
  return { session, state };
}

async function handleSession(request, response, id, shareId) {
  requireMethod(request, ["GET"]);
  const context = await secureContext(request);
  const { session, state } = await validatedSession(request, context, shareId);
  const csrfToken = randomToken(32);
  const csrfDigest = csrfTokenDigest(csrfToken, session.__sessionDigest);
  await firestoreCommit(context, [
    updateDocumentWrite(
      context.projectId,
      `publicShareAccessSessions/${session.__sessionDigest}`,
      { csrfDigest, lastSeenAt: new Date() },
      ["csrfDigest", "lastSeenAt"],
      session.__updateTime
    )
  ]);
  jsonResponse(response, 200, {
    ok: true,
    csrfToken,
    sessionExpiresAt: session.expiresAt,
    ownerPreview: session.ownerPreview === true,
    capabilities: sessionCapabilities(state.policy, session.ownerPreview === true),
    requestId: id
  });
}

function safeAttachmentMetadata(attachment) {
  return {
    id: attachment.__id,
    version: attachment.version,
    algorithm: attachment.algorithm,
    generation: attachment.generation ?? "",
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
    && (
      share.currentGeneration
        ? attachment.generation === share.currentGeneration
        : !attachment.generation
    );
}

async function currentAttachments(context, share) {
  const attachments = await firestoreListCollection(
    context,
    `publicNoteShares/${share.__id}`,
    "attachments",
    150
  );
  const current = attachments.filter((attachment) => attachmentCurrent(attachment, share));
  if (
    current.length > 100
    || current.length !== (Number.isSafeInteger(share.attachmentCount) ? share.attachmentCount : 0)
  ) {
    throw new HttpError(409, "attachment_state_changed");
  }
  return current;
}

async function handleContent(request, response, id, shareId) {
  requireMethod(request, ["GET"]);
  const context = await secureContext(request);
  const { state } = await validatedSession(request, context, shareId);
  const attachments = await currentAttachments(context, state.share);
  attachments.forEach((attachment) => validateAttachmentRecord(attachment, state.share));
  jsonResponse(response, 200, {
    ok: true,
    schemaVersion: 2,
    encryptedTitle: state.share.encryptedTitle,
    encryptedBody: state.share.encryptedBody,
    attachments: attachments.map((attachment) => safeAttachmentMetadata(attachment)),
    requestId: id
  });
}

function validateCommentBody(value) {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", "Comment body must be text");
  }
  const body = value.trim();
  if (
    Array.from(body).length < 1
    || Array.from(body).length > 2000
    || body.includes("<")
    || body.includes(">")
    || body.includes("\u0000")
  ) {
    throw new HttpError(400, "invalid_request", "Comment body is invalid");
  }
  return body;
}

function publicComment(comment) {
  return {
    id: comment.__id,
    displayName: comment.authorDisplayName,
    badge: comment.authorBadge,
    body: comment.deletedAt ? "(삭제된 댓글)" : comment.body,
    createdAt: comment.createdAt,
    canDelete: false
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
      ? boundedInteger(Number.parseInt(pageSizeText, 10), "limit", 1, maximumPageSize)
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
    const items = page.map((comment) => {
      const result = publicComment(comment);
      result.canDelete = Boolean(
        access.owner
        || access.session?.ownerPreview === true
        || (
          access.session
          && comment.authorIdentityHash === access.session.identityHash
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
  assertOnlyKeys(body, ["body"]);
  const text = validateCommentBody(body.body);
  const context = await secureContext(request);
  const { session, state } = await validatedSession(request, context, shareId);
  if (session.ownerPreview !== true && state.policy.permissionLevel !== "comment") {
    throw new HttpError(403, "access_denied");
  }
  requireCsrf(request, session);
  const networkHash = clientNetworkDigest(request);
  await consumeRateLimits(context, [
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
  const commentId = `c_${randomToken(24)}`;
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
  const comment = {
    shareId,
    ownerUid: state.share.ownerUid,
    authorType: session.identityType,
    authorUid: session.authorUid || "",
    authorIdentityHash: session.identityHash,
    authorDisplayName: safeDisplayName(
      session.authorDisplayName,
      session.identityType === "admin_preview"
        ? "Administrator"
        : session.ownerPreview === true
          ? "Owner"
          : "Guest",
      session.ownerPreview === true
    ),
    authorBadge,
    body: text,
    createdAt: now,
    expiresAt: new Date(timestampMilliseconds(state.share.expiresAt)),
    retentionExpiresAt: new Date(Math.max(
      timestampMilliseconds(state.share.expiresAt),
      now.getTime() + auditRetentionMilliseconds
    )),
    sessionDigestReference: session.sessionReferenceHash
  };
  await firestoreCommit(context, [
    createDocumentWrite(
      context.projectId,
      `publicShareComments/${shareId}/items/${commentId}`,
      comment
    ),
    createAuditWrite(context, state.share, "comment_create", "success", {
      requestId: id,
      identityType: session.identityType,
      identityHash: session.identityHash,
      ipHash: networkHash,
      userAgentHash: userAgentDigest(request)
    })
  ]);
  jsonResponse(response, 201, {
    ok: true,
    comment: publicComment({ ...comment, __id: commentId }),
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
        && comment.authorIdentityHash !== access.session.identityHash
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
  ]);
  jsonResponse(response, 200, { ok: true, deleted: true, requestId: id });
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
  const networkHash = clientNetworkDigest(request);
  await consumeRateLimits(context, [
    {
      limitType: "copy_grant_session_minute",
      keyParts: [shareId, session.__sessionDigest],
      shareId,
      ownerUid: state.share.ownerUid,
      windowSeconds: 60,
      limit: 3
    }
  ]);
  await preflightCopyAttachmentQuota(context, user.uid, state.share);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const copyGrant = signedOpaqueToken(
    {
      kind: "secure_share_copy_grant",
      shareId,
      uid: user.uid,
      policyVersion: state.policy.policyVersion,
      idempotencyHash: hmacDigest(
        requiredSecret("SHARE_SESSION_HMAC_KEY"),
        "quickmemo/secure-share/copy-idempotency/v1",
        user.uid,
        idempotencyKey
      ),
      sessionReferenceHash: session.sessionReferenceHash
    },
    "quickmemo/secure-share/copy-grant/v1",
    5 * 60
  );
  await firestoreCommit(context, [
    createAuditWrite(context, state.share, "copy_grant", "success", {
      requestId: id,
      identityType: "quickmemo_user",
      identityHash: identityDigest("uid", user.uid),
      ipHash: networkHash,
      userAgentHash: userAgentDigest(request)
    })
  ]);
  jsonResponse(response, 200, {
    ok: true,
    copyGrant,
    expiresAt: expiresAt.toISOString(),
    requestId: id
  });
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
    const metadata = await head(attachment.blobPath);
    if (
      !metadata
      || metadata.pathname !== attachment.blobPath
      || metadata.size !== encryptedSize
      || metadata.contentType !== "application/octet-stream"
    ) {
      throw new HttpError(404, "not_found", "Private Blob metadata mismatch");
    }
    const blob = await get(attachment.blobPath, { access: "private", useCache: false });
    if (!blob || blob.statusCode !== 200 || !blob.stream) {
      throw new HttpError(404, "not_found", "Private Blob is unavailable");
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
    jsonResponse(response, 200, {
      v2Enabled: secureShareV2Enabled(),
      emailEnabled: secureShareEmailEnabled()
    });
    return;
  }

  requireSecureShareV2();
  if (action === "owner-list") {
    assertQueryKeys(url, ["action", "cursor", "limit", "status"]);
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
  } else if (action === "content") {
    await handleContent(request, response, id, shareId);
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
  assertOnlyKeys,
  buildPolicySettings,
  copyGrantAuthorizesDownload,
  consumeRateLimits,
  createResendEmailAdapter,
  emailDigest,
  emailChallengeMinimumResponseMilliseconds,
  ensureSameOrigin,
  evaluateCopyAttachmentQuota,
  hashSharePassword,
  handleApiError,
  issueAccessSession,
  normalizeAllowedEmails,
  normalizeEmail,
  otpCodeDigest,
  otpVerificationFailureMinimumResponseMilliseconds,
  padEmailChallengeResponse,
  padOtpVerificationFailureResponse,
  readJsonBody,
  resolveAccessIdentity,
  safeDisplayName,
  secureShareScryptParameters,
  secureShareAttachmentBlobPath,
  secureShareEmailReadiness,
  sessionTokenDigest,
  shareOwnedBy,
  shareManagedBy,
  signedOpaqueToken,
  sourceSnapshotAvailable,
  unlockAttemptDigest,
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
