/* global AbortSignal, Buffer, URL, URLSearchParams, console, crypto, fetch, process */

import { del, get, head } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  attachmentReadyAction,
  canDeleteNoteAttachmentPolicy,
  canReadNoteAttachmentPolicy,
  canUploadNoteAttachmentPolicy,
  isValidEncryptedFileNamePayload,
  noteGenericAttachmentBaseName,
  publicAttachmentSourceAvailablePolicy,
  publicShareGenericAttachmentBaseName,
  quotaReleaseAfterAttachmentClaim,
  shouldBumpAttachmentRevisionOnDelete,
  shouldRetainPendingDeletionReservation
} from "./_attachment-policy.js";
import {
  storedBlobMetadataMatchesAttachment,
  streamedBlobMetadataMatchesAttachment
} from "./_blob-download-policy.js";
import {
  GLOBAL_BLOB_USAGE_DOCUMENT_PATH,
  GLOBAL_BLOB_USAGE_SCHEMA_VERSION,
  evaluateFreeTierUpload,
  resolveFreeTierPolicy
} from "./_free-tier-policy.js";
import {
  sourceAttachmentFingerprintMatches,
  validSourceAttachmentFingerprint
} from "./_secure-share-attachment-reuse.js";
import {
  NOTE_ATTACHMENT_COUNT_LIMIT,
  NOTE_ATTACHMENT_COUNTER_ENFORCEMENT_VERSION,
  NOTE_ATTACHMENT_COUNTER_SCHEMA_VERSION,
  NOTE_ATTACHMENT_ROLLOUT_DRAIN_ACTIVE,
  noteAttachmentCounterName,
  noteAttachmentCounterPath,
  noteAttachmentCounterState,
  noteAttachmentCounterWrite,
  noteReadyAttachmentCountTransition
} from "./_note-attachment-counter.js";
import {
  clientNetworkDigest,
  rateLimitBucketDigest
} from "./_secure-share-common.js";

const firestoreBaseUrl = "https://firestore.googleapis.com/v1";
const identityToolkitBaseUrl = "https://identitytoolkit.googleapis.com/v1";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const storageBaseUrl = "https://storage.googleapis.com/storage/v1";
const databaseId = "(default)";
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const blobContentType = "application/octet-stream";
const maxAttachmentFileMegabytes = 150;
const maxAttachmentFileBytes = maxAttachmentFileMegabytes * 1024 * 1024;
const maxAttachmentFileLabel = `${maxAttachmentFileMegabytes}MB`;
const encryptedAttachmentOverheadBytes = 16;
const maxEncryptedAttachmentBytes = maxAttachmentFileBytes + encryptedAttachmentOverheadBytes;
const encryptedAttachmentChunkSizeBytes = 4 * 1024 * 1024;
const maxEncryptedAttachmentChunkCount = Math.ceil(maxAttachmentFileBytes / encryptedAttachmentChunkSizeBytes);
const maxChunkedEncryptedAttachmentBytes = maxAttachmentFileBytes + maxEncryptedAttachmentChunkCount * encryptedAttachmentOverheadBytes;
const userBlobAttachmentQuotaBytes = 1024 * 1024 * 1024;
const userBlobAttachmentCountLimit = 500;
const attachmentCountPolicyVersion = 1;
const oauthRequestTimeoutMs = 8_000;
const accessTokenRefreshSkewMs = 60_000;
const tokenTtlMs = 10 * 60 * 1000;
const pendingDeletionGraceMs = tokenTtlMs + 60 * 1000;
const reservationGraceMs = 60 * 1000;
const reservationTtlMs = tokenTtlMs + reservationGraceMs;
const userPendingAttachmentCountLimit = 20;
const userPendingAttachmentBytesLimit = 300 * 1024 * 1024;
const opportunisticReservationCleanupLimit = 3;
const opportunisticReservationScanLimit = 20;
const attachmentRateLimitTransactionMaximumAttempts = 3;
const attachmentReservationBurstLimit = 60;
const attachmentReservationBurstWindowSeconds = 10 * 60;
const attachmentMutationLimit = 120;
const attachmentMutationWindowSeconds = 10 * 60;
const attachmentPublicDownloadUnitBytes = 10 * 1024 * 1024;
const attachmentPublicDownloadUnitLimit = 60;
const attachmentAuthenticatedDownloadUnitLimit = 180;
const attachmentDownloadWindowSeconds = 10 * 60;
const blobAttachmentAbuseProtectionProductionDefault = true;
const secureShareLiveContentSyncServerProductionDefault = true;
const secureShareCopyCleanupClaimIdField = "secureShareCopyCleanupClaimId";
const secureShareCopyCleanupClaimedAtField = "secureShareCopyCleanupClaimedAt";
const allowedAttachmentExtensions = new Set([
  "pdf",
  "txt",
  "md",
  "csv",
  "json",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "hwp",
  "hwpx",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "zip"
]);
const publicShareAttachmentMimeTypes = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  hwp: "application/x-hwp",
  hwpx: "application/vnd.hancom.hwpx",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip"
};
let cachedAccessToken = null;
let pendingAccessTokenRequest = null;

class HttpError extends Error {
  constructor(statusCode, publicMessage, internalMessage = publicMessage, options = {}) {
    super(internalMessage);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    this.retryAfter = Number.isSafeInteger(options.retryAfter) && options.retryAfter > 0
      ? options.retryAfter
      : undefined;
  }
}

function envValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function applyAttachmentResponseHeaders(response) {
  response.setHeader("cache-control", "no-store, max-age=0");
  response.setHeader("pragma", "no-cache");
  response.setHeader("expires", "0");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
}

function jsonResponse(response, statusCode, body, options = {}) {
  response.statusCode = statusCode;
  applyAttachmentResponseHeaders(response);
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (Number.isSafeInteger(options.retryAfter) && options.retryAfter > 0) {
    response.setHeader("retry-after", String(options.retryAfter));
  }
  response.end(JSON.stringify(body));
}

function requestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

function durationBucket(milliseconds) {
  if (milliseconds < 100) return "lt_100ms";
  if (milliseconds < 500) return "lt_500ms";
  if (milliseconds < 2_000) return "lt_2s";
  if (milliseconds < 10_000) return "lt_10s";
  return "gte_10s";
}

function attachmentSizeBucket(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return "unknown";
  if (bytes <= 1024 * 1024) return "lte_1mb";
  if (bytes <= 10 * 1024 * 1024) return "lte_10mb";
  if (bytes <= 50 * 1024 * 1024) return "lte_50mb";
  if (bytes <= 100 * 1024 * 1024) return "lte_100mb";
  return "lte_150mb";
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
    status: errorNumberField(error, "status"),
    statusCode: errorNumberField(error, "statusCode")
  };
}

function parseJsonCredential(value) {
  if (!value) {
    return {};
  }

  const trimmed = value.trim();
  const json = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  return JSON.parse(json);
}

function firebaseCredentials() {
  const credentialJson = parseJsonCredential(envValue("FIREBASE_CLEANUP_SERVICE_ACCOUNT_JSON"));
  const clientEmail = envValue("FIREBASE_CLEANUP_CLIENT_EMAIL") || credentialJson.client_email || "";
  const privateKey = (envValue("FIREBASE_CLEANUP_PRIVATE_KEY") || credentialJson.private_key || "").replace(/\\n/g, "\n");
  const projectId =
    envValue("FIREBASE_CLEANUP_PROJECT_ID")
    || credentialJson.project_id
    || envValue("VITE_FIREBASE_PROJECT_ID")
    || envValue("GOOGLE_CLOUD_PROJECT");

  if (!clientEmail || !privateKey || !projectId) {
    throw new HttpError(503, "첨부파일 서버 설정이 완료되지 않았습니다.", "Missing Firebase management credentials");
  }

  return {
    clientEmail,
    privateKey,
    projectId,
    storageBucket:
      envValue("FIREBASE_STORAGE_BUCKET")
      || envValue("VITE_FIREBASE_STORAGE_BUCKET")
      || credentialJson.storage_bucket
      || `${projectId}.appspot.com`
  };
}

function firebaseWebApiKey() {
  return envValue("VITE_FIREBASE_API_KEY") || envValue("FIREBASE_API_KEY");
}

function ensureBlobConfigured() {
  if (!envValue("BLOB_READ_WRITE_TOKEN") && !envValue("VERCEL_OIDC_TOKEN")) {
    throw new HttpError(503, "첨부파일 Blob 저장소 설정이 완료되지 않았습니다.", "Missing Vercel Blob credentials");
  }
}

function authToken(request) {
  const header = request.headers.authorization || request.headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/iu.exec(Array.isArray(header) ? header[0] ?? "" : header);

  return match?.[1] ?? "";
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function privateKeyDer(privateKey) {
  const base64 = privateKey
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/gu, "");

  return Buffer.from(base64, "base64");
}

async function signJwt(privateKey, unsignedJwt) {
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyDer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, Buffer.from(unsignedJwt));

  return base64UrlEncode(Buffer.from(signature));
}

function accessTokenCacheKey(credentials) {
  return `${credentials.projectId}\u0000${credentials.clientEmail}`;
}

async function requestAccessToken(credentials) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncode(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: cloudPlatformScope,
      aud: oauthTokenUrl,
      iat: nowSeconds,
      exp: nowSeconds + 3600
    })
  );
  const unsignedJwt = `${header}.${claims}`;
  const assertion = `${unsignedJwt}.${await signJwt(credentials.privateKey, unsignedJwt)}`;
  const response = await fetch(oauthTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    }),
    signal: AbortSignal.timeout(oauthRequestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`OAuth token request failed with status ${response.status}`);
  }

  const token = await response.json();
  const expiresInSeconds = Number(token.expires_in);

  if (
    typeof token.access_token !== "string"
    || !token.access_token
    || !Number.isFinite(expiresInSeconds)
    || expiresInSeconds < 60
    || expiresInSeconds > 7_200
  ) {
    throw new Error("OAuth token response was invalid");
  }

  return {
    accessToken: token.access_token,
    expiresAt: Date.now() + expiresInSeconds * 1000
  };
}

async function fetchAccessToken(credentials) {
  const cacheKey = accessTokenCacheKey(credentials);
  const now = Date.now();

  if (
    cachedAccessToken?.cacheKey === cacheKey
    && cachedAccessToken.expiresAt - accessTokenRefreshSkewMs > now
  ) {
    return cachedAccessToken.accessToken;
  }

  if (pendingAccessTokenRequest?.cacheKey === cacheKey) {
    return pendingAccessTokenRequest.promise;
  }

  let requestPromise;
  requestPromise = requestAccessToken(credentials)
    .then(({ accessToken, expiresAt }) => {
      cachedAccessToken = { accessToken, cacheKey, expiresAt };
      return accessToken;
    })
    .finally(() => {
      if (pendingAccessTokenRequest?.promise === requestPromise) {
        pendingAccessTokenRequest = null;
      }
    });
  pendingAccessTokenRequest = { cacheKey, promise: requestPromise };

  return requestPromise;
}

export async function lookupCallerUid(idToken) {
  const apiKey = firebaseWebApiKey();

  if (!apiKey) {
    throw new HttpError(503, "첨부파일 인증 설정이 완료되지 않았습니다.", "Missing Firebase web API key");
  }

  const response = await fetch(`${identityToolkitBaseUrl}/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
    signal: AbortSignal.timeout(oauthRequestTimeoutMs)
  });

  if (!response.ok) {
    return "";
  }

  const result = await response.json();
  const user = result.users?.[0];
  const uid = user?.localId;

  return typeof uid === "string" && user?.disabled !== true ? uid : "";
}

async function readJsonBody(request, maxBytes = 65536) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > maxBytes) {
      throw new HttpError(413, "요청 본문이 너무 큽니다.", "Request body is too large");
    }

    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function encodeDocumentPath(documentPath) {
  return documentPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function documentName(projectId, documentPath) {
  return `projects/${projectId}/databases/${databaseId}/documents/${documentPath}`;
}

async function firestoreRequest(path, accessToken, init = {}) {
  const response = await fetch(`${firestoreBaseUrl}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`Firestore request failed: ${response.status} ${text.slice(0, 300)}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
}

async function firestoreGetDocument(projectId, documentPath, accessToken) {
  const path = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents/${encodeDocumentPath(documentPath)}`;
  const response = await fetch(`${firestoreBaseUrl}/${path}`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Firestore get failed: ${response.status} ${text.slice(0, 300)}`);
  }

  return response.json();
}

async function firestoreListDocuments(projectId, collectionPath, accessToken, pageSize) {
  const query = new URLSearchParams({
    pageSize: String(pageSize),
    "mask.fieldPaths": "noteId"
  });
  return firestoreRequest(
    `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents/${encodeDocumentPath(collectionPath)}?${query.toString()}`,
    accessToken
  );
}

async function firestoreListDocumentsWithFields(
  projectId,
  collectionPath,
  accessToken,
  pageSize,
  fieldPaths = []
) {
  const query = new URLSearchParams({ pageSize: String(pageSize) });
  for (const fieldPath of fieldPaths) {
    query.append("mask.fieldPaths", fieldPath);
  }
  return firestoreRequest(
    `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents/${encodeDocumentPath(collectionPath)}?${query.toString()}`,
    accessToken
  );
}

async function firestoreCommit(projectId, accessToken, writes) {
  return firestoreRequest(
    `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:commit`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({ writes })
    }
  );
}

function stringValue(value) {
  return { stringValue: value };
}

function integerValue(value) {
  return { integerValue: String(value) };
}

function booleanValue(value) {
  return { booleanValue: value };
}

function bytesValue(base64Value) {
  return { bytesValue: base64Value };
}

function bytesArrayValue(base64Values) {
  return { arrayValue: { values: base64Values.map((value) => bytesValue(value)) } };
}

function timestampValue(value) {
  return { timestampValue: value instanceof Date ? value.toISOString() : value };
}

function encryptedPayloadValue(payload) {
  return {
    mapValue: {
      fields: {
        version: integerValue(payload.version),
        algorithm: stringValue(payload.algorithm),
        cipherText: stringValue(payload.cipherText),
        iv: stringValue(payload.iv)
      }
    }
  };
}

function valueString(document, fieldName) {
  const value = document?.fields?.[fieldName]?.stringValue;
  return typeof value === "string" ? value : "";
}

function valueInteger(document, fieldName) {
  const value = document?.fields?.[fieldName]?.integerValue;
  const parsed = typeof value === "string" || typeof value === "number" ? Number.parseInt(String(value), 10) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function valueBoolean(document, fieldName) {
  return document?.fields?.[fieldName]?.booleanValue === true;
}

function valueHasField(document, fieldName) {
  return Boolean(document?.fields && Object.hasOwn(document.fields, fieldName));
}

function valueTimestampMillis(document, fieldName) {
  const value = document?.fields?.[fieldName]?.timestampValue;
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function relativeDocumentPath(document) {
  const marker = "/documents/";
  const name = typeof document?.name === "string" ? document.name : "";
  const markerIndex = name.indexOf(marker);
  return markerIndex >= 0 ? name.slice(markerIndex + marker.length) : "";
}

function attachmentReservationIndexId(attachmentPath) {
  return createHash("sha256")
    .update("quickmemo/attachment-reservation-index/v1\0", "utf8")
    .update(attachmentPath, "utf8")
    .digest("base64url");
}

function attachmentReservationIndexPath(uid, attachmentPath) {
  return `userAttachmentReservations/${uid}/pendingAttachmentReservations/${attachmentReservationIndexId(attachmentPath)}`;
}

export function attachmentRateLimitDecision({
  cost,
  count,
  limit,
  nowMilliseconds,
  windowSeconds
}) {
  if (
    !Number.isSafeInteger(cost)
    || cost < 1
    || !Number.isSafeInteger(count)
    || count < 0
    || !Number.isSafeInteger(limit)
    || limit < 1
    || !Number.isSafeInteger(nowMilliseconds)
    || nowMilliseconds < 0
    || !Number.isSafeInteger(windowSeconds)
    || windowSeconds < 1
  ) {
    throw new Error("Invalid attachment rate limit state");
  }
  const windowStartSeconds = Math.floor(nowMilliseconds / 1000 / windowSeconds) * windowSeconds;
  const retryAfter = Math.max(
    1,
    windowStartSeconds + windowSeconds - Math.floor(nowMilliseconds / 1000)
  );
  return {
    allow: count + cost <= limit,
    nextCount: count + cost,
    retryAfter,
    windowStartSeconds
  };
}

async function consumeAttachmentRateLimit(
  projectId,
  accessToken,
  { cost = 1, keyParts, limit, limitType, windowSeconds }
) {
  if (blobAttachmentAbuseProtectionProductionDefault !== true) {
    throw new HttpError(
      503,
      "첨부파일 요청 보호 설정을 확인할 수 없습니다.",
      "Attachment abuse protection is disabled"
    );
  }
  for (let attempt = 0; attempt < attachmentRateLimitTransactionMaximumAttempts; attempt += 1) {
    const nowMilliseconds = Date.now();
    const windowStartSeconds = Math.floor(nowMilliseconds / 1000 / windowSeconds) * windowSeconds;
    const bucketId = rateLimitBucketDigest(
      `blob_attachment_${limitType}`,
      [...keyParts, String(windowStartSeconds)]
    );
    const path = `attachmentRateLimits/${bucketId}`;
    const document = await firestoreGetDocument(projectId, path, accessToken);
    const hasCount = Boolean(document) && valueHasField(document, "count");
    const count = hasCount ? nonNegativeIntegerField(document, "count") : 0;

    if (count === null || (document && !document.updateTime)) {
      throw new HttpError(
        503,
        "첨부파일 요청 보호 상태를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.",
        "Attachment rate limit state is invalid"
      );
    }

    const decision = attachmentRateLimitDecision({
      cost,
      count,
      limit,
      nowMilliseconds,
      windowSeconds
    });
    if (!decision.allow) {
      throw new HttpError(
        429,
        "첨부파일 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
        "Attachment rate limit exceeded",
        { retryAfter: decision.retryAfter }
      );
    }

    const fields = {
      count: integerValue(decision.nextCount),
      limitType: stringValue(limitType),
      windowStart: timestampValue(new Date(decision.windowStartSeconds * 1000)),
      expiresAt: timestampValue(new Date(
        (decision.windowStartSeconds + windowSeconds * 2) * 1000
      ))
    };
    try {
      await firestoreCommit(projectId, accessToken, [{
        update: {
          name: documentName(projectId, path),
          fields
        },
        currentDocument: document ? { updateTime: document.updateTime } : { exists: false },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      }]);
      return;
    } catch (error) {
      if (![400, 409].includes(error.statusCode) || attempt === attachmentRateLimitTransactionMaximumAttempts - 1) {
        throw error;
      }
    }
  }
}

function valueStringArray(document, fieldName) {
  const values = document?.fields?.[fieldName]?.arrayValue?.values;

  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => value.stringValue).filter((value) => typeof value === "string");
}

function valueBytes(document, fieldName) {
  const value = document?.fields?.[fieldName]?.bytesValue;
  return typeof value === "string" ? value : "";
}

function valueBytesArray(document, fieldName) {
  const values = document?.fields?.[fieldName]?.arrayValue?.values;
  return Array.isArray(values)
    ? values.map((value) => typeof value?.bytesValue === "string" ? value.bytesValue : "")
    : [];
}

function valueEncryptedPayload(document, fieldName) {
  const fields = document?.fields?.[fieldName]?.mapValue?.fields;
  return fields
    ? {
        algorithm: typeof fields.algorithm?.stringValue === "string" ? fields.algorithm.stringValue : "",
        cipherText: typeof fields.cipherText?.stringValue === "string" ? fields.cipherText.stringValue : "",
        iv: typeof fields.iv?.stringValue === "string" ? fields.iv.stringValue : "",
        version: Number(fields.version?.integerValue ?? Number.NaN)
      }
    : null;
}

function safeId(value, fieldName) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/u.test(value)) {
    throw new HttpError(400, "첨부파일 요청 값이 올바르지 않습니다.", `Invalid ${fieldName}`);
  }

  return value;
}

function safeFileName(value) {
  if (typeof value !== "string") {
    throw new HttpError(400, "첨부파일 이름이 올바르지 않습니다.", "Invalid fileName");
  }

  const normalizedValue = value.normalize("NFKC");

  if (
    normalizedValue.length <= 0
    || normalizedValue.length > 100
    || /[<>:"/\\|?*]/u.test(normalizedValue)
    || Array.from(normalizedValue).some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 31
        || (codePoint >= 127 && codePoint <= 159)
        || /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(character);
    })
  ) {
    throw new HttpError(400, "첨부파일 이름이 올바르지 않습니다.", "Invalid fileName");
  }

  return normalizedValue;
}

function safeExtension(value) {
  if (typeof value !== "string" || !allowedAttachmentExtensions.has(value.toLowerCase())) {
    throw new HttpError(400, "허용되지 않는 파일 형식입니다.", "Invalid extension");
  }

  return value.toLowerCase();
}

function safeMimeType(value) {
  if (typeof value !== "string" || value.length > 120) {
    throw new HttpError(400, "첨부파일 MIME 타입이 올바르지 않습니다.", "Invalid mimeType");
  }

  return value || blobContentType;
}

function safeEncryptedFileName(value) {
  if (!isValidEncryptedFileNamePayload(value)) {
    throw new HttpError(400, "첨부파일 이름 암호화 정보가 올바르지 않습니다.", "Invalid encryptedFileName shape");
  }

  return {
    version: 1,
    algorithm: "AES-GCM",
    cipherText: value.cipherText,
    iv: value.iv
  };
}

function safeAttachmentMimeType(extension, mimeType) {
  const normalizedMimeType = safeMimeType(mimeType).trim().toLowerCase();

  if (normalizedMimeType !== publicShareAttachmentMimeTypes[extension]) {
    throw new HttpError(400, "첨부파일 MIME 타입이 확장자와 일치하지 않습니다.", "Attachment MIME/extension mismatch");
  }

  return normalizedMimeType;
}

function canonicalNoteAttachmentMimeType(extension, mimeType) {
  safeMimeType(mimeType);
  const canonicalMimeType = publicShareAttachmentMimeTypes[extension];

  if (!canonicalMimeType) {
    throw new HttpError(400, "허용되지 않는 파일 형식입니다.", "Invalid extension");
  }

  return canonicalMimeType;
}

function safePositiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(400, "첨부파일 크기가 올바르지 않습니다.", `Invalid ${fieldName}`);
  }

  return value;
}

function validateIvBase64(value) {
  if (typeof value !== "string" || Buffer.from(value, "base64").byteLength !== 12) {
    throw new HttpError(400, "첨부파일 암호화 정보가 올바르지 않습니다.", "Invalid ivBase64");
  }

  return value;
}

function validateAttachmentSizes(originalSize, encryptedSize, version, chunkSize, chunkCount) {
  if (originalSize > maxAttachmentFileBytes) {
    throw new HttpError(400, `최대 ${maxAttachmentFileLabel}까지 업로드할 수 있습니다.`, "Invalid attachment size");
  }

  if (version === 1) {
    if (encryptedSize > maxEncryptedAttachmentBytes || encryptedSize !== originalSize + encryptedAttachmentOverheadBytes) {
      throw new HttpError(400, `최대 ${maxAttachmentFileLabel}까지 업로드할 수 있습니다.`, "Invalid attachment size");
    }
    return;
  }

  const expectedChunkCount = Math.ceil(originalSize / encryptedAttachmentChunkSizeBytes);
  const expectedEncryptedSize = originalSize + expectedChunkCount * encryptedAttachmentOverheadBytes;

  if (
    version !== 2
    || chunkSize !== encryptedAttachmentChunkSizeBytes
    || chunkCount !== expectedChunkCount
    || chunkCount <= 0
    || chunkCount > maxEncryptedAttachmentChunkCount
    || encryptedSize !== expectedEncryptedSize
    || encryptedSize > maxChunkedEncryptedAttachmentBytes
  ) {
    throw new HttpError(400, `최대 ${maxAttachmentFileLabel}까지 업로드할 수 있습니다.`, "Invalid chunked attachment size");
  }
}

function safeAttachmentVersion(value) {
  if (value === 2) {
    return 2;
  }

  if (value === undefined || value === null || value === 1) {
    return 1;
  }

  throw new HttpError(400, "첨부파일 암호화 버전이 올바르지 않습니다.", "Invalid attachment version");
}

function safeAttachmentAlgorithm(value, version) {
  const expectedAlgorithm = version === 2 ? "AES-GCM-CHUNKED" : "AES-GCM";

  if (value !== expectedAlgorithm) {
    throw new HttpError(400, "첨부파일 암호화 방식이 올바르지 않습니다.", "Invalid attachment algorithm");
  }

  return expectedAlgorithm;
}

function validateChunkIvBase64List(value, chunkCount) {
  if (!Array.isArray(value) || value.length !== chunkCount) {
    throw new HttpError(400, "첨부파일 chunk 암호화 정보가 올바르지 않습니다.", "Invalid chunk IV count");
  }

  return value.map((ivBase64) => validateIvBase64(ivBase64));
}

function parseClientPayload(clientPayload) {
  if (typeof clientPayload !== "string" || !clientPayload) {
    throw new HttpError(400, "첨부파일 업로드 정보가 없습니다.", "Missing clientPayload");
  }

  const parsed = JSON.parse(clientPayload);
  const scope = parsed.scope === "publicShare" ? "publicShare" : parsed.scope === "note" ? "note" : "";

  if (!scope) {
    throw new HttpError(400, "첨부파일 업로드 범위가 올바르지 않습니다.", "Invalid scope");
  }

  const originalSize = safePositiveInteger(parsed.originalSize, "originalSize");
  const encryptedSize = safePositiveInteger(parsed.encryptedSize, "encryptedSize");
  const version = safeAttachmentVersion(parsed.version);
  const algorithm = safeAttachmentAlgorithm(parsed.algorithm ?? "AES-GCM", version);
  const chunkSize = version === 2 ? safePositiveInteger(parsed.chunkSize, "chunkSize") : 0;
  const chunkCount = version === 2 ? safePositiveInteger(parsed.chunkCount, "chunkCount") : 0;

  validateAttachmentSizes(originalSize, encryptedSize, version, chunkSize, chunkCount);

  const extension = safeExtension(parsed.extension);
  const fileName = safeFileName(parsed.fileName);

  if (
    (scope === "note" && fileName !== noteGenericAttachmentBaseName(extension))
    || (
      scope === "publicShare"
      && fileName !== publicShareGenericAttachmentBaseName(extension)
    )
  ) {
    throw new HttpError(
      400,
      "첨부파일 이름 보호 정보가 올바르지 않습니다.",
      scope === "publicShare"
        ? "Public attachment fileName must be generic"
        : "Note attachment fileName must be generic"
    );
  }
  if (parsed.privacyVersion !== 1) {
    throw new HttpError(
      400,
      "첨부파일 이름 보호 버전이 올바르지 않습니다.",
      "Attachment privacyVersion must be one"
    );
  }

  const sourceAttachmentId =
    scope === "publicShare" && typeof parsed.sourceAttachmentId === "string"
      ? safeId(parsed.sourceAttachmentId, "sourceAttachmentId")
      : "";
  const sourceAttachmentDigest =
    scope === "publicShare" && typeof parsed.sourceAttachmentDigest === "string"
      ? parsed.sourceAttachmentDigest
      : "";
  const sourceEncryptionVersion =
    scope === "publicShare" && Number.isSafeInteger(parsed.sourceEncryptionVersion)
      ? parsed.sourceEncryptionVersion
      : 0;
  const hasSourceFingerprint =
    sourceAttachmentDigest.length > 0 || sourceEncryptionVersion !== 0;

  if (
    hasSourceFingerprint
    && !validSourceAttachmentFingerprint({
      sourceAttachmentId,
      sourceAttachmentDigest,
      sourceEncryptionVersion
    })
  ) {
    throw new HttpError(
      400,
      "공유 첨부파일 원본 지문이 올바르지 않습니다.",
      "Invalid public attachment source fingerprint"
    );
  }

  return {
    scope,
    attachmentId: safeId(parsed.attachmentId, "attachmentId"),
    noteId: scope === "note" ? safeId(parsed.noteId, "noteId") : "",
    shareId: scope === "publicShare" ? safeId(parsed.shareId, "shareId") : "",
    fileName,
    encryptedFileName: safeEncryptedFileName(parsed.encryptedFileName),
    privacyVersion: 1,
    extension,
    mimeType: scope === "publicShare"
      ? safeAttachmentMimeType(extension, parsed.mimeType)
      : canonicalNoteAttachmentMimeType(extension, parsed.mimeType),
    originalSize,
    encryptedSize,
    version,
    algorithm,
    ivBase64: version === 1 ? validateIvBase64(parsed.ivBase64) : "",
    chunkSize,
    chunkCount,
    chunkIvBase64List: version === 2 ? validateChunkIvBase64List(parsed.chunkIvBase64List, chunkCount) : [],
    uploadedBy: scope === "note" ? safeId(parsed.uploadedBy, "uploadedBy") : "",
    secureShareCopyJobId:
      scope === "note" && typeof parsed.secureShareCopyJobId === "string" && parsed.secureShareCopyJobId
        ? safeId(parsed.secureShareCopyJobId, "secureShareCopyJobId")
        : "",
    generation: scope === "publicShare" ? safeId(parsed.generation, "generation") : "",
    sourceAttachmentId,
    sourceAttachmentDigest,
    sourceEncryptionVersion
  };
}

function noteBlobPath(uid, noteId, attachmentId) {
  return `users/${uid}/notes/${noteId}/attachments/${attachmentId}/data`;
}

function publicShareBlobPath(uid, shareId, attachmentId) {
  return `users/${uid}/publicNoteShares/${shareId}/attachments/${attachmentId}/data`;
}

async function userProfile(projectId, uid, accessToken) {
  const document = await firestoreGetDocument(projectId, `users/${uid}`, accessToken);
  return {
    ...userProfileFromDocument(document),
    document
  };
}

function userProfileFromDocument(document) {
  const accountIsActive = valueBoolean(document, "isActive");

  return {
    isActive: accountIsActive && profileHasFeatureAccess(document, "notes"),
    isAdmin: valueBoolean(document, "isAdmin"),
    allowedShareTargetUids: valueStringArray(document, "allowedShareTargetUids")
  };
}

function profileHasFeatureAccess(document, feature) {
  if (!document?.fields) {
    return false;
  }
  if (valueBoolean(document, "isAdmin")) {
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(document.fields, "featureAccess")) {
    return true;
  }

  const accessFields = document.fields.featureAccess?.mapValue?.fields;
  const expectedFeatures = ["notes", "library", "schedule"];

  return Boolean(
    accessFields
    && Object.keys(accessFields).length === expectedFeatures.length
    && expectedFeatures.every((key) => typeof accessFields[key]?.booleanValue === "boolean")
    && accessFields[feature]?.booleanValue === true
  );
}

function noteIsDeleted(note) {
  return valueBoolean(note, "isDeleted");
}

function noteIsPurged(note) {
  return valueBoolean(note, "isPurged");
}

function noteIsActive(note) {
  return !note?.fields?.isDeleted || valueBoolean(note, "isDeleted") === false;
}

function secureShareCopyState(note) {
  return valueString(note, "secureShareCopyState");
}

function secureShareCopyCleanupClaimed(note) {
  return valueHasField(note, secureShareCopyCleanupClaimIdField)
    || valueHasField(note, secureShareCopyCleanupClaimedAtField);
}

async function canReadNote(projectId, uid, note, accessToken) {
  const callerProfile = await userProfile(projectId, uid, accessToken);
  const ownerUid = valueString(note, "ownerUid");
  const participantUids = valueStringArray(note, "participantUids");
  const needsOwnerProfile = callerProfile.isActive
    && !callerProfile.isAdmin
    && ownerUid !== uid
    && !noteIsDeleted(note)
    && !noteIsPurged(note)
    && participantUids.includes(uid);
  const ownerProfile = needsOwnerProfile
    ? await userProfile(projectId, ownerUid, accessToken)
    : { allowedShareTargetUids: [], isActive: false, isAdmin: false };

  return canReadNoteAttachmentPolicy({
    callerIsActive: callerProfile.isActive,
    callerIsAdmin: callerProfile.isAdmin,
    uid,
    ownerUid,
    participantUids,
    noteIsDeleted: noteIsDeleted(note),
    noteIsPurged: noteIsPurged(note),
    ownerIsActive: ownerProfile.isActive,
    ownerIsAdmin: ownerProfile.isAdmin,
    ownerAllowedShareTargetUids: ownerProfile.allowedShareTargetUids
  });
}

async function canUploadToNote(projectId, uid, note, accessToken) {
  return (await noteUploadAuthorization(projectId, uid, note, accessToken)).allowed;
}

async function noteUploadAuthorization(projectId, uid, note, accessToken) {
  const callerProfile = await userProfile(projectId, uid, accessToken);
  const ownerUid = valueString(note, "ownerUid");
  const participantUids = valueStringArray(note, "participantUids");
  const ownerProfile = ownerUid === uid
    ? callerProfile
    : await userProfile(projectId, ownerUid, accessToken);

  return {
    allowed: canUploadNoteAttachmentPolicy({
      callerIsActive: callerProfile.isActive,
      callerIsAdmin: callerProfile.isAdmin,
      uid,
      ownerUid,
      participantUids,
      noteIsDeleted: noteIsDeleted(note),
      noteIsPurged: noteIsPurged(note),
      ownerIsActive: ownerProfile.isActive,
      ownerIsAdmin: ownerProfile.isAdmin,
      ownerAllowedShareTargetUids: ownerProfile.allowedShareTargetUids
    }),
    verifyDocuments: [callerProfile.document, ownerProfile.document].filter(Boolean)
  };
}

function publicShareActive(share, now = Date.now()) {
  const expiresAt = valueTimestampMillis(share, "expiresAt");

  return valueBoolean(share, "ready") && !share?.fields?.revokedAt && Number.isFinite(expiresAt) && expiresAt > now;
}

function publicShareAttachmentIsCurrent(share, attachment) {
  const currentGeneration = valueString(share, "currentGeneration");
  const attachmentGeneration = valueString(attachment, "generation");
  const retainedGenerations = valueStringArray(attachment, "generations");

  return currentGeneration
    ? (
        attachmentGeneration === currentGeneration
        || retainedGenerations.includes(currentGeneration)
      )
    : !attachmentGeneration;
}

function secureShareLiveContentSyncEnabled(
  configuredValue = process.env.SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED
) {
  if (secureShareLiveContentSyncServerProductionDefault !== true) {
    return false;
  }
  return configuredValue === undefined || configuredValue === "true";
}

function publicShareSourceRequiresMatchingRevision(share) {
  return valueInteger(share, "schemaVersion") === 2
    && !secureShareLiveContentSyncEnabled();
}

async function publicShareSourceAvailable(
  projectId,
  share,
  accessToken,
  requireMatchingRevision = publicShareSourceRequiresMatchingRevision(share)
) {
  return (await publicShareSourceAuthorization(
    projectId,
    share,
    accessToken,
    requireMatchingRevision
  )).allowed;
}

async function publicShareSourceAuthorization(
  projectId,
  share,
  accessToken,
  requireMatchingRevision = publicShareSourceRequiresMatchingRevision(share),
  preloadedOwnerProfile = null
) {
  const sourceNoteId = valueString(share, "sourceNoteId");
  const ownerUid = valueString(share, "ownerUid");

  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(sourceNoteId) || !ownerUid) {
    return { allowed: false, sourceNote: null, verifyDocuments: [] };
  }

  const [sourceNote, ownerProfile] = await Promise.all([
    firestoreGetDocument(projectId, `notes/${sourceNoteId}`, accessToken),
    preloadedOwnerProfile
      ? Promise.resolve(preloadedOwnerProfile)
      : userProfile(projectId, ownerUid, accessToken)
  ]);

  return {
    allowed: Boolean(sourceNote)
    && noteIsActive(sourceNote)
    && publicAttachmentSourceAvailablePolicy({
      ownerIsActive: ownerProfile.isActive,
      shareOwnerUid: ownerUid,
      noteOwnerUid: valueString(sourceNote, "ownerUid"),
      noteIsDeleted: noteIsDeleted(sourceNote),
      noteIsPurged: noteIsPurged(sourceNote),
      requireMatchingRevision,
      shareSourceRevision: valueInteger(share, "sourceRevision"),
      noteRevision: valueInteger(sourceNote, "revision"),
      shareSourceAttachmentRevision: valueInteger(share, "sourceAttachmentRevision"),
      noteAttachmentRevision: valueInteger(sourceNote, "attachmentRevision")
    }),
    sourceNote,
    verifyDocuments: [sourceNote, ownerProfile.document].filter(Boolean)
  };
}

async function publicShareSourceActive(projectId, share, accessToken) {
  return publicShareSourceAvailable(projectId, share, accessToken);
}

function nonNegativeIntegerField(document, fieldName) {
  const value = document?.fields?.[fieldName]?.integerValue;
  const parsed = typeof value === "string" || typeof value === "number"
    ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function globalBlobUsage(document) {
  const schemaVersion = nonNegativeIntegerField(document, "schemaVersion");
  const usedBytes = nonNegativeIntegerField(document, "usedBytes");
  const attachmentCount = nonNegativeIntegerField(document, "attachmentCount");

  if (
    !document?.updateTime
    || schemaVersion !== GLOBAL_BLOB_USAGE_SCHEMA_VERSION
    || usedBytes === null
    || attachmentCount === null
  ) {
    return null;
  }

  return {
    attachmentCount,
    updateTime: document.updateTime,
    usedBytes
  };
}

function globalBlobUsageWrite(projectId, usage, nextUsedBytes, nextAttachmentCount, policy, state) {
  return {
    update: {
      name: documentName(projectId, GLOBAL_BLOB_USAGE_DOCUMENT_PATH),
      fields: {
        schemaVersion: integerValue(GLOBAL_BLOB_USAGE_SCHEMA_VERSION),
        attachmentCount: integerValue(nextAttachmentCount),
        usedBytes: integerValue(nextUsedBytes),
        officialCapacityBytes: integerValue(policy.officialCapacityBytes),
        operationalCapBytes: integerValue(policy.operationalCapBytes),
        hardStopBytes: integerValue(policy.hardStopBytes),
        capacityState: stringValue(state),
        accountingMode: stringValue("ready_and_pending_reservations")
      }
    },
    currentDocument: { updateTime: usage.updateTime },
    updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
  };
}

async function currentNoteAttachmentReservationCount(projectId, accessToken, noteId) {
  const result = await firestoreListDocuments(
    projectId,
    `notes/${noteId}/attachments`,
    accessToken,
    NOTE_ATTACHMENT_COUNT_LIMIT
  );
  const documents = Array.isArray(result?.documents) ? result.documents : [];

  // A page token at this bounded read means the collection is at least full.
  return result?.nextPageToken
    ? NOTE_ATTACHMENT_COUNT_LIMIT
    : Math.min(documents.length, NOTE_ATTACHMENT_COUNT_LIMIT);
}

export async function reserveNoteAttachmentCountWrite(projectId, accessToken, noteId) {
  const counterPath = noteAttachmentCounterPath(noteId);
  const counterDocument = await firestoreGetDocument(projectId, counterPath, accessToken);
  const counterState = noteAttachmentCounterState(counterDocument, noteId);

  if (counterState !== "missing" && counterState !== "open") {
    throw new HttpError(
      409,
      "삭제 중이거나 삭제된 노트에는 파일을 첨부할 수 없습니다.",
      "Note attachment counter is closed or invalid"
    );
  }
  // Always recount every metadata document. This keeps legacy or rolling-
  // deployment writers from turning a stale counter into a permissive fast
  // path; the counter document is the CAS mutex for current writers.
  const reservedCount = await currentNoteAttachmentReservationCount(projectId, accessToken, noteId);

  if (
    NOTE_ATTACHMENT_COUNTER_SCHEMA_VERSION >= NOTE_ATTACHMENT_COUNTER_ENFORCEMENT_VERSION
    && reservedCount >= NOTE_ATTACHMENT_COUNT_LIMIT
  ) {
    throw new HttpError(
      413,
      `노트당 파일은 최대 ${NOTE_ATTACHMENT_COUNT_LIMIT}개까지 첨부할 수 있습니다.`,
      "Note attachment count limit exceeded"
    );
  }

  return noteAttachmentCounterWrite({
    counterDocument,
    counterName: noteAttachmentCounterName(projectId, noteId, databaseId),
    noteId,
    reservedCount: Math.min(reservedCount + 1, NOTE_ATTACHMENT_COUNT_LIMIT),
    state: "open"
  });
}

async function reserveUserAttachmentBytes(projectId, accessToken, uid, bytes, extraWrites) {
  const quotaPath = `userAttachmentUsage/${uid}`;
  const policy = resolveFreeTierPolicy(process.env);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [quotaDocument, globalUsageDocument] = await Promise.all([
      firestoreGetDocument(projectId, quotaPath, accessToken),
      policy.enabled
        ? firestoreGetDocument(projectId, GLOBAL_BLOB_USAGE_DOCUMENT_PATH, accessToken)
        : Promise.resolve(null)
    ]);
    const usedBytes = valueInteger(quotaDocument, "usedBytes");
    const attachmentCount = valueInteger(quotaDocument, "attachmentCount");
    const pendingCount = valueHasField(quotaDocument, "pendingCount")
      ? nonNegativeIntegerField(quotaDocument, "pendingCount")
      : 0;
    const pendingBytes = valueHasField(quotaDocument, "pendingBytes")
      ? nonNegativeIntegerField(quotaDocument, "pendingBytes")
      : 0;

    if (pendingCount === null || pendingBytes === null) {
      throw new HttpError(
        503,
        "첨부파일 예약 상태를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.",
        "Attachment pending quota is invalid"
      );
    }

    if (
      !Number.isSafeInteger(bytes)
      || bytes <= 0
      || !Number.isSafeInteger(usedBytes + bytes)
      || usedBytes + bytes > userBlobAttachmentQuotaBytes
    ) {
      throw new HttpError(413, "첨부파일 총 저장 한도 1.00 GB를 초과했습니다.", "Blob attachment quota exceeded");
    }

    if (attachmentCount + 1 > userBlobAttachmentCountLimit) {
      throw new HttpError(413, "첨부파일 저장 개수 한도를 초과했습니다.", "Blob attachment count limit exceeded");
    }

    if (
      pendingCount + 1 > userPendingAttachmentCountLimit
      || !Number.isSafeInteger(pendingBytes + bytes)
      || pendingBytes + bytes > userPendingAttachmentBytesLimit
    ) {
      throw new HttpError(
        429,
        "완료되지 않은 첨부파일 업로드가 많습니다. 잠시 후 다시 시도해주세요.",
        "Pending attachment reservation limit exceeded",
        { retryAfter: Math.ceil(reservationTtlMs / 1000) }
      );
    }

    const quotaWrite = {
      update: {
        name: documentName(projectId, quotaPath),
        fields: {
          uid: stringValue(uid),
          attachmentCount: integerValue(attachmentCount + 1),
          countPolicyVersion: integerValue(attachmentCountPolicyVersion),
          limitCount: integerValue(userBlobAttachmentCountLimit),
          usedBytes: integerValue(usedBytes + bytes),
          limitBytes: integerValue(userBlobAttachmentQuotaBytes),
          pendingCount: integerValue(pendingCount + 1),
          pendingBytes: integerValue(pendingBytes + bytes),
          pendingLimitCount: integerValue(userPendingAttachmentCountLimit),
          pendingLimitBytes: integerValue(userPendingAttachmentBytesLimit)
        }
      },
      currentDocument: quotaDocument ? { updateTime: quotaDocument.updateTime } : { exists: false },
      updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
    };
    let globalWrite = null;
    let globalDecision = null;
    let globalThresholdCrossed = false;

    if (policy.enabled) {
      const usage = globalBlobUsage(globalUsageDocument);
      if (!usage) {
        throw new HttpError(
          503,
          "저장 용량 상태를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.",
          "Global Blob usage counter is missing or invalid"
        );
      }
      globalDecision = evaluateFreeTierUpload({
        usedBytes: usage.usedBytes,
        reservedBytes: 0,
        requestedBytes: bytes
      }, policy);
      if (!globalDecision.allowUpload) {
        throw new HttpError(
          507,
          "저장 용량 보호 한도에 도달했습니다. 기존 첨부파일을 정리한 뒤 다시 시도해주세요.",
          "Global Blob free-tier hard stop"
        );
      }
      globalWrite = globalBlobUsageWrite(
        projectId,
        usage,
        globalDecision.projectedBytes,
        usage.attachmentCount + 1,
        policy,
        globalDecision.state
      );
      const priorGlobalDecision = evaluateFreeTierUpload({
        usedBytes: usage.usedBytes,
        reservedBytes: 0,
        requestedBytes: 0
      }, policy);
      globalThresholdCrossed = (
        globalDecision.warnUser
        && (
          !priorGlobalDecision.warnUser
          || globalDecision.warnAdmin !== priorGlobalDecision.warnAdmin
          || globalDecision.restrictLargeUploads !== priorGlobalDecision.restrictLargeUploads
        )
      );
    }
    const resolvedExtraWrites = typeof extraWrites === "function"
      ? await extraWrites()
      : extraWrites;

    try {
      await firestoreCommit(
        projectId,
        accessToken,
        [quotaWrite, ...(globalWrite ? [globalWrite] : []), ...resolvedExtraWrites]
      );
      if (globalThresholdCrossed) {
        console.warn("blob storage capacity threshold crossed", {
          state: globalDecision.state,
          projectedBytes: globalDecision.projectedBytes,
          hardStopBytes: globalDecision.hardStopBytes,
          adminWarning: globalDecision.warnAdmin
        });
      }
      return;
    } catch (error) {
      if (![400, 409].includes(error.statusCode) || attempt === 2) {
        throw error;
      }
    }
  }
}

async function claimAttachmentDeletion(projectId, accessToken, attachmentPath, extraDeletePaths = []) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attachment = await firestoreGetDocument(projectId, attachmentPath, accessToken);

    if (!attachment) {
      return null;
    }

    const quotaUid = valueString(attachment, "ownerUid") || valueString(attachment, "uploadedBy");
    const encryptedSize = Math.max(0, valueInteger(attachment, "encryptedSize"));
    const quotaPath = quotaUid ? `userAttachmentUsage/${quotaUid}` : "";
    const quotaDocument = quotaPath
      ? await firestoreGetDocument(projectId, quotaPath, accessToken)
      : null;
    const globalUsageDocument = await firestoreGetDocument(
      projectId,
      GLOBAL_BLOB_USAGE_DOCUMENT_PATH,
      accessToken
    );
    const claim = quotaReleaseAfterAttachmentClaim({
      attachmentExists: true,
      attachmentUpdateTime: attachment.updateTime,
      attachmentCount: valueInteger(quotaDocument, "attachmentCount"),
      encryptedSize,
      quotaReserved: valueHasField(attachment, "quotaReserved")
        ? valueBoolean(attachment, "quotaReserved")
        : null,
      legacyBlobReserved:
        !valueHasField(attachment, "quotaReserved")
        && valueString(attachment, "storageProvider") === "vercel-blob"
        && Boolean(valueString(attachment, "blobPath")),
      quotaExists: Boolean(quotaDocument),
      quotaUpdateTime: quotaDocument?.updateTime ?? "",
      uid: quotaUid,
      usedBytes: valueInteger(quotaDocument, "usedBytes")
    });

    if (!claim) {
      return null;
    }

    const pendingReservationTracked = valueBoolean(attachment, "pendingReservationTracked")
      && !valueBoolean(attachment, "isReady");
    const reservationIndexPath = pendingReservationTracked && quotaUid
      ? attachmentReservationIndexPath(quotaUid, attachmentPath)
      : "";
    const resolvedExtraDeletePaths = [...new Set([
      ...extraDeletePaths,
      ...(reservationIndexPath ? [reservationIndexPath] : [])
    ])];

    const writes = [
      {
        delete: documentName(projectId, attachmentPath),
        currentDocument: { updateTime: claim.attachmentUpdateTime }
      },
      ...resolvedExtraDeletePaths.map((path) => ({ delete: documentName(projectId, path) }))
    ];

    if (claim.quota) {
      const currentPendingCount = nonNegativeIntegerField(quotaDocument, "pendingCount");
      const currentPendingBytes = nonNegativeIntegerField(quotaDocument, "pendingBytes");
      const canReleasePending = pendingReservationTracked
        && currentPendingCount !== null
        && currentPendingBytes !== null
        && currentPendingCount >= 1
        && currentPendingBytes >= encryptedSize;
      const nextPendingCount = canReleasePending
        ? currentPendingCount - 1
        : (currentPendingCount ?? 0);
      const nextPendingBytes = canReleasePending
        ? currentPendingBytes - encryptedSize
        : (currentPendingBytes ?? 0);
      writes.push({
        update: {
          name: documentName(projectId, quotaPath),
          fields: {
            uid: stringValue(claim.quota.uid),
            attachmentCount: integerValue(claim.quota.attachmentCount),
            countPolicyVersion: integerValue(attachmentCountPolicyVersion),
            limitCount: integerValue(userBlobAttachmentCountLimit),
            usedBytes: integerValue(claim.quota.usedBytes),
            limitBytes: integerValue(userBlobAttachmentQuotaBytes),
            pendingCount: integerValue(nextPendingCount),
            pendingBytes: integerValue(nextPendingBytes),
            pendingLimitCount: integerValue(userPendingAttachmentCountLimit),
            pendingLimitBytes: integerValue(userPendingAttachmentBytesLimit)
          }
        },
        currentDocument: { updateTime: claim.quota.quotaUpdateTime },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      });
      if (pendingReservationTracked && !canReleasePending) {
        console.warn("attachment pending counter release skipped", {
          reason: "counter_underflow_guard"
        });
      }
    }

    const releaseGlobalUsage = (
      valueHasField(attachment, "quotaReserved")
        ? valueBoolean(attachment, "quotaReserved")
        : (
            valueString(attachment, "storageProvider") === "vercel-blob"
            && Boolean(valueString(attachment, "blobPath"))
          )
    );
    const usage = releaseGlobalUsage ? globalBlobUsage(globalUsageDocument) : null;
    if (
      usage
      && usage.usedBytes >= encryptedSize
      && usage.attachmentCount >= 1
    ) {
      const policy = resolveFreeTierPolicy(process.env);
      const nextUsedBytes = usage.usedBytes - encryptedSize;
      const nextAttachmentCount = usage.attachmentCount - 1;
      const nextDecision = evaluateFreeTierUpload({
        usedBytes: nextUsedBytes,
        reservedBytes: 0,
        requestedBytes: 0
      }, policy);
      writes.push(globalBlobUsageWrite(
        projectId,
        usage,
        nextUsedBytes,
        nextAttachmentCount,
        policy,
        nextDecision.state
      ));
    } else if (usage) {
      console.warn("blob storage counter release skipped", {
        reason: "counter_underflow_guard"
      });
    }

    try {
      await firestoreCommit(projectId, accessToken, writes);
      return attachment;
    } catch (error) {
      if (![400, 409].includes(error.statusCode)) {
        throw error;
      }

      if (attempt === 2) {
        const remainingAttachment = await firestoreGetDocument(projectId, attachmentPath, accessToken);

        if (!remainingAttachment) {
          return null;
        }

        throw new HttpError(
          409,
          "첨부파일 정리가 다른 작업과 충돌했습니다. 다시 시도해주세요.",
          "Attachment deletion claim conflict"
        );
      }
    }
  }

  return null;
}

function attachmentBaseFields(payload, blobPath) {
  const fields = {
    version: integerValue(payload.version),
    algorithm: stringValue(payload.algorithm),
    fileName: stringValue(payload.fileName),
    encryptedFileName: encryptedPayloadValue(payload.encryptedFileName),
    privacyVersion: integerValue(1),
    extension: stringValue(payload.extension),
    mimeType: stringValue(payload.mimeType),
    originalSize: integerValue(payload.originalSize),
    encryptedSize: integerValue(payload.encryptedSize),
    storageProvider: stringValue("vercel-blob"),
    blobPath: stringValue(blobPath),
    isReady: booleanValue(false),
    quotaReserved: booleanValue(true),
    pendingReservationTracked: booleanValue(true),
    reservationExpiresAt: timestampValue(new Date(Date.now() + reservationTtlMs).toISOString())
  };

  if (payload.version === 1) {
    fields.iv = bytesValue(payload.ivBase64);
  } else {
    fields.chunkSize = integerValue(payload.chunkSize);
    fields.chunkCount = integerValue(payload.chunkCount);
    fields.chunkIvs = bytesArrayValue(payload.chunkIvBase64List);
  }

  return fields;
}

function reservationIndexWrite(projectId, uid, attachmentPath, blobPath, encryptedSize, expiresAt) {
  const indexPath = attachmentReservationIndexPath(uid, attachmentPath);
  return {
    update: {
      name: documentName(projectId, indexPath),
      fields: {
        attachmentPath: stringValue(attachmentPath),
        blobPath: stringValue(blobPath),
        encryptedSize: integerValue(encryptedSize),
        reservationExpiresAt: expiresAt
      }
    },
    currentDocument: { exists: false },
    updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]
  };
}

function reservationMatchesPayload(attachment, payload, expectedPath, uid, scope) {
  const encryptedFileName = valueEncryptedPayload(attachment, "encryptedFileName");
  const baseMatches = Boolean(attachment)
    && !valueBoolean(attachment, "isReady")
    && !valueBoolean(attachment, "deletionStarted")
    && !valueHasField(attachment, "deletionStartedAt")
    && valueString(attachment, "blobPath") === expectedPath
    && valueString(attachment, "fileName") === payload.fileName
    && valueString(attachment, "extension") === payload.extension
    && valueString(attachment, "mimeType") === payload.mimeType
    && valueInteger(attachment, "originalSize") === payload.originalSize
    && valueInteger(attachment, "encryptedSize") === payload.encryptedSize
    && valueInteger(attachment, "version") === payload.version
    && valueString(attachment, "algorithm") === payload.algorithm
    && valueInteger(attachment, "privacyVersion") === 1
    && valueBoolean(attachment, "quotaReserved")
    && valueBoolean(attachment, "pendingReservationTracked")
    && encryptedFileName?.version === payload.encryptedFileName.version
    && encryptedFileName?.algorithm === payload.encryptedFileName.algorithm
    && encryptedFileName?.cipherText === payload.encryptedFileName.cipherText
    && encryptedFileName?.iv === payload.encryptedFileName.iv
    && (
      payload.version === 1
        ? valueBytes(attachment, "iv") === payload.ivBase64
        : (
            valueInteger(attachment, "chunkSize") === payload.chunkSize
            && valueInteger(attachment, "chunkCount") === payload.chunkCount
            && valueBytesArray(attachment, "chunkIvs").join("\0") === payload.chunkIvBase64List.join("\0")
          )
    );
  if (!baseMatches) {
    return false;
  }
  if (scope === "note") {
    return valueString(attachment, "uploadedBy") === uid
      && valueString(attachment, "noteId") === payload.noteId
      && valueString(attachment, "secureShareCopyJobId") === payload.secureShareCopyJobId;
  }
  return valueString(attachment, "ownerUid") === uid
    && valueString(attachment, "generation") === payload.generation
    && valueString(attachment, "sourceAttachmentId") === payload.sourceAttachmentId
    && valueString(attachment, "sourceAttachmentDigest") === payload.sourceAttachmentDigest
    && valueInteger(attachment, "sourceEncryptionVersion") === payload.sourceEncryptionVersion;
}

function reservationAllowsTokenReissue(attachment, nowMilliseconds = Date.now()) {
  const expiresAt = valueTimestampMillis(attachment, "reservationExpiresAt");
  return Number.isFinite(expiresAt) && expiresAt >= nowMilliseconds + tokenTtlMs;
}

function existingReservationTokenPayload(attachment, payload, uid, attachmentPath, blobPath) {
  return {
    ...payload,
    uid,
    blobPath,
    attachmentPath,
    quotaUid: uid,
    ...(payload.scope === "publicShare"
      ? {
          cleanupPath: `publicShareCleanupQueue/${payload.shareId}/publicShareAttachmentCleanupQueue/${payload.attachmentId}`,
          generation: valueString(attachment, "generation")
        }
      : {})
  };
}

async function noteAttachmentReservationWrites(
  projectId,
  accessToken,
  uid,
  payload,
  attachmentWrite
) {
  const notePath = `notes/${payload.noteId}`;
  const currentNote = await firestoreGetDocument(projectId, notePath, accessToken);
  const authorization = currentNote
    ? await noteUploadAuthorization(projectId, uid, currentNote, accessToken)
    : { allowed: false, verifyDocuments: [] };

  if (
    !currentNote
    || typeof currentNote.updateTime !== "string"
    || !currentNote.updateTime
    || !authorization.allowed
  ) {
    throw new HttpError(403, "첨부파일 업로드 권한이 없습니다.", "Cannot upload to current note");
  }

  const copyState = secureShareCopyState(currentNote);
  const isSecureShareCopyReservation = Boolean(payload.secureShareCopyJobId);
  let nextSecureShareCopyReservedCount = null;

  if (isSecureShareCopyReservation) {
    const expectedCount = nonNegativeIntegerField(
      currentNote,
      "secureShareCopyExpectedAttachmentCount"
    );
    const reservedCount = nonNegativeIntegerField(
      currentNote,
      "secureShareCopyReservedAttachmentCount"
    );

    if (
      copyState !== "copying"
      || valueString(currentNote, "ownerUid") !== uid
      || valueString(currentNote, "secureShareCopyJobId") !== payload.secureShareCopyJobId
      || secureShareCopyCleanupClaimed(currentNote)
      || expectedCount === null
      || reservedCount === null
      || reservedCount >= expectedCount
    ) {
      throw new HttpError(
        409,
        "복사할 첨부파일 예약 한도를 초과했습니다.",
        "Secure share copy reservation is no longer valid"
      );
    }

    nextSecureShareCopyReservedCount = reservedCount + 1;
  } else if (copyState === "copying") {
    throw new HttpError(
      409,
      "첨부파일 복사 작업이 진행 중입니다. 잠시 후 다시 시도해주세요.",
      "Ordinary attachment reservation is blocked during secure share copy"
    );
  }

  // Touch existing note metadata in the reservation commit. Older finalizers
  // already delete with a note updateTime precondition, so this parent CAS is
  // the cross-version mutex during the staged rollout without adding a field
  // that legacy client allowlists would reject.
  const noteFields = { updatedBy: stringValue(uid) };
  const noteFieldPaths = ["updatedBy"];
  const noteUpdateTransforms = [{
    fieldPath: "updatedAt",
    setToServerValue: "REQUEST_TIME"
  }];

  if (nextSecureShareCopyReservedCount !== null) {
    noteFields.secureShareCopyReservedAttachmentCount = integerValue(
      nextSecureShareCopyReservedCount
    );
    noteFieldPaths.push("secureShareCopyReservedAttachmentCount");
    noteUpdateTransforms.push({
      fieldPath: "secureShareCopyUpdatedAt",
      setToServerValue: "REQUEST_TIME"
    });
  }

  const noteAttachmentCountWrite = await reserveNoteAttachmentCountWrite(
    projectId,
    accessToken,
    payload.noteId
  );
  const noteReservationWrite = {
    update: {
      name: documentName(projectId, notePath),
      fields: noteFields
    },
    updateMask: { fieldPaths: noteFieldPaths },
    currentDocument: { updateTime: currentNote.updateTime },
    ...(noteUpdateTransforms.length ? { updateTransforms: noteUpdateTransforms } : {})
  };

  return [
    attachmentWrite,
    noteAttachmentCountWrite,
    noteReservationWrite,
    ...authorizationVerifyWrites(authorization.verifyDocuments)
  ];
}

async function createNoteAttachmentReservation(projectId, accessToken, uid, payload, pathname) {
  // Do not start a schema-v1 reservation that could outlive the stage-two
  // alias switch and commit after the hard cap has been enabled. Existing
  // upload-completion callbacks remain available while old writers drain.
  if (NOTE_ATTACHMENT_ROLLOUT_DRAIN_ACTIVE) {
    throw new HttpError(
      503,
      "첨부파일 배포 전환 중입니다. 잠시 후 다시 시도해주세요.",
      "Note attachment reservation rollout drain is active"
    );
  }

  if (payload.uploadedBy !== uid) {
    throw new HttpError(403, "첨부파일 업로드 권한이 없습니다.", "uploadedBy mismatch");
  }

  const note = await firestoreGetDocument(projectId, `notes/${payload.noteId}`, accessToken);

  if (!note || !(await canUploadToNote(projectId, uid, note, accessToken))) {
    throw new HttpError(403, "첨부파일 업로드 권한이 없습니다.", "Cannot upload to note");
  }

  const expectedPath = noteBlobPath(uid, payload.noteId, payload.attachmentId);

  if (pathname !== expectedPath) {
    throw new HttpError(400, "첨부파일 저장 경로가 올바르지 않습니다.", "Pathname mismatch");
  }

  const attachmentPath = `notes/${payload.noteId}/attachments/${payload.attachmentId}`;
  const initialCopyState = secureShareCopyState(note);

  if (
    (initialCopyState === "copying" && (
      payload.secureShareCopyJobId !== valueString(note, "secureShareCopyJobId")
      || valueString(note, "ownerUid") !== uid
      || secureShareCopyCleanupClaimed(note)
    ))
    || (initialCopyState !== "copying" && payload.secureShareCopyJobId)
  ) {
    throw new HttpError(403, "첨부파일 복사 작업 권한이 없습니다.", "Secure share copy job mismatch");
  }

  const existingAttachment = await firestoreGetDocument(projectId, attachmentPath, accessToken);
  if (existingAttachment) {
    if (
      reservationMatchesPayload(existingAttachment, payload, expectedPath, uid, "note")
      && reservationAllowsTokenReissue(existingAttachment)
    ) {
      return existingReservationTokenPayload(
        existingAttachment,
        payload,
        uid,
        attachmentPath,
        expectedPath
      );
    }
    throw new HttpError(
      409,
      "동일한 첨부파일 요청이 이미 처리되었거나 정보가 변경되었습니다.",
      "Existing note attachment reservation does not match"
    );
  }

  const attachmentFields = {
    noteId: stringValue(payload.noteId),
    ...attachmentBaseFields(payload, expectedPath),
    uploadedBy: stringValue(uid)
  };

  if (payload.secureShareCopyJobId) {
    attachmentFields.secureShareCopyJobId = stringValue(payload.secureShareCopyJobId);
  }

  const attachmentWrite = {
    update: {
      name: documentName(projectId, attachmentPath),
      fields: attachmentFields
    },
    currentDocument: { exists: false },
    updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]
  };

  try {
    await reserveUserAttachmentBytes(
      projectId,
      accessToken,
      uid,
      payload.encryptedSize,
      async () => [
        ...await noteAttachmentReservationWrites(
          projectId,
          accessToken,
          uid,
          payload,
          attachmentWrite
        ),
        reservationIndexWrite(
          projectId,
          uid,
          attachmentPath,
          expectedPath,
          payload.encryptedSize,
          attachmentFields.reservationExpiresAt
        )
      ]
    );
  } catch (error) {
    if (![400, 409].includes(error.statusCode)) {
      throw error;
    }
    const concurrentAttachment = await firestoreGetDocument(projectId, attachmentPath, accessToken);
    if (
      reservationMatchesPayload(concurrentAttachment, payload, expectedPath, uid, "note")
      && reservationAllowsTokenReissue(concurrentAttachment)
    ) {
      return existingReservationTokenPayload(
        concurrentAttachment,
        payload,
        uid,
        attachmentPath,
        expectedPath
      );
    }
    throw error;
  }

  return {
    ...payload,
    uid,
    blobPath: expectedPath,
    attachmentPath,
    quotaUid: uid
  };
}

async function publicShareUploadAuthorization(projectId, accessToken, uid, payload) {
  const sharePath = `publicNoteShares/${payload.shareId}`;
  const [share, ownerProfile] = await Promise.all([
    firestoreGetDocument(projectId, sharePath, accessToken),
    userProfile(projectId, uid, accessToken)
  ]);
  const ownerUid = valueString(share, "ownerUid");
  const expiresAt = share?.fields?.expiresAt?.timestampValue;
  const sourceAuthorization = share && ownerUid === uid
    ? await publicShareSourceAuthorization(
        projectId,
        share,
        accessToken,
        publicShareSourceRequiresMatchingRevision(share),
        ownerProfile
      )
    : { allowed: false, sourceNote: null, verifyDocuments: [] };
  const hasSourceFingerprint = Boolean(
    payload.sourceAttachmentDigest || payload.sourceEncryptionVersion
  );
  const sourceNoteId = valueString(share, "sourceNoteId");
  const sourceAttachment = hasSourceFingerprint && sourceNoteId && payload.sourceAttachmentId
    ? await firestoreGetDocument(
        projectId,
        `notes/${sourceNoteId}/attachments/${payload.sourceAttachmentId}`,
        accessToken
      )
    : null;
  const sourceFingerprintMatches = !hasSourceFingerprint || sourceAttachmentFingerprintMatches(
    {
      sourceAttachmentId: payload.sourceAttachmentId,
      sourceAttachmentDigest: payload.sourceAttachmentDigest,
      sourceEncryptionVersion: payload.sourceEncryptionVersion
    },
    sourceAttachment
      ? {
          __id: payload.sourceAttachmentId,
          blobEtag: valueString(sourceAttachment, "blobEtag"),
          version: valueInteger(sourceAttachment, "version")
        }
      : null
  );

  return {
    allowed: Boolean(
      share
      && ownerProfile.isActive
      && ownerUid === uid
      && !share?.fields?.revokedAt
      && expiresAt
      && Date.parse(expiresAt) > Date.now()
      && sourceAuthorization.allowed
    ),
    expiresAt,
    share,
    sourceFingerprintMatches,
    verifyDocuments: [
      share,
      ownerProfile.document,
      ...sourceAuthorization.verifyDocuments,
      sourceAttachment
    ].filter(Boolean)
  };
}

async function createPublicShareAttachmentReservation(projectId, accessToken, uid, payload, pathname) {
  const authorization = await publicShareUploadAuthorization(
    projectId,
    accessToken,
    uid,
    payload
  );

  if (!authorization.allowed) {
    throw new HttpError(403, "공유 첨부파일 업로드 권한이 없습니다.", "Cannot upload to public share");
  }

  const expectedPath = publicShareBlobPath(uid, payload.shareId, payload.attachmentId);

  if (pathname !== expectedPath) {
    throw new HttpError(400, "공유 첨부파일 저장 경로가 올바르지 않습니다.", "Public share pathname mismatch");
  }

  if (!authorization.sourceFingerprintMatches) {
    throw new HttpError(
      409,
      "공유 첨부파일 원본이 변경되었습니다.",
      "Public attachment source fingerprint mismatch"
    );
  }

  const attachmentPath = `publicNoteShares/${payload.shareId}/attachments/${payload.attachmentId}`;
  const cleanupPath = `publicShareCleanupQueue/${payload.shareId}/publicShareAttachmentCleanupQueue/${payload.attachmentId}`;
  const existingAttachment = await firestoreGetDocument(projectId, attachmentPath, accessToken);
  if (existingAttachment) {
    if (
      reservationMatchesPayload(existingAttachment, payload, expectedPath, uid, "publicShare")
      && reservationAllowsTokenReissue(existingAttachment)
    ) {
      return existingReservationTokenPayload(
        existingAttachment,
        payload,
        uid,
        attachmentPath,
        expectedPath
      );
    }
    throw new HttpError(
      409,
      "동일한 공유 첨부파일 요청이 이미 처리되었거나 정보가 변경되었습니다.",
      "Existing public attachment reservation does not match"
    );
  }
  const baseFields = {
    ...attachmentBaseFields(payload, expectedPath),
    ownerUid: stringValue(uid),
    generation: stringValue(payload.generation)
  };

  if (payload.sourceAttachmentId) {
    baseFields.sourceAttachmentId = stringValue(payload.sourceAttachmentId);
  }
  if (payload.sourceAttachmentDigest) {
    baseFields.sourceAttachmentDigest = stringValue(payload.sourceAttachmentDigest);
    baseFields.sourceEncryptionVersion = integerValue(payload.sourceEncryptionVersion);
  }

  try {
    await reserveUserAttachmentBytes(
      projectId,
      accessToken,
      uid,
      payload.encryptedSize,
      async () => {
        const currentAuthorization = await publicShareUploadAuthorization(
          projectId,
          accessToken,
          uid,
          payload
        );
        if (!currentAuthorization.allowed) {
          throw new HttpError(
            403,
            "공유 첨부파일 업로드 권한이 없습니다.",
            "Cannot upload to current public share"
          );
        }
        if (!currentAuthorization.sourceFingerprintMatches) {
          throw new HttpError(
            409,
            "공유 첨부파일 원본이 변경되었습니다.",
            "Public attachment source fingerprint changed"
          );
        }
        const writes = [
          {
            update: {
              name: documentName(projectId, attachmentPath),
              fields: {
                ...baseFields,
                expiresAt: timestampValue(currentAuthorization.expiresAt)
              }
            },
            currentDocument: { exists: false },
            updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]
          },
          {
            update: {
              name: documentName(projectId, cleanupPath),
              fields: {
                shareId: stringValue(payload.shareId),
                attachmentId: stringValue(payload.attachmentId),
                expiresAt: timestampValue(currentAuthorization.expiresAt)
              }
            },
            currentDocument: { exists: false },
            updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]
          },
          reservationIndexWrite(
            projectId,
            uid,
            attachmentPath,
            expectedPath,
            payload.encryptedSize,
            baseFields.reservationExpiresAt
          )
        ];
        return [
          ...writes,
          ...authorizationVerifyWrites(currentAuthorization.verifyDocuments)
        ];
      }
    );
  } catch (error) {
    if (![400, 409].includes(error.statusCode)) {
      throw error;
    }
    const concurrentAttachment = await firestoreGetDocument(projectId, attachmentPath, accessToken);
    if (
      reservationMatchesPayload(concurrentAttachment, payload, expectedPath, uid, "publicShare")
      && reservationAllowsTokenReissue(concurrentAttachment)
    ) {
      return existingReservationTokenPayload(
        concurrentAttachment,
        payload,
        uid,
        attachmentPath,
        expectedPath
      );
    }
    throw error;
  }

  return {
    ...payload,
    uid,
    blobPath: expectedPath,
    attachmentPath,
    cleanupPath,
    quotaUid: uid
  };
}

function callbackUrlForRequest(request) {
  const configuredHost = envValue("VERCEL_URL") || envValue("VERCEL_PROJECT_PRODUCTION_URL");

  if (configuredHost && /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(configuredHost)) {
    return `https://${configuredHost}/api/blob-attachments`;
  }

  const forwardedHost = request.headers["x-forwarded-host"] || request.headers.host;
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;

  if (typeof host !== "string" || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/u.test(host)) {
    return undefined;
  }

  return `http://${host}/api/blob-attachments`;
}

function safeIndexedAttachmentPath(value) {
  return typeof value === "string"
    && /^(?:notes|publicNoteShares)\/[A-Za-z0-9_-]{1,160}\/attachments\/[A-Za-z0-9_-]{1,160}$/u.test(value)
    ? value
    : "";
}

function notePathFromAttachmentPath(attachmentPath) {
  const match = /^notes\/([A-Za-z0-9_-]{1,160})\/attachments\/[A-Za-z0-9_-]{1,160}$/u
    .exec(attachmentPath);
  return match ? `notes/${match[1]}` : "";
}

async function deleteReservationIndex(projectId, accessToken, indexDocument) {
  const indexPath = relativeDocumentPath(indexDocument);
  if (!indexPath || !indexDocument?.updateTime) {
    return;
  }
  try {
    await firestoreCommit(projectId, accessToken, [{
      delete: documentName(projectId, indexPath),
      currentDocument: { updateTime: indexDocument.updateTime }
    }]);
  } catch (error) {
    if (![400, 409].includes(error.statusCode)) {
      throw error;
    }
  }
}

async function cleanupExpiredUserReservations(projectId, accessToken, uid) {
  const result = await firestoreListDocumentsWithFields(
    projectId,
    `userAttachmentReservations/${uid}/pendingAttachmentReservations`,
    accessToken,
    opportunisticReservationScanLimit,
    ["attachmentPath", "reservationExpiresAt"]
  );
  const documents = Array.isArray(result?.documents) ? result.documents : [];
  let cleaned = 0;

  for (const indexDocument of documents) {
    if (cleaned >= opportunisticReservationCleanupLimit) {
      break;
    }
    const expiresAt = valueTimestampMillis(indexDocument, "reservationExpiresAt");
    if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
      continue;
    }
    const attachmentPath = safeIndexedAttachmentPath(valueString(indexDocument, "attachmentPath"));
    if (!attachmentPath) {
      await deleteReservationIndex(projectId, accessToken, indexDocument);
      cleaned += 1;
      continue;
    }
    const attachment = await firestoreGetDocument(projectId, attachmentPath, accessToken);
    if (!attachment) {
      await deleteReservationIndex(projectId, accessToken, indexDocument);
      cleaned += 1;
      continue;
    }
    const deletingAttachment = await beginAttachmentDeletion(
      projectId,
      accessToken,
      attachmentPath,
      notePathFromAttachmentPath(attachmentPath),
      uid,
      async (currentAttachment) => {
        const reservationOwner = valueString(currentAttachment, "ownerUid")
          || valueString(currentAttachment, "uploadedBy");
        const currentExpiresAt = valueTimestampMillis(
          currentAttachment,
          "reservationExpiresAt"
        );
        return {
          allowed: reservationOwner === uid
            && valueBoolean(currentAttachment, "pendingReservationTracked")
            && !valueBoolean(currentAttachment, "isReady")
            && Number.isFinite(currentExpiresAt)
            && currentExpiresAt <= Date.now()
        };
      }
    );
    if (!deletingAttachment) {
      continue;
    }
    await deleteAttachmentObjects(firebaseCredentials(), accessToken, deletingAttachment);
    await claimAttachmentDeletion(projectId, accessToken, attachmentPath, [
      relativeDocumentPath(indexDocument)
    ]);
    cleaned += 1;
  }

  return cleaned;
}

async function beforeGenerateToken(request, pathname, clientPayload, telemetry = null) {
  ensureBlobConfigured();

  const idToken = authToken(request);

  if (!idToken) {
    throw new HttpError(401, "로그인이 필요합니다.", "Missing auth token");
  }

  const credentials = firebaseCredentials();
  const [uid, accessToken] = await Promise.all([lookupCallerUid(idToken), fetchAccessToken(credentials)]);

  if (!uid) {
    throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해주세요.", "Invalid auth token");
  }

  await consumeAttachmentRateLimit(credentials.projectId, accessToken, {
    keyParts: [uid],
    limit: attachmentReservationBurstLimit,
    limitType: "reservation_uid",
    windowSeconds: attachmentReservationBurstWindowSeconds
  });
  await cleanupExpiredUserReservations(credentials.projectId, accessToken, uid);

  const payload = parseClientPayload(clientPayload);
  if (telemetry) {
    telemetry.scope = payload.scope;
    telemetry.sizeBucket = attachmentSizeBucket(payload.encryptedSize);
  }
  const tokenPayload =
    payload.scope === "note"
      ? await createNoteAttachmentReservation(credentials.projectId, accessToken, uid, payload, pathname)
      : await createPublicShareAttachmentReservation(credentials.projectId, accessToken, uid, payload, pathname);

  return {
    allowedContentTypes: [blobContentType],
    maximumSizeInBytes: payload.encryptedSize,
    validUntil: Date.now() + tokenTtlMs,
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 60,
    callbackUrl: callbackUrlForRequest(request),
    tokenPayload: JSON.stringify(tokenPayload)
  };
}

function parseTokenPayload(value) {
  if (typeof value !== "string" || !value) {
    throw new HttpError(400, "첨부파일 업로드 완료 정보가 없습니다.", "Missing tokenPayload");
  }

  return JSON.parse(value);
}

async function validateUploadedBlob(blobPath, encryptedSize) {
  ensureBlobConfigured();

  const blob = await head(blobPath);

  if (!blob || blob.pathname !== blobPath || blob.size !== encryptedSize || blob.contentType !== blobContentType) {
    throw new Error("Uploaded blob metadata did not match attachment reservation");
  }

  return blob;
}

async function headBlobIfPresent(blobPath) {
  try {
    return await head(blobPath);
  } catch (error) {
    if (error?.constructor?.name === "BlobNotFoundError") {
      return null;
    }

    throw error;
  }
}

async function markAttachmentReady(projectId, accessToken, tokenPayload, uploadedBlob) {
  if (uploadedBlob.pathname !== tokenPayload.blobPath) {
    throw new Error("Uploaded blob pathname mismatch");
  }

  const blob = await validateUploadedBlob(tokenPayload.blobPath, tokenPayload.encryptedSize);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attachment = await firestoreGetDocument(projectId, tokenPayload.attachmentPath, accessToken);

    if (!attachment) {
      throw new Error("Attachment reservation no longer exists");
    }

    const readyAction = attachmentReadyAction({
      isReady: valueBoolean(attachment, "isReady"),
      deletionStarted: valueBoolean(attachment, "deletionStarted") || valueHasField(attachment, "deletionStartedAt")
    });

    if (readyAction === "already-ready") {
      return;
    }

    if (readyAction === "blocked") {
      throw new HttpError(409, "삭제가 시작된 첨부파일은 업로드를 완료할 수 없습니다.", "Attachment deletion already started");
    }

    const pendingReservationTracked = valueBoolean(attachment, "pendingReservationTracked");
    const quotaPath = `userAttachmentUsage/${tokenPayload.uid}`;
    const quotaDocument = pendingReservationTracked
      ? await firestoreGetDocument(projectId, quotaPath, accessToken)
      : null;
    const pendingCount = pendingReservationTracked
      ? nonNegativeIntegerField(quotaDocument, "pendingCount")
      : 0;
    const pendingBytes = pendingReservationTracked
      ? nonNegativeIntegerField(quotaDocument, "pendingBytes")
      : 0;

    if (
      pendingReservationTracked
      && (
        !quotaDocument?.updateTime
        || pendingCount === null
        || pendingBytes === null
        || pendingCount < 1
        || pendingBytes < tokenPayload.encryptedSize
      )
    ) {
      throw new HttpError(
        503,
        "첨부파일 예약 상태를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.",
        "Attachment pending quota cannot be finalized"
      );
    }

    const writes = [
      {
        update: {
          name: documentName(projectId, tokenPayload.attachmentPath),
          fields: {
            isReady: booleanValue(true),
            blobEtag: stringValue(blob.etag),
            pendingReservationTracked: booleanValue(false)
          }
        },
        updateMask: {
          fieldPaths: [
            "isReady",
            "blobEtag",
            "pendingReservationTracked",
            "reservationExpiresAt",
            "blobUrl",
            "blobDownloadUrl"
          ]
        },
        currentDocument: { updateTime: attachment.updateTime }
      }
    ];

    if (pendingReservationTracked) {
      writes.push(
        {
          update: {
            name: documentName(projectId, quotaPath),
            fields: {
              pendingCount: integerValue(pendingCount - 1),
              pendingBytes: integerValue(pendingBytes - tokenPayload.encryptedSize),
              pendingLimitCount: integerValue(userPendingAttachmentCountLimit),
              pendingLimitBytes: integerValue(userPendingAttachmentBytesLimit)
            }
          },
          updateMask: {
            fieldPaths: [
              "pendingCount",
              "pendingBytes",
              "pendingLimitCount",
              "pendingLimitBytes"
            ]
          },
          currentDocument: { updateTime: quotaDocument.updateTime },
          updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
        },
        {
          delete: documentName(
            projectId,
            attachmentReservationIndexPath(tokenPayload.uid, tokenPayload.attachmentPath)
          )
        }
      );
    }

    const authorizationDocuments = [];
    if (tokenPayload.scope === "note") {
      const noteId = safeId(tokenPayload.noteId, "noteId");
      const note = await firestoreGetDocument(projectId, `notes/${noteId}`, accessToken);
      const authorization = note
        ? await noteUploadAuthorization(projectId, tokenPayload.uid, note, accessToken)
        : { allowed: false, verifyDocuments: [] };

      if (!note || !authorization.allowed) {
        throw new HttpError(403, "첨부파일 업로드 완료 권한이 없습니다.", "Uploader no longer has note access");
      }
      authorizationDocuments.push(...authorization.verifyDocuments);

      const noteFields = {
        attachmentRevision: integerValue(valueInteger(note, "attachmentRevision") + 1),
        updatedBy: stringValue(tokenPayload.uid)
      };
      const noteFieldPaths = ["attachmentRevision", "updatedBy"];
      const noteTransforms = [{
        fieldPath: "updatedAt",
        setToServerValue: "REQUEST_TIME"
      }];
      const readyAttachmentCount = noteReadyAttachmentCountTransition(note, 1);

      if (readyAttachmentCount.state === "invalid") {
        throw new HttpError(
          409,
          "첨부파일 개수 상태가 일치하지 않습니다. 잠시 후 다시 시도해주세요.",
          "Ready attachment count cannot be incremented"
        );
      }
      if (readyAttachmentCount.state === "write") {
        noteFields.readyAttachmentCount = integerValue(readyAttachmentCount.nextCount);
        noteFieldPaths.push("readyAttachmentCount");
      }

      if (secureShareCopyState(note) === "copying") {
        const expectedCount = valueInteger(note, "secureShareCopyExpectedAttachmentCount");
        const reservedCount = valueInteger(note, "secureShareCopyReservedAttachmentCount");
        const readyCount = valueInteger(note, "secureShareCopyReadyAttachmentCount");

        if (
          valueString(note, "ownerUid") !== tokenPayload.uid
          || valueString(note, "secureShareCopyJobId") !== valueString(attachment, "secureShareCopyJobId")
          || secureShareCopyCleanupClaimed(note)
          || readyCount < 0
          || readyCount >= reservedCount
          || reservedCount > expectedCount
        ) {
          throw new HttpError(409, "복사 첨부파일 상태가 일치하지 않습니다.", "Secure share copy ready count mismatch");
        }

        noteFields.secureShareCopyReadyAttachmentCount = integerValue(readyCount + 1);
        noteFieldPaths.push("secureShareCopyReadyAttachmentCount");
        noteTransforms.push({
          fieldPath: "secureShareCopyUpdatedAt",
          setToServerValue: "REQUEST_TIME"
        });
      } else if (valueString(attachment, "secureShareCopyJobId")) {
        throw new HttpError(409, "복사 첨부파일 작업이 종료되었습니다.", "Secure share copy job is no longer copying");
      }

      writes.push({
        update: {
          name: documentName(projectId, `notes/${noteId}`),
          fields: noteFields
        },
        updateMask: { fieldPaths: noteFieldPaths },
        currentDocument: { updateTime: note.updateTime },
        ...(noteTransforms.length ? { updateTransforms: noteTransforms } : {})
      });
    } else if (tokenPayload.scope === "publicShare") {
      const share = await firestoreGetDocument(projectId, `publicNoteShares/${safeId(tokenPayload.shareId, "shareId")}`, accessToken);
      const ownerProfile = await userProfile(projectId, tokenPayload.uid, accessToken);
      const sourceAuthorization = share
        ? await publicShareSourceAuthorization(
            projectId,
            share,
            accessToken,
            publicShareSourceRequiresMatchingRevision(share),
            ownerProfile
          )
        : { allowed: false, verifyDocuments: [] };

      if (
        !share
        || !ownerProfile.isActive
        || valueString(share, "ownerUid") !== tokenPayload.uid
        || valueString(attachment, "generation") !== safeId(tokenPayload.generation, "generation")
        || share?.fields?.revokedAt
        || !Number.isFinite(valueTimestampMillis(share, "expiresAt"))
        || valueTimestampMillis(share, "expiresAt") <= Date.now()
        || !sourceAuthorization.allowed
      ) {
        throw new HttpError(403, "공유 첨부파일 업로드 완료 권한이 없습니다.", "Inactive public share source");
      }
      authorizationDocuments.push(
        share,
        ownerProfile.document,
        ...sourceAuthorization.verifyDocuments
      );
    }

    const updatedNames = new Set(writes.map((write) => write.update?.name).filter(Boolean));
    writes.push(...authorizationVerifyWrites(authorizationDocuments, updatedNames));

    try {
      await firestoreCommit(projectId, accessToken, writes);
      return;
    } catch (error) {
      if (![400, 409].includes(error.statusCode) || attempt === 2) {
        throw error;
      }
    }
  }
}

async function cleanupRejectedUploadedBlob(projectId, accessToken, tokenPayload, uploadedBlob) {
  if (!uploadedBlob || uploadedBlob.pathname !== tokenPayload.blobPath) {
    return;
  }

  const attachment = await firestoreGetDocument(projectId, tokenPayload.attachmentPath, accessToken);

  if (
    attachment
    && !valueBoolean(attachment, "deletionStarted")
    && !valueHasField(attachment, "deletionStartedAt")
  ) {
    return;
  }

  await deleteBlobIfPresent(uploadedBlob.pathname);
}

async function onUploadCompleted({ blob, tokenPayload }) {
  const credentials = firebaseCredentials();
  const accessToken = await fetchAccessToken(credentials);
  const parsedTokenPayload = parseTokenPayload(tokenPayload);

  try {
    await markAttachmentReady(credentials.projectId, accessToken, parsedTokenPayload, blob);
  } catch (error) {
    await cleanupRejectedUploadedBlob(credentials.projectId, accessToken, parsedTokenPayload, blob);
    throw error;
  }
}

async function handleBlobUploadRequest(request, response, body, telemetry = null) {
  const result = await handleUpload({
    request,
    body,
    onBeforeGenerateToken: (pathname, clientPayload) => beforeGenerateToken(
      request,
      pathname,
      clientPayload,
      telemetry
    ),
    onUploadCompleted
  });

  jsonResponse(response, 200, result);
}

async function completeUploadFromClient(request, response, requestBody = null, telemetry = null) {
  const idToken = authToken(request);

  if (!idToken) {
    throw new HttpError(401, "로그인이 필요합니다.", "Missing auth token");
  }

  const body = requestBody ?? await readJsonBody(request);
  const scope = body.scope === "publicShare" ? "publicShare" : body.scope === "note" ? "note" : "";
  if (telemetry) {
    telemetry.scope = scope || "invalid";
    telemetry.sizeBucket = attachmentSizeBucket(Number(body?.blob?.size));
  }
  const attachmentId = safeId(body.attachmentId, "attachmentId");
  const credentials = firebaseCredentials();
  const [uid, accessToken] = await Promise.all([lookupCallerUid(idToken), fetchAccessToken(credentials)]);

  if (!uid) {
    throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해주세요.", "Invalid auth token");
  }

  await consumeAttachmentRateLimit(credentials.projectId, accessToken, {
    keyParts: [uid],
    limit: attachmentMutationLimit,
    limitType: "finalize_uid",
    windowSeconds: attachmentMutationWindowSeconds
  });

  let tokenPayload;

  if (scope === "note") {
    const noteId = safeId(body.noteId, "noteId");
    const attachmentPath = `notes/${noteId}/attachments/${attachmentId}`;
    const attachment = await firestoreGetDocument(credentials.projectId, attachmentPath, accessToken);
    const callerProfile = await userProfile(credentials.projectId, uid, accessToken);

    if (!attachment) {
      await cleanupRejectedUploadedBlob(
        credentials.projectId,
        accessToken,
        {
          attachmentPath,
          blobPath: noteBlobPath(uid, noteId, attachmentId)
        },
        body.blob
      );
      throw new HttpError(403, "첨부파일 업로드 완료 권한이 없습니다.", "Note attachment reservation is missing");
    }

    if (!callerProfile.isActive || valueString(attachment, "uploadedBy") !== uid) {
      throw new HttpError(403, "첨부파일 업로드 완료 권한이 없습니다.", "Cannot complete note attachment");
    }

    tokenPayload = {
      scope: "note",
      noteId,
      attachmentPath,
      blobPath: valueString(attachment, "blobPath"),
      encryptedSize: valueInteger(attachment, "encryptedSize"),
      uid
    };
  } else if (scope === "publicShare") {
    const shareId = safeId(body.shareId, "shareId");
    const share = await firestoreGetDocument(credentials.projectId, `publicNoteShares/${shareId}`, accessToken);
    const attachmentPath = `publicNoteShares/${shareId}/attachments/${attachmentId}`;
    const attachment = await firestoreGetDocument(credentials.projectId, attachmentPath, accessToken);
    const callerProfile = await userProfile(credentials.projectId, uid, accessToken);

    if (!attachment) {
      await cleanupRejectedUploadedBlob(
        credentials.projectId,
        accessToken,
        {
          attachmentPath,
          blobPath: publicShareBlobPath(uid, shareId, attachmentId)
        },
        body.blob
      );
      throw new HttpError(403, "공유 첨부파일 업로드 완료 권한이 없습니다.", "Public attachment reservation is missing");
    }

    if (
      !share
      || !callerProfile.isActive
      || valueString(share, "ownerUid") !== uid
      || share?.fields?.revokedAt
      || !Number.isFinite(valueTimestampMillis(share, "expiresAt"))
      || valueTimestampMillis(share, "expiresAt") <= Date.now()
      || !(await publicShareSourceAvailable(credentials.projectId, share, accessToken))
    ) {
      throw new HttpError(403, "공유 첨부파일 업로드 완료 권한이 없습니다.", "Cannot complete public share attachment");
    }

    tokenPayload = {
      scope: "publicShare",
      shareId,
      generation: valueString(attachment, "generation"),
      attachmentPath,
      blobPath: valueString(attachment, "blobPath"),
      encryptedSize: valueInteger(attachment, "encryptedSize"),
      uid
    };
  } else {
    throw new HttpError(400, "첨부파일 업로드 범위가 올바르지 않습니다.", "Invalid scope");
  }

  if (!body.blob || body.blob.pathname !== tokenPayload.blobPath) {
    throw new HttpError(400, "업로드된 첨부파일 정보가 올바르지 않습니다.", "Invalid uploaded blob");
  }

  try {
    await markAttachmentReady(credentials.projectId, accessToken, tokenPayload, body.blob);
  } catch (error) {
    await cleanupRejectedUploadedBlob(credentials.projectId, accessToken, tokenPayload, body.blob);
    throw error;
  }
  jsonResponse(response, 200, { ok: true });
}

async function migrateLegacyAttachmentFileName(request, response, body, telemetry = null) {
  const idToken = authToken(request);
  if (!idToken) {
    throw new HttpError(401, "로그인이 필요합니다.", "Missing auth token");
  }
  if (body.scope !== "note" || body.privacyVersion !== 1) {
    throw new HttpError(400, "첨부파일 이름 보호 요청이 올바르지 않습니다.", "Invalid filename migration scope");
  }
  if (telemetry) {
    telemetry.scope = "note";
  }
  const noteId = safeId(body.noteId, "noteId");
  const attachmentId = safeId(body.attachmentId, "attachmentId");
  const genericFileName = safeFileName(body.fileName);
  const encryptedFileName = safeEncryptedFileName(body.encryptedFileName);
  const credentials = firebaseCredentials();
  const [uid, accessToken] = await Promise.all([
    lookupCallerUid(idToken),
    fetchAccessToken(credentials)
  ]);
  if (!uid) {
    throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해주세요.", "Invalid auth token");
  }
  await consumeAttachmentRateLimit(credentials.projectId, accessToken, {
    keyParts: [uid],
    limit: attachmentMutationLimit,
    limitType: "filename_migration_uid",
    windowSeconds: attachmentMutationWindowSeconds
  });

  const notePath = `notes/${noteId}`;
  const attachmentPath = `${notePath}/attachments/${attachmentId}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [note, attachment, callerDocument] = await Promise.all([
      firestoreGetDocument(credentials.projectId, notePath, accessToken),
      firestoreGetDocument(credentials.projectId, attachmentPath, accessToken),
      firestoreGetDocument(credentials.projectId, `users/${uid}`, accessToken)
    ]);
    const callerProfile = userProfileFromDocument(callerDocument);
    if (
      !note
      || !attachment
      || !callerProfile.isActive
      || valueString(note, "ownerUid") !== uid
      || noteIsDeleted(note)
      || noteIsPurged(note)
      || !valueBoolean(attachment, "isReady")
      || !note.updateTime
      || !attachment.updateTime
    ) {
      throw new HttpError(
        403,
        "첨부파일 이름을 보호 형식으로 전환할 권한이 없습니다.",
        "Legacy filename migration is not authorized"
      );
    }
    const extension = valueString(attachment, "extension");
    if (genericFileName !== noteGenericAttachmentBaseName(extension)) {
      throw new HttpError(
        400,
        "첨부파일 이름 보호 요청이 올바르지 않습니다.",
        "Filename migration fallback must be generic"
      );
    }
    const currentEncryptedFileName = valueEncryptedPayload(attachment, "encryptedFileName");
    const hasExistingPrivacyMetadata = valueHasField(attachment, "privacyVersion")
      || valueHasField(attachment, "encryptedFileName");
    if (hasExistingPrivacyMetadata) {
      const exactMatch = valueInteger(attachment, "privacyVersion") === 1
        && valueString(attachment, "fileName") === genericFileName
        && currentEncryptedFileName?.version === encryptedFileName.version
        && currentEncryptedFileName?.algorithm === encryptedFileName.algorithm
        && currentEncryptedFileName?.cipherText === encryptedFileName.cipherText
        && currentEncryptedFileName?.iv === encryptedFileName.iv;
      if (exactMatch) {
        jsonResponse(response, 200, { ok: true, status: "already-migrated" });
        return;
      }
      throw new HttpError(
        409,
        "첨부파일 이름 보호 정보가 이미 다르게 설정되어 있습니다.",
        "Filename privacy metadata conflict"
      );
    }

    try {
      await firestoreCommit(credentials.projectId, accessToken, [
        {
          update: {
            name: documentName(credentials.projectId, attachmentPath),
            fields: {
              fileName: stringValue(genericFileName),
              encryptedFileName: encryptedPayloadValue(encryptedFileName),
              privacyVersion: integerValue(1)
            }
          },
          updateMask: {
            fieldPaths: ["fileName", "encryptedFileName", "privacyVersion"]
          },
          currentDocument: { updateTime: attachment.updateTime }
        },
        {
          verify: documentName(credentials.projectId, notePath),
          currentDocument: { updateTime: note.updateTime }
        },
        ...authorizationVerifyWrites([callerDocument])
      ]);
      jsonResponse(response, 200, { ok: true, status: "migrated" });
      return;
    } catch (error) {
      if (![400, 409].includes(error.statusCode) || attempt === 2) {
        throw error;
      }
    }
  }
}

async function attachmentStatus(request, response, telemetry = null) {
  const idToken = authToken(request);
  if (!idToken) {
    throw new HttpError(401, "로그인이 필요합니다.", "Missing auth token");
  }
  const url = new URL(request.url, "https://quickmemo.local");
  const scope = url.searchParams.get("scope");
  if (telemetry) {
    telemetry.scope = scope === "note" || scope === "publicShare" ? scope : "invalid";
  }
  const attachmentId = safeId(url.searchParams.get("attachmentId"), "attachmentId");
  const credentials = firebaseCredentials();
  const [uid, accessToken] = await Promise.all([
    lookupCallerUid(idToken),
    fetchAccessToken(credentials)
  ]);
  if (!uid) {
    throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해주세요.", "Invalid auth token");
  }
  await consumeAttachmentRateLimit(credentials.projectId, accessToken, {
    keyParts: [uid],
    limit: attachmentMutationLimit,
    limitType: "status_uid",
    windowSeconds: attachmentMutationWindowSeconds
  });

  let attachment = null;
  if (scope === "note") {
    const noteId = safeId(url.searchParams.get("noteId"), "noteId");
    const note = await firestoreGetDocument(credentials.projectId, `notes/${noteId}`, accessToken);
    if (!note || !(await canReadNote(credentials.projectId, uid, note, accessToken))) {
      throw new HttpError(403, "첨부파일 상태를 확인할 권한이 없습니다.", "Cannot inspect note attachment status");
    }
    attachment = await firestoreGetDocument(
      credentials.projectId,
      `notes/${noteId}/attachments/${attachmentId}`,
      accessToken
    );
  } else if (scope === "publicShare") {
    const shareId = safeId(url.searchParams.get("shareId"), "shareId");
    const share = await firestoreGetDocument(
      credentials.projectId,
      `publicNoteShares/${shareId}`,
      accessToken
    );
    const profile = await userProfile(credentials.projectId, uid, accessToken);
    if (!share || !profile.isActive || valueString(share, "ownerUid") !== uid) {
      throw new HttpError(403, "공유 첨부파일 상태를 확인할 권한이 없습니다.", "Cannot inspect public attachment status");
    }
    attachment = await firestoreGetDocument(
      credentials.projectId,
      `publicNoteShares/${shareId}/attachments/${attachmentId}`,
      accessToken
    );
  } else {
    throw new HttpError(400, "첨부파일 조회 범위가 올바르지 않습니다.", "Invalid status scope");
  }

  const status = !attachment
    ? "missing"
    : valueBoolean(attachment, "isReady")
      ? "ready"
      : "pending";
  jsonResponse(response, 200, { status });
}

async function streamBlobAttachment(request, response, telemetry = null) {
  ensureBlobConfigured();

  const url = new URL(request.url, "https://quickmemo.local");
  const scope = url.searchParams.get("scope");
  if (telemetry) {
    telemetry.scope = scope === "note" || scope === "publicShare" ? scope : "invalid";
  }
  const credentials = firebaseCredentials();
  const accessToken = await fetchAccessToken(credentials);
  let attachment;
  let publicShare;
  let authorizedUid = "";
  let authorizedShareId = "";
  let attachmentId = "";

  if (scope === "note") {
    const idToken = authToken(request);

    if (!idToken) {
      throw new HttpError(401, "로그인이 필요합니다.", "Missing auth token");
    }

    const uid = await lookupCallerUid(idToken);
    authorizedUid = uid;
    if (!uid) {
      throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해주세요.", "Invalid auth token");
    }
    await consumeAttachmentRateLimit(credentials.projectId, accessToken, {
      keyParts: [uid],
      limit: attachmentAuthenticatedDownloadUnitLimit,
      limitType: "note_download_uid",
      windowSeconds: attachmentDownloadWindowSeconds
    });
    const noteId = safeId(url.searchParams.get("noteId"), "noteId");
    attachmentId = safeId(url.searchParams.get("attachmentId"), "attachmentId");
    const note = await firestoreGetDocument(credentials.projectId, `notes/${noteId}`, accessToken);

    if (!note || !(await canReadNote(credentials.projectId, uid, note, accessToken))) {
      throw new HttpError(403, "첨부파일을 읽을 권한이 없습니다.", "Cannot read note attachment");
    }

    attachment = await firestoreGetDocument(credentials.projectId, `notes/${noteId}/attachments/${attachmentId}`, accessToken);
  } else if (scope === "publicShare") {
    const rawShareId = url.searchParams.get("shareId");
    await consumeAttachmentRateLimit(credentials.projectId, accessToken, {
      keyParts: [clientNetworkDigest(request)],
      limit: attachmentPublicDownloadUnitLimit,
      limitType: "public_download_network_base",
      windowSeconds: attachmentDownloadWindowSeconds
    });
    const shareId = safeId(rawShareId, "shareId");
    attachmentId = safeId(url.searchParams.get("attachmentId"), "attachmentId");
    authorizedShareId = shareId;
    const share = await firestoreGetDocument(credentials.projectId, `publicNoteShares/${shareId}`, accessToken);

    if (
      !share
      || valueInteger(share, "schemaVersion") === 2
      || !publicShareActive(share)
      || !(await publicShareSourceActive(credentials.projectId, share, accessToken))
    ) {
      throw new HttpError(403, "공유 첨부파일을 읽을 수 없습니다.", "Inactive public share");
    }

    publicShare = share;
    attachment = await firestoreGetDocument(credentials.projectId, `publicNoteShares/${shareId}/attachments/${attachmentId}`, accessToken);
  } else {
    throw new HttpError(400, "첨부파일 조회 범위가 올바르지 않습니다.", "Invalid scope");
  }

  const blobPath = valueString(attachment, "blobPath");
  const encryptedSize = valueInteger(attachment, "encryptedSize");
  if (telemetry) {
    telemetry.sizeBucket = attachmentSizeBucket(encryptedSize);
  }

  if (
    !attachment
    || (publicShare && !publicShareAttachmentIsCurrent(publicShare, attachment))
    || (
      publicShare
      && (valueInteger(attachment, "privacyVersion") !== 1 || !valueHasField(attachment, "encryptedFileName"))
    )
    || !valueBoolean(attachment, "isReady")
    || !blobPath
    || encryptedSize > maxChunkedEncryptedAttachmentBytes
  ) {
    throw new HttpError(404, "첨부파일을 찾을 수 없습니다.", "Attachment blob not ready");
  }

  const downloadCost = Math.max(1, Math.ceil(encryptedSize / attachmentPublicDownloadUnitBytes));
  const additionalDownloadCost = downloadCost - 1;
  if (publicShare && additionalDownloadCost > 0) {
    await consumeAttachmentRateLimit(credentials.projectId, accessToken, {
      cost: additionalDownloadCost,
      keyParts: [authorizedShareId, clientNetworkDigest(request)],
      limit: attachmentPublicDownloadUnitLimit,
      limitType: "public_download_share_network",
      windowSeconds: attachmentDownloadWindowSeconds
    });
  } else if (!publicShare && additionalDownloadCost > 0) {
    await consumeAttachmentRateLimit(credentials.projectId, accessToken, {
      cost: additionalDownloadCost,
      keyParts: [authorizedUid],
      limit: attachmentAuthenticatedDownloadUnitLimit,
      limitType: "note_download_uid",
      windowSeconds: attachmentDownloadWindowSeconds
    });
  }

  const blobMetadata = await headBlobIfPresent(blobPath);

  if (!storedBlobMetadataMatchesAttachment(blobMetadata, blobPath, encryptedSize)) {
    throw new HttpError(404, "첨부파일을 찾을 수 없습니다.", "Blob metadata mismatch");
  }

  const blob = await get(blobPath, { access: "private", useCache: false });

  if (!blob || blob.statusCode !== 200 || !blob.stream) {
    throw new HttpError(404, "첨부파일을 찾을 수 없습니다.", "Blob not found");
  }
  if (!streamedBlobMetadataMatchesAttachment(blob.blob, blobPath, encryptedSize)) {
    await blob.stream.cancel().catch(() => undefined);
    throw new HttpError(404, "첨부파일을 찾을 수 없습니다.", "Blob stream metadata mismatch");
  }

  response.statusCode = 200;
  applyAttachmentResponseHeaders(response);
  response.setHeader("content-type", blobContentType);
  response.setHeader("content-length", String(blobMetadata.size));
  await pipeline(Readable.fromWeb(blob.stream), response);
}

async function deleteBlobIfPresent(blobPath) {
  if (!blobPath) {
    return;
  }

  ensureBlobConfigured();

  try {
    await del(blobPath);
  } catch (error) {
    if (!/not\s+found/iu.test(String(error?.message ?? ""))) {
      throw error;
    }
  }
}

async function deleteStorageObjectIfPresent(storageBucket, storagePath, accessToken) {
  if (
    envValue("LEGACY_FIREBASE_STORAGE_ENABLED") !== "true"
    || !storageBucket
    || !storagePath
  ) {
    return;
  }

  const response = await fetch(
    `${storageBaseUrl}/b/${encodeURIComponent(storageBucket)}/o/${encodeURIComponent(storagePath)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` }
    }
  );

  if (response.status === 404) {
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Storage delete failed: ${response.status} ${text.slice(0, 300)}`);
  }
}

async function deleteAttachmentObjects(credentials, accessToken, attachment) {
  await deleteBlobIfPresent(valueString(attachment, "blobPath"));
  await deleteStorageObjectIfPresent(credentials.storageBucket, valueString(attachment, "storagePath"), accessToken);
}

function authorizationVerifyWrites(documents, excludedNames = new Set()) {
  const seen = new Set();
  return documents.flatMap((document) => {
    const name = typeof document?.name === "string" ? document.name : "";
    if (!name || !document.updateTime || excludedNames.has(name) || seen.has(name)) {
      return [];
    }
    seen.add(name);
    return [{
      verify: name,
      currentDocument: { updateTime: document.updateTime }
    }];
  });
}

async function beginAttachmentDeletion(
  projectId,
  accessToken,
  attachmentPath,
  notePath = "",
  noteUpdatedByUid = "",
  authorizeCurrent = null
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [attachment, currentNote] = await Promise.all([
      firestoreGetDocument(projectId, attachmentPath, accessToken),
      notePath
        ? firestoreGetDocument(projectId, notePath, accessToken)
        : Promise.resolve(null)
    ]);

    if (!attachment) {
      return null;
    }

    const authorization = authorizeCurrent
      ? await authorizeCurrent(attachment, currentNote)
      : null;
    if (authorization?.allowed === false) {
      return null;
    }
    const authorizationDocuments = [
      attachment,
      ...(currentNote ? [currentNote] : []),
      ...(Array.isArray(authorization?.verifyDocuments)
        ? authorization.verifyDocuments
        : [])
    ];

    const deletionStarted = valueBoolean(attachment, "deletionStarted");
    const revisionBumped = valueBoolean(attachment, "attachmentRevisionBumped");
    const secureShareCopyJobId = valueString(attachment, "secureShareCopyJobId");
    const shouldBumpRevision = shouldBumpAttachmentRevisionOnDelete({
      scope: notePath ? "note" : "publicShare",
      alreadyBumped: revisionBumped,
      hasReadyField: valueHasField(attachment, "isReady"),
      isReady: valueBoolean(attachment, "isReady")
    });

    if (deletionStarted && !shouldBumpRevision) {
      const claimedNote = secureShareCopyJobId && notePath ? currentNote : null;

      if (secureShareCopyCleanupClaimed(claimedNote)) {
        throw new HttpError(
          409,
          "서버에서 복사 첨부파일을 정리하고 있습니다.",
          "Secure share copy cleanup already claimed"
        );
      }
      try {
        await firestoreCommit(
          projectId,
          accessToken,
          authorizationVerifyWrites(authorizationDocuments)
        );
        return attachment;
      } catch (error) {
        if (![400, 409].includes(error.statusCode) || attempt === 2) {
          throw error;
        }
        continue;
      }
    }

    const attachmentFields = { deletionStarted: booleanValue(true) };
    const attachmentFieldPaths = ["deletionStarted"];
    const writes = [];
    const note = notePath && (shouldBumpRevision || (secureShareCopyJobId && !deletionStarted))
      ? currentNote
      : null;

    if (shouldBumpRevision || (secureShareCopyJobId && !deletionStarted)) {
      if (!note) {
        throw new HttpError(409, "첨부파일의 노트가 더 이상 존재하지 않습니다.", "Attachment note no longer exists");
      }

      const noteFields = {};
      const noteFieldPaths = [];
      const noteTransforms = [];

      if (shouldBumpRevision) {
        attachmentFields.attachmentRevisionBumped = booleanValue(true);
        attachmentFieldPaths.push("attachmentRevisionBumped");
        noteFields.attachmentRevision = integerValue(valueInteger(note, "attachmentRevision") + 1);
        noteFields.updatedBy = stringValue(noteUpdatedByUid);
        noteFieldPaths.push("attachmentRevision", "updatedBy");
        noteTransforms.push({
          fieldPath: "updatedAt",
          setToServerValue: "REQUEST_TIME"
        });
      }

      if (
        shouldBumpRevision
        && valueHasField(attachment, "isReady")
        && valueBoolean(attachment, "isReady")
      ) {
        const readyAttachmentCount = noteReadyAttachmentCountTransition(note, -1);

        if (readyAttachmentCount.state === "invalid") {
          throw new HttpError(
            409,
            "첨부파일 개수 상태가 일치하지 않습니다. 잠시 후 다시 시도해주세요.",
            "Ready attachment count cannot be decremented"
          );
        }
        if (readyAttachmentCount.state === "write") {
          noteFields.readyAttachmentCount = integerValue(readyAttachmentCount.nextCount);
          noteFieldPaths.push("readyAttachmentCount");
        }
      }

      if (secureShareCopyJobId && !deletionStarted && secureShareCopyState(note) === "copying") {
        const reservedCount = valueInteger(note, "secureShareCopyReservedAttachmentCount");
        const readyCount = valueInteger(note, "secureShareCopyReadyAttachmentCount");

        if (
          valueString(note, "secureShareCopyJobId") !== secureShareCopyJobId
          || secureShareCopyCleanupClaimed(note)
          || reservedCount <= 0
          || (valueBoolean(attachment, "isReady") && readyCount <= 0)
        ) {
          throw new HttpError(409, "복사 첨부파일 정리 상태가 일치하지 않습니다.", "Secure share copy deletion count mismatch");
        }

        noteFields.secureShareCopyReservedAttachmentCount = integerValue(reservedCount - 1);
        noteFieldPaths.push("secureShareCopyReservedAttachmentCount");

        if (valueBoolean(attachment, "isReady")) {
          noteFields.secureShareCopyReadyAttachmentCount = integerValue(readyCount - 1);
          noteFieldPaths.push("secureShareCopyReadyAttachmentCount");
        }

        noteTransforms.push({
          fieldPath: "secureShareCopyUpdatedAt",
          setToServerValue: "REQUEST_TIME"
        });
      }

      writes.push({
        update: {
          name: documentName(projectId, notePath),
          fields: noteFields
        },
        updateMask: { fieldPaths: noteFieldPaths },
        currentDocument: { updateTime: note.updateTime },
        ...(noteTransforms.length ? { updateTransforms: noteTransforms } : {})
      });
    }

    if (shouldRetainPendingDeletionReservation({
      hasReadyField: valueHasField(attachment, "isReady"),
      isReady: valueBoolean(attachment, "isReady")
    })) {
      attachmentFields.reservationExpiresAt = timestampValue(new Date(Date.now() + pendingDeletionGraceMs));
      attachmentFieldPaths.push("reservationExpiresAt");
    }

    writes.unshift({
      update: {
        name: documentName(projectId, attachmentPath),
        fields: attachmentFields
      },
      updateMask: { fieldPaths: attachmentFieldPaths },
      currentDocument: { updateTime: attachment.updateTime },
      ...(!deletionStarted
        ? { updateTransforms: [{ fieldPath: "deletionStartedAt", setToServerValue: "REQUEST_TIME" }] }
        : {})
    });
    const updatedNames = new Set(writes.map((write) => write.update?.name).filter(Boolean));
    writes.push(...authorizationVerifyWrites(authorizationDocuments, updatedNames));

    try {
      await firestoreCommit(projectId, accessToken, writes);
      return attachment;
    } catch (error) {
      if (![400, 409].includes(error.statusCode)) {
        throw error;
      }

      if (attempt === 2) {
        throw new HttpError(409, "첨부파일 삭제가 다른 작업과 충돌했습니다. 다시 시도해주세요.", "Attachment deletion precondition conflict");
      }
    }
  }

  return null;
}

async function deleteAttachment(request, response, requestBody = null, telemetry = null) {
  const idToken = authToken(request);

  if (!idToken) {
    throw new HttpError(401, "로그인이 필요합니다.", "Missing auth token");
  }

  const body = requestBody ?? await readJsonBody(request);
  const scope = body.scope === "publicShare" ? "publicShare" : body.scope === "note" ? "note" : "";
  if (telemetry) {
    telemetry.scope = scope || "invalid";
  }
  const attachmentId = safeId(body.attachmentId, "attachmentId");
  const credentials = firebaseCredentials();
  const [uid, accessToken] = await Promise.all([lookupCallerUid(idToken), fetchAccessToken(credentials)]);

  if (!uid) {
    throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해주세요.", "Invalid auth token");
  }

  await consumeAttachmentRateLimit(credentials.projectId, accessToken, {
    keyParts: [uid],
    limit: attachmentMutationLimit,
    limitType: "delete_uid",
    windowSeconds: attachmentMutationWindowSeconds
  });

  if (scope === "note") {
    const noteId = safeId(body.noteId, "noteId");
    const note = await firestoreGetDocument(credentials.projectId, `notes/${noteId}`, accessToken);
    const attachmentPath = `notes/${noteId}/attachments/${attachmentId}`;
    const attachment = await firestoreGetDocument(credentials.projectId, attachmentPath, accessToken);
    const callerProfile = await userProfile(credentials.projectId, uid, accessToken);
    const ownerUid = valueString(note, "ownerUid");
    const ownerProfile = note ? await userProfile(credentials.projectId, ownerUid, accessToken) : { allowedShareTargetUids: [], isActive: false, isAdmin: false };
    const canDelete = Boolean(note && attachment) && canDeleteNoteAttachmentPolicy({
      callerIsActive: callerProfile.isActive,
      callerIsAdmin: callerProfile.isAdmin,
      uid,
      ownerUid,
      participantUids: valueStringArray(note, "participantUids"),
      uploadedBy: valueString(attachment, "uploadedBy"),
      noteIsDeleted: noteIsDeleted(note),
      noteIsPurged: noteIsPurged(note),
      ownerIsActive: ownerProfile.isActive,
      ownerIsAdmin: ownerProfile.isAdmin,
      ownerAllowedShareTargetUids: ownerProfile.allowedShareTargetUids
    });

    if (!canDelete) {
      throw new HttpError(403, "첨부파일 삭제 권한이 없습니다.", "Cannot delete note attachment");
    }

    const deletingAttachment = await beginAttachmentDeletion(
      credentials.projectId,
      accessToken,
      attachmentPath,
      `notes/${noteId}`,
      uid,
      async (currentAttachment, currentNote) => {
        const currentOwnerUid = valueString(currentNote, "ownerUid");
        const currentCallerDocument = currentNote
          ? await firestoreGetDocument(credentials.projectId, `users/${uid}`, accessToken)
          : null;
        const currentOwnerDocument = !currentNote
          ? null
          : currentOwnerUid === uid
            ? currentCallerDocument
            : await firestoreGetDocument(
                credentials.projectId,
                `users/${currentOwnerUid}`,
                accessToken
              );
        const currentCallerProfile = userProfileFromDocument(currentCallerDocument);
        const currentOwnerProfile = userProfileFromDocument(currentOwnerDocument);
        const stillAllowed = Boolean(currentNote) && canDeleteNoteAttachmentPolicy({
          callerIsActive: currentCallerProfile.isActive,
          callerIsAdmin: currentCallerProfile.isAdmin,
          uid,
          ownerUid: currentOwnerUid,
          participantUids: valueStringArray(currentNote, "participantUids"),
          uploadedBy: valueString(currentAttachment, "uploadedBy"),
          noteIsDeleted: noteIsDeleted(currentNote),
          noteIsPurged: noteIsPurged(currentNote),
          ownerIsActive: currentOwnerProfile.isActive,
          ownerIsAdmin: currentOwnerProfile.isAdmin,
          ownerAllowedShareTargetUids: currentOwnerProfile.allowedShareTargetUids
        });
        if (!stillAllowed) {
          throw new HttpError(
            403,
            "첨부파일 삭제 권한이 없습니다.",
            "Note attachment delete authorization changed"
          );
        }
        return {
          verifyDocuments: [currentCallerDocument, currentOwnerDocument].filter(Boolean)
        };
      }
    );

    if (deletingAttachment) {
      await deleteAttachmentObjects(credentials, accessToken, deletingAttachment);

      if (!shouldRetainPendingDeletionReservation({
        hasReadyField: valueHasField(deletingAttachment, "isReady"),
        isReady: valueBoolean(deletingAttachment, "isReady")
      })) {
        await claimAttachmentDeletion(credentials.projectId, accessToken, attachmentPath);
      }
    }

    jsonResponse(response, 200, { ok: true });
    return;
  }

  if (scope === "publicShare") {
    const shareId = safeId(body.shareId, "shareId");
    const share = await firestoreGetDocument(credentials.projectId, `publicNoteShares/${shareId}`, accessToken);
    const attachmentPath = `publicNoteShares/${shareId}/attachments/${attachmentId}`;
    const cleanupPath = `publicShareCleanupQueue/${shareId}/publicShareAttachmentCleanupQueue/${attachmentId}`;
    const attachment = await firestoreGetDocument(credentials.projectId, attachmentPath, accessToken);
    const callerProfile = await userProfile(credentials.projectId, uid, accessToken);

    if (!share || !callerProfile.isActive || valueString(share, "ownerUid") !== uid) {
      throw new HttpError(403, "공유 첨부파일 삭제 권한이 없습니다.", "Cannot delete public share attachment");
    }
    if (!attachment) {
      jsonResponse(response, 200, { ok: true });
      return;
    }

    const deletingAttachment = await beginAttachmentDeletion(
      credentials.projectId,
      accessToken,
      attachmentPath,
      "",
      "",
      async () => {
        const [currentShare, currentCallerDocument] = await Promise.all([
          firestoreGetDocument(
            credentials.projectId,
            `publicNoteShares/${shareId}`,
            accessToken
          ),
          firestoreGetDocument(credentials.projectId, `users/${uid}`, accessToken)
        ]);
        const currentCallerProfile = userProfileFromDocument(currentCallerDocument);
        if (
          !currentShare
          || !currentCallerProfile.isActive
          || valueString(currentShare, "ownerUid") !== uid
        ) {
          throw new HttpError(
            403,
            "공유 첨부파일 삭제 권한이 없습니다.",
            "Public attachment delete authorization changed"
          );
        }
        return {
          verifyDocuments: [currentShare, currentCallerDocument].filter(Boolean)
        };
      }
    );

    if (deletingAttachment) {
      await deleteAttachmentObjects(credentials, accessToken, deletingAttachment);

      if (!shouldRetainPendingDeletionReservation({
        hasReadyField: valueHasField(deletingAttachment, "isReady"),
        isReady: valueBoolean(deletingAttachment, "isReady")
      })) {
        await claimAttachmentDeletion(credentials.projectId, accessToken, attachmentPath, [cleanupPath]);
      }
    }

    jsonResponse(response, 200, { ok: true });
    return;
  }

  throw new HttpError(400, "첨부파일 삭제 범위가 올바르지 않습니다.", "Invalid scope");
}

function handleError(error, response) {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof HttpError ? error.publicMessage : "첨부파일 서버 작업에 실패했습니다.";

  if (!(error instanceof HttpError)) {
    console.error("blob attachment request failed", safeErrorSummary(error));
  }

  if (response.headersSent) {
    if (!response.destroyed && typeof response.destroy === "function") {
      response.destroy();
    }
    return;
  }

  jsonResponse(response, statusCode,
    { ok: false, error: message },
    { retryAfter: error instanceof HttpError ? error.retryAfter : undefined }
  );
}

export {
  canonicalNoteAttachmentMimeType,
  claimAttachmentDeletion,
  noteAttachmentReservationWrites,
  publicShareAttachmentIsCurrent,
  reserveUserAttachmentBytes,
  safeAttachmentMimeType,
  safeFileName
};

// Narrow test seam for exercising the real optimistic Firestore mutations.
// Production request handling continues to reach the same private functions.
export const __blobAttachmentTesting = Object.freeze({
  beginAttachmentDeletion,
  markAttachmentReady
});

export default async function handler(request, response) {
  const startedAt = Date.now();
  const telemetry = {
    method: typeof request.method === "string" ? request.method : "UNKNOWN",
    operation: "unknown",
    requestId: requestId(),
    scope: "unknown",
    sizeBucket: "unknown"
  };
  response.setHeader("x-request-id", telemetry.requestId);
  try {
    if (request.method === "POST") {
      telemetry.operation = "reserve";
      await handleBlobUploadRequest(request, response, await readJsonBody(request), telemetry);
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request);
      if (body.type === "attachment.filename-migrate") {
        telemetry.operation = "filename_migrate";
        await migrateLegacyAttachmentFileName(request, response, body, telemetry);
      } else {
        telemetry.operation = "finalize";
        await completeUploadFromClient(request, response, body, telemetry);
      }
      return;
    }

    if (request.method === "GET") {
      const url = new URL(request.url, "https://quickmemo.local");
      if (url.searchParams.get("type") === "attachment.status") {
        telemetry.operation = "status";
        await attachmentStatus(request, response, telemetry);
      } else {
        telemetry.operation = "download";
        await streamBlobAttachment(request, response, telemetry);
      }
      return;
    }

    if (request.method === "DELETE") {
      telemetry.operation = "delete";
      await deleteAttachment(request, response, await readJsonBody(request), telemetry);
      return;
    }

    response.setHeader("allow", "GET, POST, PATCH, DELETE");
    jsonResponse(response, 405, { ok: false, error: "method_not_allowed" });
  } catch (error) {
    handleError(error, response);
  } finally {
    console.info("blob attachment request completed", {
      durationBucket: durationBucket(Date.now() - startedAt),
      method: telemetry.method,
      operation: telemetry.operation,
      outcome: response.destroyed ? "connection_closed" : "completed",
      requestId: telemetry.requestId,
      scope: telemetry.scope,
      sizeBucket: telemetry.sizeBucket,
      statusCode: Number.isInteger(response.statusCode) ? response.statusCode : 500
    });
  }
}
