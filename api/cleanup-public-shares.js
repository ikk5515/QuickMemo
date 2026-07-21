/* global Buffer, URLSearchParams, console, crypto, fetch, process */
import { del } from "@vercel/blob";
import { createHash, timingSafeEqual } from "node:crypto";
import { quotaReleaseAfterAttachmentClaim } from "./_attachment-policy.js";

const firestoreBaseUrl = "https://firestore.googleapis.com/v1";
const storageBaseUrl = "https://storage.googleapis.com/storage/v1";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const databaseId = "(default)";
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const defaultBatchSize = 50;
const defaultMaxDocumentDeletes = 1000;
const firestoreCommitWriteLimit = 500;
const userBlobAttachmentQuotaBytes = 1024 * 1024 * 1024;
const userBlobAttachmentCountLimit = 500;
const attachmentCountPolicyVersion = 1;
const deletionRetryDelayMs = 15 * 60 * 1000;
const legacyReservationGraceMs = 3 * 60 * 60 * 1000;

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

const sensitiveLogPatterns = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /"access_token"\s*:\s*"[^"]+"/giu,
  /"idToken"\s*:\s*"[^"]+"/giu,
  /"private_key"\s*:\s*"[^"]+"/giu,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
  /AIza[0-9A-Za-z_-]{35}/gu,
  /gh[pousr]_[A-Za-z0-9_]{36,}/gu,
  /xox[baprs]-[A-Za-z0-9-]{20,}/gu
];

function redactLogMessage(value) {
  return String(value)
    .replace(sensitiveLogPatterns[0], "Bearer [redacted]")
    .replace(sensitiveLogPatterns[1], '"access_token":"[redacted]"')
    .replace(sensitiveLogPatterns[2], '"idToken":"[redacted]"')
    .replace(sensitiveLogPatterns[3], '"private_key":"[redacted]"')
    .replace(sensitiveLogPatterns[4], "[redacted private key]")
    .replace(sensitiveLogPatterns[5], "[redacted api key]")
    .replace(sensitiveLogPatterns[6], "[redacted github token]")
    .replace(sensitiveLogPatterns[7], "[redacted slack token]")
    .slice(0, 1000);
}

function errorNumberField(error, fieldName) {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const value = error[fieldName];
  return Number.isInteger(value) ? value : undefined;
}

function safeErrorSummary(error) {
  if (error instanceof Error) {
    return {
      message: redactLogMessage(error.message),
      name: error.name,
      status: errorNumberField(error, "status"),
      statusCode: errorNumberField(error, "statusCode")
    };
  }

  return {
    message: redactLogMessage(error)
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function timingSafeStringEqual(left, right) {
  return timingSafeEqual(sha256(left), sha256(right));
}

function authorizationHeader(request) {
  const value = request.headers.authorization;

  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return typeof value === "string" ? value : "";
}

function authorizedCleanupRequest(request, cronSecret) {
  return timingSafeStringEqual(authorizationHeader(request), `Bearer ${cronSecret}`);
}

function configuredInteger(name, fallback, min, max) {
  const parsed = Number.parseInt(envValue(name), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function parseJsonCredential(value) {
  if (!value) {
    return {};
  }

  const trimmed = value.trim();
  const json = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  return JSON.parse(json);
}

function cleanupCredentials() {
  const credentialJson = parseJsonCredential(envValue("FIREBASE_CLEANUP_SERVICE_ACCOUNT_JSON"));
  const clientEmail = envValue("FIREBASE_CLEANUP_CLIENT_EMAIL") || credentialJson.client_email || "";
  const privateKey = (envValue("FIREBASE_CLEANUP_PRIVATE_KEY") || credentialJson.private_key || "").replace(/\\n/g, "\n");
  const projectId =
    envValue("FIREBASE_CLEANUP_PROJECT_ID") ||
    credentialJson.project_id ||
    envValue("VITE_FIREBASE_PROJECT_ID") ||
    envValue("GOOGLE_CLOUD_PROJECT");

  if (!clientEmail || !privateKey || !projectId) {
    throw new Error("Missing Firebase cleanup service credentials");
  }

  return {
    clientEmail,
    privateKey,
    projectId,
    storageBucket: envValue("FIREBASE_STORAGE_BUCKET") || envValue("VITE_FIREBASE_STORAGE_BUCKET") || `${projectId}.appspot.com`
  };
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
  const signature = await signJwt(credentials.privateKey, unsignedJwt);
  const assertion = `${unsignedJwt}.${signature}`;
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

function encodeDocumentPath(documentPath) {
  return documentPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function documentsResourceRoot(projectId) {
  return `projects/${projectId}/databases/${databaseId}/documents`;
}

async function firestoreRequest(path, accessToken, init) {
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

async function storageDeleteObject(bucket, objectName, accessToken) {
  if (!bucket || !objectName) {
    return false;
  }

  const response = await fetch(
    `${storageBaseUrl}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` }
    }
  );

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Storage delete failed: ${response.status} ${text.slice(0, 300)}`);
  }

  return true;
}

function firestoreCommitPathFromDocumentName(documentName) {
  const marker = "/documents/";
  const markerIndex = documentName.indexOf(marker);

  if (markerIndex < 0) {
    throw new Error("Invalid Firestore document name");
  }

  return `${documentName.slice(0, markerIndex + marker.length - 1)}:commit`;
}

async function firestoreDeleteMany(documentNames, accessToken) {
  const uniqueNames = Array.from(new Set(documentNames.filter(Boolean)));

  for (let index = 0; index < uniqueNames.length; index += firestoreCommitWriteLimit) {
    const chunk = uniqueNames.slice(index, index + firestoreCommitWriteLimit);

    if (!chunk.length) {
      continue;
    }

    await firestoreRequest(firestoreCommitPathFromDocumentName(chunk[0]), accessToken, {
      method: "POST",
      body: JSON.stringify({
        writes: chunk.map((documentName) => ({ delete: documentName }))
      })
    });
  }

  return uniqueNames.length;
}

async function deleteDocumentNames(documentNames, accessToken, stats, counterName) {
  const remainingDeletes = Math.max(0, stats.maxDocumentDeletes - stats.documentDeletesAttempted);
  const names = documentNames.slice(0, remainingDeletes);

  if (!names.length) {
    return 0;
  }

  const deletedCount = await firestoreDeleteMany(names, accessToken);

  stats.documentDeletesAttempted += deletedCount;
  stats[counterName] += deletedCount;

  return deletedCount;
}

async function queryExpiredShareQueues({ accessToken, projectId, nowIso, limit }) {
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [{ fieldPath: "__name__" }]
        },
        from: [{ collectionId: "publicShareCleanupQueue" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "expiresAt" },
            op: "LESS_THAN_OR_EQUAL",
            value: { timestampValue: nowIso }
          }
        },
        orderBy: [
          {
            field: { fieldPath: "expiresAt" },
            direction: "ASCENDING"
          }
        ],
        limit
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

export function googleCalendarOAuthStateCleanupBatchLimit(batchSize, maxDocumentDeletes) {
  return Math.min(batchSize, Math.max(1, Math.floor(maxDocumentDeletes / 10)));
}

export async function queryExpiredGoogleCalendarOAuthStates({ accessToken, projectId, nowIso, limit }) {
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [{ fieldPath: "__name__" }]
        },
        from: [{ collectionId: "googleCalendarOAuthStates" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "expiresAt" },
            op: "LESS_THAN_OR_EQUAL",
            value: { timestampValue: nowIso }
          }
        },
        orderBy: [
          {
            field: { fieldPath: "expiresAt" },
            direction: "ASCENDING"
          }
        ],
        limit
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

async function cleanupExpiredGoogleCalendarOAuthStates(config, stats) {
  const limit = googleCalendarOAuthStateCleanupBatchLimit(config.limit, stats.maxDocumentDeletes);
  const documents = await queryExpiredGoogleCalendarOAuthStates({ ...config, limit });

  return deleteDocumentNames(
    documents.map((document) => document.name),
    config.accessToken,
    stats,
    "googleCalendarOAuthStatesDeleted"
  );
}

async function queryExpiredShares({ accessToken, projectId, nowIso, limit }) {
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [{ fieldPath: "__name__" }]
        },
        from: [{ collectionId: "publicNoteShares" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "expiresAt" },
            op: "LESS_THAN_OR_EQUAL",
            value: { timestampValue: nowIso }
          }
        },
        orderBy: [
          {
            field: { fieldPath: "expiresAt" },
            direction: "ASCENDING"
          }
        ],
        limit
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

async function queryExpiredPublicShareAttachments({ accessToken, projectId, nowIso, limit }) {
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [{ fieldPath: "__name__" }]
        },
        from: [{ collectionId: "attachments", allDescendants: true }],
        where: {
          fieldFilter: {
            field: { fieldPath: "expiresAt" },
            op: "LESS_THAN_OR_EQUAL",
            value: { timestampValue: nowIso }
          }
        },
        orderBy: [
          {
            field: { fieldPath: "expiresAt" },
            direction: "ASCENDING"
          }
        ],
        limit
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

async function queryExpiredAttachmentReservations({ accessToken, projectId, nowIso, limit }) {
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [{ fieldPath: "__name__" }]
        },
        from: [{ collectionId: "attachments", allDescendants: true }],
        where: {
          fieldFilter: {
            field: { fieldPath: "reservationExpiresAt" },
            op: "LESS_THAN_OR_EQUAL",
            value: { timestampValue: nowIso }
          }
        },
        orderBy: [
          {
            field: { fieldPath: "reservationExpiresAt" },
            direction: "ASCENDING"
          }
        ],
        limit
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

async function queryAbandonedAttachmentDeletions({ accessToken, projectId, nowIso, limit }) {
  const cutoffIso = new Date(Date.parse(nowIso) - deletionRetryDelayMs).toISOString();
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [{ fieldPath: "__name__" }]
        },
        from: [{ collectionId: "attachments", allDescendants: true }],
        where: {
          fieldFilter: {
            field: { fieldPath: "deletionStartedAt" },
            op: "LESS_THAN_OR_EQUAL",
            value: { timestampValue: cutoffIso }
          }
        },
        orderBy: [
          {
            field: { fieldPath: "deletionStartedAt" },
            direction: "ASCENDING"
          }
        ],
        limit
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

async function queryLegacyExpiredAttachmentReservations({ accessToken, projectId, nowIso, limit }) {
  const cutoffIso = new Date(Date.parse(nowIso) - legacyReservationGraceMs).toISOString();
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [{ fieldPath: "__name__" }]
        },
        from: [{ collectionId: "attachments", allDescendants: true }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: "storageProvider" },
                  op: "EQUAL",
                  value: { stringValue: "vercel-blob" }
                }
              },
              {
                fieldFilter: {
                  field: { fieldPath: "isReady" },
                  op: "EQUAL",
                  value: { booleanValue: false }
                }
              },
              {
                fieldFilter: {
                  field: { fieldPath: "createdAt" },
                  op: "LESS_THAN_OR_EQUAL",
                  value: { timestampValue: cutoffIso }
                }
              }
            ]
          }
        },
        orderBy: [
          {
            field: { fieldPath: "createdAt" },
            direction: "ASCENDING"
          }
        ],
        limit
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

async function queryPurgedNotes({ accessToken, projectId, limit }) {
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [
            { fieldPath: "ownerUid" },
            { fieldPath: "isDeleted" },
            { fieldPath: "isPurged" }
          ]
        },
        from: [{ collectionId: "notes" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "isPurged" },
            op: "EQUAL",
            value: { booleanValue: true }
          }
        },
        limit
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

async function queryActiveNotesByNoteId({ accessToken, projectId, noteId, limit = 300 }) {
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [{ fieldPath: "__name__" }]
        },
        from: [{ collectionId: "activeNotes" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "noteId" },
            op: "EQUAL",
            value: { stringValue: noteId }
          }
        },
        limit
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

async function listChildDocuments(
  parentName,
  collectionId,
  accessToken,
  maxDocuments = Number.POSITIVE_INFINITY,
  fieldMask = []
) {
  const documents = [];
  let pageToken = "";

  do {
    const remaining = Math.max(0, maxDocuments - documents.length);

    if (remaining === 0) {
      break;
    }

    const query = new URLSearchParams({ pageSize: String(Math.min(300, remaining)) });

    for (const fieldPath of fieldMask) {
      query.append("mask.fieldPaths", fieldPath);
    }

    if (pageToken) {
      query.set("pageToken", pageToken);
    }

    const response = await fetch(
      `${firestoreBaseUrl}/${encodeDocumentPath(parentName)}/${encodeURIComponent(collectionId)}?${query.toString()}`,
      {
        headers: { authorization: `Bearer ${accessToken}` }
      }
    );

    if (response.status === 404) {
      return documents;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Firestore list failed: ${response.status} ${text.slice(0, 300)}`);
    }

    const result = await response.json();
    documents.push(...(result.documents ?? []).slice(0, remaining));
    pageToken = result.nextPageToken ?? "";
  } while (pageToken && documents.length < maxDocuments);

  return documents;
}

function stringField(document, fieldName) {
  const value = document?.fields?.[fieldName]?.stringValue;
  return typeof value === "string" ? value : "";
}

function integerField(document, fieldName) {
  const value = document?.fields?.[fieldName]?.integerValue;
  const parsed = typeof value === "string" || typeof value === "number" ? Number.parseInt(String(value), 10) : Number.NaN;

  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function booleanField(document, fieldName) {
  return document?.fields?.[fieldName]?.booleanValue === true;
}

function hasField(document, fieldName) {
  return Boolean(document?.fields && Object.hasOwn(document.fields, fieldName));
}

function timestampFieldMillis(document, fieldName) {
  const value = document?.fields?.[fieldName]?.timestampValue;
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function integerValue(value) {
  return { integerValue: String(value) };
}

function documentNameForPath(projectId, documentPath) {
  return `${documentsResourceRoot(projectId)}/${documentPath}`;
}

async function getDocumentByName(documentName, accessToken) {
  const response = await fetch(`${firestoreBaseUrl}/${encodeDocumentPath(documentName)}`, {
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

async function beginAttachmentDeletionByName(documentName, accessToken, shouldDelete = () => true) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attachment = await getDocumentByName(documentName, accessToken);

    if (!attachment || !shouldDelete(attachment)) {
      return null;
    }

    if (booleanField(attachment, "deletionStarted")) {
      return attachment;
    }

    try {
      await firestoreRequest(firestoreCommitPathFromDocumentName(documentName), accessToken, {
        method: "POST",
        body: JSON.stringify({
          writes: [
            {
              update: {
                name: documentName,
                fields: { deletionStarted: { booleanValue: true } }
              },
              updateMask: { fieldPaths: ["deletionStarted"] },
              currentDocument: { updateTime: attachment.updateTime },
              updateTransforms: [{ fieldPath: "deletionStartedAt", setToServerValue: "REQUEST_TIME" }]
            }
          ]
        })
      });
      return attachment;
    } catch (error) {
      if (![400, 409].includes(error.statusCode)) {
        throw error;
      }

      if (attempt === 2) {
        return null;
      }
    }
  }

  return null;
}

async function claimAttachmentDeletionByName(
  projectId,
  attachmentName,
  accessToken,
  stats,
  extraDeleteNames = []
) {
  const deleteCount = 1 + extraDeleteNames.filter(Boolean).length;

  if (stats.documentDeletesAttempted + deleteCount > stats.maxDocumentDeletes) {
    return null;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attachment = await getDocumentByName(attachmentName, accessToken);

    if (!attachment) {
      return null;
    }

    const uid = stringField(attachment, "ownerUid") || stringField(attachment, "uploadedBy");
    const bytes = Math.max(0, integerField(attachment, "encryptedSize"));
    const quotaName = uid ? documentNameForPath(projectId, `userAttachmentUsage/${uid}`) : "";
    const quotaDocument = quotaName ? await getDocumentByName(quotaName, accessToken) : null;
    const claim = quotaReleaseAfterAttachmentClaim({
      attachmentExists: true,
      attachmentUpdateTime: attachment.updateTime,
      attachmentCount: integerField(quotaDocument, "attachmentCount"),
      encryptedSize: bytes,
      quotaReserved: hasField(attachment, "quotaReserved")
        ? booleanField(attachment, "quotaReserved")
        : null,
      legacyBlobReserved:
        !hasField(attachment, "quotaReserved")
        && stringField(attachment, "storageProvider") === "vercel-blob"
        && Boolean(stringField(attachment, "blobPath")),
      quotaExists: Boolean(quotaDocument),
      quotaUpdateTime: quotaDocument?.updateTime ?? "",
      uid,
      usedBytes: integerField(quotaDocument, "usedBytes")
    });

    if (!claim) {
      return null;
    }

    const writes = [
      {
        delete: attachmentName,
        currentDocument: { updateTime: claim.attachmentUpdateTime }
      },
      ...extraDeleteNames.filter(Boolean).map((name) => ({ delete: name }))
    ];

    if (claim.quota) {
      writes.push({
        update: {
          name: quotaName,
          fields: {
            uid: { stringValue: claim.quota.uid },
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

    try {
      await firestoreRequest(firestoreCommitPathFromDocumentName(attachmentName), accessToken, {
        method: "POST",
        body: JSON.stringify({ writes })
      });
      stats.documentDeletesAttempted += deleteCount;
      stats.attachmentsDeleted += 1;
      stats.attachmentQueuesDeleted += extraDeleteNames.filter(Boolean).length;

      if (claim.quota) {
        stats.storageBytesReleased += bytes;
      }

      return attachment;
    } catch (error) {
      if (![400, 409].includes(error.statusCode)) {
        throw error;
      }

      if (attempt === 2) {
        return null;
      }
    }
  }

  return null;
}

async function deleteAttachmentObjects(attachment, storageBucket, accessToken, stats) {
  const storagePath = stringField(attachment, "storagePath");
  const blobPath = stringField(attachment, "blobPath");

  if (storagePath && await storageDeleteObject(storageBucket, storagePath, accessToken)) {
    stats.storageObjectsDeleted += 1;
  }

  if (!blobPath) {
    return;
  }

  try {
    await del(blobPath);
    stats.blobObjectsDeleted += 1;
  } catch (error) {
    if (!/not\s+found/iu.test(String(error?.message ?? ""))) {
      throw error;
    }
  }
}

function cleanupQueueNameFromShareName(shareName) {
  return shareName.replace("/publicNoteShares/", "/publicShareCleanupQueue/");
}

function publicShareNameFromCleanupQueueName(cleanupQueueName) {
  return cleanupQueueName.replace("/publicShareCleanupQueue/", "/publicNoteShares/");
}

function parsePublicShareAttachmentName(attachmentName) {
  const marker = "/documents/publicNoteShares/";
  const markerIndex = attachmentName.indexOf(marker);

  if (markerIndex < 0) {
    return null;
  }

  const relativePath = attachmentName.slice(markerIndex + marker.length);
  const [shareId, collectionId, attachmentId] = relativePath.split("/");

  if (!shareId || collectionId !== "attachments" || !attachmentId) {
    return null;
  }

  return { attachmentId, shareId };
}

function cleanupAttachmentQueueNameFromAttachmentName(attachmentName) {
  const parsed = parsePublicShareAttachmentName(attachmentName);

  if (!parsed) {
    return "";
  }

  return attachmentName
    .slice(0, attachmentName.indexOf("/documents/") + "/documents/".length)
    .concat(
      `publicShareCleanupQueue/${parsed.shareId}/publicShareAttachmentCleanupQueue/${parsed.attachmentId}`
    );
}

async function cleanupAttachmentDocument(
  attachmentName,
  accessToken,
  storageBucket,
  stats,
  projectId,
  extraDeleteNames = [],
  shouldDelete = () => true
) {
  const attachment = await beginAttachmentDeletionByName(attachmentName, accessToken, shouldDelete);

  if (!attachment) {
    const attachmentStillExists = await getDocumentByName(attachmentName, accessToken);

    if (attachmentStillExists) {
      return false;
    }

    await deleteDocumentNames(
      extraDeleteNames,
      accessToken,
      stats,
      "attachmentQueuesDeleted"
    );
    return true;
  }

  await deleteAttachmentObjects(attachment, storageBucket, accessToken, stats);
  const claimed = await claimAttachmentDeletionByName(
    projectId,
    attachmentName,
    accessToken,
    stats,
    extraDeleteNames
  );

  return Boolean(claimed) || (await getDocumentByName(attachmentName, accessToken)) === null;
}

async function deletePublicShareTreeByName(shareName, accessToken, storageBucket, stats, projectId) {
  const cleanupQueueName = cleanupQueueNameFromShareName(shareName);
  const remainingAttachmentDeleteBudget = stats.maxDocumentDeletes - stats.documentDeletesAttempted;

  if (remainingAttachmentDeleteBudget <= 0) {
    return false;
  }

  const attachmentDocuments = await listChildDocuments(
    shareName,
    "attachments",
    accessToken,
    Math.min(300, Math.max(1, Math.floor(remainingAttachmentDeleteBudget / 2))),
    ["isReady"]
  );

  if (attachmentDocuments.length > 0 && remainingAttachmentDeleteBudget < 2) {
    return false;
  }

  for (const attachment of attachmentDocuments) {
    const cleanupAttachmentQueueName = cleanupAttachmentQueueNameFromAttachmentName(attachment.name);

    if (!await cleanupAttachmentDocument(
      attachment.name,
      accessToken,
      storageBucket,
      stats,
      projectId,
      cleanupAttachmentQueueName ? [cleanupAttachmentQueueName] : []
    )) {
      return false;
    }
  }

  if ((await listChildDocuments(shareName, "attachments", accessToken, 1, ["isReady"])).length > 0) {
    return false;
  }

  const remainingQueueDeleteBudget = stats.maxDocumentDeletes - stats.documentDeletesAttempted;

  if (remainingQueueDeleteBudget <= 0) {
    return false;
  }

  const cleanupAttachmentDocuments = await listChildDocuments(
    cleanupQueueName,
    "publicShareAttachmentCleanupQueue",
    accessToken,
    Math.min(300, remainingQueueDeleteBudget),
    ["expiresAt"]
  );

  await deleteDocumentNames(
    cleanupAttachmentDocuments.map((cleanupAttachment) => cleanupAttachment.name),
    accessToken,
    stats,
    "attachmentQueuesDeleted"
  );

  if (
    (await listChildDocuments(shareName, "attachments", accessToken, 1, ["isReady"])).length > 0
    || (
      await listChildDocuments(cleanupQueueName, "publicShareAttachmentCleanupQueue", accessToken, 1, ["expiresAt"])
    ).length > 0
  ) {
    return false;
  }

  if (stats.documentDeletesAttempted + 2 > stats.maxDocumentDeletes) {
    return false;
  }

  await deleteDocumentNames([shareName], accessToken, stats, "sharesDeleted");
  await deleteDocumentNames([cleanupQueueName], accessToken, stats, "shareQueuesDeleted");
  return true;
}

async function deletePublicShareTree(cleanupQueueDocument, accessToken, storageBucket, stats, projectId) {
  const shareName = publicShareNameFromCleanupQueueName(cleanupQueueDocument.name);

  await deletePublicShareTreeByName(shareName, accessToken, storageBucket, stats, projectId);
}

async function deleteExpiredPublicShareAttachment(attachmentDocument, accessToken, storageBucket, stats, projectId, nowIso) {
  const cleanupAttachmentQueueName = cleanupAttachmentQueueNameFromAttachmentName(attachmentDocument.name);

  if (!cleanupAttachmentQueueName) {
    return;
  }

  await cleanupAttachmentDocument(
    attachmentDocument.name,
    accessToken,
    storageBucket,
    stats,
    projectId,
    [cleanupAttachmentQueueName],
    (current) => {
      const expiresAt = timestampFieldMillis(current, "expiresAt");
      return Number.isFinite(expiresAt) && expiresAt <= Date.parse(nowIso);
    }
  );
}

async function deleteExpiredAttachmentReservation(attachmentDocument, accessToken, storageBucket, stats, projectId, nowIso) {
  const cleanupAttachmentQueueName = cleanupAttachmentQueueNameFromAttachmentName(attachmentDocument.name);
  const deleted = await cleanupAttachmentDocument(
    attachmentDocument.name,
    accessToken,
    storageBucket,
    stats,
    projectId,
    cleanupAttachmentQueueName ? [cleanupAttachmentQueueName] : [],
    (current) => {
      const expiresAt = timestampFieldMillis(current, "reservationExpiresAt");
      return !booleanField(current, "isReady")
        && Number.isFinite(expiresAt)
        && expiresAt <= Date.parse(nowIso);
    }
  );

  if (deleted) {
    stats.reservationsDeleted += 1;
  }
}

async function deleteAbandonedAttachmentDeletion(attachmentDocument, accessToken, storageBucket, stats, projectId) {
  const cleanupAttachmentQueueName = cleanupAttachmentQueueNameFromAttachmentName(attachmentDocument.name);
  const deleted = await cleanupAttachmentDocument(
    attachmentDocument.name,
    accessToken,
    storageBucket,
    stats,
    projectId,
    cleanupAttachmentQueueName ? [cleanupAttachmentQueueName] : [],
    (current) => booleanField(current, "deletionStarted")
      && Number.isFinite(timestampFieldMillis(current, "deletionStartedAt"))
  );

  if (deleted) {
    stats.abandonedDeletionsRetried += 1;
  }
}

async function deleteLegacyExpiredAttachmentReservation(
  attachmentDocument,
  accessToken,
  storageBucket,
  stats,
  projectId,
  nowIso
) {
  const cleanupAttachmentQueueName = cleanupAttachmentQueueNameFromAttachmentName(attachmentDocument.name);
  const cutoffMillis = Date.parse(nowIso) - legacyReservationGraceMs;
  const deleted = await cleanupAttachmentDocument(
    attachmentDocument.name,
    accessToken,
    storageBucket,
    stats,
    projectId,
    cleanupAttachmentQueueName ? [cleanupAttachmentQueueName] : [],
    (current) =>
      !hasField(current, "reservationExpiresAt")
      && stringField(current, "storageProvider") === "vercel-blob"
      && Boolean(stringField(current, "blobPath"))
      && !booleanField(current, "isReady")
      && Number.isFinite(timestampFieldMillis(current, "createdAt"))
      && timestampFieldMillis(current, "createdAt") <= cutoffMillis
  );

  if (deleted) {
    stats.legacyReservationsDeleted += 1;
  }
}

function documentIdFromName(documentName) {
  const segments = String(documentName).split("/");
  return segments.at(-1) ?? "";
}

function validPurgeQueue(queueDocument, noteDocument, projectId) {
  const queueId = documentIdFromName(queueDocument?.name);
  const noteId = stringField(queueDocument, "noteId");
  const ownerUid = stringField(queueDocument, "ownerUid");

  return /^[A-Za-z0-9_-]{1,160}$/u.test(noteId)
    && queueId === noteId
    && ownerUid.length > 0
    && noteDocument?.name === documentNameForPath(projectId, `notes/${noteId}`)
    && booleanField(noteDocument, "isDeleted")
    && booleanField(noteDocument, "isPurged")
    && stringField(noteDocument, "ownerUid") === ownerUid;
}

async function finalizePurgedNote(queueDocument, noteId, accessToken, stats, projectId) {
  if (stats.documentDeletesAttempted + 2 > stats.maxDocumentDeletes) {
    return false;
  }

  const queueName = documentNameForPath(projectId, `notePurgeCleanupQueue/${noteId}`);
  const noteName = documentNameForPath(projectId, `notes/${noteId}`);
  const [currentQueue, currentNote] = await Promise.all([
    getDocumentByName(queueName, accessToken),
    getDocumentByName(noteName, accessToken)
  ]);

  if (!currentQueue || !currentNote || !validPurgeQueue(currentQueue, currentNote, projectId)) {
    return false;
  }

  try {
    await firestoreRequest(firestoreCommitPathFromDocumentName(noteName), accessToken, {
      method: "POST",
      body: JSON.stringify({
        writes: [
          {
            delete: noteName,
            currentDocument: { updateTime: currentNote.updateTime }
          },
          {
            delete: queueName,
            currentDocument: { updateTime: currentQueue.updateTime }
          }
        ]
      })
    });
  } catch (error) {
    if ([400, 409].includes(error.statusCode)) {
      return false;
    }
    throw error;
  }

  stats.documentDeletesAttempted += 2;
  stats.purgedNotesDeleted += 1;
  stats.purgeQueuesDeleted += 1;
  return true;
}

async function cleanupPurgedNote(queueDocument, accessToken, storageBucket, stats, projectId) {
  const noteId = stringField(queueDocument, "noteId");

  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(noteId)) {
    stats.purgeQueuesSkipped += 1;
    return false;
  }

  const noteName = documentNameForPath(projectId, `notes/${noteId}`);
  const noteDocument = await getDocumentByName(noteName, accessToken);

  if (!noteDocument || !validPurgeQueue(queueDocument, noteDocument, projectId)) {
    stats.purgeQueuesSkipped += 1;
    return false;
  }

  const remainingAttachmentDeletes = Math.max(1, stats.maxDocumentDeletes - stats.documentDeletesAttempted);
  const attachmentDocuments = await listChildDocuments(
    noteName,
    "attachments",
    accessToken,
    Math.min(300, remainingAttachmentDeletes),
    ["isReady"]
  );

  for (const attachment of attachmentDocuments) {
    if (!await cleanupAttachmentDocument(
      attachment.name,
      accessToken,
      storageBucket,
      stats,
      projectId
    )) {
      return false;
    }
    stats.purgedNoteAttachmentsDeleted += 1;
  }

  if ((await listChildDocuments(noteName, "attachments", accessToken, 1, ["isReady"])).length > 0) {
    return false;
  }

  const remainingHistoryDeletes = Math.max(1, stats.maxDocumentDeletes - stats.documentDeletesAttempted);
  const historyDocuments = await listChildDocuments(
    noteName,
    "history",
    accessToken,
    Math.min(50, remainingHistoryDeletes),
    ["revision"]
  );
  await deleteDocumentNames(
    historyDocuments.map((history) => history.name),
    accessToken,
    stats,
    "noteHistoriesDeleted"
  );

  if ((await listChildDocuments(noteName, "history", accessToken, 1, ["revision"])).length > 0) {
    return false;
  }

  const noteStateParentName = documentNameForPath(projectId, `noteUserStates/${noteId}`);
  const remainingStateDeletes = Math.max(1, stats.maxDocumentDeletes - stats.documentDeletesAttempted);
  const noteStateDocuments = await listChildDocuments(
    noteStateParentName,
    "users",
    accessToken,
    Math.min(500, remainingStateDeletes),
    ["updatedAt"]
  );
  await deleteDocumentNames(
    noteStateDocuments.map((state) => state.name),
    accessToken,
    stats,
    "noteUserStatesDeleted"
  );

  if ((await listChildDocuments(noteStateParentName, "users", accessToken, 1, ["updatedAt"])).length > 0) {
    return false;
  }

  const remainingActiveNoteDeletes = Math.max(1, stats.maxDocumentDeletes - stats.documentDeletesAttempted);
  const activeNoteDocuments = await queryActiveNotesByNoteId({
    accessToken,
    projectId,
    noteId,
    limit: Math.min(500, remainingActiveNoteDeletes)
  });
  await deleteDocumentNames(
    activeNoteDocuments.map((activeNote) => activeNote.name),
    accessToken,
    stats,
    "activeNotesDeleted"
  );

  if ((await queryActiveNotesByNoteId({ accessToken, projectId, noteId, limit: 1 })).length > 0) {
    return false;
  }

  const finalized = await finalizePurgedNote(queueDocument, noteId, accessToken, stats, projectId);

  if (finalized) {
    stats.purgeQueuesProcessed += 1;
  }

  return finalized;
}

async function backfillNotePurgeQueues(config, stats) {
  const purgedNotes = await queryPurgedNotes(config);

  for (const noteDocument of purgedNotes) {
    const noteId = documentIdFromName(noteDocument.name);
    const ownerUid = stringField(noteDocument, "ownerUid");

    if (!/^[A-Za-z0-9_-]{1,160}$/u.test(noteId) || !ownerUid || !booleanField(noteDocument, "isPurged")) {
      continue;
    }

    const queueName = documentNameForPath(config.projectId, `notePurgeCleanupQueue/${noteId}`);

    if (await getDocumentByName(queueName, config.accessToken)) {
      continue;
    }

    try {
      await firestoreRequest(firestoreCommitPathFromDocumentName(queueName), config.accessToken, {
        method: "POST",
        body: JSON.stringify({
          writes: [
            {
              update: {
                name: queueName,
                fields: {
                  noteId: { stringValue: noteId },
                  ownerUid: { stringValue: ownerUid }
                }
              },
              currentDocument: { exists: false },
              updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]
            }
          ]
        })
      });
      stats.purgeQueuesBackfilled += 1;
    } catch (error) {
      if (![400, 409].includes(error.statusCode)) {
        throw error;
      }
    }
  }
}

async function cleanupNotePurgeQueues(config, stats) {
  const queueDocuments = await listChildDocuments(
    documentsResourceRoot(config.projectId),
    "notePurgeCleanupQueue",
    config.accessToken,
    config.limit,
    ["noteId", "ownerUid"]
  );

  for (const queueDocument of queueDocuments) {
    if (stats.documentDeletesAttempted >= stats.maxDocumentDeletes) {
      break;
    }

    await cleanupPurgedNote(
      queueDocument,
      config.accessToken,
      config.storageBucket,
      stats,
      config.projectId
    );
  }

  return queueDocuments.length;
}

async function cleanupExpiredPublicShares() {
  const credentials = cleanupCredentials();
  const accessToken = await fetchAccessToken(credentials);
  const config = {
    accessToken,
    projectId: credentials.projectId,
    storageBucket: credentials.storageBucket,
    nowIso: new Date().toISOString(),
    limit: configuredInteger("PUBLIC_SHARE_CLEANUP_BATCH_SIZE", defaultBatchSize, 1, 100)
  };
  const stats = {
    abandonedDeletionsRetried: 0,
    activeNotesDeleted: 0,
    attachmentQueuesDeleted: 0,
    attachmentsDeleted: 0,
    blobObjectsDeleted: 0,
    documentDeletesAttempted: 0,
    googleCalendarOAuthStatesDeleted: 0,
    maxDocumentDeletes: configuredInteger("PUBLIC_SHARE_CLEANUP_MAX_DELETES", defaultMaxDocumentDeletes, 10, 5000),
    legacyReservationsDeleted: 0,
    noteHistoriesDeleted: 0,
    noteUserStatesDeleted: 0,
    purgeQueuesDeleted: 0,
    purgeQueuesBackfilled: 0,
    purgeQueuesProcessed: 0,
    purgeQueuesSkipped: 0,
    purgedNoteAttachmentsDeleted: 0,
    purgedNotesDeleted: 0,
    reservationsDeleted: 0,
    shareQueuesDeleted: 0,
    sharesDeleted: 0,
    storageBytesReleased: 0,
    storageObjectsDeleted: 0
  };

  // Reserve at most 10% of the delete budget (and no more than one configured
  // batch) for expired OAuth state. This guarantees bounded daily retention
  // cleanup without allowing authorization churn to starve user-data queues.
  await cleanupExpiredGoogleCalendarOAuthStates(config, stats);
  await backfillNotePurgeQueues(config, stats);
  await cleanupNotePurgeQueues(config, stats);

  for (let pass = 0; pass < 20 && stats.documentDeletesAttempted < stats.maxDocumentDeletes; pass += 1) {
    let foundExpiredDocuments = false;
    const shareQueues = await queryExpiredShareQueues(config);

    foundExpiredDocuments ||= shareQueues.length > 0;

    for (const shareQueue of shareQueues) {
      if (stats.documentDeletesAttempted >= stats.maxDocumentDeletes) {
        break;
      }

      await deletePublicShareTree(shareQueue, accessToken, config.storageBucket, stats, config.projectId);
    }

    const shares = await queryExpiredShares(config);

    foundExpiredDocuments ||= shares.length > 0;

    for (const share of shares) {
      if (stats.documentDeletesAttempted >= stats.maxDocumentDeletes) {
        break;
      }

      await deletePublicShareTreeByName(share.name, accessToken, config.storageBucket, stats, config.projectId);
    }

    const attachments = await queryExpiredPublicShareAttachments(config);

    foundExpiredDocuments ||= attachments.length > 0;

    for (const attachment of attachments) {
      if (stats.documentDeletesAttempted >= stats.maxDocumentDeletes) {
        break;
      }

      await deleteExpiredPublicShareAttachment(
        attachment,
        accessToken,
        config.storageBucket,
        stats,
        config.projectId,
        config.nowIso
      );
    }

    const abandonedDeletions = await queryAbandonedAttachmentDeletions(config);

    foundExpiredDocuments ||= abandonedDeletions.length > 0;

    for (const attachment of abandonedDeletions) {
      if (stats.documentDeletesAttempted >= stats.maxDocumentDeletes) {
        break;
      }

      await deleteAbandonedAttachmentDeletion(
        attachment,
        accessToken,
        config.storageBucket,
        stats,
        config.projectId
      );
    }

    const legacyReservations = await queryLegacyExpiredAttachmentReservations(config);

    foundExpiredDocuments ||= legacyReservations.length > 0;

    for (const reservation of legacyReservations) {
      if (stats.documentDeletesAttempted >= stats.maxDocumentDeletes) {
        break;
      }

      await deleteLegacyExpiredAttachmentReservation(
        reservation,
        accessToken,
        config.storageBucket,
        stats,
        config.projectId,
        config.nowIso
      );
    }

    const reservations = await queryExpiredAttachmentReservations(config);

    foundExpiredDocuments ||= reservations.length > 0;

    for (const reservation of reservations) {
      if (stats.documentDeletesAttempted >= stats.maxDocumentDeletes) {
        break;
      }

      await deleteExpiredAttachmentReservation(
        reservation,
        accessToken,
        config.storageBucket,
        stats,
        config.projectId,
        config.nowIso
      );
    }

    if (
      !foundExpiredDocuments
      || (
        shareQueues.length < config.limit
        && shares.length < config.limit
        && attachments.length < config.limit
        && abandonedDeletions.length < config.limit
        && legacyReservations.length < config.limit
        && reservations.length < config.limit
      )
    ) {
      break;
    }
  }

  return {
    abandonedDeletionsRetried: stats.abandonedDeletionsRetried,
    activeNotesDeleted: stats.activeNotesDeleted,
    attachmentQueuesDeleted: stats.attachmentQueuesDeleted,
    attachmentsDeleted: stats.attachmentsDeleted,
    blobObjectsDeleted: stats.blobObjectsDeleted,
    documentDeletesAttempted: stats.documentDeletesAttempted,
    googleCalendarOAuthStatesDeleted: stats.googleCalendarOAuthStatesDeleted,
    legacyReservationsDeleted: stats.legacyReservationsDeleted,
    noteHistoriesDeleted: stats.noteHistoriesDeleted,
    noteUserStatesDeleted: stats.noteUserStatesDeleted,
    purgeQueuesDeleted: stats.purgeQueuesDeleted,
    purgeQueuesBackfilled: stats.purgeQueuesBackfilled,
    purgeQueuesProcessed: stats.purgeQueuesProcessed,
    purgeQueuesSkipped: stats.purgeQueuesSkipped,
    purgedNoteAttachmentsDeleted: stats.purgedNoteAttachmentsDeleted,
    purgedNotesDeleted: stats.purgedNotesDeleted,
    reservationsDeleted: stats.reservationsDeleted,
    shareQueuesDeleted: stats.shareQueuesDeleted,
    sharesDeleted: stats.sharesDeleted,
    storageBytesReleased: stats.storageBytesReleased,
    storageObjectsDeleted: stats.storageObjectsDeleted
  };
}

export default async function handler(request, response) {
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("allow", "GET, POST");
    jsonResponse(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const cronSecret = envValue("CRON_SECRET");

  if (!cronSecret) {
    console.error("public share cleanup denied", { reason: "cron_auth_unavailable" });
    jsonResponse(response, 401, { ok: false, error: "unauthorized" });
    return;
  }

  if (!authorizedCleanupRequest(request, cronSecret)) {
    jsonResponse(response, 401, { ok: false, error: "unauthorized" });
    return;
  }

  try {
    const stats = await cleanupExpiredPublicShares();
    jsonResponse(response, 200, { ok: true, ...stats });
  } catch (error) {
    console.error("public share cleanup failed", safeErrorSummary(error));
    jsonResponse(response, 500, { ok: false, error: "cleanup_failed" });
  }
}
