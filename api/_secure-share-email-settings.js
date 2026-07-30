/* global Buffer, process */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import {
  HttpError,
  createDocumentWrite,
  deleteDocumentWrite,
  firestoreCommit,
  firestoreGet,
  gmailSmtpConfiguration,
  hmacDigest,
  normalizeEmail,
  randomToken,
  requiredSecret,
  secureShareEmailReadiness,
  updateDocumentWrite
} from "./_secure-share-common.js";

export const secureShareEmailSettingsPath = "secureShareEmailSettings/current";
export const secureShareEmailProviderHealthPath =
  "publicShareEmailProviderHealth/gmail-smtp";
const settingsSchemaVersion = 1;
const encryptedSlotVersion = 1;
const encryptionKeyVersion = 1;
const runtimeCacheMilliseconds = 5_000;
const testCodeTtlMilliseconds = 10 * 60 * 1000;
const testCodeMaximumAttempts = 5;
const testResendCooldownMilliseconds = 60 * 1000;
const testSendMaximumPerGeneration = 5;
const adminRateLimitWindowSeconds = 60;
const adminRateLimitMaximum = 12;
const adminIdempotencyRetentionMilliseconds = 24 * 60 * 60 * 1000;
const adminAuditRetentionMilliseconds = 180 * 24 * 60 * 60 * 1000;
const generationPattern = /^[A-Za-z0-9_-]{16,64}$/u;
const idempotencyPattern = /^[A-Za-z0-9_-]{16,128}$/u;
const requestHashPattern = /^[A-Za-z0-9_-]{43}$/u;
const gmailAppPasswordPattern = /^[A-Za-z0-9]{16}$/u;
const gmailAddressPattern =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/u;
const encryptedTextPattern = /^[A-Za-z0-9_-]{16,8192}$/u;
const exactEncryptionKeyPattern = /^[A-Za-z0-9_-]{43}$/u;
const runtimeCache = new Map();
const recentAuthenticationMaximumAgeMilliseconds = 5 * 60 * 1000;
const recentAuthenticationFutureSkewMilliseconds = 60 * 1000;

function settingsUnavailable(message = "Secure Share email settings are unavailable") {
  return new HttpError(503, "email_settings_unavailable", message);
}

function conflict(message = "Secure Share email settings changed concurrently") {
  return new HttpError(409, "conflict", message);
}

function normalizedTimestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return "";
}

function encryptionKey(environment = process.env) {
  const encoded =
    typeof environment.SHARE_EMAIL_SETTINGS_ENCRYPTION_KEY_V1 === "string"
      ? environment.SHARE_EMAIL_SETTINGS_ENCRYPTION_KEY_V1.trim()
      : "";
  if (!exactEncryptionKeyPattern.test(encoded)) {
    throw settingsUnavailable();
  }
  if ([
    "SHARE_PASSWORD_PEPPER",
    "SHARE_SESSION_HMAC_KEY",
    "SHARE_PARTICIPANT_HMAC_KEY",
    "SHARE_COOKIE_NAME_HMAC_KEY",
    "SHARE_CSRF_HMAC_KEY",
    "SHARE_OTP_HMAC_KEY",
    "SHARE_EMAIL_HMAC_KEY",
    "SHARE_RATE_LIMIT_HMAC_KEY"
  ].some((name) => environment[name] === encoded)) {
    throw settingsUnavailable();
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== encoded) {
    throw settingsUnavailable();
  }
  return decoded;
}

function encryptionAad(projectId, slot, generation) {
  if (
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(projectId)
    || !new Set(["active", "pending"]).has(slot)
    || !generationPattern.test(generation)
  ) {
    throw settingsUnavailable();
  }
  return Buffer.from(
    JSON.stringify({
      purpose: "quickmemo/secure-share/email-settings/v1",
      projectId,
      slot,
      generation
    }),
    "utf8"
  );
}

function hasControlCharacter(value) {
  return typeof value === "string"
    && Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    });
}

export function normalizeGmailSettingsInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "invalid_request", "Invalid Gmail settings");
  }
  let username;
  let replyTo = "";
  try {
    username = normalizeEmail(input.username);
    replyTo = input.replyTo ? normalizeEmail(input.replyTo) : "";
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid Gmail settings");
  }
  const appPassword =
    typeof input.appPassword === "string"
      ? input.appPassword.split(" ").join("")
      : "";
  if (
    !gmailAddressPattern.test(username)
    || hasControlCharacter(username)
    || !gmailAppPasswordPattern.test(appPassword)
    || (replyTo && hasControlCharacter(replyTo))
    || replyTo.endsWith("@quickmemo-tan.vercel.app")
  ) {
    throw new HttpError(400, "invalid_request", "Invalid Gmail settings");
  }
  return Object.freeze({ username, appPassword, replyTo });
}

export function idTokenHasRecentAdminAuthentication(
  idToken,
  expectedUid,
  expectedProjectId,
  now = Date.now()
) {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  const encodedPayload = parts[1] ?? "";
  if (
    parts.length !== 3
    || !parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part))
    || encodedPayload.length > 8_192
  ) {
    return false;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );
    const authTime = payload?.auth_time;
    const issuedAt = payload?.iat;
    const expiresAt = payload?.exp;
    if (
      !payload
      || typeof payload !== "object"
      || payload.sub !== expectedUid
      || payload.aud !== expectedProjectId
      || payload.iss !== `https://securetoken.google.com/${expectedProjectId}`
      || !Number.isSafeInteger(authTime)
      || !Number.isSafeInteger(issuedAt)
      || !Number.isSafeInteger(expiresAt)
      || authTime <= 0
      || issuedAt <= 0
      || expiresAt <= 0
    ) {
      return false;
    }
    const authTimeMilliseconds = authTime * 1000;
    const issuedAtMilliseconds = issuedAt * 1000;
    const expiresAtMilliseconds = expiresAt * 1000;
    return (
      authTimeMilliseconds <= now + recentAuthenticationFutureSkewMilliseconds
      && authTimeMilliseconds >= now - recentAuthenticationMaximumAgeMilliseconds
      && issuedAtMilliseconds <= now + recentAuthenticationFutureSkewMilliseconds
      && authTimeMilliseconds <= issuedAtMilliseconds
        + recentAuthenticationFutureSkewMilliseconds
      && expiresAtMilliseconds > now
    );
  } catch {
    return false;
  }
}

export function gmailRuntimeEnvironment(settings, environment = process.env) {
  const normalized = normalizeGmailSettingsInput(settings);
  return Object.freeze({
    ...environment,
    SHARE_EMAIL_PROVIDER: "gmail_smtp",
    SHARE_EMAIL_FREE_TIER_MODE: "true",
    SHARE_EMAIL_FROM: normalized.username,
    SHARE_EMAIL_FROM_NAME: "QuickMemo",
    SHARE_EMAIL_REPLY_TO: normalized.replyTo,
    SHARE_SMTP_HOST: "smtp.gmail.com",
    SHARE_SMTP_PORT: "465",
    SHARE_SMTP_SECURE: "true",
    SHARE_SMTP_REQUIRE_TLS: "true",
    SHARE_SMTP_USERNAME: normalized.username,
    SHARE_SMTP_APP_PASSWORD: normalized.appPassword
  });
}

export function maskEmailAddress(value) {
  let normalized;
  try {
    normalized = normalizeEmail(value);
  } catch {
    return "";
  }
  const separator = normalized.lastIndexOf("@");
  const local = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  if (!local || !domain) {
    return "";
  }
  const visibleLocal = local.length === 1
    ? `${local[0]}***`
    : `${local[0]}***${local.at(-1)}`;
  return `${visibleLocal}@${domain}`;
}

export function encryptEmailSettingsSlot(
  settings,
  { environment = process.env, generation, projectId, slot }
) {
  const normalized = normalizeGmailSettingsInput(settings);
  const configuration = gmailSmtpConfiguration(
    gmailRuntimeEnvironment(normalized, environment)
  );
  const plaintext = Buffer.from(JSON.stringify({
    provider: "gmail_smtp",
    host: configuration.host,
    port: configuration.port,
    secure: configuration.secure,
    requireTls: configuration.requireTls,
    username: configuration.username,
    appPassword: configuration.appPassword,
    fromAddress: configuration.fromAddress,
    fromName: configuration.fromName,
    replyTo: configuration.replyTo,
    freeTierMode: true
  }), "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(environment), iv);
  cipher.setAAD(encryptionAad(projectId, slot, generation));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  plaintext.fill(0);
  return Object.freeze({
    version: encryptedSlotVersion,
    algorithm: "AES-256-GCM",
    keyVersion: encryptionKeyVersion,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: authTag.toString("base64url")
  });
}

function validEncryptedSlot(value) {
  return Boolean(
    value
    && typeof value === "object"
    && value.version === encryptedSlotVersion
    && value.algorithm === "AES-256-GCM"
    && value.keyVersion === encryptionKeyVersion
    && /^[A-Za-z0-9_-]{16}$/u.test(value.iv)
    && encryptedTextPattern.test(value.ciphertext)
    && /^[A-Za-z0-9_-]{22}$/u.test(value.authTag)
  );
}

export function decryptEmailSettingsSlot(
  encrypted,
  { environment = process.env, generation, projectId, slot }
) {
  if (!validEncryptedSlot(encrypted)) {
    throw settingsUnavailable();
  }
  let plaintext = null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(environment),
      Buffer.from(encrypted.iv, "base64url")
    );
    decipher.setAAD(encryptionAad(projectId, slot, generation));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final()
    ]);
    if (plaintext.byteLength > 4_096) {
      throw settingsUnavailable();
    }
    const parsed = JSON.parse(plaintext.toString("utf8"));
    const normalized = normalizeGmailSettingsInput(parsed);
    const runtimeEnvironment = gmailRuntimeEnvironment(normalized, environment);
    const configuration = gmailSmtpConfiguration(runtimeEnvironment);
    if (
      parsed.provider !== "gmail_smtp"
      || parsed.host !== "smtp.gmail.com"
      || parsed.port !== 465
      || parsed.secure !== true
      || parsed.requireTls !== true
      || parsed.fromAddress !== configuration.username
      || parsed.fromName !== "QuickMemo"
      || parsed.freeTierMode !== true
    ) {
      throw settingsUnavailable();
    }
    return Object.freeze({
      configuration,
      environment: runtimeEnvironment,
      settings: normalized
    });
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw settingsUnavailable();
  } finally {
    plaintext?.fill(0);
  }
}

function validGeneration(value) {
  return typeof value === "string" && generationPattern.test(value);
}

function slotMetadata(slot) {
  if (
    !slot
    || typeof slot !== "object"
    || !validGeneration(slot.generation)
    || !validEncryptedSlot(slot.encrypted)
    || typeof slot.usernameMasked !== "string"
    || slot.usernameMasked.length > 320
    || typeof slot.replyToMasked !== "string"
    || slot.replyToMasked.length > 320
  ) {
    return null;
  }
  return slot;
}

function publicSlot(slot) {
  const normalized = slotMetadata(slot);
  if (!normalized) {
    return {
      present: false,
      generation: null,
      usernameMasked: null,
      replyToMasked: null,
      verifiedAt: null,
      stagedAt: null,
      testSentAt: null,
      testExpiresAt: null,
      attemptsRemaining: null
    };
  }
  const attempts = Number.isSafeInteger(normalized.testAttempts)
    ? Math.min(Math.max(normalized.testAttempts, 0), testCodeMaximumAttempts)
    : 0;
  return {
    present: true,
    generation: normalized.generation,
    usernameMasked: normalized.usernameMasked,
    replyToMasked: normalized.replyToMasked || null,
    verifiedAt: normalizedTimestamp(normalized.verifiedAt) || null,
    stagedAt: normalizedTimestamp(normalized.stagedAt) || null,
    testSentAt: normalizedTimestamp(normalized.testSentAt) || null,
    testExpiresAt: normalizedTimestamp(normalized.testExpiresAt) || null,
    attemptsRemaining: normalized.testState === "sent"
      ? Math.max(0, testCodeMaximumAttempts - attempts)
      : null
  };
}

export function publicEmailSettingsStatus(document) {
  const active = publicSlot(document?.active);
  const pending = publicSlot(document?.pending);
  return {
    enabled:
      document?.schemaVersion === settingsSchemaVersion
      && document?.enabled === true
      && active.present,
    active,
    pending
  };
}

export function createPendingEmailSettingsSlot(
  settings,
  { environment = process.env, generation = randomToken(18), now = new Date(), projectId }
) {
  const normalized = normalizeGmailSettingsInput(settings);
  return {
    generation,
    encrypted: encryptEmailSettingsSlot(normalized, {
      environment,
      generation,
      projectId,
      slot: "pending"
    }),
    usernameMasked: maskEmailAddress(normalized.username),
    replyToMasked: normalized.replyTo ? maskEmailAddress(normalized.replyTo) : "",
    stagedAt: now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    verifiedAt: undefined,
    testState: "not_sent",
    testCodeDigest: "",
    testRequestHash: "",
    testAttempts: 0,
    testSentAt: undefined,
    testExpiresAt: undefined
  };
}

export function emailTestCodeDigest(generation, code) {
  if (!validGeneration(generation) || !/^[0-9]{6}$/u.test(code)) {
    throw new HttpError(400, "invalid_request", "Invalid email settings test");
  }
  return hmacDigest(
    requiredSecret("SHARE_OTP_HMAC_KEY"),
    "quickmemo/secure-share/email-settings-test/v1",
    generation,
    code
  );
}

export function emailTestCodeMatches(generation, code, expectedDigest) {
  if (
    !/^[0-9]{6}$/u.test(code)
    || typeof expectedDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test(expectedDigest)
  ) {
    return false;
  }
  const actual = Buffer.from(emailTestCodeDigest(generation, code), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function nextTestWindow(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw settingsUnavailable();
  }
  return {
    sentAt: now,
    expiresAt: new Date(now.getTime() + testCodeTtlMilliseconds)
  };
}

export function assertEmailSettingsTestSendAvailable(
  pending,
  nowMilliseconds = Date.now()
) {
  if (!pending || typeof pending !== "object") {
    throw conflict("Pending Gmail settings are unavailable");
  }
  if (pending.testState === "sending" || pending.testState === "ambiguous") {
    throw conflict("A test delivery is unresolved");
  }
  const lastTestAt = Date.parse(pending.testSentAt ?? "");
  if (
    Number.isFinite(lastTestAt)
    && lastTestAt + testResendCooldownMilliseconds > nowMilliseconds
  ) {
    throw new HttpError(429, "rate_limited", "Test resend cooldown", {
      retryAfter: Math.max(
        1,
        Math.ceil((
          lastTestAt
          + testResendCooldownMilliseconds
          - nowMilliseconds
        ) / 1000)
      )
    });
  }
  const sendCount = Number.isSafeInteger(pending.testSendCount)
    ? pending.testSendCount
    : 0;
  if (sendCount >= testSendMaximumPerGeneration) {
    throw new HttpError(429, "rate_limited", "Test send limit exhausted", {
      retryAfter: 24 * 60 * 60
    });
  }
  return sendCount;
}

export function emailSettingsTestFailureDisposition(
  error,
  nowMilliseconds = Date.now()
) {
  let ambiguous = false;
  if (error && typeof error === "object") {
    try {
      ambiguous = error.deliveryAmbiguous === true;
    } catch {
      ambiguous = false;
    }
  }
  return {
    state: ambiguous ? "ambiguous" : "failed",
    quotaOutcome: ambiguous ? "ambiguous" : "failed",
    testNotBefore: new Date(
      nowMilliseconds + testResendCooldownMilliseconds
    )
  };
}

export function assertEmailSettingsGeneration(value) {
  if (!validGeneration(value)) {
    throw new HttpError(400, "invalid_request", "Invalid settings generation");
  }
  return value;
}

export function assertEmailSettingsIdempotencyKey(value) {
  if (typeof value !== "string" || !idempotencyPattern.test(value)) {
    throw new HttpError(400, "invalid_request", "Invalid idempotency key");
  }
  return value;
}

export function isOptimisticFirestoreConflict(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  try {
    return new Set([409, 412]).has(error.upstreamStatus)
      || new Set(["ABORTED", "ALREADY_EXISTS", "FAILED_PRECONDITION"])
        .has(error.upstreamCode);
  } catch {
    return false;
  }
}

export function settingsDocumentWrite(context, current, fields) {
  const normalizedFields = {
    schemaVersion: settingsSchemaVersion,
    enabled: fields.enabled === true,
    active: fields.active,
    pending: fields.pending,
    updatedAt: fields.updatedAt,
    updatedBy: fields.updatedBy
  };
  return current
    ? updateDocumentWrite(
      context.projectId,
      secureShareEmailSettingsPath,
      normalizedFields,
      Object.keys(normalizedFields),
      current.__updateTime
    )
    : createDocumentWrite(
      context.projectId,
      secureShareEmailSettingsPath,
      normalizedFields
    );
}

function idempotencyDigest(actorUid, action, idempotencyKey) {
  return hmacDigest(
    requiredSecret("SHARE_RATE_LIMIT_HMAC_KEY"),
    "quickmemo/secure-share/email-settings-idempotency/v1",
    actorUid,
    action,
    idempotencyKey
  );
}

export function adminEmailSettingsRequestHash(actorUid, body) {
  if (
    typeof actorUid !== "string"
    || actorUid.length < 1
    || actorUid.length > 128
    || !body
    || typeof body !== "object"
    || Array.isArray(body)
    || typeof body.action !== "string"
  ) {
    throw new HttpError(400, "invalid_request");
  }
  let canonicalPayload;
  if (body.action === "stage") {
    const settings = normalizeGmailSettingsInput(body);
    canonicalPayload = [
      body.action,
      settings.username,
      settings.appPassword,
      settings.replyTo
    ];
  } else if (
    body.action === "send-test"
    || body.action === "discard-pending"
  ) {
    canonicalPayload = [
      body.action,
      assertEmailSettingsGeneration(body.generation)
    ];
  } else if (body.action === "confirm-test") {
    if (typeof body.code !== "string" || !/^[0-9]{6}$/u.test(body.code)) {
      throw new HttpError(400, "invalid_request");
    }
    canonicalPayload = [
      body.action,
      assertEmailSettingsGeneration(body.generation),
      body.code
    ];
  } else if (body.action === "disable") {
    canonicalPayload = [body.action];
  } else if (body.action === "remove") {
    if (!new Set(["active", "pending", "all"]).has(body.target)) {
      throw new HttpError(400, "invalid_request");
    }
    canonicalPayload = [
      body.action,
      body.target,
      body.generation === undefined
        ? ""
        : assertEmailSettingsGeneration(body.generation)
    ];
  } else {
    throw new HttpError(400, "invalid_request");
  }
  return hmacDigest(
    requiredSecret("SHARE_RATE_LIMIT_HMAC_KEY"),
    "quickmemo/secure-share/email-settings-request/v2",
    actorUid,
    JSON.stringify(canonicalPayload)
  );
}

export function adminIdempotencyRequestMatches(
  document,
  {
    action,
    actorUid,
    nowMilliseconds = Date.now(),
    requestHash
  }
) {
  const expiresAt = Date.parse(document?.expiresAt ?? "");
  if (
    document?.schemaVersion !== 1
    || document?.actorUid !== actorUid
    || document?.action !== action
    || !Number.isSafeInteger(nowMilliseconds)
    || nowMilliseconds < 0
    || !Number.isFinite(expiresAt)
    || expiresAt <= nowMilliseconds
    || !requestHashPattern.test(requestHash)
    || !requestHashPattern.test(document?.requestHash ?? "")
  ) {
    return false;
  }
  const expected = Buffer.from(requestHash, "base64url");
  const actual = Buffer.from(document.requestHash, "base64url");
  return timingSafeEqual(expected, actual);
}

export function adminIdempotencyPath(actorUid, action, idempotencyKey) {
  return `secureShareEmailAdminIdempotency/idem_${idempotencyDigest(
    actorUid,
    action,
    assertEmailSettingsIdempotencyKey(idempotencyKey)
  ).slice(0, 48)}`;
}

export function adminIdempotencyWrite(
  context,
  {
    action,
    actorUid,
    generation = "",
    httpStatus = 200,
    idempotencyKey,
    now = new Date(),
    outcome = "success",
    requestHash
  }
) {
  if (!requestHashPattern.test(requestHash)) {
    throw settingsUnavailable();
  }
  return createDocumentWrite(
    context.projectId,
    adminIdempotencyPath(actorUid, action, idempotencyKey),
    {
      schemaVersion: 1,
      actorUid,
      action,
      generation,
      outcome,
      httpStatus,
      requestHash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + adminIdempotencyRetentionMilliseconds)
    }
  );
}

export function adminIdempotencyOutcomeWrite(
  context,
  document,
  outcome,
  httpStatus,
  now = new Date()
) {
  if (
    !document
    || typeof outcome !== "string"
    || !/^[a-z0-9_]{1,80}$/u.test(outcome)
    || !Number.isSafeInteger(httpStatus)
    || httpStatus < 200
    || httpStatus > 599
  ) {
    throw settingsUnavailable();
  }
  return updateDocumentWrite(
    context.projectId,
    `secureShareEmailAdminIdempotency/${document.__id}`,
    { outcome, httpStatus, updatedAt: now },
    ["outcome", "httpStatus", "updatedAt"],
    document.__updateTime
  );
}

export function adminAuditWrite(
  context,
  { action, actorUid, generation = "", requestId, result, now = new Date() }
) {
  const eventId = `evt_${randomToken(18)}`;
  return createDocumentWrite(
    context.projectId,
    `secureShareEmailAdminAudit/${eventId}`,
    {
      schemaVersion: 1,
      actorUid,
      action,
      result,
      generation,
      requestId,
      createdAt: now,
      retentionExpiresAt: new Date(now.getTime() + adminAuditRetentionMilliseconds)
    }
  );
}

export async function priorAdminIdempotency(
  context,
  { action, actorUid, idempotencyKey }
) {
  return firestoreGet(
    context,
    adminIdempotencyPath(actorUid, action, idempotencyKey)
  );
}

export async function consumeEmailSettingsAdminRateLimit(
  context,
  { action, actorUid, now = Date.now() }
) {
  const windowStartSeconds =
    Math.floor(now / 1000 / adminRateLimitWindowSeconds) * adminRateLimitWindowSeconds;
  const bucketId = hmacDigest(
    requiredSecret("SHARE_RATE_LIMIT_HMAC_KEY"),
    "quickmemo/secure-share/email-settings-admin-rate/v1",
    actorUid,
    action,
    windowStartSeconds
  ).slice(0, 48);
  const path = `secureShareEmailAdminRateLimits/rate_${bucketId}`;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const document = await firestoreGet(context, path);
    const count = document?.count ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw settingsUnavailable();
    }
    if (count >= adminRateLimitMaximum) {
      const retryAfter = Math.max(
        1,
        windowStartSeconds + adminRateLimitWindowSeconds - Math.floor(now / 1000)
      );
      throw new HttpError(429, "rate_limited", "Admin email settings rate limit", {
        retryAfter
      });
    }
    const fields = {
      schemaVersion: 1,
      actorUid,
      action,
      windowStart: new Date(windowStartSeconds * 1000),
      count: count + 1,
      updatedAt: new Date(now),
      expiresAt: new Date((windowStartSeconds + 120) * 1000)
    };
    const write = document
      ? updateDocumentWrite(
        context.projectId,
        path,
        fields,
        Object.keys(fields),
        document.__updateTime
      )
      : createDocumentWrite(context.projectId, path, fields);
    try {
      await firestoreCommit(context, [write]);
      return;
    } catch (error) {
      if (!isOptimisticFirestoreConflict(error) || attempt === 5) {
        throw error;
      }
    }
  }
}

function disabledRuntimeSnapshot(reason = "disabled") {
  return Object.freeze({
    ready: false,
    enabled: false,
    generation: "",
    provider: "",
    reason,
    configuration: null,
    environment: null
  });
}

export async function loadSecureShareEmailRuntimeSnapshot(
  context,
  { allowCache = true, environment = process.env } = {}
) {
  if (
    String(environment.SECURE_SHARE_V2_ENABLED ?? "").trim().toLowerCase()
      !== "true"
    || String(environment.SECURE_SHARE_EMAIL_ENABLED ?? "").trim().toLowerCase()
      !== "true"
  ) {
    return disabledRuntimeSnapshot("master_switch_disabled");
  }
  const cached = runtimeCache.get(context.projectId);
  const now = Date.now();
  if (
    allowCache
    && cached
    && cached.expiresAt > now
  ) {
    return cached.snapshot;
  }
  let snapshot = disabledRuntimeSnapshot();
  try {
    const document = await firestoreGet(context, secureShareEmailSettingsPath);
    const active = slotMetadata(document?.active);
    if (
      document?.schemaVersion === settingsSchemaVersion
      && document?.enabled === true
      && active
    ) {
      const decrypted = decryptEmailSettingsSlot(active.encrypted, {
        environment,
        generation: active.generation,
        projectId: context.projectId,
        slot: "active"
      });
      const readiness = secureShareEmailReadiness(decrypted.environment);
      snapshot = Object.freeze({
        ...readiness,
        ready: readiness.ready === true,
        enabled: readiness.ready === true,
        generation: active.generation,
        provider: "gmail_smtp",
        configuration: decrypted.configuration,
        environment: decrypted.environment,
        reason: readiness.ready ? "" : "prerequisite_unavailable"
      });
    } else if (
      String(environment.NODE_ENV ?? "").trim().toLowerCase() === "test"
    ) {
      const readiness = secureShareEmailReadiness(environment);
      if (readiness.ready === true) {
        const provider =
          String(environment.SHARE_EMAIL_PROVIDER ?? "").trim().toLowerCase();
        snapshot = Object.freeze({
          ...readiness,
          ready: true,
          enabled: true,
          generation: "",
          provider,
          configuration: provider === "gmail_smtp"
            ? gmailSmtpConfiguration(environment)
            : {
              fromAddress:
                String(environment.SHARE_EMAIL_FROM ?? "").trim()
            },
          environment,
          reason: "test_environment_fallback"
        });
      }
    }
  } catch {
    snapshot = disabledRuntimeSnapshot("invalid_or_unavailable");
  }
  runtimeCache.set(context.projectId, {
    expiresAt: now + runtimeCacheMilliseconds,
    snapshot
  });
  return snapshot;
}

export function invalidateSecureShareEmailRuntimeCache(projectId = "") {
  if (projectId) {
    runtimeCache.delete(projectId);
    return;
  }
  runtimeCache.clear();
}

export async function safeSecureShareEmailRuntimeSnapshot(
  context,
  options = {}
) {
  try {
    return await loadSecureShareEmailRuntimeSnapshot(context, options);
  } catch {
    return disabledRuntimeSnapshot("invalid_or_unavailable");
  }
}

export function promotedActiveSlot(pending, now = new Date()) {
  const normalized = slotMetadata(pending);
  if (!normalized) {
    throw conflict("Pending Gmail settings are unavailable");
  }
  return {
    generation: normalized.generation,
    encrypted: normalized.encrypted,
    usernameMasked: normalized.usernameMasked,
    replyToMasked: normalized.replyToMasked,
    stagedAt: normalized.stagedAt,
    verifiedAt: now
  };
}

export function activeSlotForProject(
  pending,
  { environment = process.env, projectId }
) {
  const normalized = slotMetadata(pending);
  if (!normalized) {
    throw conflict("Pending Gmail settings are unavailable");
  }
  const decrypted = decryptEmailSettingsSlot(normalized.encrypted, {
    environment,
    generation: normalized.generation,
    projectId,
    slot: "pending"
  });
  return {
    ...promotedActiveSlot(normalized),
    encrypted: encryptEmailSettingsSlot(decrypted.settings, {
      environment,
      generation: normalized.generation,
      projectId,
      slot: "active"
    })
  };
}

export function providerHealthWrite(
  context,
  current,
  generation,
  now = new Date()
) {
  const fields = {
    schemaVersion: 1,
    settingsGeneration: generation,
    status: "healthy",
    consecutiveFailures: 0,
    blockedUntil: undefined,
    lastReasonCode: "",
    lastSuccessfulSendAt: now,
    lastFailureAt: undefined,
    updatedAt: now
  };
  return current
    ? updateDocumentWrite(
      context.projectId,
      secureShareEmailProviderHealthPath,
      fields,
      Object.keys(fields),
      current.__updateTime
    )
    : createDocumentWrite(
      context.projectId,
      secureShareEmailProviderHealthPath,
      fields
    );
}

export function removeProviderHealthWrite(context, current) {
  return current
    ? deleteDocumentWrite(
      context.projectId,
      secureShareEmailProviderHealthPath,
      current.__updateTime
    )
    : null;
}

export function testRequestHash(actorUid, generation, idempotencyKey) {
  return createHmac(
    "sha256",
    requiredSecret("SHARE_RATE_LIMIT_HMAC_KEY")
  ).update(
    Buffer.from(
      `quickmemo/secure-share/email-settings-test-request/v1\u0000${actorUid}`
      + `\u0000${generation}\u0000${idempotencyKey}`,
      "utf8"
    )
  ).digest("hex");
}

export const emailSettingsTestMaximumAttempts = testCodeMaximumAttempts;
