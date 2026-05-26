/* global Buffer, URL, URLSearchParams, console, crypto, fetch, process */

import { del, get, head } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import { Readable } from "node:stream";

const firestoreBaseUrl = "https://firestore.googleapis.com/v1";
const identityToolkitBaseUrl = "https://identitytoolkit.googleapis.com/v1";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const databaseId = "(default)";
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const blobContentType = "application/octet-stream";
const maxAttachmentFileBytes = 50 * 1024 * 1024;
const encryptedAttachmentOverheadBytes = 16;
const maxEncryptedAttachmentBytes = maxAttachmentFileBytes + encryptedAttachmentOverheadBytes;
const userBlobAttachmentQuotaBytes = 1024 * 1024 * 1024;
const tokenTtlMs = 10 * 60 * 1000;
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

  return { clientEmail, privateKey, projectId };
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

async function fetchAccessToken(credentials) {
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
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OAuth token request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  const token = await response.json();

  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new Error("OAuth token response did not include an access token");
  }

  return token.access_token;
}

async function lookupCallerUid(idToken) {
  const apiKey = firebaseWebApiKey();

  if (!apiKey) {
    throw new HttpError(503, "첨부파일 인증 설정이 완료되지 않았습니다.", "Missing Firebase web API key");
  }

  const response = await fetch(`${identityToolkitBaseUrl}/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken })
  });

  if (!response.ok) {
    return "";
  }

  const result = await response.json();
  const uid = result.users?.[0]?.localId;

  return typeof uid === "string" ? uid : "";
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

function timestampValue(value) {
  return { timestampValue: value instanceof Date ? value.toISOString() : value };
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

function validateAttachmentSizes(originalSize, encryptedSize) {
  if (originalSize > maxAttachmentFileBytes || encryptedSize > maxEncryptedAttachmentBytes || encryptedSize !== originalSize + encryptedAttachmentOverheadBytes) {
    throw new HttpError(400, "첨부파일은 50.00 MB 이하만 업로드할 수 있습니다.", "Invalid attachment size");
  }
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

  validateAttachmentSizes(originalSize, encryptedSize);

  return {
    scope,
    attachmentId: safeId(parsed.attachmentId, "attachmentId"),
    noteId: scope === "note" ? safeId(parsed.noteId, "noteId") : "",
    shareId: scope === "publicShare" ? safeId(parsed.shareId, "shareId") : "",
    fileName: safeFileName(parsed.fileName),
    extension: safeExtension(parsed.extension),
    mimeType: safeMimeType(parsed.mimeType),
    originalSize,
    encryptedSize,
    ivBase64: validateIvBase64(parsed.ivBase64),
    uploadedBy: scope === "note" ? safeId(parsed.uploadedBy, "uploadedBy") : "",
    sourceAttachmentId:
      scope === "publicShare" && typeof parsed.sourceAttachmentId === "string"
        ? safeId(parsed.sourceAttachmentId, "sourceAttachmentId")
        : ""
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
    isActive: valueBoolean(document, "isActive"),
    isAdmin: valueBoolean(document, "isAdmin"),
    allowedShareTargetUids: valueStringArray(document, "allowedShareTargetUids")
  };
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

function ownerAllowsParticipant(note, uid, ownerProfile) {
  const ownerUid = valueString(note, "ownerUid");

  return uid === ownerUid || ownerProfile.isAdmin || ownerProfile.allowedShareTargetUids.includes(uid);
}

async function canReadNote(projectId, uid, note, accessToken) {
  const callerProfile = await userProfile(projectId, uid, accessToken);

  if (!callerProfile.isActive) {
    return false;
  }

  const ownerUid = valueString(note, "ownerUid");
  const participantUids = valueStringArray(note, "participantUids");

  if (noteIsDeleted(note)) {
    return callerProfile.isAdmin || ownerUid === uid;
  }

  if (!noteIsActive(note) || noteIsPurged(note)) {
    return false;
  }

  if (callerProfile.isAdmin || ownerUid === uid) {
    return true;
  }

  if (!participantUids.includes(uid)) {
    return false;
  }

  return ownerAllowsParticipant(note, uid, await userProfile(projectId, ownerUid, accessToken));
}

async function canUploadToNote(projectId, uid, note, accessToken) {
  if (noteIsDeleted(note) || noteIsPurged(note)) {
    return false;
  }

  const callerProfile = await userProfile(projectId, uid, accessToken);

  return callerProfile.isActive && valueStringArray(note, "participantUids").includes(uid);
}

function publicShareActive(share, now = Date.now()) {
  const expiresAt = valueTimestampMillis(share, "expiresAt");

  return valueBoolean(share, "ready") && !share?.fields?.revokedAt && Number.isFinite(expiresAt) && expiresAt > now;
}

async function reserveUserAttachmentBytes(projectId, accessToken, uid, bytes, extraWrites) {
  const quotaPath = `userAttachmentUsage/${uid}`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const quotaDocument = await firestoreGetDocument(projectId, quotaPath, accessToken);
    const usedBytes = valueInteger(quotaDocument, "usedBytes");

    if (usedBytes + bytes > userBlobAttachmentQuotaBytes) {
      throw new HttpError(413, "첨부파일 총 저장 한도 1.00 GB를 초과했습니다.", "Blob attachment quota exceeded");
    }

    const quotaWrite = {
      update: {
        name: documentName(projectId, quotaPath),
        fields: {
          uid: stringValue(uid),
          usedBytes: integerValue(usedBytes + bytes),
          limitBytes: integerValue(userBlobAttachmentQuotaBytes)
        }
      },
      currentDocument: quotaDocument ? { updateTime: quotaDocument.updateTime } : { exists: false },
      updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
    };

    try {
      await firestoreCommit(projectId, accessToken, [quotaWrite, ...extraWrites]);
      return;
    } catch (error) {
      if (![400, 409].includes(error.statusCode) || attempt === 2) {
        throw error;
      }
    }
  }
}

async function releaseUserAttachmentBytes(projectId, accessToken, uid, bytes, extraWrites = []) {
  if (!uid || bytes <= 0) {
    await firestoreCommit(projectId, accessToken, extraWrites);
    return;
  }

  const quotaPath = `userAttachmentUsage/${uid}`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const quotaDocument = await firestoreGetDocument(projectId, quotaPath, accessToken);
    const usedBytes = Math.max(0, valueInteger(quotaDocument, "usedBytes") - bytes);
    const writes = [...extraWrites];

    if (quotaDocument) {
      writes.push({
        update: {
          name: documentName(projectId, quotaPath),
          fields: {
            uid: stringValue(uid),
            usedBytes: integerValue(usedBytes),
            limitBytes: integerValue(userBlobAttachmentQuotaBytes)
          }
        },
        currentDocument: { updateTime: quotaDocument.updateTime },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      });
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

function attachmentBaseFields(payload, blobPath) {
  return {
    version: integerValue(1),
    algorithm: stringValue("AES-GCM"),
    fileName: stringValue(payload.fileName),
    extension: stringValue(payload.extension),
    mimeType: stringValue(payload.mimeType),
    originalSize: integerValue(payload.originalSize),
    encryptedSize: integerValue(payload.encryptedSize),
    storageProvider: stringValue("vercel-blob"),
    blobPath: stringValue(blobPath),
    isReady: booleanValue(false),
    iv: bytesValue(payload.ivBase64)
  };
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
  const write = {
    update: {
      name: documentName(projectId, attachmentPath),
      fields: {
        noteId: stringValue(payload.noteId),
        ...attachmentBaseFields(payload, expectedPath),
        uploadedBy: stringValue(uid)
      }
    },
    currentDocument: { exists: false },
    updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]
  };

  await reserveUserAttachmentBytes(projectId, accessToken, uid, payload.encryptedSize, [write]);

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

  if (!share || !ownerProfile.isActive || ownerUid !== uid || share?.fields?.revokedAt || !expiresAt || Date.parse(expiresAt) <= Date.now()) {
    throw new HttpError(403, "공유 첨부파일 업로드 권한이 없습니다.", "Cannot upload to public share");
  }

  const expectedPath = publicShareBlobPath(uid, payload.shareId, payload.attachmentId);

  if (pathname !== expectedPath) {
    throw new HttpError(400, "공유 첨부파일 저장 경로가 올바르지 않습니다.", "Public share pathname mismatch");
  }

  const attachmentPath = `publicNoteShares/${payload.shareId}/attachments/${payload.attachmentId}`;
  const cleanupPath = `publicShareCleanupQueue/${payload.shareId}/publicShareAttachmentCleanupQueue/${payload.attachmentId}`;
  const fields = {
    ...attachmentBaseFields(payload, expectedPath),
    ownerUid: stringValue(uid),
    expiresAt: timestampValue(expiresAt)
  };

  if (payload.sourceAttachmentId) {
    fields.sourceAttachmentId = stringValue(payload.sourceAttachmentId);
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
  const protocol = request.headers["x-forwarded-proto"] || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host;

  if (!host) {
    return undefined;
  }

  return `${Array.isArray(protocol) ? protocol[0] : protocol}://${Array.isArray(host) ? host[0] : host}/api/blob-attachments`;
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

async function markAttachmentReady(projectId, accessToken, tokenPayload, uploadedBlob) {
  if (uploadedBlob.pathname !== tokenPayload.blobPath) {
    throw new Error("Uploaded blob pathname mismatch");
  }

  const blob = await validateUploadedBlob(tokenPayload.blobPath, tokenPayload.encryptedSize);
  const document = await firestoreGetDocument(projectId, tokenPayload.attachmentPath, accessToken);

  if (!document) {
    throw new Error("Attachment reservation no longer exists");
  }

  if (valueBoolean(document, "isReady")) {
    return;
  }

  await firestoreCommit(projectId, accessToken, [
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
        fieldPaths: ["isReady", "blobUrl", "blobDownloadUrl", "blobEtag"]
      },
      currentDocument: { exists: true }
    }
  ]);
}

async function onUploadCompleted({ blob, tokenPayload }) {
  const credentials = firebaseCredentials();
  const accessToken = await fetchAccessToken(credentials);

  await markAttachmentReady(credentials.projectId, accessToken, parseTokenPayload(tokenPayload), blob);
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

    if (!attachment || valueString(attachment, "uploadedBy") !== uid) {
      throw new HttpError(403, "첨부파일 업로드 완료 권한이 없습니다.", "Cannot complete note attachment");
    }

    tokenPayload = {
      attachmentPath,
      blobPath: valueString(attachment, "blobPath"),
      encryptedSize: valueInteger(attachment, "encryptedSize")
    };
  } else if (scope === "publicShare") {
    const shareId = safeId(body.shareId, "shareId");
    const share = await firestoreGetDocument(credentials.projectId, `publicNoteShares/${shareId}`, accessToken);
    const attachmentPath = `publicNoteShares/${shareId}/attachments/${attachmentId}`;
    const attachment = await firestoreGetDocument(credentials.projectId, attachmentPath, accessToken);
    const callerProfile = await userProfile(credentials.projectId, uid, accessToken);

    if (!share || !attachment || !callerProfile.isActive || valueString(share, "ownerUid") !== uid) {
      throw new HttpError(403, "공유 첨부파일 업로드 완료 권한이 없습니다.", "Cannot complete public share attachment");
    }

    tokenPayload = {
      attachmentPath,
      blobPath: valueString(attachment, "blobPath"),
      encryptedSize: valueInteger(attachment, "encryptedSize")
    };
  } else {
    throw new HttpError(400, "첨부파일 업로드 범위가 올바르지 않습니다.", "Invalid scope");
  }

  if (!body.blob || body.blob.pathname !== tokenPayload.blobPath) {
    throw new HttpError(400, "업로드된 첨부파일 정보가 올바르지 않습니다.", "Invalid uploaded blob");
  }

  await markAttachmentReady(credentials.projectId, accessToken, tokenPayload, body.blob);
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

    if (!share || !publicShareActive(share)) {
      throw new HttpError(403, "공유 첨부파일을 읽을 수 없습니다.", "Inactive public share");
    }

    attachment = await firestoreGetDocument(credentials.projectId, `publicNoteShares/${shareId}/attachments/${attachmentId}`, accessToken);
  } else {
    throw new HttpError(400, "첨부파일 조회 범위가 올바르지 않습니다.", "Invalid scope");
  }

  const blobPath = valueString(attachment, "blobPath");
  const encryptedSize = valueInteger(attachment, "encryptedSize");

  if (!attachment || !valueBoolean(attachment, "isReady") || !blobPath || encryptedSize > maxEncryptedAttachmentBytes) {
    throw new HttpError(404, "첨부파일을 찾을 수 없습니다.", "Attachment blob not ready");
  }

  const blob = await get(blobPath, { access: "private", useCache: false });

  if (!blob || blob.statusCode !== 200 || !blob.stream || blob.blob.size !== encryptedSize) {
    throw new HttpError(404, "첨부파일을 찾을 수 없습니다.", "Blob not found");
  }

  response.statusCode = 200;
  response.setHeader("content-type", blobContentType);
  response.setHeader("content-length", String(encryptedSize));
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  Readable.fromWeb(blob.stream).pipe(response);
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
    const canDelete =
      Boolean(note && attachment)
      && callerProfile.isActive
      && (callerProfile.isAdmin || (valueStringArray(note, "participantUids").includes(uid) && [valueString(note, "ownerUid"), valueString(attachment, "uploadedBy")].includes(uid)));

    if (!canDelete) {
      throw new HttpError(403, "첨부파일 삭제 권한이 없습니다.", "Cannot delete note attachment");
    }

    await deleteBlobIfPresent(valueString(attachment, "blobPath"));
    await releaseUserAttachmentBytes(credentials.projectId, accessToken, valueString(attachment, "uploadedBy"), valueInteger(attachment, "encryptedSize"), [
      { delete: documentName(credentials.projectId, attachmentPath) }
    ]);
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

    if (!share || !attachment || !callerProfile.isActive || valueString(share, "ownerUid") !== uid) {
      throw new HttpError(403, "공유 첨부파일 삭제 권한이 없습니다.", "Cannot delete public share attachment");
    }

    await deleteBlobIfPresent(valueString(attachment, "blobPath"));
    await releaseUserAttachmentBytes(credentials.projectId, accessToken, uid, valueInteger(attachment, "encryptedSize"), [
      { delete: documentName(credentials.projectId, attachmentPath) },
      { delete: documentName(credentials.projectId, cleanupPath) }
    ]);
    jsonResponse(response, 200, { ok: true });
    return;
  }

  throw new HttpError(400, "첨부파일 삭제 범위가 올바르지 않습니다.", "Invalid scope");
}

function handleError(error, response) {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof HttpError ? error.publicMessage : "첨부파일 서버 작업에 실패했습니다.";

  if (!(error instanceof HttpError)) {
    console.error("blob attachment request failed", error);
  }

  jsonResponse(response, statusCode, { ok: false, error: message });
}

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
