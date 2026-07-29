/* global AbortSignal, Buffer, URL, URLSearchParams, console, fetch, process */

import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt as nodeScrypt,
  sign as signBytes,
  timingSafeEqual
} from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const scryptAsync = promisify(nodeScrypt);
const productionFirestoreBaseUrl = "https://firestore.googleapis.com/v1";
const productionIdentityToolkitBaseUrl = "https://identitytoolkit.googleapis.com/v1";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const databaseId = "(default)";
const maxJsonDepth = 12;
const forbiddenObjectKeys = new Set(["__proto__", "prototype", "constructor"]);
const safeIdentifierPattern = /^[A-Za-z0-9_-]{1,160}$/u;
const safeUnlockAttemptPattern = /^[A-Za-z0-9_-]{16,160}$/u;
const secureShareCookiePath = "/api/public-shares-v2";
const defaultNormalSessionTtlSeconds = 4 * 60 * 60;
const defaultOneTimeSessionTtlSeconds = 30 * 60;
const defaultOneTimeGraceSeconds = 2 * 60;
const defaultOtpTtlSeconds = 10 * 60;
const emailProviderTotalTimeoutMilliseconds = 2_500;

export const secureShareScryptParameters = Object.freeze({
  N: 131_072,
  r: 8,
  p: 2,
  keyLength: 32,
  maxmem: 160 * 1024 * 1024
});

export class HttpError extends Error {
  constructor(statusCode, code, internalMessage = code, options = {}) {
    super(internalMessage);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfter = Number.isInteger(options.retryAfter) ? options.retryAfter : undefined;
    this.expose = options.expose !== false;
    this.deliveryAmbiguous = options.deliveryAmbiguous === true;
    this.upstreamStatus = Number.isInteger(options.upstreamStatus)
      ? options.upstreamStatus
      : undefined;
  }
}

export function envValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function loopbackEmulatorHost(name) {
  const configuredHost = envValue(name);
  if (!configuredHost) {
    return "";
  }
  if (envValue("NODE_ENV") !== "test") {
    throw new HttpError(503, "service_unavailable", `${name} is restricted to the test environment`, {
      expose: false
    });
  }
  let parsed;
  try {
    parsed = new URL(`http://${configuredHost}`);
  } catch {
    throw new HttpError(503, "service_unavailable", `Invalid ${name}`, { expose: false });
  }
  if (
    !new Set(["localhost", "127.0.0.1", "[::1]"]).has(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.protocol !== "http:"
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || !parsed.port
  ) {
    throw new HttpError(503, "service_unavailable", `Unsafe ${name}`, { expose: false });
  }
  return parsed.host;
}

function firestoreApiBaseUrl() {
  const emulatorHost = loopbackEmulatorHost("FIRESTORE_EMULATOR_HOST");
  return emulatorHost ? `http://${emulatorHost}/v1` : productionFirestoreBaseUrl;
}

function identityToolkitApiBaseUrl() {
  const emulatorHost = loopbackEmulatorHost("FIREBASE_AUTH_EMULATOR_HOST");
  return emulatorHost
    ? `http://${emulatorHost}/identitytoolkit.googleapis.com/v1`
    : productionIdentityToolkitBaseUrl;
}

export function exactFeatureFlag(name) {
  return envValue(name).toLowerCase() === "true";
}

export function secureShareV2Enabled() {
  return exactFeatureFlag("SECURE_SHARE_V2_ENABLED");
}

export function secureShareEmailEnabled() {
  return secureShareEmailReadiness().ready;
}

export function secureShareParticipantIdentityEnabled() {
  const requested = secureShareV2Enabled()
    && exactFeatureFlag("SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED");
  if (!requested) {
    return false;
  }
  const participantKey = envValue("SHARE_PARTICIPANT_HMAC_KEY");
  const prohibitedReuse = [
    "SHARE_PASSWORD_PEPPER",
    "SHARE_SESSION_HMAC_KEY",
    "SHARE_COOKIE_NAME_HMAC_KEY",
    "SHARE_CSRF_HMAC_KEY",
    "SHARE_OTP_HMAC_KEY",
    "SHARE_EMAIL_HMAC_KEY",
    "SHARE_RATE_LIMIT_HMAC_KEY"
  ].some((name) => {
    const otherSecret = envValue(name);
    return otherSecret && otherSecret === participantKey;
  });
  if (
    Buffer.byteLength(participantKey, "utf8") < 32
    || prohibitedReuse
  ) {
    throw new HttpError(
      503,
      "service_unavailable",
      "Participant identity secret is unavailable",
      { expose: false }
    );
  }
  return true;
}

export function secureShareCommentIpPrefixEnabled() {
  const requested = secureShareParticipantIdentityEnabled()
    && exactFeatureFlag("SECURE_SHARE_COMMENT_IP_PREFIX_ENABLED");
  if (!requested) {
    return false;
  }
  const networkKey = envValue("SHARE_RATE_LIMIT_HMAC_KEY");
  const prohibitedReuse = [
    "SHARE_PASSWORD_PEPPER",
    "SHARE_SESSION_HMAC_KEY"
  ].some((name) => {
    const otherSecret = envValue(name);
    return otherSecret && otherSecret === networkKey;
  });
  if (
    Buffer.byteLength(networkKey, "utf8") < 32
    || prohibitedReuse
  ) {
    throw new HttpError(
      503,
      "service_unavailable",
      "Network identity secret is unavailable",
      { expose: false }
    );
  }
  return true;
}

function configuredEmailSenderAddress(value) {
  const hasControlCharacter = typeof value === "string"
    && Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    });
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > 320
    || hasControlCharacter
  ) {
    return "";
  }
  const mailbox = /^(?:[^<>]{1,120}<([^<>]+)>|([^<>]+))$/u.exec(value);
  const address = mailbox?.[1] ?? mailbox?.[2] ?? "";
  try {
    const normalized = normalizeEmail(address);
    return normalized === address.trim().normalize("NFKC").toLowerCase()
      ? normalized
      : "";
  } catch {
    return "";
  }
}

function environmentValue(environment, name) {
  const value = environment?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function configuredBoolean(environment, name) {
  return environmentValue(environment, name).toLowerCase() === "true";
}

function configuredBoundedInteger(environment, name, fallback, minimum, maximum) {
  const value = Number.parseInt(environmentValue(environment, name), 10);
  return Number.isSafeInteger(value)
    ? Math.min(Math.max(value, minimum), maximum)
    : fallback;
}

function emailConfigurationError() {
  return new HttpError(
    503,
    "email_feature_unavailable",
    "Gmail SMTP configuration is unavailable",
    { expose: false }
  );
}

export function gmailSmtpConfiguration(environment = process.env) {
  const host = environmentValue(environment, "SHARE_SMTP_HOST").toLowerCase();
  const port = Number.parseInt(environmentValue(environment, "SHARE_SMTP_PORT"), 10);
  const secure = configuredBoolean(environment, "SHARE_SMTP_SECURE");
  const requireTls = configuredBoolean(environment, "SHARE_SMTP_REQUIRE_TLS");
  let username;
  let replyTo = "";
  try {
    username = normalizeEmail(environmentValue(environment, "SHARE_SMTP_USERNAME"));
    const replyToValue = environmentValue(environment, "SHARE_EMAIL_REPLY_TO");
    replyTo = replyToValue ? normalizeEmail(replyToValue) : "";
  } catch {
    throw emailConfigurationError();
  }
  const appPassword = environmentValue(environment, "SHARE_SMTP_APP_PASSWORD");
  const fromAddress = configuredEmailSenderAddress(
    environmentValue(environment, "SHARE_EMAIL_FROM")
  );
  const fromName = environmentValue(environment, "SHARE_EMAIL_FROM_NAME") || "QuickMemo";
  const gmailProvider =
    environmentValue(environment, "SHARE_EMAIL_PROVIDER").toLowerCase() === "gmail_smtp";
  const validTransport =
    host === "smtp.gmail.com"
    && (
      (port === 465 && secure)
      || (port === 587 && !secure && requireTls)
    );
  const validCredentials =
    username.endsWith("@gmail.com")
    && /^[A-Za-z0-9]{16}$/u.test(appPassword);
  const validSender =
    fromName === "QuickMemo"
    && fromAddress === username
    && (!replyTo || !replyTo.endsWith("@quickmemo-tan.vercel.app"));
  if (
    !gmailProvider
    || !validTransport
    || !validCredentials
    || !validSender
    || !configuredBoolean(environment, "SHARE_EMAIL_FREE_TIER_MODE")
  ) {
    throw emailConfigurationError();
  }
  return Object.freeze({
    appPassword,
    connectionTimeout: configuredBoundedInteger(
      environment,
      "SHARE_EMAIL_CONNECTION_TIMEOUT_MS",
      10_000,
      1_000,
      10_000
    ),
    fromAddress,
    fromName,
    greetingTimeout: configuredBoundedInteger(
      environment,
      "SHARE_EMAIL_GREETING_TIMEOUT_MS",
      10_000,
      1_000,
      10_000
    ),
    healthCacheSeconds: configuredBoundedInteger(
      environment,
      "SHARE_EMAIL_PROVIDER_HEALTH_CACHE_SECONDS",
      600,
      30,
      600
    ),
    host,
    port,
    replyTo,
    requireTls,
    secure,
    socketTimeout: configuredBoundedInteger(
      environment,
      "SHARE_EMAIL_SOCKET_TIMEOUT_MS",
      15_000,
      1_000,
      15_000
    ),
    username
  });
}

export function secureShareEmailReadiness(environment = process.env) {
  const v2Enabled = configuredBoolean(environment, "SECURE_SHARE_V2_ENABLED");
  const featureEnabled = configuredBoolean(environment, "SECURE_SHARE_EMAIL_ENABLED");
  const provider = environmentValue(environment, "SHARE_EMAIL_PROVIDER").toLowerCase();
  let providerConfigured = false;
  if (provider === "gmail_smtp") {
    try {
      gmailSmtpConfiguration(environment);
      providerConfigured = true;
    } catch {
      providerConfigured = false;
    }
  } else if (provider === "resend" && environmentValue(environment, "NODE_ENV") === "test") {
    providerConfigured =
      environmentValue(environment, "SHARE_EMAIL_API_KEY").length >= 16
      && Boolean(configuredEmailSenderAddress(environmentValue(environment, "SHARE_EMAIL_FROM")));
  }
  const requiredEmailSecrets = [
    "SHARE_OTP_HMAC_KEY",
    "SHARE_EMAIL_HMAC_KEY",
    "SHARE_RATE_LIMIT_HMAC_KEY"
  ].map((name) => environmentValue(environment, name));
  const secretsConfigured =
    requiredEmailSecrets.every((value) => Buffer.byteLength(value, "utf8") >= 32)
    && new Set(requiredEmailSecrets).size === requiredEmailSecrets.length
    && ![
      "SHARE_PASSWORD_PEPPER",
      "SHARE_SESSION_HMAC_KEY",
      "SHARE_COOKIE_NAME_HMAC_KEY",
      "SHARE_CSRF_HMAC_KEY",
      "SHARE_PARTICIPANT_HMAC_KEY"
    ].map((name) => environmentValue(environment, name))
      .filter(Boolean)
      .some((otherSecret) => requiredEmailSecrets.includes(otherSecret));
  const senderVerified = provider === "gmail_smtp"
    ? providerConfigured
    : configuredBoolean(environment, "SHARE_EMAIL_SENDER_VERIFIED");
  return {
    ready:
      v2Enabled
      && featureEnabled
      && providerConfigured
      && secretsConfigured
      && senderVerified,
    v2Enabled,
    featureEnabled,
    providerConfigured,
    secretsConfigured,
    senderVerified,
    freeTierMode: configuredBoolean(environment, "SHARE_EMAIL_FREE_TIER_MODE")
  };
}

export function requireSecureShareV2() {
  if (!secureShareV2Enabled()) {
    throw new HttpError(404, "not_found", "Secure Share v2 is disabled");
  }
}

export function configuredInteger(name, fallback, minimum, maximum) {
  const value = Number.parseInt(envValue(name), 10);
  if (!Number.isSafeInteger(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, minimum), maximum);
}

export function sessionTtlSeconds(oneTime) {
  return oneTime
    ? configuredInteger(
      "SHARE_ONE_TIME_SESSION_TTL_SECONDS",
      defaultOneTimeSessionTtlSeconds,
      5 * 60,
      60 * 60
    )
    : configuredInteger("SHARE_SESSION_TTL_SECONDS", defaultNormalSessionTtlSeconds, 5 * 60, 24 * 60 * 60);
}

export function oneTimeGraceSeconds() {
  return configuredInteger("SHARE_ONE_TIME_GRACE_SECONDS", defaultOneTimeGraceSeconds, 30, 10 * 60);
}

export function otpTtlSeconds() {
  return configuredInteger("SHARE_OTP_TTL_SECONDS", defaultOtpTtlSeconds, 5 * 60, 15 * 60);
}

export function requiredSecret(name, minimumLength = 32) {
  const value = envValue(name);
  if (Buffer.byteLength(value, "utf8") < minimumLength) {
    throw new HttpError(503, "service_unavailable", `Missing or short ${name}`, { expose: false });
  }
  return value;
}

export function requestId() {
  return randomBytes(16).toString("hex");
}

export function applySecureResponseHeaders(response, id) {
  response.setHeader("cache-control", "no-store, max-age=0");
  response.setHeader("pragma", "no-cache");
  response.setHeader("expires", "0");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader("vary", "Origin, Cookie");
  response.setHeader("x-request-id", id);
}

export function jsonResponse(response, statusCode, body, options = {}) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (Number.isInteger(options.retryAfter)) {
    response.setHeader("retry-after", String(options.retryAfter));
  }
  if (options.setCookies?.length) {
    response.setHeader("set-cookie", options.setCookies);
  }
  if (options.head === true) {
    response.end();
    return;
  }
  response.end(JSON.stringify(body));
}

function errorNumberField(error, fieldName) {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  try {
    const value = error[fieldName];
    return Number.isInteger(value) && value >= 100 && value <= 599
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function safeErrorSummary(error) {
  return {
    kind: error instanceof Error ? "error" : "non_error",
    statusCode: errorNumberField(error, "statusCode"),
    upstreamStatus: errorNumberField(error, "upstreamStatus")
  };
}

export function handleApiError(error, response, id) {
  const operational = error instanceof HttpError;
  const statusCode = operational ? error.statusCode : 500;
  const code = operational && error.expose ? error.code : "request_failed";

  if (!operational || statusCode >= 500) {
    console.error("secure share request failed", { requestId: id, error: safeErrorSummary(error) });
  }

  if (response.headersSent) {
    if (!response.destroyed && typeof response.destroy === "function") {
      response.destroy();
    }
    return;
  }

  jsonResponse(
    response,
    statusCode,
    { ok: false, error: code, requestId: id },
    { retryAfter: operational ? error.retryAfter : undefined }
  );
}

export function headerValue(request, name) {
  const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()] ?? "";
  return Array.isArray(value) ? value[0] ?? "" : typeof value === "string" ? value : "";
}

export function requestUrl(request) {
  return new URL(request.url ?? "/", "https://quickmemo.invalid");
}

export function queryString(url, name, maximumLength = 200) {
  const value = url.searchParams.get(name);
  if (value === null) {
    return "";
  }
  if (value.length > maximumLength) {
    throw new HttpError(400, "invalid_request", `Query field ${name} is too long`);
  }
  return value;
}

export function safeId(value, fieldName = "id") {
  if (typeof value !== "string" || !safeIdentifierPattern.test(value)) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

export function safeUnlockAttemptId(value) {
  if (typeof value !== "string" || !safeUnlockAttemptPattern.test(value)) {
    throw new HttpError(400, "invalid_request", "Invalid unlockAttemptId");
  }
  return value;
}

export function assertOnlyKeys(value, allowedKeys) {
  if (!isPlainRecord(value)) {
    throw new HttpError(400, "invalid_request", "Expected a JSON object");
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new HttpError(400, "invalid_request", "Unknown request field");
  }
}

export function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeJsonTree(value, depth = 0) {
  if (depth > maxJsonDepth) {
    throw new HttpError(400, "invalid_request", "JSON nesting is too deep");
  }
  if (Array.isArray(value)) {
    if (value.length > 500) {
      throw new HttpError(400, "invalid_request", "JSON array is too large");
    }
    value.forEach((item) => assertSafeJsonTree(item, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    if (!isPlainRecord(value)) {
      throw new HttpError(400, "invalid_request", "Unsupported JSON value");
    }
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenObjectKeys.has(key)) {
        throw new HttpError(400, "invalid_request", "Unsafe JSON key");
      }
      assertSafeJsonTree(child, depth + 1);
    }
  }
}

function ensureJsonContentType(request) {
  const contentType = headerValue(request, "content-type").trim();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new HttpError(415, "json_required", "JSON Content-Type is required");
  }
}

export async function readJsonBody(request, maximumBytes = 2 * 1024 * 1024) {
  ensureJsonContentType(request);
  const declaredLength = Number.parseInt(headerValue(request, "content-length"), 10);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new HttpError(413, "request_too_large", "JSON body exceeds the limit");
  }

  let parsed;
  try {
    if (request.body !== undefined && request.body !== null) {
      if (Buffer.isBuffer(request.body)) {
        if (request.body.byteLength > maximumBytes) {
          throw new HttpError(413, "request_too_large");
        }
        parsed = JSON.parse(request.body.toString("utf8"));
      } else if (typeof request.body === "string") {
        if (Buffer.byteLength(request.body, "utf8") > maximumBytes) {
          throw new HttpError(413, "request_too_large");
        }
        parsed = JSON.parse(request.body);
      } else {
        const serialized = JSON.stringify(request.body);
        if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
          throw new HttpError(413, "request_too_large");
        }
        parsed = request.body;
      }
    } else {
      const chunks = [];
      let total = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > maximumBytes) {
          throw new HttpError(413, "request_too_large");
        }
        chunks.push(buffer);
      }
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "invalid_request", "Malformed JSON body");
  }

  assertSafeJsonTree(parsed);
  if (!isPlainRecord(parsed)) {
    throw new HttpError(400, "invalid_request", "Expected a JSON object");
  }
  return parsed;
}

function normalizedOrigin(value) {
  if (typeof value !== "string" || !value || value.length > 300) {
    return "";
  }
  try {
    const parsed = new URL(value);
    if (
      !new Set(["http:", "https:"]).has(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function requestHostOrigin(request) {
  const forwardedHost = headerValue(request, "x-forwarded-host") || headerValue(request, "host");
  if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::[0-9]{1,5})?$/u.test(forwardedHost)) {
    return "";
  }
  const forwardedProtocol = headerValue(request, "x-forwarded-proto").split(",")[0]?.trim();
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/u.test(forwardedHost);
  return normalizedOrigin(`${local && forwardedProtocol !== "https" ? "http" : "https"}://${forwardedHost}`);
}

function configuredOrigins(request) {
  const origins = new Set();
  const add = (candidate) => {
    const origin = normalizedOrigin(candidate);
    if (origin) {
      origins.add(origin);
    }
  };

  for (const candidate of envValue("SECURE_SHARE_ALLOWED_ORIGINS").split(",")) {
    add(candidate.trim());
  }
  for (const name of ["VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"]) {
    const host = envValue(name);
    if (/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(host)) {
      add(`https://${host}`);
    }
  }
  const localOrigin = requestHostOrigin(request);
  if (/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/u.test(localOrigin)) {
    add(localOrigin);
  }
  return origins;
}

export function ensureSameOrigin(request) {
  const origin = normalizedOrigin(headerValue(request, "origin"));
  if (!origin || !configuredOrigins(request).has(origin)) {
    throw new HttpError(403, "request_rejected", "Origin is not allowed");
  }
  const fetchSite = headerValue(request, "sec-fetch-site").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    throw new HttpError(403, "request_rejected", "Cross-site request rejected");
  }
}

export function authorizationToken(request) {
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,10000})$/u.exec(headerValue(request, "authorization"));
  return match?.[1] ?? "";
}

export function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

export function base64UrlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new HttpError(400, "invalid_request", "Invalid base64url value");
  }
  return Buffer.from(value, "base64url");
}

export function randomToken(byteLength = 32) {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new TypeError("Invalid token byte length");
  }
  return randomBytes(byteLength).toString("base64url");
}

function lengthPrefixedHmacInput(purpose, values) {
  const parts = [purpose, ...values].map((value) => Buffer.from(String(value), "utf8"));
  const encoded = [];
  for (const part of parts) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(part.byteLength);
    encoded.push(length, part);
  }
  return Buffer.concat(encoded);
}

export function hmacDigest(secret, purpose, ...values) {
  return createHmac("sha256", secret).update(lengthPrefixedHmacInput(purpose, values)).digest("base64url");
}

export function sha256Digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("base64url");
}

export function constantTimeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function emailDigest(normalizedEmail, secret = requiredSecret("SHARE_EMAIL_HMAC_KEY")) {
  return hmacDigest(secret, "quickmemo/secure-share/email/v1", normalizedEmail);
}

export function identityDigest(identityType, identityValue, secret = requiredSecret("SHARE_SESSION_HMAC_KEY")) {
  return hmacDigest(secret, "quickmemo/secure-share/identity/v1", identityType, identityValue);
}

export function sessionTokenDigest(token, secret = requiredSecret("SHARE_SESSION_HMAC_KEY")) {
  return hmacDigest(secret, "quickmemo/secure-share/session/v1", token);
}

export function csrfTokenDigest(token, sessionDigest, secret = requiredSecret("SHARE_CSRF_HMAC_KEY")) {
  return hmacDigest(secret, "quickmemo/secure-share/csrf/v1", sessionDigest, token);
}

export function unlockAttemptDigest(
  shareId,
  unlockAttemptId,
  identityHash,
  secret = requiredSecret("SHARE_SESSION_HMAC_KEY")
) {
  return hmacDigest(secret, "quickmemo/secure-share/unlock-attempt/v1", shareId, unlockAttemptId, identityHash);
}

export function otpCodeDigest(
  challengeId,
  shareId,
  emailHash,
  code,
  secret = requiredSecret("SHARE_OTP_HMAC_KEY")
) {
  return hmacDigest(secret, "quickmemo/secure-share/otp/v1", challengeId, shareId, emailHash, code);
}

export function rateLimitBucketDigest(
  limitType,
  keyParts,
  secret = requiredSecret("SHARE_RATE_LIMIT_HMAC_KEY")
) {
  return hmacDigest(secret, "quickmemo/secure-share/rate-limit/v1", limitType, ...keyParts);
}

export function normalizeEmail(value) {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_email", "Email must be a string");
  }
  const trimmed = value.trim();
  const hasForbiddenCharacter = [...trimmed].some((character) => {
    const codePoint = character.codePointAt(0);
    return /\s/u.test(character)
      || codePoint <= 31
      || codePoint === 127
      || "<>()[],;:\\\"".includes(character);
  });
  if (
    !trimmed
    || Buffer.byteLength(trimmed, "utf8") > 254
    || hasForbiddenCharacter
  ) {
    throw new HttpError(400, "invalid_email", "Email is invalid");
  }
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0 || separator !== trimmed.indexOf("@") || separator === trimmed.length - 1) {
    throw new HttpError(400, "invalid_email", "Email is invalid");
  }
  const local = trimmed.slice(0, separator).toLowerCase();
  const rawDomain = trimmed.slice(separator + 1);
  const asciiDomain = domainToASCII(rawDomain.toLowerCase());
  if (
    !local
    || Array.from(local).length > 64
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
    || !/^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+$/u.test(local)
    || ["/", "\\", ":", "%", "?", "#", "[", "]"].some((character) => rawDomain.includes(character))
    || !asciiDomain
    || asciiDomain.length > 253
    || asciiDomain.split(".").some((label) => !/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/u.test(label))
    || !asciiDomain.includes(".")
  ) {
    throw new HttpError(400, "invalid_email", "Email is invalid");
  }
  return `${local}@${asciiDomain}`;
}

export function normalizeAllowedEmails(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    throw new HttpError(400, "invalid_email_list", "Allowed emails must contain 1 to 100 items");
  }
  const unique = new Set(values.map((value) => normalizeEmail(value)));
  if (unique.size < 1 || unique.size > 100) {
    throw new HttpError(400, "invalid_email_list");
  }
  return [...unique].sort();
}

function passwordLength(password) {
  return typeof password === "string" ? Array.from(password).length : -1;
}

export function validateSharePassword(password) {
  const length = passwordLength(password);
  if (length < 8 || length > 128 || Buffer.byteLength(password, "utf8") > 512) {
    throw new HttpError(400, "invalid_password", "Password must contain 8 to 128 characters");
  }
  return password;
}

function passwordMaterial(password, pepper) {
  return createHmac("sha256", pepper)
    .update(lengthPrefixedHmacInput("quickmemo/secure-share/password-material/v1", [password]))
    .digest();
}

export async function hashSharePassword(
  password,
  pepper = requiredSecret("SHARE_PASSWORD_PEPPER"),
  pepperVersion = envValue("SHARE_PASSWORD_PEPPER_VERSION") || "1"
) {
  validateSharePassword(password);
  const salt = randomBytes(16);
  const digest = await scryptAsync(passwordMaterial(password, pepper), salt, secureShareScryptParameters.keyLength, {
    N: secureShareScryptParameters.N,
    r: secureShareScryptParameters.r,
    p: secureShareScryptParameters.p,
    maxmem: secureShareScryptParameters.maxmem
  });
  return {
    algorithm: "scrypt",
    hashVersion: 1,
    pepperVersion,
    parameters: {
      N: secureShareScryptParameters.N,
      r: secureShareScryptParameters.r,
      p: secureShareScryptParameters.p,
      keyLength: secureShareScryptParameters.keyLength
    },
    salt: salt.toString("base64url"),
    digest: Buffer.from(digest).toString("base64url")
  };
}

function validPasswordHashRecord(record) {
  return isPlainRecord(record)
    && record.algorithm === "scrypt"
    && record.hashVersion === 1
    && typeof record.pepperVersion === "string"
    && record.pepperVersion.length >= 1
    && record.pepperVersion.length <= 32
    && isPlainRecord(record.parameters)
    && record.parameters.N === secureShareScryptParameters.N
    && record.parameters.r === secureShareScryptParameters.r
    && record.parameters.p === secureShareScryptParameters.p
    && record.parameters.keyLength === secureShareScryptParameters.keyLength
    && typeof record.salt === "string"
    && /^[A-Za-z0-9_-]{20,64}$/u.test(record.salt)
    && typeof record.digest === "string"
    && /^[A-Za-z0-9_-]{40,64}$/u.test(record.digest);
}

export async function verifySharePassword(
  password,
  record,
  pepper = requiredSecret("SHARE_PASSWORD_PEPPER"),
  currentPepperVersion = envValue("SHARE_PASSWORD_PEPPER_VERSION") || "1"
) {
  if (
    passwordLength(password) < 8
    || passwordLength(password) > 128
    || !validPasswordHashRecord(record)
    || record.pepperVersion !== currentPepperVersion
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(record.salt, "base64url");
    const expected = Buffer.from(record.digest, "base64url");
    if (salt.byteLength !== 16 || expected.byteLength !== secureShareScryptParameters.keyLength) {
      return false;
    }
    const actual = Buffer.from(await scryptAsync(
      passwordMaterial(password, pepper),
      salt,
      secureShareScryptParameters.keyLength,
      {
        N: secureShareScryptParameters.N,
        r: secureShareScryptParameters.r,
        p: secureShareScryptParameters.p,
        maxmem: secureShareScryptParameters.maxmem
      }
    ));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function generateOtpCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function parseCookies(request) {
  const result = new Map();
  for (const part of headerValue(request, "cookie").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) && value.length <= 2048) {
      result.set(name, value);
    }
  }
  return result;
}

function cookieSuffix(shareId) {
  return hmacDigest(
    requiredSecret("SHARE_COOKIE_NAME_HMAC_KEY"),
    "quickmemo/secure-share/cookie-name/v1",
    shareId
  ).slice(0, 24);
}

function isProductionRequest(request) {
  const host = headerValue(request, "x-forwarded-host") || headerValue(request, "host");
  return !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/u.test(host);
}

export function sessionCookieName(shareId, request) {
  return `${isProductionRequest(request) ? "__Secure-" : ""}qmss_${cookieSuffix(shareId)}`;
}

export function browserBindingCookieName(shareId, request) {
  return `${isProductionRequest(request) ? "__Secure-" : ""}qmsb_${cookieSuffix(shareId)}`;
}

export function participantCookieName(shareId, request) {
  return `${isProductionRequest(request) ? "__Secure-" : ""}qmsp_${cookieSuffix(shareId)}`;
}

function cookieHeader(name, value, request, maxAgeSeconds, httpOnly = true) {
  const parts = [
    `${name}=${value}`,
    `Path=${secureShareCookiePath}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "SameSite=Lax"
  ];
  if (httpOnly) {
    parts.push("HttpOnly");
  }
  if (isProductionRequest(request)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function sessionCookie(request, shareId, token, maxAgeSeconds) {
  return cookieHeader(sessionCookieName(shareId, request), token, request, maxAgeSeconds);
}

export function clearSessionCookie(request, shareId) {
  return cookieHeader(sessionCookieName(shareId, request), "", request, 0);
}

export function browserBindingCookie(request, shareId, token, maxAgeSeconds = 24 * 60 * 60) {
  return cookieHeader(browserBindingCookieName(shareId, request), token, request, maxAgeSeconds);
}

export function participantCookie(
  request,
  shareId,
  token,
  maxAgeSeconds = 365 * 24 * 60 * 60
) {
  return cookieHeader(participantCookieName(shareId, request), token, request, maxAgeSeconds);
}

export function sessionTokenFromRequest(request, shareId) {
  const token = parseCookies(request).get(sessionCookieName(shareId, request)) ?? "";
  return /^[A-Za-z0-9_-]{40,200}$/u.test(token) ? token : "";
}

export function browserBindingFromRequest(request, shareId) {
  const token = parseCookies(request).get(browserBindingCookieName(shareId, request)) ?? "";
  return /^[A-Za-z0-9_-]{40,200}$/u.test(token) ? token : "";
}

export function participantTokenFromRequest(request, shareId) {
  const token = parseCookies(request).get(participantCookieName(shareId, request)) ?? "";
  return /^[A-Za-z0-9_-]{40,200}$/u.test(token) ? token : "";
}

export function requireCsrf(request, session) {
  const token = headerValue(request, "x-csrf-token");
  if (
    !/^[A-Za-z0-9_-]{40,200}$/u.test(token)
    || typeof session.csrfDigest !== "string"
    || !constantTimeStringEqual(csrfTokenDigest(token, session.__sessionDigest), session.csrfDigest)
  ) {
    throw new HttpError(403, "request_rejected", "CSRF validation failed");
  }
}

function parseJsonCredential(value) {
  if (!value) {
    return {};
  }
  const trimmed = value.trim();
  const json = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  return JSON.parse(json);
}

export function firebaseManagementCredentials() {
  let credentialJson;
  try {
    credentialJson = parseJsonCredential(envValue("FIREBASE_CLEANUP_SERVICE_ACCOUNT_JSON"));
  } catch {
    throw new HttpError(503, "service_unavailable", "Invalid management credentials", { expose: false });
  }
  const clientEmail = envValue("FIREBASE_CLEANUP_CLIENT_EMAIL") || credentialJson.client_email || "";
  const privateKey = (envValue("FIREBASE_CLEANUP_PRIVATE_KEY") || credentialJson.private_key || "")
    .replace(/\\n/gu, "\n");
  const projectId =
    envValue("FIREBASE_CLEANUP_PROJECT_ID")
    || credentialJson.project_id
    || envValue("VITE_FIREBASE_PROJECT_ID")
    || envValue("GOOGLE_CLOUD_PROJECT");
  if (!clientEmail || !privateKey || !projectId) {
    throw new HttpError(503, "service_unavailable", "Missing management credentials", { expose: false });
  }
  return { clientEmail, privateKey, projectId };
}

function firebaseWebApiKey() {
  const key = envValue("VITE_FIREBASE_API_KEY") || envValue("FIREBASE_API_KEY");
  if (!key) {
    throw new HttpError(503, "service_unavailable", "Missing Firebase web API key", { expose: false });
  }
  return key;
}

let accessTokenCache = null;

export async function fetchFirebaseManagementAccessToken(credentials) {
  const now = Date.now();
  if (
    accessTokenCache
    && accessTokenCache.projectId === credentials.projectId
    && accessTokenCache.clientEmail === credentials.clientEmail
    && accessTokenCache.expiresAt > now + 60_000
  ) {
    return accessTokenCache.token;
  }

  const nowSeconds = Math.floor(now / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncode(JSON.stringify({
    iss: credentials.clientEmail,
    scope: cloudPlatformScope,
    aud: oauthTokenUrl,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  }));
  const unsignedJwt = `${header}.${claims}`;
  const signature = signBytes("RSA-SHA256", Buffer.from(unsignedJwt), credentials.privateKey).toString("base64url");
  const response = await fetch(oauthTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsignedJwt}.${signature}`
    }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) {
    throw new HttpError(503, "service_unavailable", `OAuth request failed (${response.status})`, { expose: false });
  }
  const payload = await response.json();
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new HttpError(503, "service_unavailable", "OAuth response lacked a token", { expose: false });
  }
  accessTokenCache = {
    projectId: credentials.projectId,
    clientEmail: credentials.clientEmail,
    token: payload.access_token,
    expiresAt: now + Math.max(60, Number(payload.expires_in) || 3600) * 1000
  };
  return payload.access_token;
}

export async function createFirestoreContext() {
  if (loopbackEmulatorHost("FIRESTORE_EMULATOR_HOST")) {
    const projectId =
      envValue("GCLOUD_PROJECT")
      || envValue("FIREBASE_CLEANUP_PROJECT_ID")
      || envValue("VITE_FIREBASE_PROJECT_ID");
    if (!/^[a-z][a-z0-9-]{4,29}$/u.test(projectId)) {
      throw new HttpError(503, "service_unavailable", "Missing emulator project id", {
        expose: false
      });
    }
    return { projectId, accessToken: "owner" };
  }
  const credentials = firebaseManagementCredentials();
  const accessToken = await fetchFirebaseManagementAccessToken(credentials);
  return { projectId: credentials.projectId, accessToken };
}

export async function verifySecureShareAppCheck(request, context) {
  const configuredMode = envValue("FIREBASE_APP_CHECK_ENFORCEMENT").toLowerCase() || "off";
  if (!new Set(["off", "monitor", "enforce"]).has(configuredMode)) {
    throw new HttpError(503, "service_unavailable", "Invalid App Check enforcement mode", { expose: false });
  }
  if (configuredMode === "off") {
    return { enforced: false, valid: null };
  }
  const enforce = configuredMode === "enforce";
  const token = headerValue(request, "x-firebase-appcheck");
  const projectNumber = envValue("FIREBASE_APP_CHECK_PROJECT_NUMBER");

  if (!token) {
    if (enforce) {
      throw new HttpError(401, "request_rejected", "App Check token is required");
    }
    console.warn("secure share App Check monitor", { result: "missing_token" });
    return { enforced: false, valid: null };
  }
  if (!/^[A-Za-z0-9._~-]{100,10000}$/u.test(token)) {
    if (enforce) {
      throw new HttpError(401, "request_rejected", "Malformed App Check token");
    }
    console.warn("secure share App Check monitor", { result: "malformed_token" });
    return { enforced: false, valid: false };
  }
  if (!/^[0-9]{6,24}$/u.test(projectNumber)) {
    if (enforce) {
      throw new HttpError(503, "service_unavailable", "Missing App Check project number", { expose: false });
    }
    console.warn("secure share App Check monitor", { result: "missing_project_number" });
    return { enforced: false, valid: null };
  }

  try {
    const response = await fetch(
      `https://firebaseappcheck.googleapis.com/v1beta/projects/${encodeURIComponent(projectNumber)}:verifyAppCheckToken`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${context.accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ appCheckToken: token }),
        signal: AbortSignal.timeout(8_000)
      }
    );
    if (!response.ok) {
      if (enforce) {
        throw new HttpError(401, "request_rejected", `App Check verification failed (${response.status})`);
      }
      console.warn("secure share App Check monitor", { result: "invalid_token", statusCode: response.status });
      return { enforced: false, valid: false };
    }
    await response.json();
    return { enforced: enforce, valid: true };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (enforce) {
      throw new HttpError(503, "service_unavailable", "App Check verification unavailable", { expose: false });
    }
    console.warn("secure share App Check monitor", { result: "verification_unavailable" });
    return { enforced: false, valid: null };
  }
}

function documentsRoot(projectId) {
  return `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents`;
}

export function firestoreDocumentName(projectId, documentPath) {
  return `projects/${projectId}/databases/${databaseId}/documents/${documentPath}`;
}

function encodeDocumentPath(documentPath) {
  return documentPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

async function firestoreFetch(context, path, init = {}) {
  const response = await fetch(`${firestoreApiBaseUrl()}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${context.accessToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    },
    signal: init.signal ?? AbortSignal.timeout(10_000)
  });
  return response;
}

async function upstreamError(message, response) {
  let upstreamCode = "";
  try {
    const payload = await response.json();
    upstreamCode = typeof payload?.error?.status === "string"
      ? payload.error.status
      : "";
  } catch {
    // Normalize only the status code; never surface the upstream response body.
  }
  const error = new Error(message);
  error.name = "UpstreamError";
  error.statusCode = response.status;
  error.upstreamCode = upstreamCode;
  error.upstreamStatus = response.status;
  return error;
}

export function toFirestoreValue(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError("Invalid date");
    }
    return { timestampValue: value.toISOString() };
  }
  if (value === null) {
    return { nullValue: null };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Invalid number");
    }
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { bytesValue: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) {
    return value.length
      ? { arrayValue: { values: value.map((item) => toFirestoreValue(item)) } }
      : { arrayValue: {} };
  }
  if (isPlainRecord(value)) {
    return { mapValue: { fields: toFirestoreFields(value) } };
  }
  throw new TypeError("Unsupported Firestore value");
}

export function toFirestoreFields(value) {
  const fields = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      continue;
    }
    if (forbiddenObjectKeys.has(key) || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key)) {
      throw new TypeError("Invalid Firestore field name");
    }
    fields[key] = toFirestoreValue(child);
  }
  return fields;
}

export function fromFirestoreValue(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(value, "stringValue")) {
    return value.stringValue;
  }
  if (Object.prototype.hasOwnProperty.call(value, "booleanValue")) {
    return value.booleanValue;
  }
  if (Object.prototype.hasOwnProperty.call(value, "integerValue")) {
    const parsed = Number.parseInt(value.integerValue, 10);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  if (Object.prototype.hasOwnProperty.call(value, "doubleValue")) {
    return value.doubleValue;
  }
  if (Object.prototype.hasOwnProperty.call(value, "timestampValue")) {
    return value.timestampValue;
  }
  if (Object.prototype.hasOwnProperty.call(value, "bytesValue")) {
    return value.bytesValue;
  }
  if (Object.prototype.hasOwnProperty.call(value, "referenceValue")) {
    return value.referenceValue;
  }
  if (Object.prototype.hasOwnProperty.call(value, "nullValue")) {
    return null;
  }
  if (value.arrayValue) {
    return (value.arrayValue.values ?? []).map((item) => fromFirestoreValue(item));
  }
  if (value.mapValue) {
    return fromFirestoreFields(value.mapValue.fields ?? {});
  }
  return undefined;
}

export function fromFirestoreFields(fields) {
  const result = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    result[key] = fromFirestoreValue(value);
  }
  return result;
}

export function decodeFirestoreDocument(document) {
  if (!document?.name || !document?.fields) {
    return null;
  }
  const decoded = fromFirestoreFields(document.fields);
  decoded.__name = document.name;
  decoded.__updateTime = document.updateTime ?? "";
  decoded.__createTime = document.createTime ?? "";
  decoded.__id = document.name.split("/").pop() ?? "";
  return decoded;
}

export async function firestoreGet(context, documentPath) {
  const response = await firestoreFetch(
    context,
    `${documentsRoot(context.projectId)}/${encodeDocumentPath(documentPath)}`
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await upstreamError("Firestore read failed", response);
  }
  return decodeFirestoreDocument(await response.json());
}

export async function firestoreBatchGet(context, documentPaths) {
  if (
    !Array.isArray(documentPaths)
    || documentPaths.length < 1
    || documentPaths.length > 100
  ) {
    throw new TypeError("A bounded Firestore read set is required");
  }
  const response = await firestoreFetch(
    context,
    `${documentsRoot(context.projectId)}:batchGet`,
    {
      method: "POST",
      body: JSON.stringify({
        documents: documentPaths.map((documentPath) =>
          firestoreDocumentName(context.projectId, documentPath)
        )
      })
    }
  );
  if (!response.ok) {
    throw await upstreamError("Firestore batch read failed", response);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) {
    throw new Error("Firestore batch read returned an invalid response");
  }
  const documentsByName = new Map(
    rows
      .filter((row) => row?.found?.name)
      .map((row) => [row.found.name, decodeFirestoreDocument(row.found)])
  );
  return documentPaths.map((documentPath) =>
    documentsByName.get(firestoreDocumentName(context.projectId, documentPath)) ?? null
  );
}

export async function firestoreCommit(context, writes, transaction = "") {
  const response = await firestoreFetch(context, `${documentsRoot(context.projectId)}:commit`, {
    method: "POST",
    body: JSON.stringify({
      writes,
      ...(transaction ? { transaction } : {})
    })
  });
  if (!response.ok) {
    throw await upstreamError("Firestore commit failed", response);
  }
  return response.json();
}

export async function firestoreBatchGetNewTransaction(context, documentPaths) {
  if (
    !Array.isArray(documentPaths)
    || documentPaths.length < 1
    || documentPaths.length > 100
  ) {
    throw new TypeError("A bounded transaction read set is required");
  }
  const response = await firestoreFetch(
    context,
    `${documentsRoot(context.projectId)}:batchGet`,
    {
      method: "POST",
      body: JSON.stringify({
        documents: documentPaths.map((documentPath) =>
          firestoreDocumentName(context.projectId, documentPath)
        ),
        newTransaction: { readWrite: {} }
      })
    }
  );
  if (!response.ok) {
    throw await upstreamError("Firestore transaction read failed", response);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) {
    throw new Error("Firestore transaction read returned an invalid response");
  }
  const transaction = rows.find((row) => typeof row?.transaction === "string")
    ?.transaction ?? "";
  if (!/^[A-Za-z0-9+/=_-]{8,4096}$/u.test(transaction)) {
    throw new Error("Firestore transaction read omitted its transaction token");
  }
  const documentsByName = new Map(
    rows
      .filter((row) => row?.found?.name)
      .map((row) => [row.found.name, decodeFirestoreDocument(row.found)])
  );
  return {
    documents: documentPaths.map((documentPath) =>
      documentsByName.get(firestoreDocumentName(context.projectId, documentPath)) ?? null
    ),
    transaction
  };
}

export async function firestoreRollback(context, transaction) {
  if (!/^[A-Za-z0-9+/=_-]{8,4096}$/u.test(transaction)) {
    throw new TypeError("A valid Firestore transaction token is required");
  }
  const response = await firestoreFetch(
    context,
    `${documentsRoot(context.projectId)}:rollback`,
    {
      method: "POST",
      body: JSON.stringify({ transaction })
    }
  );
  if (!response.ok) {
    throw await upstreamError("Firestore rollback failed", response);
  }
}

export async function firestoreRunQuery(
  context,
  structuredQuery,
  parentPath = "",
  transaction = ""
) {
  const queryParent = parentPath
    ? `${documentsRoot(context.projectId)}/${encodeDocumentPath(parentPath)}`
    : documentsRoot(context.projectId);
  const response = await firestoreFetch(context, `${queryParent}:runQuery`, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery,
      ...(transaction ? { transaction } : {})
    })
  });
  if (!response.ok) {
    throw await upstreamError("Firestore query failed", response);
  }
  const rows = await response.json();
  return rows.map((row) => decodeFirestoreDocument(row.document)).filter(Boolean);
}

export async function firestoreListCollection(context, parentPath, collectionId, pageSize = 100) {
  const base = parentPath
    ? `${documentsRoot(context.projectId)}/${encodeDocumentPath(parentPath)}/${encodeURIComponent(collectionId)}`
    : `${documentsRoot(context.projectId)}/${encodeURIComponent(collectionId)}`;
  const response = await firestoreFetch(context, `${base}?pageSize=${Math.min(Math.max(pageSize, 1), 300)}`);
  if (!response.ok) {
    throw await upstreamError("Firestore list failed", response);
  }
  const payload = await response.json();
  return (payload.documents ?? []).map((document) => decodeFirestoreDocument(document)).filter(Boolean);
}

export function createDocumentWrite(projectId, documentPath, fields) {
  return {
    update: {
      name: firestoreDocumentName(projectId, documentPath),
      fields: toFirestoreFields(fields)
    },
    currentDocument: { exists: false }
  };
}

export function updateDocumentWrite(projectId, documentPath, fields, fieldPaths, updateTime) {
  if (!updateTime) {
    throw new TypeError("An update precondition is required");
  }
  return {
    update: {
      name: firestoreDocumentName(projectId, documentPath),
      fields: toFirestoreFields(fields)
    },
    updateMask: { fieldPaths: [...new Set(fieldPaths)] },
    currentDocument: { updateTime }
  };
}

export function deleteDocumentWrite(projectId, documentPath, updateTime) {
  return {
    delete: firestoreDocumentName(projectId, documentPath),
    currentDocument: updateTime ? { updateTime } : { exists: true }
  };
}

export function firestoreStringValue(value) {
  return { stringValue: value };
}

export function firestoreIntegerValue(value) {
  return { integerValue: String(value) };
}

export function firestoreTimestampValue(value) {
  return { timestampValue: value instanceof Date ? value.toISOString() : value };
}

export function firestoreReferenceValue(value) {
  return { referenceValue: value };
}

export async function lookupFirebaseCaller(idToken) {
  if (!idToken) {
    return null;
  }
  const response = await fetch(
    `${identityToolkitApiBaseUrl()}/accounts:lookup?key=${encodeURIComponent(firebaseWebApiKey())}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
      signal: AbortSignal.timeout(8_000)
    }
  );
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      return null;
    }
    throw await upstreamError("Identity lookup failed", response);
  }
  const user = (await response.json()).users?.[0];
  if (typeof user?.localId !== "string" || !user.localId || user.disabled === true) {
    return null;
  }
  const providerIds = (user.providerUserInfo ?? [])
    .map((provider) => provider?.providerId)
    .filter((providerId) => typeof providerId === "string");
  const email = typeof user.email === "string" && user.email ? normalizeEmail(user.email) : "";
  return {
    uid: user.localId,
    email,
    emailVerified: user.emailVerified === true,
    displayName: typeof user.displayName === "string" ? user.displayName.slice(0, 80) : "",
    providerIds,
    isAnonymous: !email && providerIds.length === 0
  };
}

function profileHasNotesAccess(profile) {
  if (profile?.isAdmin === true) {
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(profile ?? {}, "featureAccess")) {
    return true;
  }
  const features = profile?.featureAccess;
  return isPlainRecord(features) && features.notes === true;
}

export async function activeUserFromRequest(request, context = null, options = {}) {
  const idToken = authorizationToken(request);
  if (!idToken) {
    if (options.optional) {
      return null;
    }
    throw new HttpError(401, "authentication_required");
  }
  const caller = await lookupFirebaseCaller(idToken);
  if (!caller || caller.isAnonymous) {
    throw new HttpError(401, "authentication_required", "Invalid or anonymous caller");
  }
  const firestoreContext = context ?? await createFirestoreContext();
  const profile = await firestoreGet(firestoreContext, `users/${safeId(caller.uid, "uid")}`);
  if (!profile || profile.isActive !== true || !profileHasNotesAccess(profile)) {
    throw new HttpError(403, "access_denied", "Inactive user or notes access denied");
  }
  return {
    ...caller,
    isAdmin: profile.isAdmin === true,
    profileDisplayName: typeof profile.displayName === "string" ? profile.displayName.slice(0, 80) : "",
    context: firestoreContext
  };
}

function parsedPublicIpv4(value) {
  if (isIP(value) !== 4) {
    return null;
  }
  const octets = value.split(".").map((part) => Number.parseInt(part, 10));
  const [first, second] = octets;
  const reserved = (
    first === 0
    || first === 10
    || first === 127
    || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0)
    || (first === 192 && second === 88)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51)
    || (first === 203 && second === 0)
  );
  return reserved ? null : octets;
}

function expandedIpv6(value) {
  if (isIP(value) !== 6 || value.includes("%")) {
    return null;
  }
  let normalized = value.toLowerCase();
  const ipv4Match = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(normalized);
  if (ipv4Match) {
    const ipv4 = ipv4Match[1];
    if (isIP(ipv4) !== 4) {
      return null;
    }
    const octets = ipv4.split(".").map((part) => Number.parseInt(part, 10));
    const replacement = `${((octets[0] << 8) | octets[1]).toString(16)}:`
      + `${((octets[2] << 8) | octets[3]).toString(16)}`;
    normalized = `${normalized.slice(0, normalized.length - ipv4.length)}${replacement}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0)
    || (halves.length === 2 && missing < 1)
  ) {
    return null;
  }
  const groups = [
    ...left,
    ...Array.from({ length: Math.max(0, missing) }, () => "0"),
    ...right
  ].map((group) => Number.parseInt(group || "0", 16));
  return groups.length === 8 && groups.every((group) =>
    Number.isSafeInteger(group) && group >= 0 && group <= 0xffff
  )
    ? groups
    : null;
}

export function publicIpPrefix(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 128) {
    return null;
  }
  const candidate = value.trim();
  const directIpv4 = parsedPublicIpv4(candidate);
  if (directIpv4) {
    return `${directIpv4[0]}.${directIpv4[1]}`;
  }
  const groups = expandedIpv6(candidate);
  if (!groups) {
    return null;
  }
  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0)
    && groups[5] === 0xffff;
  if (ipv4Mapped) {
    const mapped = [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff
    ].join(".");
    const mappedIpv4 = parsedPublicIpv4(mapped);
    return mappedIpv4 ? `${mappedIpv4[0]}.${mappedIpv4[1]}` : null;
  }
  const first = groups[0];
  const second = groups[1];
  const allZero = groups.every((group) => group === 0);
  const reserved = (
    allZero
    || (first & 0xe000) !== 0x2000
    || (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1)
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xffc0) === 0xfec0
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && second === 0x0002 && groups[2] === 0)
    || (first === 0x2001 && second === 0x0db8)
    || (first === 0x3fff && (second & 0xf000) === 0)
  );
  if (reserved) {
    return null;
  }
  return `${first.toString(16)}:${second.toString(16)}`;
}

function trustedClientNetworkValues(request) {
  const injected = process.env.NODE_ENV === "test"
    && typeof request?.secureShareTestClientIp === "string"
    ? request.secureShareTestClientIp.trim()
    : "";
  const managedForwarded = process.env.VERCEL === "1"
    ? headerValue(request, "x-vercel-forwarded-for")
    : "";
  const singleForwarded = managedForwarded && !managedForwarded.includes(",")
    ? managedForwarded.trim()
    : "";
  const directAddress = typeof request?.socket?.remoteAddress === "string"
    ? request.socket.remoteAddress.trim()
    : "";
  const digestCandidate =
    injected
    || singleForwarded
    || directAddress
    || "unknown";
  return {
    digestCandidate,
    prefixCandidate: injected || singleForwarded || ""
  };
}

export function clientNetworkIdentity(request) {
  const values = trustedClientNetworkValues(request);
  return {
    digest: hmacDigest(
      requiredSecret("SHARE_RATE_LIMIT_HMAC_KEY"),
      "quickmemo/secure-share/network/v1",
      values.digestCandidate.slice(0, 128)
    ),
    prefix: publicIpPrefix(values.prefixCandidate)
  };
}

export function clientIpPrefix(request) {
  return publicIpPrefix(trustedClientNetworkValues(request).prefixCandidate);
}

export function clientNetworkDigest(request) {
  return clientNetworkIdentity(request).digest;
}

export function userAgentDigest(request) {
  return hmacDigest(
    requiredSecret("SHARE_RATE_LIMIT_HMAC_KEY"),
    "quickmemo/secure-share/user-agent/v1",
    headerValue(request, "user-agent").slice(0, 512)
  );
}

export function verificationEmailText(code, ttlSeconds) {
  if (
    typeof code !== "string"
    || !/^\d{6}$/u.test(code)
    || !Number.isSafeInteger(ttlSeconds)
    || ttlSeconds < 1
  ) {
    throw new HttpError(500, "internal_error", "Invalid verification email input", { expose: false });
  }
  const validity = ttlSeconds % 60 === 0
    ? `${ttlSeconds / 60}분`
    : `${ttlSeconds}초`;
  return [
    "QuickMemo 공유 노트를 열기 위한 인증번호입니다.",
    "",
    `인증번호: ${code}`,
    "",
    `이 인증번호는 ${validity} 동안 유효합니다.`,
    "본인이 요청하지 않았다면 이 메일을 무시하세요.",
    "",
    "서비스 주소:",
    "https://quickmemo-tan.vercel.app"
  ].join("\n");
}

export function createResendEmailAdapter(
  request = fetch,
  wait = delay,
  beforeAttempt = async () => undefined
) {
  const send = async ({
    from,
    idempotencyKey,
    text,
    timeoutMilliseconds = emailProviderTotalTimeoutMilliseconds,
    to
  }) => {
    const boundedTimeoutMilliseconds =
      Number.isSafeInteger(timeoutMilliseconds)
      && timeoutMilliseconds >= 1
      && timeoutMilliseconds <= emailProviderTotalTimeoutMilliseconds
        ? timeoutMilliseconds
        : emailProviderTotalTimeoutMilliseconds;
    const startedAt = Date.now();
    let lastStatus = 0;
    let mayHaveBeenAccepted = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let remainingMilliseconds =
        boundedTimeoutMilliseconds - (Date.now() - startedAt);
      if (remainingMilliseconds <= 0) {
        break;
      }
      try {
        await beforeAttempt();
      } catch (error) {
        if (error instanceof HttpError) {
          error.deliveryAmbiguous =
            error.deliveryAmbiguous || mayHaveBeenAccepted;
          throw error;
        }
        throw new HttpError(
          503,
          "email_feature_unavailable",
          "Email provider request gate failed",
          {
            deliveryAmbiguous: mayHaveBeenAccepted,
            expose: false
          }
        );
      }
      remainingMilliseconds =
        boundedTimeoutMilliseconds - (Date.now() - startedAt);
      if (remainingMilliseconds <= 0) {
        break;
      }
      try {
        const response = await request("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${envValue("SHARE_EMAIL_API_KEY")}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            "user-agent": "QuickMemo-Secure-Share/2"
          },
          body: JSON.stringify({
            from,
            to: [to],
            subject: "QuickMemo 공유 노트 인증번호",
            text
          }),
          signal: AbortSignal.timeout(remainingMilliseconds)
        });
        if (response.ok) {
          let payload;
          try {
            payload = await response.json();
          } catch {
            throw new HttpError(
              503,
              "email_feature_unavailable",
              "Email provider returned malformed success",
              {
                deliveryAmbiguous: true,
                expose: false,
                upstreamStatus: response.status
              }
            );
          }
          if (
            typeof payload?.id !== "string"
            || !/^[A-Za-z0-9_-]{8,160}$/u.test(payload.id)
          ) {
            throw new HttpError(
              503,
              "email_feature_unavailable",
              "Email provider success lacked a valid message id",
              {
                deliveryAmbiguous: true,
                expose: false,
                upstreamStatus: response.status
              }
            );
          }
          return { accepted: true, messageId: payload.id };
        }
        lastStatus = response.status;
        let providerErrorName = "";
        if (response.status === 409) {
          try {
            const payload = await response.json();
            const candidate = payload?.name ?? payload?.error?.name ?? payload?.error?.code;
            providerErrorName = typeof candidate === "string" ? candidate : "";
          } catch {
            // An unknown 409 is delivery-ambiguous; never expose the provider body.
          }
        }
        const concurrentIdempotentRequest =
          response.status === 409
          && providerErrorName === "concurrent_idempotent_requests";
        const invalidIdempotentRequest =
          response.status === 409
          && providerErrorName === "invalid_idempotent_request";
        if (
          response.status >= 500
          || (
            response.status === 409
            && !invalidIdempotentRequest
          )
        ) {
          mayHaveBeenAccepted = true;
        }
        if (
          attempt === 0
          && (
            response.status === 429
            || response.status >= 500
            || concurrentIdempotentRequest
            || (response.status === 409 && !providerErrorName)
          )
        ) {
          const retryDelayMilliseconds = 100 + randomInt(0, 101);
          if (
            Date.now() - startedAt + retryDelayMilliseconds
            < boundedTimeoutMilliseconds
          ) {
            await wait(retryDelayMilliseconds);
            continue;
          }
        }
        break;
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        mayHaveBeenAccepted = true;
        if (attempt === 0 && error instanceof Error && error.name !== "AbortError") {
          const retryDelayMilliseconds = 100 + randomInt(0, 101);
          if (
            Date.now() - startedAt + retryDelayMilliseconds
            < boundedTimeoutMilliseconds
          ) {
            await wait(retryDelayMilliseconds);
            continue;
          }
        }
        throw new HttpError(503, "email_feature_unavailable", "Email provider request failed", {
          deliveryAmbiguous: mayHaveBeenAccepted,
          expose: false
        });
      }
    }
    throw new HttpError(
      503,
      "email_feature_unavailable",
      `Email provider rejected request (${lastStatus || "unknown"})`,
      {
        deliveryAmbiguous: mayHaveBeenAccepted,
        expose: false,
        upstreamStatus: lastStatus || undefined
      }
    );
  };
  return {
    send,
    async healthCheck({ from, idempotencyKey, to }) {
      return send({
        from,
        idempotencyKey,
        text: "QuickMemo Secure Share 이메일 제공자 상태 확인 메시지입니다.",
        to
      });
    }
  };
}

export async function sendVerificationEmail(
  to,
  code,
  ttlSeconds,
  idempotencyKey,
  adapter,
  timeoutMilliseconds = emailProviderTotalTimeoutMilliseconds
) {
  if (!secureShareEmailEnabled()) {
    throw new HttpError(503, "email_feature_unavailable", "Email delivery is disabled");
  }
  if (
    typeof idempotencyKey !== "string"
    || !/^[A-Za-z0-9_-]{16,200}$/u.test(idempotencyKey)
    || !adapter
    || typeof adapter.send !== "function"
  ) {
    throw new HttpError(500, "internal_error", "Invalid email idempotency key", {
      expose: false
    });
  }
  return adapter.send({
    from: envValue("SHARE_EMAIL_FROM"),
    idempotencyKey,
    text: verificationEmailText(code, ttlSeconds),
    timeoutMilliseconds,
    to: normalizeEmail(to)
  });
}

export function signedOpaqueToken(
  payload,
  purpose,
  ttlSeconds,
  secret = requiredSecret("SHARE_SESSION_HMAC_KEY"),
  now = Math.floor(Date.now() / 1000)
) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("A valid token issue time is required");
  }
  const body = base64UrlEncode(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const signature = hmacDigest(secret, purpose, body);
  return `${body}.${signature}`;
}

export function verifySignedOpaqueToken(
  token,
  purpose,
  secret = requiredSecret("SHARE_SESSION_HMAC_KEY"),
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  if (typeof token !== "string" || token.length < 40 || token.length > 2048) {
    return null;
  }
  const parts = token.split(".");
  if (
    parts.length !== 2
    || !/^[A-Za-z0-9_-]+$/u.test(parts[0])
    || !/^[A-Za-z0-9_-]{40,64}$/u.test(parts[1])
    || !constantTimeStringEqual(hmacDigest(secret, purpose, parts[0]), parts[1])
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (
      !isPlainRecord(payload)
      || !Number.isSafeInteger(payload.iat)
      || !Number.isSafeInteger(payload.exp)
      || payload.iat > nowSeconds + 60
      || payload.exp <= nowSeconds
      || payload.exp - payload.iat > 15 * 60
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function cleanDocumentMetadata(document) {
  if (!document) {
    return null;
  }
  const fields = { ...document };
  delete fields.__name;
  delete fields.__updateTime;
  delete fields.__createTime;
  delete fields.__id;
  return fields;
}
