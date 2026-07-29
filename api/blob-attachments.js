/* global AbortSignal, Buffer, URL, URLSearchParams, console, crypto, fetch, process */

import { del, get, head } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  attachmentReadyAction,
  canDeleteNoteAttachmentPolicy,
  canReadNoteAttachmentPolicy,
  canUploadNoteAttachmentPolicy,
  isValidEncryptedFileNamePayload,
  publicAttachmentSourceAvailablePolicy,
  publicShareGenericAttachmentBaseName,
  quotaReleaseAfterAttachmentClaim,
  shouldBumpAttachmentRevisionOnDelete,
  shouldRetainPendingDeletionReservation
} from "./_attachment-policy.js";
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
const reservationTtlMs = 2 * 60 * 60 * 1000;
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
  constructor(statusCode, publicMessage, internalMessage = publicMessage) {
    super(internalMessage);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

function envValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function jsonResponse(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
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

function valueStringArray(document, fieldName) {
  const values = document?.fields?.[fieldName]?.arrayValue?.values;

  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => value.stringValue).filter((value) => typeof value === "string");
}

function safeId(value, fieldName) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/u.test(value)) {
    throw new HttpError(400, "첨부파일 요청 값이 올바르지 않습니다.", `Invalid ${fieldName}`);
  }

  return value;
}

function safeFileName(value) {
  if (
    typeof value !== "string"
    || value.length <= 0
    || value.length > 100
    || /[<>:"/\\|?*]/u.test(value)
    || value.split("").some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new HttpError(400, "첨부파일 이름이 올바르지 않습니다.", "Invalid fileName");
  }

  return value;
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

function safePublicShareMimeType(extension, mimeType) {
  const normalizedMimeType = safeMimeType(mimeType).trim().toLowerCase();

  if (normalizedMimeType !== publicShareAttachmentMimeTypes[extension]) {
    throw new HttpError(400, "공유 첨부파일 MIME 타입이 올바르지 않습니다.", "Public share MIME/extension mismatch");
  }

  return normalizedMimeType;
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

  if (scope === "publicShare" && fileName !== publicShareGenericAttachmentBaseName(extension)) {
    throw new HttpError(400, "공유 첨부파일 이름이 올바르지 않습니다.", "Public attachment fileName must be generic");
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
    encryptedFileName: scope === "publicShare" ? safeEncryptedFileName(parsed.encryptedFileName) : null,
    extension,
    mimeType: scope === "publicShare" ? safePublicShareMimeType(extension, parsed.mimeType) : safeMimeType(parsed.mimeType),
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
  if (noteIsDeleted(note) || noteIsPurged(note)) {
    return false;
  }

  const callerProfile = await userProfile(projectId, uid, accessToken);
  const ownerUid = valueString(note, "ownerUid");
  const participantUids = valueStringArray(note, "participantUids");
  const ownerProfile = await userProfile(projectId, ownerUid, accessToken);

  return canUploadNoteAttachmentPolicy({
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
  const sourceNoteId = valueString(share, "sourceNoteId");
  const ownerUid = valueString(share, "ownerUid");

  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(sourceNoteId) || !ownerUid) {
    return false;
  }

  const [sourceNote, ownerProfile] = await Promise.all([
    firestoreGetDocument(projectId, `notes/${sourceNoteId}`, accessToken),
    userProfile(projectId, ownerUid, accessToken)
  ]);

  return Boolean(sourceNote)
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
    });
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

    const quotaWrite = {
      update: {
        name: documentName(projectId, quotaPath),
        fields: {
          uid: stringValue(uid),
          attachmentCount: integerValue(attachmentCount + 1),
          countPolicyVersion: integerValue(attachmentCountPolicyVersion),
          limitCount: integerValue(userBlobAttachmentCountLimit),
          usedBytes: integerValue(usedBytes + bytes),
          limitBytes: integerValue(userBlobAttachmentQuotaBytes)
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

    const writes = [
      {
        delete: documentName(projectId, attachmentPath),
        currentDocument: { updateTime: claim.attachmentUpdateTime }
      },
      ...extraDeletePaths.map((path) => ({ delete: documentName(projectId, path) }))
    ];

    if (claim.quota) {
      writes.push({
        update: {
          name: documentName(projectId, quotaPath),
          fields: {
            uid: stringValue(claim.quota.uid),
            attachmentCount: integerValue(claim.quota.attachmentCount),
            countPolicyVersion: integerValue(attachmentCountPolicyVersion),
            limitCount: integerValue(userBlobAttachmentCountLimit),
            usedBytes: integerValue(claim.quota.usedBytes),
            limitBytes: integerValue(userBlobAttachmentQuotaBytes)
          }
        },
        currentDocument: { updateTime: claim.quota.quotaUpdateTime },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      });
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
    extension: stringValue(payload.extension),
    mimeType: stringValue(payload.mimeType),
    originalSize: integerValue(payload.originalSize),
    encryptedSize: integerValue(payload.encryptedSize),
    storageProvider: stringValue("vercel-blob"),
    blobPath: stringValue(blobPath),
    isReady: booleanValue(false),
    quotaReserved: booleanValue(true),
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

async function createNoteAttachmentReservation(projectId, accessToken, uid, payload, pathname) {
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

  await reserveUserAttachmentBytes(
    projectId,
    accessToken,
    uid,
    payload.encryptedSize,
    initialCopyState === "copying"
      ? async () => {
          const currentNote = await firestoreGetDocument(projectId, `notes/${payload.noteId}`, accessToken);
          const expectedCount = valueInteger(currentNote, "secureShareCopyExpectedAttachmentCount");
          const reservedCount = valueInteger(currentNote, "secureShareCopyReservedAttachmentCount");

          if (
            !currentNote
            || !(await canUploadToNote(projectId, uid, currentNote, accessToken))
            || secureShareCopyState(currentNote) !== "copying"
            || valueString(currentNote, "ownerUid") !== uid
            || valueString(currentNote, "secureShareCopyJobId") !== payload.secureShareCopyJobId
            || secureShareCopyCleanupClaimed(currentNote)
            || expectedCount < 0
            || reservedCount < 0
            || reservedCount >= expectedCount
          ) {
            throw new HttpError(409, "복사할 첨부파일 예약 한도를 초과했습니다.", "Secure share copy reservation is no longer valid");
          }

          return [
            attachmentWrite,
            {
              update: {
                name: documentName(projectId, `notes/${payload.noteId}`),
                fields: {
                  secureShareCopyReservedAttachmentCount: integerValue(reservedCount + 1)
                }
              },
              updateMask: { fieldPaths: ["secureShareCopyReservedAttachmentCount"] },
              currentDocument: { updateTime: currentNote.updateTime },
              updateTransforms: [{
                fieldPath: "secureShareCopyUpdatedAt",
                setToServerValue: "REQUEST_TIME"
              }]
            }
          ];
        }
      : [attachmentWrite]
  );

  return {
    ...payload,
    uid,
    blobPath: expectedPath,
    attachmentPath,
    quotaUid: uid
  };
}

async function createPublicShareAttachmentReservation(projectId, accessToken, uid, payload, pathname) {
  const share = await firestoreGetDocument(projectId, `publicNoteShares/${payload.shareId}`, accessToken);
  const ownerUid = valueString(share, "ownerUid");
  const expiresAt = share?.fields?.expiresAt?.timestampValue;
  const ownerProfile = await userProfile(projectId, uid, accessToken);

  if (
    !share
    || !ownerProfile.isActive
    || ownerUid !== uid
    || share?.fields?.revokedAt
    || !expiresAt
    || Date.parse(expiresAt) <= Date.now()
    || !(await publicShareSourceAvailable(projectId, share, accessToken))
  ) {
    throw new HttpError(403, "공유 첨부파일 업로드 권한이 없습니다.", "Cannot upload to public share");
  }

  const expectedPath = publicShareBlobPath(uid, payload.shareId, payload.attachmentId);

  if (pathname !== expectedPath) {
    throw new HttpError(400, "공유 첨부파일 저장 경로가 올바르지 않습니다.", "Public share pathname mismatch");
  }

  if (payload.sourceAttachmentDigest || payload.sourceEncryptionVersion) {
    const sourceNoteId = valueString(share, "sourceNoteId");
    const sourceAttachment = sourceNoteId && payload.sourceAttachmentId
      ? await firestoreGetDocument(
          projectId,
          `notes/${sourceNoteId}/attachments/${payload.sourceAttachmentId}`,
          accessToken
        )
      : null;

    if (!sourceAttachmentFingerprintMatches(
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
    )) {
      throw new HttpError(
        409,
        "공유 첨부파일 원본이 변경되었습니다.",
        "Public attachment source fingerprint mismatch"
      );
    }
  }

  const attachmentPath = `publicNoteShares/${payload.shareId}/attachments/${payload.attachmentId}`;
  const cleanupPath = `publicShareCleanupQueue/${payload.shareId}/publicShareAttachmentCleanupQueue/${payload.attachmentId}`;
  const fields = {
    ...attachmentBaseFields(payload, expectedPath),
    encryptedFileName: encryptedPayloadValue(payload.encryptedFileName),
    privacyVersion: integerValue(1),
    ownerUid: stringValue(uid),
    generation: stringValue(payload.generation),
    expiresAt: timestampValue(expiresAt)
  };

  if (payload.sourceAttachmentId) {
    fields.sourceAttachmentId = stringValue(payload.sourceAttachmentId);
  }
  if (payload.sourceAttachmentDigest) {
    fields.sourceAttachmentDigest = stringValue(payload.sourceAttachmentDigest);
    fields.sourceEncryptionVersion = integerValue(payload.sourceEncryptionVersion);
  }

  await reserveUserAttachmentBytes(projectId, accessToken, uid, payload.encryptedSize, [
    {
      update: {
        name: documentName(projectId, attachmentPath),
        fields
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
          expiresAt: timestampValue(expiresAt)
        }
      },
      currentDocument: { exists: false },
      updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]
    }
  ]);

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

async function beforeGenerateToken(request, pathname, clientPayload) {
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

  const payload = parseClientPayload(clientPayload);
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

function blobMetadataMatchesAttachment(blob, blobPath, encryptedSize) {
  return Boolean(blob)
    && blob.pathname === blobPath
    && blob.size === encryptedSize
    && blob.contentType === blobContentType;
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

    const uploaderProfile = await userProfile(projectId, tokenPayload.uid, accessToken);

    if (!uploaderProfile.isActive) {
      throw new HttpError(403, "첨부파일 업로드 완료 권한이 없습니다.", "Inactive uploader cannot complete attachment");
    }

    const writes = [
      {
        update: {
          name: documentName(projectId, tokenPayload.attachmentPath),
          fields: {
            isReady: booleanValue(true),
            blobUrl: stringValue(blob.url),
            blobDownloadUrl: stringValue(blob.downloadUrl),
            blobEtag: stringValue(blob.etag)
          }
        },
        updateMask: {
          fieldPaths: ["isReady", "blobUrl", "blobDownloadUrl", "blobEtag", "reservationExpiresAt"]
        },
        currentDocument: { updateTime: attachment.updateTime }
      }
    ];

    if (tokenPayload.scope === "note") {
      const noteId = safeId(tokenPayload.noteId, "noteId");
      const note = await firestoreGetDocument(projectId, `notes/${noteId}`, accessToken);

      if (!note || !(await canUploadToNote(projectId, tokenPayload.uid, note, accessToken))) {
        throw new HttpError(403, "첨부파일 업로드 완료 권한이 없습니다.", "Uploader no longer has note access");
      }

      const noteFields = {
        attachmentRevision: integerValue(valueInteger(note, "attachmentRevision") + 1)
      };
      const noteFieldPaths = ["attachmentRevision"];
      const noteTransforms = [];

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

      if (
        !share
        || valueString(share, "ownerUid") !== tokenPayload.uid
        || valueString(attachment, "generation") !== safeId(tokenPayload.generation, "generation")
        || share?.fields?.revokedAt
        || !Number.isFinite(valueTimestampMillis(share, "expiresAt"))
        || valueTimestampMillis(share, "expiresAt") <= Date.now()
        || !(await publicShareSourceAvailable(projectId, share, accessToken))
      ) {
        throw new HttpError(403, "공유 첨부파일 업로드 완료 권한이 없습니다.", "Inactive public share source");
      }
    }

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

async function handleBlobUploadRequest(request, response, body) {
  const result = await handleUpload({
    request,
    body,
    onBeforeGenerateToken: (pathname, clientPayload) => beforeGenerateToken(request, pathname, clientPayload),
    onUploadCompleted
  });

  jsonResponse(response, 200, result);
}

async function completeUploadFromClient(request, response) {
  const idToken = authToken(request);

  if (!idToken) {
    throw new HttpError(401, "로그인이 필요합니다.", "Missing auth token");
  }

  const body = await readJsonBody(request);
  const scope = body.scope === "publicShare" ? "publicShare" : body.scope === "note" ? "note" : "";
  const attachmentId = safeId(body.attachmentId, "attachmentId");
  const credentials = firebaseCredentials();
  const [uid, accessToken] = await Promise.all([lookupCallerUid(idToken), fetchAccessToken(credentials)]);

  if (!uid) {
    throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해주세요.", "Invalid auth token");
  }

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

async function streamBlobAttachment(request, response) {
  ensureBlobConfigured();

  const url = new URL(request.url, "https://quickmemo.local");
  const scope = url.searchParams.get("scope");
  const attachmentId = safeId(url.searchParams.get("attachmentId"), "attachmentId");
  const credentials = firebaseCredentials();
  const accessToken = await fetchAccessToken(credentials);
  let attachment;
  let publicShare;

  if (scope === "note") {
    const idToken = authToken(request);

    if (!idToken) {
      throw new HttpError(401, "로그인이 필요합니다.", "Missing auth token");
    }

    const uid = await lookupCallerUid(idToken);
    const noteId = safeId(url.searchParams.get("noteId"), "noteId");
    const note = await firestoreGetDocument(credentials.projectId, `notes/${noteId}`, accessToken);

    if (!uid || !note || !(await canReadNote(credentials.projectId, uid, note, accessToken))) {
      throw new HttpError(403, "첨부파일을 읽을 권한이 없습니다.", "Cannot read note attachment");
    }

    attachment = await firestoreGetDocument(credentials.projectId, `notes/${noteId}/attachments/${attachmentId}`, accessToken);
  } else if (scope === "publicShare") {
    const shareId = safeId(url.searchParams.get("shareId"), "shareId");
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

  const blob = await get(blobPath, { access: "private", useCache: false });

  if (!blob || blob.statusCode !== 200 || !blob.stream) {
    throw new HttpError(404, "첨부파일을 찾을 수 없습니다.", "Blob not found");
  }
  if (!blobMetadataMatchesAttachment(blob.blob, blobPath, encryptedSize)) {
    await blob.stream.cancel().catch(() => undefined);
    throw new HttpError(404, "첨부파일을 찾을 수 없습니다.", "Blob metadata mismatch");
  }

  response.statusCode = 200;
  response.setHeader("content-type", blobContentType);
  response.setHeader("content-length", String(blob.blob.size));
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
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

async function beginAttachmentDeletion(projectId, accessToken, attachmentPath, notePath = "") {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attachment = await firestoreGetDocument(projectId, attachmentPath, accessToken);

    if (!attachment) {
      return null;
    }

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
      const claimedNote = secureShareCopyJobId && notePath
        ? await firestoreGetDocument(projectId, notePath, accessToken)
        : null;

      if (secureShareCopyCleanupClaimed(claimedNote)) {
        throw new HttpError(
          409,
          "서버에서 복사 첨부파일을 정리하고 있습니다.",
          "Secure share copy cleanup already claimed"
        );
      }
      return attachment;
    }

    const attachmentFields = { deletionStarted: booleanValue(true) };
    const attachmentFieldPaths = ["deletionStarted"];
    const writes = [];
    const note = notePath && (shouldBumpRevision || (secureShareCopyJobId && !deletionStarted))
      ? await firestoreGetDocument(projectId, notePath, accessToken)
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
        noteFieldPaths.push("attachmentRevision");
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

async function deleteAttachment(request, response) {
  const idToken = authToken(request);

  if (!idToken) {
    throw new HttpError(401, "로그인이 필요합니다.", "Missing auth token");
  }

  const body = await readJsonBody(request);
  const scope = body.scope === "publicShare" ? "publicShare" : body.scope === "note" ? "note" : "";
  const attachmentId = safeId(body.attachmentId, "attachmentId");
  const credentials = firebaseCredentials();
  const [uid, accessToken] = await Promise.all([lookupCallerUid(idToken), fetchAccessToken(credentials)]);

  if (!uid) {
    throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해주세요.", "Invalid auth token");
  }

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
      `notes/${noteId}`
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

    const deletingAttachment = await beginAttachmentDeletion(credentials.projectId, accessToken, attachmentPath);

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

  jsonResponse(response, statusCode, { ok: false, error: message });
}

export {
  claimAttachmentDeletion,
  publicShareAttachmentIsCurrent,
  reserveUserAttachmentBytes
};

export default async function handler(request, response) {
  try {
    if (request.method === "POST") {
      await handleBlobUploadRequest(request, response, await readJsonBody(request));
      return;
    }

    if (request.method === "PATCH") {
      await completeUploadFromClient(request, response);
      return;
    }

    if (request.method === "GET") {
      await streamBlobAttachment(request, response);
      return;
    }

    if (request.method === "DELETE") {
      await deleteAttachment(request, response);
      return;
    }

    response.setHeader("allow", "GET, POST, PATCH, DELETE");
    jsonResponse(response, 405, { ok: false, error: "method_not_allowed" });
  } catch (error) {
    handleError(error, response);
  }
}
