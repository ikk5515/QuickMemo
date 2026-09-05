/* global Buffer, URLSearchParams, console, crypto, fetch, process */
import { del } from "@vercel/blob";
import { cleanupExpiredPublishedWikis } from "./published-wikis.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { quotaReleaseAfterAttachmentClaim } from "./_attachment-policy.js";
import {
  GLOBAL_BLOB_USAGE_DOCUMENT_PATH,
  GLOBAL_BLOB_USAGE_SCHEMA_VERSION,
  evaluateFreeTierUpload,
  resolveFreeTierPolicy
} from "./_free-tier-policy.js";
import {
  NOTE_ATTACHMENT_ROLLOUT_DRAIN_ACTIVE,
  noteAttachmentCounterName,
  noteAttachmentCounterWrite,
  noteReadyAttachmentCountTransition
} from "./_note-attachment-counter.js";
import {
  canonicalVaultInventoryManifestEntryKey,
  canonicalVaultInventoryManifestEntryToken,
  canonicalVaultInventoryManifestShard,
  validVaultInventoryManifestDigest,
  vaultInventoryManifestContract,
  vaultInventoryManifestMarkerPath,
  vaultInventoryManifestShardIndexFromEntryKey,
  vaultInventoryManifestShardPath
} from "../shared/vault-inventory-manifest.js";

const firestoreBaseUrl = "https://firestore.googleapis.com/v1";
const storageBaseUrl = "https://storage.googleapis.com/storage/v1";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const databaseId = "(default)";
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const defaultBatchSize = 50;
const defaultMaxDocumentDeletes = 1000;
const defaultLegacyNoteBackfillMaxScanned = 500;
const defaultCleanupMaxRuntimeSeconds = 240;
const maximumCleanupMaxRuntimeSeconds = 240;
const cleanupLeaseSafetySeconds = 60;
const cleanupExternalRequestTimeoutMilliseconds = 20 * 1000;
const cleanupLeaseDocumentPath = "systemMaintenance/secureShareCleanupLockV1";
const attachmentCleanupHeartbeatDocumentPath = "systemMaintenance/attachmentCleanupHeartbeatV1";
const firestoreCommitWriteLimit = 500;
const userBlobAttachmentQuotaBytes = 1024 * 1024 * 1024;
const userBlobAttachmentCountLimit = 500;
const userPendingAttachmentCountLimit = 20;
const userPendingAttachmentBytesLimit = 300 * 1024 * 1024;
const attachmentCountPolicyVersion = 1;
const deletionRetryDelayMs = 15 * 60 * 1000;
const legacyReservationGraceMs = 3 * 60 * 60 * 1000;
const legacyNoteDeletionBackfillVersion = 1;
const secureShareCopyStaleMs = 24 * 60 * 60 * 1000;
const secureShareCopyCleanupBatchLimit = 20;
const secureShareCopyCleanupAttachmentDeleteLimit = 100;
const secureShareEmailDeliveryCleanupLimit = 200;
const secureShareCopyCleanupClaimIdField = "secureShareCopyCleanupClaimId";
const secureShareCopyCleanupClaimedAtField = "secureShareCopyCleanupClaimedAt";
const vaultNameClaimPattern = /^[A-Za-z0-9_-]{43}$/u;
const secureShareRootStateCollections = [
  "publicShareAccessSessions",
  "publicShareEmailChallenges",
  "publicShareEmailDeliveries",
  "publicShareEmailSendAttempts",
  "publicShareCopyGrantRequests",
  "publicShareSourceGuards",
  "publicShareUnlockGrants",
  "publicShareRateLimits",
  "publicShareParticipantCounters"
];
const secureShareRootRetentionCollections = secureShareRootStateCollections.filter(
  (collectionId) => collectionId !== "publicShareParticipantCounters"
);
const secureShareGlobalRetentionCollections = [
  {
    allDescendants: false,
    collectionId: "attachmentRateLimits",
    counterName: "attachmentRateLimitsDeleted"
  },
  {
    allDescendants: false,
    collectionId: "publicShareEmailQuotaBuckets",
    counterName: "secureShareEmailQuotaBucketsDeleted"
  },
  {
    allDescendants: false,
    collectionId: "secureShareEmailAdminIdempotency",
    counterName: "secureShareRateLimitsDeleted"
  },
  {
    allDescendants: false,
    collectionId: "secureShareEmailAdminRateLimits",
    counterName: "secureShareRateLimitsDeleted"
  },
  {
    allDescendants: false,
    collectionId: "secureShareEmailAdminAudit",
    counterName: "secureShareAuditEventsDeleted"
  }
];
const secureShareChildStateCollections = [
  {
    collectionId: "items",
    counterName: "secureShareRecipientsDeleted",
    parentCollectionId: "publicShareRecipients"
  },
  {
    collectionId: "items",
    counterName: "secureShareCommentsDeleted",
    parentCollectionId: "publicShareComments"
  },
  {
    collectionId: "items",
    counterName: "secureShareAuditEventsDeleted",
    parentCollectionId: "publicShareAuditEvents"
  },
  {
    collectionId: "items",
    counterName: "secureShareParticipantsDeleted",
    parentCollectionId: "publicShareParticipants",
    retentionEligible: false
  },
  {
    collectionId: "items",
    counterName: "secureShareParticipantNamesDeleted",
    parentCollectionId: "publicShareParticipantNames",
    retentionEligible: false
  },
  {
    collectionId: "items",
    counterName: "secureShareParticipantRenameRequestsDeleted",
    parentCollectionId: "publicShareParticipantRenameRequests",
    retentionEligible: false
  }
];
const secureShareContainerCollections = secureShareChildStateCollections.map(
  ({ parentCollectionId }) => parentCollectionId
);

function envValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function cleanupAbortSignal() {
  return globalThis.AbortSignal.timeout(cleanupExternalRequestTimeoutMilliseconds);
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
    signal: cleanupAbortSignal(),
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
    signal: cleanupAbortSignal(),
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
  if (
    envValue("LEGACY_FIREBASE_STORAGE_ENABLED") !== "true"
    || !bucket
    || !objectName
  ) {
    return false;
  }

  const response = await fetch(
    `${storageBaseUrl}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: cleanupAbortSignal()
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

async function deleteDocumentSnapshots(documents, accessToken, stats, counterName) {
  const remainingDeletes = Math.max(
    0,
    stats.maxDocumentDeletes - stats.documentDeletesAttempted
  );
  const snapshots = documents.slice(0, remainingDeletes);

  if (!snapshots.length) {
    return 0;
  }
  if (snapshots.some((document) => !document?.name || !document.updateTime)) {
    throw new Error("A Firestore delete precondition is required");
  }

  for (let index = 0; index < snapshots.length; index += firestoreCommitWriteLimit) {
    const chunk = snapshots.slice(index, index + firestoreCommitWriteLimit);
    await firestoreRequest(
      firestoreCommitPathFromDocumentName(chunk[0].name),
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          writes: chunk.map((document) => ({
            delete: document.name,
            currentDocument: { updateTime: document.updateTime }
          }))
        })
      }
    );
  }

  stats.documentDeletesAttempted += snapshots.length;
  stats[counterName] += snapshots.length;
  return snapshots.length;
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

export async function queryLegacyNoteDeletionPage({
  accessToken,
  projectId,
  limit,
  lastDocumentName = ""
}) {
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const structuredQuery = {
    select: {
      fields: [
        { fieldPath: "__name__" },
        { fieldPath: "isDeleted" },
        { fieldPath: "deletedAt" },
        { fieldPath: "deletedBy" },
        { fieldPath: "isPurged" },
        { fieldPath: "purgedAt" },
        { fieldPath: "purgedBy" }
      ]
    },
    from: [{ collectionId: "notes" }],
    orderBy: [
      {
        field: { fieldPath: "__name__" },
        direction: "ASCENDING"
      }
    ],
    limit
  };

  if (lastDocumentName) {
    structuredQuery.startAt = {
      before: false,
      values: [{ referenceValue: lastDocumentName }]
    };
  }

  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({ structuredQuery })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
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

export async function querySecureShareDocumentsByShareId({
  accessToken,
  collectionId,
  limit,
  projectId,
  shareId
}) {
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [{ fieldPath: "__name__" }]
        },
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath: "shareId" },
            op: "EQUAL",
            value: { stringValue: shareId }
          }
        },
        limit
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

export async function queryExpiredSecureShareDocuments({
  accessToken,
  allDescendants = false,
  collectionId,
  fieldPath,
  limit,
  nowIso,
  projectId
}) {
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [{ fieldPath: "__name__" }]
        },
        from: [{ collectionId, ...(allDescendants ? { allDescendants: true } : {}) }],
        where: {
          fieldFilter: {
            field: { fieldPath },
            op: "LESS_THAN_OR_EQUAL",
            value: { timestampValue: nowIso }
          }
        },
        orderBy: [
          {
            field: { fieldPath },
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

async function queryStaleSecureShareCopyJobs({ accessToken, projectId, nowIso, limit }) {
  const cutoffIso = new Date(Date.parse(nowIso) - secureShareCopyStaleMs).toISOString();
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [
            { fieldPath: "ownerUid" },
            { fieldPath: "type" },
            { fieldPath: "participantUids" },
            { fieldPath: "isDeleted" },
            { fieldPath: "revision" },
            { fieldPath: "secureShareCopyState" },
            { fieldPath: "secureShareCopyJobId" },
            { fieldPath: "secureShareCopyExpectedAttachmentCount" },
            { fieldPath: "secureShareCopyReservedAttachmentCount" },
            { fieldPath: "secureShareCopyReadyAttachmentCount" },
            { fieldPath: "secureShareCopyUpdatedAt" }
          ]
        },
        from: [{ collectionId: "notes" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: "secureShareCopyState" },
                  op: "EQUAL",
                  value: { stringValue: "copying" }
                }
              },
              {
                fieldFilter: {
                  field: { fieldPath: "secureShareCopyUpdatedAt" },
                  op: "LESS_THAN_OR_EQUAL",
                  value: { timestampValue: cutoffIso }
                }
              }
            ]
          }
        },
        orderBy: [{
          field: { fieldPath: "secureShareCopyUpdatedAt" },
          direction: "ASCENDING"
        }],
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
        headers: { authorization: `Bearer ${accessToken}` },
        signal: cleanupAbortSignal()
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

function nonNegativeIntegerField(document, fieldName) {
  const value = document?.fields?.[fieldName]?.integerValue;
  const parsed = typeof value === "string" || typeof value === "number"
    ? Number(value)
    : Number.NaN;

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function stringArrayField(document, fieldName) {
  const values = document?.fields?.[fieldName]?.arrayValue?.values;

  if (!Array.isArray(values)) {
    return [];
  }

  const strings = values.map((value) => value?.stringValue);
  return strings.every((value) => typeof value === "string") ? strings : [];
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

function sha256Base64Url(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function decodeFirestoreValue(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  if (Object.hasOwn(value, "stringValue")) {
    return typeof value.stringValue === "string" ? value.stringValue : undefined;
  }
  if (Object.hasOwn(value, "booleanValue")) {
    return typeof value.booleanValue === "boolean" ? value.booleanValue : undefined;
  }
  if (Object.hasOwn(value, "integerValue")) {
    const parsed = Number(value.integerValue);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (Object.hasOwn(value, "nullValue")) return null;
  if (Object.hasOwn(value, "timestampValue")) {
    return typeof value.timestampValue === "string" ? value.timestampValue : undefined;
  }
  if (value.mapValue && typeof value.mapValue === "object") {
    return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(
      ([key, child]) => [key, decodeFirestoreValue(child, depth + 1)]
    ));
  }
  if (value.arrayValue && typeof value.arrayValue === "object") {
    return (value.arrayValue.values ?? []).map((child) => (
      decodeFirestoreValue(child, depth + 1)
    ));
  }
  return undefined;
}

const vaultInventoryNoteFields = Object.freeze([
  "contentFormat",
  "encryptedBody",
  "encryptedTitle",
  "entryKind",
  "folderId",
  "isDeleted",
  "isPurged",
  "ownerUid",
  "revision",
  "secureShareCopyState",
  "type",
  "vaultImportJobId",
  "vaultNameClaimId",
  "vaultNameIndexVersion"
]);

function decodedVaultInventoryNote(note, state) {
  const decoded = { id: state.noteId };
  for (const fieldName of vaultInventoryNoteFields) {
    if (Object.hasOwn(note?.fields ?? {}, fieldName)) {
      decoded[fieldName] = decodeFirestoreValue(note.fields[fieldName]);
    }
  }
  return decoded;
}

function exactFirestoreFieldSet(document, expected) {
  return Boolean(document?.fields)
    && Object.keys(document.fields).sort().join("\u0000")
      === [...expected].sort().join("\u0000");
}

function validFirestoreTimestampField(document, fieldName) {
  return Number.isFinite(Date.parse(document?.fields?.[fieldName]?.timestampValue ?? ""));
}

function firestoreStringMap(entries) {
  return {
    mapValue: {
      fields: Object.fromEntries(Object.entries(entries).map(
        ([key, value]) => [key, { stringValue: value }]
      ))
    }
  };
}

function manifestVerifyWrite(documentName, document) {
  return {
    verify: documentName,
    currentDocument: document?.updateTime
      ? { updateTime: document.updateTime }
      : { exists: false }
  };
}

function parsedCopyManifest(marker, shard, state, entryKey, projectId) {
  const markerName = documentNameForPath(
    projectId,
    vaultInventoryManifestMarkerPath(state.ownerUid)
  );
  const shardIndex = vaultInventoryManifestShardIndexFromEntryKey(entryKey);
  const shardName = documentNameForPath(
    projectId,
    vaultInventoryManifestShardPath(state.ownerUid, shardIndex)
  );
  if (!marker && !shard) {
    return {
      initialized: false,
      shardIndex,
      writes: [
        manifestVerifyWrite(markerName, null),
        manifestVerifyWrite(shardName, null)
      ]
    };
  }
  if (
    !marker
    || !shard
    || marker.name !== markerName
    || shard.name !== shardName
    || !marker.updateTime
    || !shard.updateTime
    || !exactFirestoreFieldSet(marker, [
      "createdAt", "epoch", "ownerUid", "shardCount", "updatedAt", "version"
    ])
    || !exactFirestoreFieldSet(shard, [
      "createdAt", "entries", "epoch", "ownerUid", "revision", "root",
      "shardIndex", "updatedAt", "version"
    ])
    || stringField(marker, "ownerUid") !== state.ownerUid
    || integerField(marker, "version") !== vaultInventoryManifestContract.version
    || integerField(marker, "shardCount") !== vaultInventoryManifestContract.shardCount
    || integerField(marker, "epoch") < 1
    || integerField(marker, "epoch") > 999_999_999_999
    || !validFirestoreTimestampField(marker, "createdAt")
    || !validFirestoreTimestampField(marker, "updatedAt")
    || stringField(shard, "ownerUid") !== state.ownerUid
    || integerField(shard, "version") !== vaultInventoryManifestContract.version
    || integerField(shard, "epoch") !== integerField(marker, "epoch")
    || integerField(shard, "shardIndex") !== shardIndex
    || integerField(shard, "revision") < 1
    || integerField(shard, "revision") > 999_999_999_999
    || !validVaultInventoryManifestDigest(stringField(shard, "root"))
    || !validFirestoreTimestampField(shard, "createdAt")
    || !validFirestoreTimestampField(shard, "updatedAt")
  ) {
    return null;
  }
  const entries = decodeFirestoreValue(shard.fields.entries);
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;
  const canonical = canonicalVaultInventoryManifestShard({
    entries,
    epoch: integerField(shard, "epoch"),
    revision: integerField(shard, "revision"),
    shardIndex,
    uid: state.ownerUid
  });
  if (sha256Base64Url(canonical) !== stringField(shard, "root")) return null;
  return {
    entries,
    initialized: true,
    marker,
    markerName,
    revision: integerField(shard, "revision"),
    shard,
    shardIndex,
    shardName,
    writes: [manifestVerifyWrite(markerName, marker)]
  };
}

async function secureShareCopyManifestWrites(
  note,
  state,
  nextState,
  accessToken,
  projectId
) {
  let currentNote;
  let entryKey;
  try {
    currentNote = decodedVaultInventoryNote(note, state);
    if (currentNote.ownerUid !== state.ownerUid) return null;
    entryKey = sha256Base64Url(canonicalVaultInventoryManifestEntryKey({
      document: currentNote,
      kind: "note",
      uid: state.ownerUid
    }));
    if (canonicalVaultInventoryManifestEntryToken({
      document: currentNote,
      kind: "note",
      uid: state.ownerUid
    }) !== null) {
      return null;
    }
  } catch {
    return null;
  }

  const shardIndex = vaultInventoryManifestShardIndexFromEntryKey(entryKey);
  const markerName = documentNameForPath(
    projectId,
    vaultInventoryManifestMarkerPath(state.ownerUid)
  );
  const shardName = documentNameForPath(
    projectId,
    vaultInventoryManifestShardPath(state.ownerUid, shardIndex)
  );
  const [marker, shard] = await Promise.all([
    getDocumentByName(markerName, accessToken),
    getDocumentByName(shardName, accessToken)
  ]);
  let manifest;
  try {
    manifest = parsedCopyManifest(marker, shard, state, entryKey, projectId);
  } catch {
    return null;
  }
  if (!manifest) return null;
  if (!manifest.initialized) return manifest.writes;
  if (Object.hasOwn(manifest.entries, entryKey)) return null;

  const nextNote = {
    ...currentNote,
    secureShareCopyState: nextState,
    ...(nextState === "aborted" ? {
      isDeleted: true,
      revision: state.revision + 1
    } : {})
  };
  let nextTokenPreimage;
  try {
    nextTokenPreimage = canonicalVaultInventoryManifestEntryToken({
      document: nextNote,
      kind: "note",
      uid: state.ownerUid
    });
  } catch {
    return null;
  }
  if (nextTokenPreimage === null) {
    return [
      ...manifest.writes,
      manifestVerifyWrite(manifest.shardName, manifest.shard)
    ];
  }
  const entries = {
    ...manifest.entries,
    [entryKey]: sha256Base64Url(nextTokenPreimage)
  };
  const revision = manifest.revision + 1;
  if (revision > 999_999_999_999) return null;
  let root;
  try {
    root = sha256Base64Url(canonicalVaultInventoryManifestShard({
      entries,
      epoch: integerField(manifest.shard, "epoch"),
      revision,
      shardIndex: manifest.shardIndex,
      uid: state.ownerUid
    }));
  } catch {
    return null;
  }
  return [
    ...manifest.writes,
    {
      update: {
        name: manifest.shardName,
        fields: {
          entries: firestoreStringMap(entries),
          revision: integerValue(revision),
          root: { stringValue: root }
        }
      },
      updateMask: { fieldPaths: ["entries", "revision", "root"] },
      currentDocument: { updateTime: manifest.shard.updateTime },
      updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
    }
  ];
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

function globalBlobUsageReleaseWrite(projectId, usage, encryptedSize) {
  if (
    usage.usedBytes < encryptedSize
    || usage.attachmentCount < 1
  ) {
    return null;
  }
  const policy = resolveFreeTierPolicy(process.env);
  const usedBytes = usage.usedBytes - encryptedSize;
  const attachmentCount = usage.attachmentCount - 1;
  const decision = evaluateFreeTierUpload({
    usedBytes,
    reservedBytes: 0,
    requestedBytes: 0
  }, policy);

  return {
    update: {
      name: documentNameForPath(projectId, GLOBAL_BLOB_USAGE_DOCUMENT_PATH),
      fields: {
        schemaVersion: integerValue(GLOBAL_BLOB_USAGE_SCHEMA_VERSION),
        attachmentCount: integerValue(attachmentCount),
        usedBytes: integerValue(usedBytes),
        officialCapacityBytes: integerValue(policy.officialCapacityBytes),
        operationalCapBytes: integerValue(policy.operationalCapBytes),
        hardStopBytes: integerValue(policy.hardStopBytes),
        capacityState: { stringValue: decision.state },
        accountingMode: { stringValue: "ready_and_pending_reservations" }
      }
    },
    currentDocument: { updateTime: usage.updateTime },
    updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
  };
}

async function getDocumentByName(documentName, accessToken, fieldMask = []) {
  const query = new URLSearchParams();

  for (const fieldPath of fieldMask) {
    query.append("mask.fieldPaths", fieldPath);
  }

  const queryString = query.toString();
  const response = await fetch(`${firestoreBaseUrl}/${encodeDocumentPath(documentName)}${queryString ? `?${queryString}` : ""}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: cleanupAbortSignal()
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

function cleanupRunId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `cleanup_run_${Buffer.from(bytes).toString("hex")}`;
}

async function acquireCleanupLease({
  accessToken,
  maxRuntimeMilliseconds,
  projectId
}) {
  const leaseName = documentNameForPath(projectId, cleanupLeaseDocumentPath);
  const runId = cleanupRunId();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await getDocumentByName(
      leaseName,
      accessToken,
      ["runId", "leaseExpiresAt"]
    );
    const nowMilliseconds = Date.now();
    const existingLeaseExpiresAt = timestampFieldMillis(existing, "leaseExpiresAt");

    if (existing && Number.isFinite(existingLeaseExpiresAt) && existingLeaseExpiresAt > nowMilliseconds) {
      return null;
    }
    if (existing && !existing.updateTime) {
      throw new Error("Cleanup lease is missing its Firestore update time");
    }

    const leaseExpiresAt = new Date(
      nowMilliseconds
      + maxRuntimeMilliseconds
      + cleanupLeaseSafetySeconds * 1000
    );
    const fields = {
      runId: { stringValue: runId },
      leaseExpiresAt: { timestampValue: leaseExpiresAt.toISOString() },
      startedAt: { timestampValue: new Date(nowMilliseconds).toISOString() }
    };

    try {
      await firestoreRequest(firestoreCommitPathFromDocumentName(leaseName), accessToken, {
        method: "POST",
        body: JSON.stringify({
          writes: [{
            update: {
              name: leaseName,
              fields
            },
            updateMask: {
              fieldPaths: ["runId", "leaseExpiresAt", "startedAt"]
            },
            currentDocument: existing
              ? { updateTime: existing.updateTime }
              : { exists: false },
            updateTransforms: [{
              fieldPath: "updatedAt",
              setToServerValue: "REQUEST_TIME"
            }]
          }]
        })
      });
      return { leaseName, runId };
    } catch (error) {
      if (![400, 409].includes(error.statusCode)) {
        throw error;
      }
    }
  }

  const racedLease = await getDocumentByName(
    leaseName,
    accessToken,
    ["runId", "leaseExpiresAt"]
  );

  if (
    racedLease
    && Number.isFinite(timestampFieldMillis(racedLease, "leaseExpiresAt"))
    && timestampFieldMillis(racedLease, "leaseExpiresAt") > Date.now()
  ) {
    return null;
  }

  throw new Error("Cleanup lease could not be acquired safely");
}

async function releaseCleanupLease(lease, accessToken) {
  const existing = await getDocumentByName(
    lease.leaseName,
    accessToken,
    ["runId", "leaseExpiresAt"]
  );

  if (!existing || stringField(existing, "runId") !== lease.runId) {
    return false;
  }

  try {
    await firestoreRequest(firestoreCommitPathFromDocumentName(lease.leaseName), accessToken, {
      method: "POST",
      body: JSON.stringify({
        writes: [{
          delete: lease.leaseName,
          currentDocument: { updateTime: existing.updateTime }
        }]
      })
    });
    return true;
  } catch (error) {
    if ([400, 409].includes(error.statusCode)) {
      return false;
    }
    throw error;
  }
}

function legacyNoteDeletionBackfillCursorName(projectId) {
  return documentNameForPath(projectId, "systemMaintenance/legacyNoteDeletionBackfillV1");
}

function validNoteDocumentName(documentName, projectId) {
  const prefix = `${documentNameForPath(projectId, "notes")}/`;
  const noteId = typeof documentName === "string" && documentName.startsWith(prefix)
    ? documentName.slice(prefix.length)
    : "";

  return /^[A-Za-z0-9_-]{1,160}$/u.test(noteId);
}

function legacyNoteBackfillCursor(cursorDocument, projectId) {
  if (!cursorDocument || integerField(cursorDocument, "version") !== legacyNoteDeletionBackfillVersion) {
    return { completed: false, lastDocumentName: "" };
  }

  const lastDocumentName = stringField(cursorDocument, "lastDocumentName");

  return {
    completed: booleanField(cursorDocument, "completed"),
    lastDocumentName: validNoteDocumentName(lastDocumentName, projectId) ? lastDocumentName : ""
  };
}

function safeLegacyActiveNote(document) {
  return ![
    "isDeleted",
    "deletedAt",
    "deletedBy",
    "isPurged",
    "purgedAt",
    "purgedBy"
  ].some((fieldName) => hasField(document, fieldName));
}

async function writeLegacyNoteBackfillCursor({
  accessToken,
  completed,
  cursorDocument,
  lastDocumentName,
  projectId
}) {
  const cursorName = legacyNoteDeletionBackfillCursorName(projectId);
  const currentDocument = cursorDocument?.updateTime
    ? { updateTime: cursorDocument.updateTime }
    : { exists: false };

  try {
    await firestoreRequest(firestoreCommitPathFromDocumentName(cursorName), accessToken, {
      method: "POST",
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: cursorName,
              fields: {
                completed: { booleanValue: completed },
                lastDocumentName: { stringValue: lastDocumentName },
                version: integerValue(legacyNoteDeletionBackfillVersion)
              }
            },
            currentDocument,
            updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
          }
        ]
      })
    });
    return true;
  } catch (error) {
    if ([400, 409].includes(error.statusCode)) {
      return false;
    }
    throw error;
  }
}

async function normalizeLegacyNoteDeletionDocument(noteDocument, accessToken, projectId) {
  let currentDocument = noteDocument;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!currentDocument || !validNoteDocumentName(currentDocument.name, projectId)) {
      return { normalized: false, resolved: true };
    }

    if (!safeLegacyActiveNote(currentDocument)) {
      return { normalized: false, resolved: true };
    }

    if (!currentDocument.updateTime) {
      return { normalized: false, resolved: false };
    }

    try {
      await firestoreRequest(firestoreCommitPathFromDocumentName(currentDocument.name), accessToken, {
        method: "POST",
        body: JSON.stringify({
          writes: [
            {
              update: {
                name: currentDocument.name,
                fields: { isDeleted: { booleanValue: false } }
              },
              updateMask: { fieldPaths: ["isDeleted"] },
              currentDocument: { updateTime: currentDocument.updateTime }
            }
          ]
        })
      });
      return { normalized: true, resolved: true };
    } catch (error) {
      if (![400, 409].includes(error.statusCode)) {
        throw error;
      }
    }

    currentDocument = await getDocumentByName(currentDocument.name, accessToken);
  }

  return { normalized: false, resolved: false };
}

async function normalizeLegacyNoteDeletionPage(noteDocuments, accessToken, projectId) {
  const candidates = noteDocuments.filter((document) => safeLegacyActiveNote(document));

  if (!candidates.length) {
    return { normalized: 0, resolved: true };
  }

  if (candidates.some((document) => !validNoteDocumentName(document.name, projectId) || !document.updateTime)) {
    return { normalized: 0, resolved: false };
  }

  try {
    await firestoreRequest(firestoreCommitPathFromDocumentName(candidates[0].name), accessToken, {
      method: "POST",
      body: JSON.stringify({
        writes: candidates.map((document) => ({
          update: {
            name: document.name,
            fields: { isDeleted: { booleanValue: false } }
          },
          updateMask: { fieldPaths: ["isDeleted"] },
          currentDocument: { updateTime: document.updateTime }
        }))
      })
    });
    return { normalized: candidates.length, resolved: true };
  } catch (error) {
    if (![400, 409].includes(error.statusCode)) {
      throw error;
    }
  }

  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < candidates.length) {
      const document = candidates[nextIndex];
      nextIndex += 1;
      results.push(await normalizeLegacyNoteDeletionDocument(document, accessToken, projectId));
    }
  }

  await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, worker));

  return {
    normalized: results.filter((result) => result.normalized).length,
    resolved: results.every((result) => result.resolved)
  };
}

function noteAttachmentParentState(attachmentName, projectId) {
  const notesPrefix = `${documentNameForPath(projectId, "notes")}/`;
  const relativeName =
    typeof attachmentName === "string" && attachmentName.startsWith(notesPrefix)
      ? attachmentName.slice(notesPrefix.length)
      : "";
  const [noteId, collectionId, attachmentId, ...extraSegments] = relativeName.split("/");

  if (
    !/^[A-Za-z0-9_-]{1,160}$/u.test(noteId)
    || collectionId !== "attachments"
    || !/^[A-Za-z0-9_-]{1,160}$/u.test(attachmentId)
    || extraSegments.length > 0
  ) {
    return null;
  }

  return {
    attachmentId,
    noteId,
    noteName: `${notesPrefix}${noteId}`
  };
}

function secureShareCopyCounterReleaseWrite(
  attachment,
  note,
  noteName,
  preserveStaleHeartbeat = false
) {
  const copyJobId = stringField(attachment, "secureShareCopyJobId");

  if (
    !copyJobId
    || !note
    || stringField(note, "secureShareCopyState") !== "copying"
    || stringField(note, "secureShareCopyJobId") !== copyJobId
  ) {
    return { valid: true, write: null };
  }

  const expectedCount = integerField(note, "secureShareCopyExpectedAttachmentCount");
  const reservedCount = integerField(note, "secureShareCopyReservedAttachmentCount");
  const readyCount = integerField(note, "secureShareCopyReadyAttachmentCount");
  const attachmentReady = booleanField(attachment, "isReady");
  const readyAttachmentCount = attachmentReady
    ? noteReadyAttachmentCountTransition(note, -1)
    : { state: "unknown" };

  if (
    !note.updateTime
    || !hasField(note, "secureShareCopyExpectedAttachmentCount")
    || !hasField(note, "secureShareCopyReservedAttachmentCount")
    || !hasField(note, "secureShareCopyReadyAttachmentCount")
    || expectedCount < 0
    || expectedCount > 100
    || reservedCount <= 0
    || reservedCount > expectedCount
    || readyCount < 0
    || readyCount > reservedCount
    || (attachmentReady && readyCount <= 0)
    || readyAttachmentCount.state === "invalid"
  ) {
    return { valid: false, write: null };
  }

  const fields = {
    secureShareCopyReservedAttachmentCount: integerValue(reservedCount - 1)
  };
  const fieldPaths = ["secureShareCopyReservedAttachmentCount"];

  if (attachmentReady) {
    fields.secureShareCopyReadyAttachmentCount = integerValue(readyCount - 1);
    fieldPaths.push("secureShareCopyReadyAttachmentCount");
  }
  if (readyAttachmentCount.state === "write") {
    fields.readyAttachmentCount = integerValue(readyAttachmentCount.nextCount);
    fieldPaths.push("readyAttachmentCount");
  }

  return {
    valid: true,
    write: {
      update: {
        name: noteName,
        fields
      },
      updateMask: { fieldPaths },
      currentDocument: { updateTime: note.updateTime },
      ...(!preserveStaleHeartbeat
        ? {
            updateTransforms: [{
              fieldPath: "secureShareCopyUpdatedAt",
              setToServerValue: "REQUEST_TIME"
            }]
          }
        : {})
    }
  };
}

export async function beginAttachmentDeletionByName(
  projectId,
  documentName,
  accessToken,
  shouldDelete = () => true,
  requiredCopyJobId = "",
  requiredCleanupClaimId = ""
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attachment = await getDocumentByName(documentName, accessToken);

    if (!attachment || !shouldDelete(attachment)) {
      return null;
    }

    if (
      booleanField(attachment, "deletionStarted")
      && !requiredCopyJobId
      && !requiredCleanupClaimId
    ) {
      return attachment;
    }

    const copyJobId = stringField(attachment, "secureShareCopyJobId");
    const parentState = copyJobId
      ? noteAttachmentParentState(documentName, projectId)
      : null;
    const note = parentState
      ? await getDocumentByName(parentState.noteName, accessToken)
      : null;

    if (
      (
        requiredCopyJobId
        && (
          copyJobId !== requiredCopyJobId
          || !parentState
          || !note
          || stringField(note, "secureShareCopyState") !== "copying"
          || stringField(note, "secureShareCopyJobId") !== requiredCopyJobId
        )
      )
      || (
        requiredCleanupClaimId
        && (
          !note
          || stringField(note, secureShareCopyCleanupClaimIdField) !== requiredCleanupClaimId
          || !Number.isFinite(
            timestampFieldMillis(note, secureShareCopyCleanupClaimedAtField)
          )
        )
      )
    ) {
      return null;
    }

    // The Blob API and this cron path record deletionStarted in the same
    // preconditioned commit that releases secure-share copy counters. Treat it
    // as the idempotency boundary so their retries cannot decrement twice. A
    // stale-copy cleanup must still prove its exact durable claim before using
    // that boundary, otherwise a resumed job could be deleted by an old pass.
    if (booleanField(attachment, "deletionStarted")) {
      return attachment;
    }

    const counterRelease = parentState
      ? secureShareCopyCounterReleaseWrite(
          attachment,
          note,
          parentState.noteName,
          Boolean(requiredCleanupClaimId)
        )
      : { valid: true, write: null };

    // A matching copying job with malformed counters is retained for a later
    // safe repair instead of deleting metadata and creating a ghost count.
    if (!counterRelease.valid) {
      return null;
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
            },
            ...(counterRelease.write ? [counterRelease.write] : [])
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

function attachmentReservationIndexName(projectId, uid, attachmentName) {
  const marker = "/documents/";
  const markerIndex = typeof attachmentName === "string" ? attachmentName.indexOf(marker) : -1;
  const attachmentPath = markerIndex >= 0
    ? attachmentName.slice(markerIndex + marker.length)
    : "";
  if (!uid || !attachmentPath) {
    return "";
  }
  const indexId = createHash("sha256")
    .update("quickmemo/attachment-reservation-index/v1\0", "utf8")
    .update(attachmentPath, "utf8")
    .digest("base64url");
  return documentNameForPath(
    projectId,
    `userAttachmentReservations/${uid}/pendingAttachmentReservations/${indexId}`
  );
}

async function claimAttachmentDeletionByName(
  projectId,
  attachmentName,
  accessToken,
  stats,
  extraDeleteNames = []
) {
  const baseExtraDeleteNames = extraDeleteNames.filter(Boolean);
  const maximumDeleteCount = 2 + baseExtraDeleteNames.length;

  if (stats.documentDeletesAttempted + maximumDeleteCount > stats.maxDocumentDeletes) {
    return null;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attachment = await getDocumentByName(attachmentName, accessToken);

    if (!attachment) {
      return null;
    }

    const uid = stringField(attachment, "ownerUid") || stringField(attachment, "uploadedBy");
    const bytes = Math.max(0, integerField(attachment, "encryptedSize"));
    const pendingReservationTracked = booleanField(attachment, "pendingReservationTracked")
      && !booleanField(attachment, "isReady");
    const reservationIndexName = pendingReservationTracked
      ? attachmentReservationIndexName(projectId, uid, attachmentName)
      : "";
    const resolvedExtraDeleteNames = [...new Set([
      ...baseExtraDeleteNames,
      ...(reservationIndexName ? [reservationIndexName] : [])
    ])];
    const deleteCount = 1 + resolvedExtraDeleteNames.length;
    const quotaName = uid ? documentNameForPath(projectId, `userAttachmentUsage/${uid}`) : "";
    const releaseGlobalUsage = hasField(attachment, "quotaReserved")
      ? booleanField(attachment, "quotaReserved")
      : (
          stringField(attachment, "storageProvider") === "vercel-blob"
          && Boolean(stringField(attachment, "blobPath"))
        );
    const globalUsageName = documentNameForPath(
      projectId,
      GLOBAL_BLOB_USAGE_DOCUMENT_PATH
    );
    const [quotaDocument, globalUsageDocument] = await Promise.all([
      quotaName ? getDocumentByName(quotaName, accessToken) : Promise.resolve(null),
      releaseGlobalUsage
        ? getDocumentByName(globalUsageName, accessToken)
        : Promise.resolve(null)
    ]);
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
      ...resolvedExtraDeleteNames.map((name) => ({ delete: name }))
    ];

    if (claim.quota) {
      const currentPendingCount = nonNegativeIntegerField(quotaDocument, "pendingCount");
      const currentPendingBytes = nonNegativeIntegerField(quotaDocument, "pendingBytes");
      const canReleasePending = pendingReservationTracked
        && currentPendingCount !== null
        && currentPendingBytes !== null
        && currentPendingCount >= 1
        && currentPendingBytes >= bytes;
      const nextPendingCount = canReleasePending
        ? currentPendingCount - 1
        : (currentPendingCount ?? 0);
      const nextPendingBytes = canReleasePending
        ? currentPendingBytes - bytes
        : (currentPendingBytes ?? 0);
      writes.push({
        update: {
          name: quotaName,
          fields: {
            uid: { stringValue: claim.quota.uid },
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

    const usage = releaseGlobalUsage ? globalBlobUsage(globalUsageDocument) : null;

    // Missing or malformed global accounting must never make user deletion
    // impossible. New uploads fail closed elsewhere; cleanup still removes the
    // attachment and only adjusts a counter whose schema and CAS version are
    // both valid.
    if (usage) {
      const globalUsageWrite = globalBlobUsageReleaseWrite(
        projectId,
        usage,
        bytes
      );
      if (globalUsageWrite) {
        writes.push(globalUsageWrite);
      } else {
        console.warn("blob storage counter release skipped", {
          reason: "counter_underflow_guard"
        });
      }
    }

    try {
      await firestoreRequest(firestoreCommitPathFromDocumentName(attachmentName), accessToken, {
        method: "POST",
        body: JSON.stringify({ writes })
      });
      stats.documentDeletesAttempted += deleteCount;
      stats.attachmentsDeleted += 1;
      stats.attachmentQueuesDeleted += baseExtraDeleteNames.length;
      stats.reservationIndexesDeleted = (stats.reservationIndexesDeleted ?? 0)
        + (reservationIndexName ? 1 : 0);

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
    await del(blobPath, { abortSignal: cleanupAbortSignal() });
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

function publicShareIdFromShareName(shareName, projectId) {
  const prefix = `${documentNameForPath(projectId, "publicNoteShares")}/`;
  const shareId = typeof shareName === "string" && shareName.startsWith(prefix)
    ? shareName.slice(prefix.length)
    : "";

  return shareId && !shareId.includes("/") ? shareId : "";
}

function publicShareIdFromPolicyName(policyName, projectId) {
  const prefix = `${documentNameForPath(projectId, "publicSharePolicies")}/`;
  const shareId = typeof policyName === "string" && policyName.startsWith(prefix)
    ? policyName.slice(prefix.length)
    : "";

  return shareId && !shareId.includes("/") ? shareId : "";
}

function secureShareRootStateCounterName(collectionId) {
  switch (collectionId) {
    case "publicShareAccessSessions":
      return "secureShareAccessSessionsDeleted";
    case "publicShareEmailChallenges":
      return "secureShareEmailChallengesDeleted";
    case "publicShareEmailDeliveries":
      return "secureShareEmailDeliveriesDeleted";
    case "publicShareEmailSendAttempts":
      return "secureShareEmailSendAttemptsDeleted";
    case "publicShareCopyGrantRequests":
      return "secureShareCopyGrantRequestsDeleted";
    case "publicShareSourceGuards":
      return "secureShareSourceGuardsDeleted";
    case "publicShareUnlockGrants":
      return "secureShareUnlockGrantsDeleted";
    case "publicShareRateLimits":
      return "secureShareRateLimitsDeleted";
    case "publicShareParticipantCounters":
      return "secureShareParticipantCountersDeleted";
    default:
      throw new Error("Unsupported secure share state collection");
  }
}

function secureShareItemState(documentName, projectId) {
  const prefix = `${documentsResourceRoot(projectId)}/`;
  const relativeName = typeof documentName === "string" && documentName.startsWith(prefix)
    ? documentName.slice(prefix.length)
    : "";
  const [parentCollectionId, shareId, collectionId, documentId, ...extraSegments] = relativeName.split("/");
  const definition = secureShareChildStateCollections.find(
    (candidate) =>
      candidate.parentCollectionId === parentCollectionId
      && candidate.retentionEligible !== false
  );

  if (
    !definition
    || !shareId
    || collectionId !== definition.collectionId
    || !documentId
    || extraSegments.length > 0
  ) {
    return null;
  }

  return {
    counterName: definition.counterName,
    parentCollectionId,
    shareId
  };
}

async function secureShareStateRemains(shareId, accessToken, projectId) {
  for (const collectionId of secureShareRootStateCollections) {
    const documents = await querySecureShareDocumentsByShareId({
      accessToken,
      collectionId,
      limit: 1,
      projectId,
      shareId
    });

    if (documents.length > 0) {
      return true;
    }
  }

  for (const definition of secureShareChildStateCollections) {
    const parentName = documentNameForPath(
      projectId,
      `${definition.parentCollectionId}/${shareId}`
    );
    const documents = await listChildDocuments(
      parentName,
      definition.collectionId,
      accessToken,
      1,
      ["__name__"]
    );

    if (documents.length > 0) {
      return true;
    }
  }

  return false;
}

async function secureShareRootDocumentsEligibleForTreeDeletion(
  collectionId,
  documents,
  accessToken
) {
  const stateField = collectionId === "publicShareEmailDeliveries"
    ? "status"
    : collectionId === "publicShareEmailSendAttempts"
      ? "state"
      : "";

  if (!stateField) {
    return documents;
  }

  const currentDocuments = await Promise.all(documents.map((document) =>
    getDocumentByName(document.name, accessToken, [stateField])
  ));
  return currentDocuments.filter((document) => {
    if (!document) {
      return false;
    }
    const state = stringField(document, stateField);
    return state === "sent" || state === "failed";
  });
}

async function finalizedExpiredEmailSendAttempts(
  documents,
  fieldPath,
  config
) {
  const nowMilliseconds = Date.parse(config.nowIso);
  const currentDocuments = await Promise.all(documents.map((document) =>
    getDocumentByName(
      document.name,
      config.accessToken,
      ["state", fieldPath]
    )
  ));
  return currentDocuments.filter((document) => {
    if (!document) {
      return false;
    }
    const state = stringField(document, "state");
    const expiresAt = timestampFieldMillis(document, fieldPath);
    return (
      (state === "sent" || state === "failed")
      && Number.isFinite(expiresAt)
      && expiresAt <= nowMilliseconds
    );
  });
}

async function unreservedExpiredEmailQuotaBuckets(
  documents,
  fieldPath,
  config
) {
  const nowMilliseconds = Date.parse(config.nowIso);
  const currentDocuments = await Promise.all(documents.map((document) =>
    getDocumentByName(
      document.name,
      config.accessToken,
      ["reservedCount", fieldPath]
    )
  ));
  return currentDocuments.filter((document) => {
    if (!document) {
      return false;
    }
    const reservedCount = nonNegativeIntegerField(document, "reservedCount");
    const expiresAt = timestampFieldMillis(document, fieldPath);
    return (
      reservedCount === 0
      && Number.isFinite(expiresAt)
      && expiresAt <= nowMilliseconds
    );
  });
}

async function deleteSecureShareStateByShareId(shareId, accessToken, stats, projectId) {
  if (!shareId || !cleanupStatsCanContinue(stats)) {
    return false;
  }

  for (const collectionId of secureShareRootStateCollections) {
    const remainingDeletes = stats.maxDocumentDeletes - stats.documentDeletesAttempted;

    if (remainingDeletes <= 0 || !cleanupStatsCanContinue(stats)) {
      return false;
    }

    const documents = await querySecureShareDocumentsByShareId({
      accessToken,
      collectionId,
      limit: Math.min(300, remainingDeletes),
      projectId,
      shareId
    });
    const eligibleDocuments = await secureShareRootDocumentsEligibleForTreeDeletion(
      collectionId,
      documents,
      accessToken
    );
    const counterName = secureShareRootStateCounterName(collectionId);
    if (
      collectionId === "publicShareEmailDeliveries"
      || collectionId === "publicShareEmailSendAttempts"
    ) {
      await deleteDocumentSnapshots(
        eligibleDocuments,
        accessToken,
        stats,
        counterName
      );
    } else {
      await deleteDocumentNames(
        eligibleDocuments.map((document) => document.name),
        accessToken,
        stats,
        counterName
      );
    }
  }

  for (const definition of secureShareChildStateCollections) {
    const remainingDeletes = stats.maxDocumentDeletes - stats.documentDeletesAttempted;

    if (remainingDeletes <= 0 || !cleanupStatsCanContinue(stats)) {
      return false;
    }

    const parentName = documentNameForPath(
      projectId,
      `${definition.parentCollectionId}/${shareId}`
    );
    const documents = await listChildDocuments(
      parentName,
      definition.collectionId,
      accessToken,
      Math.min(300, remainingDeletes),
      ["__name__"]
    );
    await deleteDocumentNames(
      documents.map((document) => document.name),
      accessToken,
      stats,
      definition.counterName
    );
  }

  if (
    !cleanupStatsCanContinue(stats)
    || await secureShareStateRemains(shareId, accessToken, projectId)
  ) {
    return false;
  }

  const existingContainerNames = (
    await Promise.all(
      secureShareContainerCollections.map(async (collectionId) => {
        const documentName = documentNameForPath(projectId, `${collectionId}/${shareId}`);
        return await getDocumentByName(documentName, accessToken, ["shareId"])
          ? documentName
          : "";
      })
    )
  ).filter(Boolean);
  const remainingContainerDeletes = stats.maxDocumentDeletes - stats.documentDeletesAttempted;

  if (existingContainerNames.length > remainingContainerDeletes) {
    return false;
  }

  await deleteDocumentNames(
    existingContainerNames,
    accessToken,
    stats,
    "secureShareContainersDeleted"
  );

  const policyName = documentNameForPath(projectId, `publicSharePolicies/${shareId}`);
  const policy = await getDocumentByName(policyName, accessToken, ["shareId"]);

  if (!policy) {
    return true;
  }

  if (stats.documentDeletesAttempted >= stats.maxDocumentDeletes) {
    return false;
  }

  await deleteDocumentNames(
    [policyName],
    accessToken,
    stats,
    "secureSharePoliciesDeleted"
  );
  return true;
}

function cleanupStatsCanContinue(stats) {
  if (!Number.isFinite(stats.deadlineAt)) {
    return true;
  }
  if (Date.now() < stats.deadlineAt) {
    return true;
  }

  stats.deadlineReached = true;
  return false;
}

function cleanupCanContinue(config, stats) {
  if (!Number.isFinite(config.deadlineAt) && !Number.isFinite(stats.deadlineAt)) {
    return true;
  }
  return config.deadlineAt === stats.deadlineAt && cleanupStatsCanContinue(stats);
}

async function discardExpiredPendingEmailSettings(config, stats) {
  const limit = Math.min(
    10,
    Math.floor(
      Math.max(
        0,
        stats.maxDocumentDeletes - stats.documentDeletesAttempted
      ) / 4
    )
  );
  if (limit <= 0 || !cleanupCanContinue(config, stats)) {
    return;
  }
  const documents = await queryExpiredSecureShareDocuments({
    accessToken: config.accessToken,
    collectionId: "secureShareEmailSettings",
    fieldPath: "pending.expiresAt",
    limit,
    nowIso: config.nowIso,
    projectId: config.projectId
  });
  if (!documents.length) {
    return;
  }
  for (const candidate of documents) {
    if (!cleanupCanContinue(config, stats)) {
      return;
    }
    const current = await getDocumentByName(
      candidate.name,
      config.accessToken,
      [
        "pending.expiresAt",
        "pending.testState",
        "pending.testQuotaState",
        "pending.testQuotaBucketIds"
      ]
    );
    const pendingFields = current?.fields?.pending?.mapValue?.fields;
    const pending = pendingFields ? { fields: pendingFields } : null;
    const expiresAt = pending?.fields?.expiresAt?.timestampValue;
    if (
      !current?.updateTime
      || typeof expiresAt !== "string"
      || !Number.isFinite(Date.parse(expiresAt))
      || Date.parse(expiresAt) > Date.parse(config.nowIso)
    ) {
      continue;
    }
    const bucketIds = stringArrayField(pending, "testQuotaBucketIds");
    const sending = stringField(pending, "testState") === "sending";
    const quotaReserved =
      stringField(pending, "testQuotaState") === "reserved";
    if (sending && (!quotaReserved || bucketIds.length !== 3)) {
      throw new Error("Invalid pending Gmail test quota reservation");
    }
    const hasUnresolvedReservation =
      sending
      && quotaReserved
      && bucketIds.length === 3;
    const writes = [];
    if (hasUnresolvedReservation) {
      const quotaDocuments = await Promise.all(bucketIds.map((bucketId) =>
        getDocumentByName(
          documentNameForPath(
            config.projectId,
            `publicShareEmailQuotaBuckets/${bucketId}`
          ),
          config.accessToken
        )
      ));
      writes.push(...quotaDocuments.map((quotaDocument, index) =>
        emailQuotaReconciliationWrite(
          quotaDocument,
          bucketIds[index],
          config
        )
      ));
    }
    writes.push({
      update: {
        name: current.name,
        fields: {}
      },
      updateMask: { fieldPaths: ["pending"] },
      currentDocument: { updateTime: current.updateTime }
    });
    await firestoreRequest(
      firestoreCommitPathFromDocumentName(current.name),
      config.accessToken,
      {
        method: "POST",
        body: JSON.stringify({ writes })
      }
    );
    stats.documentDeletesAttempted += writes.length;
    if (hasUnresolvedReservation) {
      stats.secureShareEmailReservationsReconciled += 1;
    }
  }
}

function secureShareRetentionQueues() {
  return [
    ...secureShareRootRetentionCollections
      .filter((collectionId) => collectionId !== "publicShareEmailDeliveries")
      .map((collectionId) => ({
        allDescendants: false,
        collectionId,
        counterName: secureShareRootStateCounterName(collectionId)
      })),
    ...secureShareGlobalRetentionCollections,
    {
      allDescendants: true,
      collectionId: "items",
      counterName: ""
    }
  ];
}

async function deleteExpiredSecureShareQueueDocuments(
  queue,
  fieldPath,
  limit,
  config,
  stats
) {
  if (limit <= 0 || !cleanupCanContinue(config, stats)) {
    return 0;
  }

  const documents = await queryExpiredSecureShareDocuments({
    ...config,
    ...(queue.allDescendants ? { allDescendants: true } : {}),
    collectionId: queue.collectionId,
    fieldPath,
    limit
  });

  if (
    !queue.allDescendants
    && queue.collectionId === "publicShareEmailQuotaBuckets"
  ) {
    const eligibleDocuments = await unreservedExpiredEmailQuotaBuckets(
      documents,
      fieldPath,
      config
    );
    return deleteDocumentSnapshots(
      eligibleDocuments,
      config.accessToken,
      stats,
      queue.counterName
    );
  }

  if (
    !queue.allDescendants
    && queue.collectionId === "publicShareEmailSendAttempts"
  ) {
    const eligibleDocuments = await finalizedExpiredEmailSendAttempts(
      documents,
      fieldPath,
      config
    );
    return deleteDocumentSnapshots(
      eligibleDocuments,
      config.accessToken,
      stats,
      queue.counterName
    );
  }

  if (!queue.allDescendants) {
    return deleteDocumentNames(
      documents.map((document) => document.name),
      config.accessToken,
      stats,
      queue.counterName
    );
  }

  const documentsByCounter = new Map();
  const itemStates = documents.map((document) =>
    secureShareItemState(document.name, config.projectId)
  );
  const shareEligibility = new Map();

  const requiresCurrentShareExpiry = (state) =>
    fieldPath === "expiresAt"
    || state?.parentCollectionId === "publicShareComments";

  if (itemStates.some(requiresCurrentShareExpiry)) {
    const shareIds = [...new Set(itemStates.flatMap((state) =>
      state?.shareId && requiresCurrentShareExpiry(state) ? [state.shareId] : []
    ))];
    let nextShareIndex = 0;
    async function loadShareEligibility() {
      while (nextShareIndex < shareIds.length) {
        const shareId = shareIds[nextShareIndex];
        nextShareIndex += 1;
        shareEligibility.set(
          shareId,
          await claimExpiredPublicShareCleanup(
            documentNameForPath(config.projectId, `publicNoteShares/${shareId}`),
            config.accessToken
          )
        );
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(8, shareIds.length) }, loadShareEligibility)
    );
  }

  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    const state = itemStates[index];

    if (
      !state
      || (
        requiresCurrentShareExpiry(state)
        && shareEligibility.get(state.shareId) !== true
      )
    ) {
      continue;
    }

    const names = documentsByCounter.get(state.counterName) ?? [];
    names.push(document.name);
    documentsByCounter.set(state.counterName, names);
  }

  let deletedTotal = 0;

  for (const [counterName, documentNames] of documentsByCounter) {
    if (deletedTotal >= limit || !cleanupCanContinue(config, stats)) {
      break;
    }
    deletedTotal += await deleteDocumentNames(
      documentNames.slice(0, limit - deletedTotal),
      config.accessToken,
      stats,
      counterName
    );
  }

  return deletedTotal;
}

function emailQuotaBucketIdentity(bucketId) {
  const match = /^(minute_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})|hour_(\d{4}-\d{2}-\d{2}T\d{2})|month_(\d{4}-\d{2}))$/u
    .exec(bucketId);

  if (!match) {
    return null;
  }
  if (match[2]) {
    return { periodKey: match[2], scope: "minute" };
  }
  if (match[3]) {
    return { periodKey: match[3], scope: "hourly" };
  }
  return { periodKey: match[4], scope: "monthly" };
}

function emailQuotaReconciliationWrite(document, bucketId, config) {
  const identity = emailQuotaBucketIdentity(bucketId);
  const reservedCount = nonNegativeIntegerField(document, "reservedCount");
  const sentCount = nonNegativeIntegerField(document, "sentCount");
  const failedCount = nonNegativeIntegerField(document, "failedCount");
  const ambiguousCount = nonNegativeIntegerField(document, "ambiguousCount");
  const softLimit = nonNegativeIntegerField(document, "softLimit");
  const hardLimit = nonNegativeIntegerField(document, "hardLimit");
  const expiresAt = document?.fields?.expiresAt?.timestampValue;
  const expectedName = documentNameForPath(
    config.projectId,
    `publicShareEmailQuotaBuckets/${bucketId}`
  );

  if (
    !identity
    || document?.name !== expectedName
    || !document.updateTime
    || stringField(document, "scope") !== identity.scope
    || stringField(document, "periodKey") !== identity.periodKey
    || reservedCount === null
    || reservedCount < 1
    || sentCount === null
    || failedCount === null
    || ambiguousCount === null
    || softLimit === null
    || softLimit < 1
    || hardLimit === null
    || hardLimit < softLimit
    || typeof expiresAt !== "string"
    || !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new Error("Invalid secure-share email quota reservation");
  }

  const nextReservedCount = reservedCount - 1;
  const nextAmbiguousCount = ambiguousCount + 1;
  return {
    update: {
      name: expectedName,
      fields: {
        scope: { stringValue: identity.scope },
        periodKey: { stringValue: identity.periodKey },
        reservedCount: integerValue(nextReservedCount),
        sentCount: integerValue(sentCount),
        failedCount: integerValue(failedCount),
        ambiguousCount: integerValue(nextAmbiguousCount),
        softLimit: integerValue(softLimit),
        hardLimit: integerValue(hardLimit),
        softLimitReached: {
          booleanValue:
            nextReservedCount
            + sentCount
            + nextAmbiguousCount
            + (identity.scope === "minute" || identity.scope === "hourly"
              ? failedCount
              : 0)
            >= softLimit
        },
        updatedAt: { timestampValue: config.nowIso },
        expiresAt: { timestampValue: expiresAt }
      }
    },
    updateMask: {
      fieldPaths: [
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
      ]
    },
    currentDocument: { updateTime: document.updateTime }
  };
}

async function queryEmailSendAttemptsByChallengeId(config, challengeId) {
  const runQueryPath = `projects/${encodeURIComponent(config.projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, config.accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "publicShareEmailSendAttempts" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "challengeId" },
            op: "EQUAL",
            value: { stringValue: challengeId }
          }
        },
        limit: 2
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

function matchingExpiredEmailSendAttempt(attempts, delivery, status, config) {
  if (attempts.length > 1) {
    throw new Error("Duplicate secure-share email send attempts");
  }
  const attempt = attempts[0] ?? null;

  if (!attempt) {
    return null;
  }

  const prefix = `${documentNameForPath(
    config.projectId,
    "publicShareEmailSendAttempts"
  )}/`;
  const expiresAt = timestampFieldMillis(attempt, "expiresAt");
  if (
    !attempt.name?.startsWith(prefix)
    || attempt.name.slice(prefix.length).includes("/")
    || !attempt.updateTime
    || stringField(attempt, "challengeId") !== stringField(delivery, "challengeId")
    || stringField(attempt, "shareId") !== stringField(delivery, "shareId")
    || stringField(attempt, "state") !== status
    || !Number.isFinite(expiresAt)
    || expiresAt > Date.parse(config.nowIso)
  ) {
    throw new Error("Invalid secure-share email send attempt");
  }

  return attempt;
}

async function reconcileExpiredEmailDelivery(
  documentName,
  remainingDeleteBudget,
  config,
  stats
) {
  const delivery = await getDocumentByName(documentName, config.accessToken);

  if (!delivery) {
    return 0;
  }

  const expectedPrefix = `${documentNameForPath(
    config.projectId,
    "publicShareEmailDeliveries"
  )}/`;
  const expiresAt = timestampFieldMillis(delivery, "expiresAt");
  if (
    delivery.name !== documentName
    || !delivery.name.startsWith(expectedPrefix)
    || delivery.name.slice(expectedPrefix.length).includes("/")
    || !delivery.updateTime
    || !Number.isFinite(expiresAt)
    || expiresAt > Date.parse(config.nowIso)
  ) {
    return 0;
  }

  const status = stringField(delivery, "status");
  if (status === "sent" || status === "failed") {
    return deleteDocumentSnapshots(
      [delivery],
      config.accessToken,
      stats,
      "secureShareEmailDeliveriesDeleted"
    );
  }
  if (status !== "reserved" && status !== "ambiguous") {
    return 0;
  }

  const challengeId = stringField(delivery, "challengeId");
  const shareId = stringField(delivery, "shareId");
  if (
    !/^[A-Za-z0-9_-]{1,160}$/u.test(challengeId)
    || !/^[A-Za-z0-9_-]{1,160}$/u.test(shareId)
  ) {
    throw new Error("Invalid secure-share email delivery identity");
  }

  const attempts = await queryEmailSendAttemptsByChallengeId(config, challengeId);
  const attempt = matchingExpiredEmailSendAttempt(
    attempts,
    delivery,
    status,
    config
  );
  const requiredDeletes = 1 + (attempt ? 1 : 0);
  if (
    requiredDeletes > remainingDeleteBudget
    ||
    stats.documentDeletesAttempted + requiredDeletes > stats.maxDocumentDeletes
    || !cleanupCanContinue(config, stats)
  ) {
    return 0;
  }

  const writes = [];
  if (status === "reserved") {
    const bucketIds = stringArrayField(delivery, "quotaBucketIds");
    if (
      bucketIds.length !== 3
      || new Set(bucketIds).size !== 3
      || bucketIds.some((bucketId) => !emailQuotaBucketIdentity(bucketId))
    ) {
      throw new Error("Invalid secure-share email delivery reservation");
    }
    const quotaDocuments = await Promise.all(bucketIds.map((bucketId) =>
      getDocumentByName(
        documentNameForPath(
          config.projectId,
          `publicShareEmailQuotaBuckets/${bucketId}`
        ),
        config.accessToken
      )
    ));
    writes.push(...quotaDocuments.map((quotaDocument, index) =>
      emailQuotaReconciliationWrite(quotaDocument, bucketIds[index], config)
    ));
  }

  if (attempt) {
    writes.push({
      delete: attempt.name,
      currentDocument: { updateTime: attempt.updateTime }
    });
  }
  writes.push({
    delete: delivery.name,
    currentDocument: { updateTime: delivery.updateTime }
  });

  await firestoreRequest(
    firestoreCommitPathFromDocumentName(delivery.name),
    config.accessToken,
    {
      method: "POST",
      body: JSON.stringify({ writes })
    }
  );

  stats.documentDeletesAttempted += requiredDeletes;
  stats.secureShareEmailDeliveriesDeleted += 1;
  stats.secureShareEmailSendAttemptsDeleted += attempt ? 1 : 0;
  stats.secureShareEmailReservationsReconciled += status === "reserved" ? 1 : 0;
  return requiredDeletes;
}

async function cleanupExpiredEmailDeliveries(limit, config, stats) {
  if (limit <= 0 || !cleanupCanContinue(config, stats)) {
    return 0;
  }
  const documents = await queryExpiredSecureShareDocuments({
    ...config,
    collectionId: "publicShareEmailDeliveries",
    fieldPath: "expiresAt",
    limit
  });
  let deletedTotal = 0;

  for (const document of documents) {
    if (deletedTotal >= limit || !cleanupCanContinue(config, stats)) {
      break;
    }
    deletedTotal += await reconcileExpiredEmailDelivery(
      document.name,
      limit - deletedTotal,
      config,
      stats
    );
  }
  return deletedTotal;
}

async function cleanupSecureShareRetentionQueue(queue, limit, config, stats) {
  const fieldPaths = ["expiresAt", "retentionExpiresAt"];
  const perFieldFairShare = Math.max(1, Math.floor(limit / fieldPaths.length));
  let remaining = limit;
  let deletedTotal = 0;

  // First give both expiry fields a bounded chance. Comments can have both
  // fields while audit events only have retentionExpiresAt, so draining
  // expiresAt first would otherwise starve audit retention inside `items`.
  for (const fieldPath of fieldPaths) {
    if (remaining <= 0 || !cleanupCanContinue(config, stats)) {
      return deletedTotal;
    }
    const deleted = await deleteExpiredSecureShareQueueDocuments(
      queue,
      fieldPath,
      Math.min(perFieldFairShare, remaining),
      config,
      stats
    );
    deletedTotal += deleted;
    remaining -= deleted;
  }

  // Reuse otherwise-idle quota without exceeding this collection's share.
  for (const fieldPath of fieldPaths) {
    if (remaining <= 0 || !cleanupCanContinue(config, stats)) {
      break;
    }
    const deleted = await deleteExpiredSecureShareQueueDocuments(
      queue,
      fieldPath,
      remaining,
      config,
      stats
    );
    deletedTotal += deleted;
    remaining -= deleted;
  }

  return deletedTotal;
}

async function cleanupExpiredSecureShareState(config, stats) {
  await discardExpiredPendingEmailSettings(config, stats);
  const deliveryBudget = Math.min(
    secureShareEmailDeliveryCleanupLimit,
    Math.max(0, stats.maxDocumentDeletes - stats.documentDeletesAttempted)
  );
  if (deliveryBudget > 0 && cleanupCanContinue(config, stats)) {
    await cleanupExpiredEmailDeliveries(
      deliveryBudget,
      config,
      stats
    );
  }

  const queues = secureShareRetentionQueues();
  const retentionDeleteBudget = Math.min(
    config.limit,
    Math.max(1, Math.floor(stats.maxDocumentDeletes / 10))
  );
  const perQueueFairShare = Math.max(
    1,
    Math.floor(retentionDeleteBudget / queues.length)
  );
  let remainingRetentionDeletes = retentionDeleteBudget;

  // A first fair pass prevents a busy session collection from consuming the
  // entire daily retention budget before OTP, grant, rate-limit, or child
  // state has a chance to run.
  for (const queue of queues) {
    if (
      remainingRetentionDeletes <= 0
      || stats.documentDeletesAttempted >= stats.maxDocumentDeletes
      || !cleanupCanContinue(config, stats)
    ) {
      return;
    }
    const deleted = await cleanupSecureShareRetentionQueue(
      queue,
      Math.min(perQueueFairShare, remainingRetentionDeletes),
      config,
      stats
    );
    remainingRetentionDeletes -= deleted;
  }

  // Drain spare quota in bounded queue order after every collection received
  // its fair share. This preserves the existing total delete budget and keeps
  // small installations from wasting most of a daily run.
  for (const queue of queues) {
    if (
      remainingRetentionDeletes <= 0
      || stats.documentDeletesAttempted >= stats.maxDocumentDeletes
      || !cleanupCanContinue(config, stats)
    ) {
      return;
    }
    const deleted = await cleanupSecureShareRetentionQueue(
      queue,
      remainingRetentionDeletes,
      config,
      stats
    );
    remainingRetentionDeletes -= deleted;
  }
}

async function queryExpiredSecureSharePolicies(config) {
  const results = await Promise.all(
    ["expiresAt", "retentionExpiresAt"].map((fieldPath) =>
      queryExpiredSecureShareDocuments({
        ...config,
        collectionId: "publicSharePolicies",
        fieldPath
      })
    )
  );
  const uniqueDocuments = new Map();

  for (const document of results.flat()) {
    uniqueDocuments.set(document.name, document);
  }

  return Array.from(uniqueDocuments.values());
}

async function cleanupAttachmentDocument(
  attachmentName,
  accessToken,
  storageBucket,
  stats,
  projectId,
  extraDeleteNames = [],
  shouldDelete = () => true,
  requiredCopyJobId = "",
  requiredCleanupClaimId = ""
) {
  const attachment = await beginAttachmentDeletionByName(
    projectId,
    attachmentName,
    accessToken,
    shouldDelete,
    requiredCopyJobId,
    requiredCleanupClaimId
  );

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

function secureShareCopyJobState(note, projectId, staleCutoffMs = Number.POSITIVE_INFINITY) {
  const noteId = documentIdFromName(note?.name);
  const ownerUid = stringField(note, "ownerUid");
  const participantUids = stringArrayField(note, "participantUids");
  const copyJobId = stringField(note, "secureShareCopyJobId");
  const expectedCount = integerField(note, "secureShareCopyExpectedAttachmentCount");
  const reservedCount = integerField(note, "secureShareCopyReservedAttachmentCount");
  const readyCount = integerField(note, "secureShareCopyReadyAttachmentCount");
  const revision = integerField(note, "revision");
  const copyUpdatedAtMs = timestampFieldMillis(note, "secureShareCopyUpdatedAt");

  if (
    !validNoteDocumentName(note?.name, projectId)
    || !/^[A-Za-z0-9_-]{1,160}$/u.test(noteId)
    || !/^[A-Za-z0-9_-]{1,160}$/u.test(ownerUid)
    || stringField(note, "type") !== "personal"
    || participantUids.length !== 1
    || participantUids[0] !== ownerUid
    || !hasField(note, "isDeleted")
    || booleanField(note, "isDeleted")
    || stringField(note, "secureShareCopyState") !== "copying"
    || !/^[A-Za-z0-9_-]{16,160}$/u.test(copyJobId)
    || !hasField(note, "secureShareCopyExpectedAttachmentCount")
    || !hasField(note, "secureShareCopyReservedAttachmentCount")
    || !hasField(note, "secureShareCopyReadyAttachmentCount")
    || !hasField(note, "revision")
    || expectedCount < 0
    || expectedCount > 100
    || reservedCount < 0
    || reservedCount > expectedCount
    || readyCount < 0
    || readyCount > reservedCount
    || revision < 1
    || revision >= 999999999999
    || !note.updateTime
    || !Number.isFinite(copyUpdatedAtMs)
    || copyUpdatedAtMs > staleCutoffMs
  ) {
    return null;
  }

  return {
    copyJobId,
    expectedCount,
    noteId,
    ownerUid,
    readyCount,
    reservedCount,
    revision
  };
}

function secureShareCopyVaultNameClaimName(note, state, projectId) {
  const claimId = stringField(note, "vaultNameClaimId");
  if (
    stringField(note, "contentFormat") !== "legacy-html-v1"
    || stringField(note, "entryKind") !== "legacy-html"
    || integerField(note, "vaultNameIndexVersion") !== 1
    || !vaultNameClaimPattern.test(claimId)
    || note?.fields?.folderId?.nullValue !== null
  ) {
    return "";
  }
  return documentNameForPath(
    projectId,
    `vaultIntegrity/${state.ownerUid}/nameClaims/${claimId}`
  );
}

function exactSecureShareCopyVaultNameClaim(claim, claimName, state) {
  return Boolean(
    claim
    && claim.name === claimName
    && claim.updateTime
    && stringField(claim, "ownerUid") === state.ownerUid
    && integerField(claim, "indexVersion") === 1
    && claim?.fields?.parentId?.nullValue === null
    && stringField(claim, "targetId") === state.noteId
    && stringField(claim, "targetType") === "entry"
  );
}

function legacySecureShareCopyWithoutVaultIdentity(note) {
  return Boolean(
    note
    && !hasField(note, "contentFormat")
    && !hasField(note, "entryKind")
    && !hasField(note, "vaultNameClaimId")
    && !hasField(note, "vaultNameIndexVersion")
  );
}

function vaultNameClaimVerificationWrite(claim) {
  return {
    update: {
      name: claim.name,
      fields: {
        indexVersion: claim.fields.indexVersion,
        ownerUid: claim.fields.ownerUid,
        parentId: claim.fields.parentId,
        targetId: claim.fields.targetId,
        targetType: claim.fields.targetType
      }
    },
    updateMask: {
      fieldPaths: ["indexVersion", "ownerUid", "parentId", "targetId", "targetType"]
    },
    currentDocument: { updateTime: claim.updateTime }
  };
}

function secureShareCopyCleanupClaimId(note, state) {
  return `copy_cleanup_claim_${createHash("sha256")
    .update(`${note.name}:${state.copyJobId}:${state.revision}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function exactSecureShareCopyCleanupClaim(note, state, cleanupClaimId) {
  return cleanupClaimId === secureShareCopyCleanupClaimId(note, state)
    && stringField(note, secureShareCopyCleanupClaimIdField) === cleanupClaimId
    && Number.isFinite(timestampFieldMillis(note, secureShareCopyCleanupClaimedAtField));
}

async function claimStaleSecureShareCopyJob(
  note,
  state,
  accessToken,
  projectId,
  staleCutoffMs
) {
  const cleanupClaimId = secureShareCopyCleanupClaimId(note, state);
  const storedClaimId = stringField(note, secureShareCopyCleanupClaimIdField);
  const hasStoredClaimedAt = hasField(note, secureShareCopyCleanupClaimedAtField);

  if (storedClaimId || hasStoredClaimedAt) {
    return exactSecureShareCopyCleanupClaim(note, state, cleanupClaimId)
      ? { cleanupClaimId, note, state }
      : null;
  }

  if (!secureShareCopyJobState(note, projectId, staleCutoffMs)) {
    return null;
  }

  // Claim fields do not participate in the manifest tuple and the note stays
  // in the inventory-excluded `copying` state, so no shard read is required.
  try {
    await firestoreRequest(firestoreCommitPathFromDocumentName(note.name), accessToken, {
      method: "POST",
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: note.name,
              fields: {
                [secureShareCopyCleanupClaimIdField]: { stringValue: cleanupClaimId }
              }
            },
            updateMask: { fieldPaths: [secureShareCopyCleanupClaimIdField] },
            currentDocument: { updateTime: note.updateTime },
            updateTransforms: [{
              fieldPath: secureShareCopyCleanupClaimedAtField,
              setToServerValue: "REQUEST_TIME"
            }]
          }
        ]
      })
    });
  } catch (error) {
    if ([400, 409].includes(error.statusCode)) {
      return null;
    }
    throw error;
  }

  const claimedNote = await getDocumentByName(note.name, accessToken);
  const claimedState = secureShareCopyJobState(claimedNote, projectId);

  if (
    !claimedState
    || claimedState.copyJobId !== state.copyJobId
    || claimedState.ownerUid !== state.ownerUid
    || claimedState.revision !== state.revision
    || !exactSecureShareCopyCleanupClaim(claimedNote, claimedState, cleanupClaimId)
  ) {
    return null;
  }

  return { cleanupClaimId, note: claimedNote, state: claimedState };
}

async function activateStaleSecureShareCopyJob(
  note,
  state,
  cleanupClaimId,
  accessToken,
  projectId
) {
  if (!exactSecureShareCopyCleanupClaim(note, state, cleanupClaimId)) {
    return false;
  }

  const claimName = secureShareCopyVaultNameClaimName(note, state, projectId);
  const claim = claimName ? await getDocumentByName(claimName, accessToken) : null;
  if (!exactSecureShareCopyVaultNameClaim(claim, claimName, state)) {
    return false;
  }

  const inventoryWrites = await secureShareCopyManifestWrites(
    note,
    state,
    "active",
    accessToken,
    projectId
  );
  if (!inventoryWrites) return false;

  try {
    await firestoreRequest(firestoreCommitPathFromDocumentName(note.name), accessToken, {
      method: "POST",
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: note.name,
              fields: {
                secureShareCopyState: { stringValue: "active" },
                updatedBy: { stringValue: state.ownerUid }
              }
            },
            updateMask: {
              fieldPaths: [
                "secureShareCopyState",
                "updatedBy",
                secureShareCopyCleanupClaimIdField,
                secureShareCopyCleanupClaimedAtField
              ]
            },
            currentDocument: { updateTime: note.updateTime },
            updateTransforms: [
              { fieldPath: "savedAt", setToServerValue: "REQUEST_TIME" },
              { fieldPath: "secureShareCopyFinishedAt", setToServerValue: "REQUEST_TIME" },
              { fieldPath: "secureShareCopyUpdatedAt", setToServerValue: "REQUEST_TIME" },
              { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }
            ]
          },
          vaultNameClaimVerificationWrite(claim),
          ...inventoryWrites
        ]
      })
    });
    return true;
  } catch (error) {
    if ([400, 409].includes(error.statusCode)) {
      return false;
    }
    throw error;
  }
}

function secureShareCopyAbortMutationId(note, state) {
  return `copy_cleanup_${createHash("sha256")
    .update(`${note.name}:${state.copyJobId}:${state.revision}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

async function abortStaleSecureShareCopyJob(
  note,
  state,
  cleanupClaimId,
  accessToken,
  projectId
) {
  if (!exactSecureShareCopyCleanupClaim(note, state, cleanupClaimId)) {
    return false;
  }

  const mutationId = secureShareCopyAbortMutationId(note, state);
  const historyName = `${note.name}/history/${mutationId}`;
  const revision = state.revision + 1;
  const claimName = secureShareCopyVaultNameClaimName(note, state, projectId);
  const claim = claimName ? await getDocumentByName(claimName, accessToken) : null;
  const legacyWithoutIdentity = legacySecureShareCopyWithoutVaultIdentity(note);
  if (!legacyWithoutIdentity && !exactSecureShareCopyVaultNameClaim(claim, claimName, state)) {
    return false;
  }

  const inventoryWrites = await secureShareCopyManifestWrites(
    note,
    state,
    "aborted",
    accessToken,
    projectId
  );
  if (!inventoryWrites) return false;

  try {
    await firestoreRequest(firestoreCommitPathFromDocumentName(note.name), accessToken, {
      method: "POST",
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: note.name,
              fields: {
                deletedBy: { stringValue: state.ownerUid },
                isDeleted: { booleanValue: true },
                lastMutationId: { stringValue: mutationId },
                revision: integerValue(revision),
                secureShareCopyState: { stringValue: "aborted" },
                updatedBy: { stringValue: state.ownerUid }
              }
            },
            updateMask: {
              fieldPaths: [
                "deletedBy",
                "isDeleted",
                "lastMutationId",
                "revision",
                "secureShareCopyState",
                "updatedBy",
                secureShareCopyCleanupClaimIdField,
                secureShareCopyCleanupClaimedAtField
              ]
            },
            currentDocument: { updateTime: note.updateTime },
            updateTransforms: [
              { fieldPath: "deletedAt", setToServerValue: "REQUEST_TIME" },
              { fieldPath: "secureShareCopyFinishedAt", setToServerValue: "REQUEST_TIME" },
              { fieldPath: "secureShareCopyUpdatedAt", setToServerValue: "REQUEST_TIME" },
              { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }
            ]
          },
          {
            update: {
              name: historyName,
              fields: {
                action: { stringValue: "delete" },
                actorUid: { stringValue: state.ownerUid },
                changedFields: {
                  arrayValue: { values: [{ stringValue: "deleted" }] }
                },
                noteId: { stringValue: state.noteId },
                readerUids: {
                  arrayValue: { values: [{ stringValue: state.ownerUid }] }
                },
                revision: integerValue(revision)
              }
            },
            currentDocument: { exists: false },
            updateTransforms: [
              { fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }
            ]
          },
          ...(!legacyWithoutIdentity ? [{
            delete: claim.name,
            currentDocument: { updateTime: claim.updateTime }
          }] : []),
          ...inventoryWrites
        ]
      })
    });
    return true;
  } catch (error) {
    if ([400, 409].includes(error.statusCode)) {
      return false;
    }
    throw error;
  }
}

async function cleanupStaleSecureShareCopyJobs(config, stats) {
  const jobs = await queryStaleSecureShareCopyJobs({
    ...config,
    limit: Math.min(config.limit, secureShareCopyCleanupBatchLimit)
  });
  const staleCutoffMs = Date.parse(config.nowIso) - secureShareCopyStaleMs;
  const attachmentsDeletedAtStart = stats.attachmentsDeleted;

  stats.staleSecureShareCopyJobsScanned += jobs.length;

  for (const discoveredNote of jobs) {
    if (
      stats.documentDeletesAttempted >= stats.maxDocumentDeletes
      || !cleanupStatsCanContinue(stats)
    ) {
      stats.staleSecureShareCopyJobsRetained += 1;
      continue;
    }

    const discoveredCurrentNote = await getDocumentByName(
      discoveredNote.name,
      config.accessToken
    );
    const discoveredState = secureShareCopyJobState(
      discoveredCurrentNote,
      config.projectId,
      staleCutoffMs
    );

    if (!discoveredState) {
      stats.staleSecureShareCopyJobsRetained += 1;
      continue;
    }

    const claimedJob = await claimStaleSecureShareCopyJob(
      discoveredCurrentNote,
      discoveredState,
      config.accessToken,
      config.projectId,
      staleCutoffMs
    );

    if (!claimedJob) {
      stats.staleSecureShareCopyJobsRetained += 1;
      continue;
    }

    const {
      cleanupClaimId,
      note,
      state
    } = claimedJob;

    const legacyWithoutIdentity = legacySecureShareCopyWithoutVaultIdentity(note);

    if (
      !legacyWithoutIdentity
      &&
      state.reservedCount === state.expectedCount
      && state.readyCount === state.expectedCount
    ) {
      if (
        await activateStaleSecureShareCopyJob(
          note,
          state,
          cleanupClaimId,
          config.accessToken,
          config.projectId
        )
      ) {
        stats.staleSecureShareCopyJobsActivated += 1;
      } else {
        stats.staleSecureShareCopyJobsRetained += 1;
      }
      continue;
    }

    const attachments = await listChildDocuments(
      note.name,
      "attachments",
      config.accessToken,
      101,
      ["secureShareCopyJobId", "ownerUid", "uploadedBy"]
    );

    if (
      attachments.length > 100
      || attachments.length > (
        secureShareCopyCleanupAttachmentDeleteLimit
        - (stats.attachmentsDeleted - attachmentsDeletedAtStart)
      )
      || attachments.some((attachment) =>
        stringField(attachment, "secureShareCopyJobId") !== state.copyJobId
        || (
          stringField(attachment, "ownerUid")
          || stringField(attachment, "uploadedBy")
        ) !== state.ownerUid
      )
    ) {
      stats.staleSecureShareCopyJobsRetained += 1;
      continue;
    }

    let cleanupComplete = true;

    for (const attachment of attachments) {
      if (
        stats.documentDeletesAttempted >= stats.maxDocumentDeletes
        || !cleanupStatsCanContinue(stats)
      ) {
        cleanupComplete = false;
        break;
      }

      const cleaned = await cleanupAttachmentDocument(
        attachment.name,
        config.accessToken,
        config.storageBucket,
        stats,
        config.projectId,
        [],
        (currentAttachment) =>
          stringField(currentAttachment, "secureShareCopyJobId") === state.copyJobId
          && (
            stringField(currentAttachment, "ownerUid")
            || stringField(currentAttachment, "uploadedBy")
          ) === state.ownerUid,
        state.copyJobId,
        cleanupClaimId
      );

      if (!cleaned) {
        cleanupComplete = false;
        break;
      }
    }

    if (
      !cleanupComplete
      || !cleanupStatsCanContinue(stats)
      || (
        await listChildDocuments(
          note.name,
          "attachments",
          config.accessToken,
          1,
          ["secureShareCopyJobId"]
        )
      ).length > 0
    ) {
      stats.staleSecureShareCopyJobsRetained += 1;
      continue;
    }

    const currentNote = await getDocumentByName(note.name, config.accessToken);
    const currentState = secureShareCopyJobState(currentNote, config.projectId);

    if (
      !currentState
      || currentState.copyJobId !== state.copyJobId
      || currentState.ownerUid !== state.ownerUid
      || currentState.revision !== state.revision
      || currentState.reservedCount !== 0
      || currentState.readyCount !== 0
      || !exactSecureShareCopyCleanupClaim(
        currentNote,
        currentState,
        cleanupClaimId
      )
    ) {
      stats.staleSecureShareCopyJobsRetained += 1;
      continue;
    }

    if (
      await abortStaleSecureShareCopyJob(
        currentNote,
        currentState,
        cleanupClaimId,
        config.accessToken,
        config.projectId
      )
    ) {
      stats.staleSecureShareCopyJobsAborted += 1;
    } else {
      stats.staleSecureShareCopyJobsRetained += 1;
    }
  }
}

async function claimExpiredPublicShareCleanup(shareName, accessToken) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const share = await getDocumentByName(
      shareName,
      accessToken,
      ["cleanupClaimVersion", "cleanupStartedAt", "expiresAt", "schemaVersion"]
    );

    if (!share) {
      return true;
    }
    const expiresAt = timestampFieldMillis(share, "expiresAt");
    if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
      return false;
    }
    if (
      integerField(share, "schemaVersion") < 2
      || hasField(share, "cleanupStartedAt")
    ) {
      return true;
    }
    if (!share.updateTime) {
      return false;
    }

    try {
      await firestoreRequest(firestoreCommitPathFromDocumentName(shareName), accessToken, {
        method: "POST",
        body: JSON.stringify({
          writes: [{
            update: {
              name: shareName,
              fields: { cleanupClaimVersion: integerValue(1) }
            },
            updateMask: { fieldPaths: ["cleanupClaimVersion"] },
            currentDocument: { updateTime: share.updateTime },
            updateTransforms: [{
              fieldPath: "cleanupStartedAt",
              setToServerValue: "REQUEST_TIME"
            }]
          }]
        })
      });
      return true;
    } catch (error) {
      if (![400, 409].includes(error.statusCode)) {
        throw error;
      }
    }
  }

  return false;
}

async function deletePublicShareTreeByName(shareName, accessToken, storageBucket, stats, projectId) {
  const cleanupQueueName = cleanupQueueNameFromShareName(shareName);
  const shareId = publicShareIdFromShareName(shareName, projectId);

  if (!shareId || !cleanupStatsCanContinue(stats)) {
    return false;
  }
  if (!await claimExpiredPublicShareCleanup(shareName, accessToken)) {
    return false;
  }
  const initialShare = await getDocumentByName(
    shareName,
    accessToken,
    ["expiresAt", "schemaVersion"]
  );
  const initialExpiresAt = timestampFieldMillis(initialShare, "expiresAt");
  if (
    initialShare
    && (!Number.isFinite(initialExpiresAt) || initialExpiresAt > Date.now())
  ) {
    return false;
  }

  const remainingAttachmentDeleteBudget = stats.maxDocumentDeletes - stats.documentDeletesAttempted;

  if (remainingAttachmentDeleteBudget <= 0 || !cleanupStatsCanContinue(stats)) {
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
    if (!cleanupStatsCanContinue(stats)) {
      return false;
    }
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

  if (
    !cleanupStatsCanContinue(stats)
    || (await listChildDocuments(shareName, "attachments", accessToken, 1, ["isReady"])).length > 0
  ) {
    return false;
  }

  const remainingQueueDeleteBudget = stats.maxDocumentDeletes - stats.documentDeletesAttempted;

  if (remainingQueueDeleteBudget <= 0 || !cleanupStatsCanContinue(stats)) {
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
    !cleanupStatsCanContinue(stats)
    || (await listChildDocuments(shareName, "attachments", accessToken, 1, ["isReady"])).length > 0
    || (
      await listChildDocuments(cleanupQueueName, "publicShareAttachmentCleanupQueue", accessToken, 1, ["expiresAt"])
    ).length > 0
  ) {
    return false;
  }

  const shareMetadata = await getDocumentByName(
    shareName,
    accessToken,
    ["expiresAt", "schemaVersion"]
  );
  const currentExpiresAt = timestampFieldMillis(shareMetadata, "expiresAt");

  if (
    shareMetadata
    && (!Number.isFinite(currentExpiresAt) || currentExpiresAt > Date.now())
  ) {
    return false;
  }

  if (
    (!shareMetadata || integerField(shareMetadata, "schemaVersion") >= 2)
    && !await deleteSecureShareStateByShareId(shareId, accessToken, stats, projectId)
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
  const parsedAttachment = parsePublicShareAttachmentName(attachmentDocument.name);

  if (!cleanupAttachmentQueueName || !parsedAttachment) {
    return;
  }
  const shareName = documentNameForPath(
    projectId,
    `publicNoteShares/${parsedAttachment.shareId}`
  );
  if (!await claimExpiredPublicShareCleanup(shareName, accessToken)) {
    return;
  }
  const share = await getDocumentByName(
    shareName,
    accessToken,
    ["expiresAt"]
  );
  const shareExpiresAt = timestampFieldMillis(share, "expiresAt");
  if (
    share
    && (!Number.isFinite(shareExpiresAt) || shareExpiresAt > Date.parse(nowIso))
  ) {
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

async function cleanupPriorityExpiredAttachmentReservations(config, stats) {
  const priorityLimit = Math.min(
    configuredInteger("ATTACHMENT_RESERVATION_CLEANUP_PRIORITY_LIMIT", 20, 1, 100),
    Math.max(1, stats.maxDocumentDeletes - stats.documentDeletesAttempted)
  );
  const reservations = await queryExpiredAttachmentReservations({
    ...config,
    limit: priorityLimit
  });
  stats.priorityReservationsScanned += reservations.length;

  for (const reservation of reservations) {
    if (
      stats.documentDeletesAttempted >= stats.maxDocumentDeletes
      || !cleanupCanContinue(config, stats)
    ) {
      break;
    }
    const before = stats.reservationsDeleted;
    await deleteExpiredAttachmentReservation(
      reservation,
      config.accessToken,
      config.storageBucket,
      stats,
      config.projectId,
      config.nowIso
    );
    if (stats.reservationsDeleted > before) {
      stats.priorityReservationsDeleted += 1;
    }
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
  // Stage one installs the shared reservation mutex while deliberately
  // postponing parent deletion. Stage two enables this after old invocations
  // have drained from the protected production alias.
  if (NOTE_ATTACHMENT_ROLLOUT_DRAIN_ACTIVE) {
    return false;
  }

  if (stats.documentDeletesAttempted + 2 > stats.maxDocumentDeletes) {
    return false;
  }

  const queueName = documentNameForPath(projectId, `notePurgeCleanupQueue/${noteId}`);
  const noteName = documentNameForPath(projectId, `notes/${noteId}`);
  const counterName = noteAttachmentCounterName(projectId, noteId, databaseId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [currentQueue, currentNote, currentCounter] = await Promise.all([
      getDocumentByName(queueName, accessToken),
      getDocumentByName(noteName, accessToken),
      getDocumentByName(counterName, accessToken)
    ]);

    if (
      !currentQueue
      || !currentNote
      || !validPurgeQueue(currentQueue, currentNote, projectId)
    ) {
      return false;
    }

    // This read must happen after the counter snapshot. A reservation that wins
    // later also updates the counter, so the atomic counter precondition below
    // conflicts and every retry repeats this child check before deleting parents.
    if (
      (await listChildDocuments(
        noteName,
        "attachments",
        accessToken,
        1,
        ["noteId"]
      )).length > 0
    ) {
      return false;
    }

    try {
      await firestoreRequest(firestoreCommitPathFromDocumentName(noteName), accessToken, {
        method: "POST",
        body: JSON.stringify({
          writes: [
            noteAttachmentCounterWrite({
              counterDocument: currentCounter,
              counterName,
              noteId,
              reservedCount: 0,
              state: "closed"
            }),
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

      stats.documentDeletesAttempted += 2;
      stats.purgedNotesDeleted += 1;
      stats.purgeQueuesDeleted += 1;
      return true;
    } catch (error) {
      if (![400, 409].includes(error.statusCode)) {
        throw error;
      }
    }
  }

  return false;
}

async function cleanupPurgedNote(queueDocument, accessToken, storageBucket, stats, projectId) {
  const noteId = stringField(queueDocument, "noteId");

  if (
    !cleanupStatsCanContinue(stats)
    || !/^[A-Za-z0-9_-]{1,160}$/u.test(noteId)
  ) {
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
    if (!cleanupStatsCanContinue(stats)) {
      return false;
    }
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

  if (
    !cleanupStatsCanContinue(stats)
    || (await listChildDocuments(noteName, "attachments", accessToken, 1, ["isReady"])).length > 0
  ) {
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

  if (
    !cleanupStatsCanContinue(stats)
    || (await listChildDocuments(noteName, "history", accessToken, 1, ["revision"])).length > 0
  ) {
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

  if (
    !cleanupStatsCanContinue(stats)
    || (await listChildDocuments(noteStateParentName, "users", accessToken, 1, ["updatedAt"])).length > 0
  ) {
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

  if (
    !cleanupStatsCanContinue(stats)
    || (await queryActiveNotesByNoteId({ accessToken, projectId, noteId, limit: 1 })).length > 0
  ) {
    return false;
  }

  const finalized = await finalizePurgedNote(queueDocument, noteId, accessToken, stats, projectId);

  if (finalized) {
    stats.purgeQueuesProcessed += 1;
  }

  return finalized;
}

export async function backfillLegacyNoteDeletionMetadata(config, stats) {
  const cursorName = legacyNoteDeletionBackfillCursorName(config.projectId);
  let cursorDocument = await getDocumentByName(cursorName, config.accessToken);
  let cursor = legacyNoteBackfillCursor(cursorDocument, config.projectId);

  if (cursor.completed) {
    stats.legacyNoteBackfillComplete = true;
    return;
  }

  while (
    stats.legacyNotesScanned < config.legacyNoteBackfillMaxScanned
    && cleanupCanContinue(config, stats)
  ) {
    const remaining = config.legacyNoteBackfillMaxScanned - stats.legacyNotesScanned;
    const pageLimit = Math.min(config.legacyNoteBackfillPageSize, remaining);
    const noteDocuments = await queryLegacyNoteDeletionPage({
      accessToken: config.accessToken,
      projectId: config.projectId,
      limit: pageLimit,
      lastDocumentName: cursor.lastDocumentName
    });

    if (!noteDocuments.length) {
      stats.legacyNoteBackfillComplete = await writeLegacyNoteBackfillCursor({
        accessToken: config.accessToken,
        completed: true,
        cursorDocument,
        lastDocumentName: cursor.lastDocumentName,
        projectId: config.projectId
      });
      return;
    }

    stats.legacyNotesScanned += noteDocuments.length;
    const pageResult = await normalizeLegacyNoteDeletionPage(
      noteDocuments,
      config.accessToken,
      config.projectId
    );
    stats.legacyNotesBackfilled += pageResult.normalized;

    const lastDocumentName = noteDocuments.at(-1)?.name ?? "";

    if (!pageResult.resolved || !validNoteDocumentName(lastDocumentName, config.projectId)) {
      return;
    }

    const reachedEnd = noteDocuments.length < pageLimit;
    const cursorAdvanced = await writeLegacyNoteBackfillCursor({
      accessToken: config.accessToken,
      completed: reachedEnd,
      cursorDocument,
      lastDocumentName,
      projectId: config.projectId
    });

    if (!cursorAdvanced) {
      return;
    }

    stats.legacyNoteBackfillComplete = reachedEnd;

    if (reachedEnd) {
      return;
    }

    cursorDocument = await getDocumentByName(cursorName, config.accessToken);
    cursor = legacyNoteBackfillCursor(cursorDocument, config.projectId);

    if (cursor.completed || cursor.lastDocumentName !== lastDocumentName) {
      stats.legacyNoteBackfillComplete = cursor.completed;
      return;
    }
  }
}

async function backfillNotePurgeQueues(config, stats) {
  const purgedNotes = await queryPurgedNotes(config);

  for (const noteDocument of purgedNotes) {
    if (!cleanupCanContinue(config, stats)) {
      break;
    }
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
    if (
      stats.documentDeletesAttempted >= stats.maxDocumentDeletes
      || !cleanupCanContinue(config, stats)
    ) {
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

async function cleanupExpiredPublicShares({
  accessToken,
  credentials,
  deadlineAt
}) {
  const config = {
    accessToken,
    deadlineAt,
    projectId: credentials.projectId,
    storageBucket: credentials.storageBucket,
    nowIso: new Date().toISOString(),
    limit: configuredInteger("PUBLIC_SHARE_CLEANUP_BATCH_SIZE", defaultBatchSize, 1, 100),
    legacyNoteBackfillPageSize: configuredInteger("LEGACY_NOTE_BACKFILL_PAGE_SIZE", defaultBatchSize, 1, 100),
    legacyNoteBackfillMaxScanned: configuredInteger(
      "LEGACY_NOTE_BACKFILL_MAX_SCANNED",
      defaultLegacyNoteBackfillMaxScanned,
      1,
      2000
    )
  };
  const stats = {
    abandonedDeletionsRetried: 0,
    activeNotesDeleted: 0,
    attachmentRateLimitsDeleted: 0,
    attachmentQueuesDeleted: 0,
    attachmentsDeleted: 0,
    blobObjectsDeleted: 0,
    deadlineAt,
    documentDeletesAttempted: 0,
    deadlineReached: false,
    googleCalendarOAuthStatesDeleted: 0,
    legacyNoteBackfillComplete: false,
    legacyNoteBackfillFailed: false,
    legacyNotesBackfilled: 0,
    legacyNotesScanned: 0,
    maxDocumentDeletes: configuredInteger("PUBLIC_SHARE_CLEANUP_MAX_DELETES", defaultMaxDocumentDeletes, 10, 5000),
    legacyReservationsDeleted: 0,
    noteHistoriesDeleted: 0,
    noteUserStatesDeleted: 0,
    purgeQueuesDeleted: 0,
    purgeQueuesBackfilled: 0,
    purgeQueuesProcessed: 0,
    purgeQueuesSkipped: 0,
    priorityReservationsDeleted: 0,
    priorityReservationsScanned: 0,
    purgedNoteAttachmentsDeleted: 0,
    purgedNotesDeleted: 0,
    reservationsDeleted: 0,
    reservationIndexesDeleted: 0,
    secureShareAccessSessionsDeleted: 0,
    secureShareAuditEventsDeleted: 0,
    secureShareCommentsDeleted: 0,
    secureShareContainersDeleted: 0,
    secureShareCopyGrantRequestsDeleted: 0,
    secureShareEmailChallengesDeleted: 0,
    secureShareEmailDeliveriesDeleted: 0,
    secureShareEmailReservationsReconciled: 0,
    secureShareEmailSendAttemptsDeleted: 0,
    secureShareEmailQuotaBucketsDeleted: 0,
    secureShareParticipantCountersDeleted: 0,
    secureShareParticipantNamesDeleted: 0,
    secureShareParticipantRenameRequestsDeleted: 0,
    secureShareParticipantsDeleted: 0,
    secureSharePoliciesDeleted: 0,
    secureShareRateLimitsDeleted: 0,
    secureShareRecipientsDeleted: 0,
    secureShareSourceGuardsDeleted: 0,
    secureShareUnlockGrantsDeleted: 0,
    shareQueuesDeleted: 0,
    sharesDeleted: 0,
    storageBytesReleased: 0,
    storageObjectsDeleted: 0,
    staleSecureShareCopyJobsAborted: 0,
    staleSecureShareCopyJobsActivated: 0,
    staleSecureShareCopyJobsRetained: 0,
    staleSecureShareCopyJobsScanned: 0
  };

  // Run a bounded reservation pass first. Upload reservations are short-lived
  // and hold both user and global capacity, so later share/purge work must not
  // be able to starve them until the next cron invocation.
  if (cleanupCanContinue(config, stats)) {
    await cleanupPriorityExpiredAttachmentReservations(config, stats);
  }

  // Reserve at most 10% of the delete budget (and no more than one configured
  // batch) for expired OAuth state. This guarantees bounded daily retention
  // cleanup without allowing authorization churn to starve user-data queues.
  if (cleanupCanContinue(config, stats)) {
    await cleanupExpiredGoogleCalendarOAuthStates(config, stats);
  }
  if (cleanupCanContinue(config, stats)) {
    await cleanupExpiredSecureShareState(config, stats);
  }
  if (cleanupCanContinue(config, stats)) {
    await cleanupStaleSecureShareCopyJobs(config, stats);
  }
  if (cleanupCanContinue(config, stats)) {
    await backfillNotePurgeQueues(config, stats);
  }
  if (cleanupCanContinue(config, stats)) {
    await cleanupNotePurgeQueues(config, stats);
  }

  for (
    let pass = 0;
    pass < 20
      && stats.documentDeletesAttempted < stats.maxDocumentDeletes
      && cleanupCanContinue(config, stats);
    pass += 1
  ) {
    let foundExpiredDocuments = false;
    const shareQueues = await queryExpiredShareQueues(config);

    foundExpiredDocuments ||= shareQueues.length > 0;

    for (const shareQueue of shareQueues) {
      if (
        stats.documentDeletesAttempted >= stats.maxDocumentDeletes
        || !cleanupCanContinue(config, stats)
      ) {
        break;
      }

      await deletePublicShareTree(shareQueue, accessToken, config.storageBucket, stats, config.projectId);
    }

    if (!cleanupCanContinue(config, stats)) {
      break;
    }
    const shares = await queryExpiredShares(config);

    foundExpiredDocuments ||= shares.length > 0;

    for (const share of shares) {
      if (
        stats.documentDeletesAttempted >= stats.maxDocumentDeletes
        || !cleanupCanContinue(config, stats)
      ) {
        break;
      }

      await deletePublicShareTreeByName(share.name, accessToken, config.storageBucket, stats, config.projectId);
    }

    if (!cleanupCanContinue(config, stats)) {
      break;
    }
    const secureSharePolicies = await queryExpiredSecureSharePolicies(config);

    foundExpiredDocuments ||= secureSharePolicies.length > 0;

    for (const policy of secureSharePolicies) {
      if (
        stats.documentDeletesAttempted >= stats.maxDocumentDeletes
        || !cleanupCanContinue(config, stats)
      ) {
        break;
      }

      const shareId = publicShareIdFromPolicyName(policy.name, config.projectId);

      if (!shareId) {
        continue;
      }

      await deletePublicShareTreeByName(
        documentNameForPath(config.projectId, `publicNoteShares/${shareId}`),
        accessToken,
        config.storageBucket,
        stats,
        config.projectId
      );
    }

    if (!cleanupCanContinue(config, stats)) {
      break;
    }
    const attachments = await queryExpiredPublicShareAttachments(config);

    foundExpiredDocuments ||= attachments.length > 0;

    for (const attachment of attachments) {
      if (
        stats.documentDeletesAttempted >= stats.maxDocumentDeletes
        || !cleanupCanContinue(config, stats)
      ) {
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

    if (!cleanupCanContinue(config, stats)) {
      break;
    }
    const abandonedDeletions = await queryAbandonedAttachmentDeletions(config);

    foundExpiredDocuments ||= abandonedDeletions.length > 0;

    for (const attachment of abandonedDeletions) {
      if (
        stats.documentDeletesAttempted >= stats.maxDocumentDeletes
        || !cleanupCanContinue(config, stats)
      ) {
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

    if (!cleanupCanContinue(config, stats)) {
      break;
    }
    const legacyReservations = await queryLegacyExpiredAttachmentReservations(config);

    foundExpiredDocuments ||= legacyReservations.length > 0;

    for (const reservation of legacyReservations) {
      if (
        stats.documentDeletesAttempted >= stats.maxDocumentDeletes
        || !cleanupCanContinue(config, stats)
      ) {
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

    if (!cleanupCanContinue(config, stats)) {
      break;
    }
    const reservations = await queryExpiredAttachmentReservations(config);

    foundExpiredDocuments ||= reservations.length > 0;

    for (const reservation of reservations) {
      if (
        stats.documentDeletesAttempted >= stats.maxDocumentDeletes
        || !cleanupCanContinue(config, stats)
      ) {
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
        && secureSharePolicies.length < config.limit
        && attachments.length < config.limit
        && abandonedDeletions.length < config.limit
        && legacyReservations.length < config.limit
        && reservations.length < config.limit
      )
    ) {
      break;
    }
  }

  // Legacy visibility repair is best-effort and intentionally follows the
  // retention queues. A migration-only failure must never block purged-note,
  // expired-share, or abandoned-attachment cleanup.
  if (cleanupCanContinue(config, stats)) {
    try {
      await backfillLegacyNoteDeletionMetadata(config, stats);
    } catch {
      stats.legacyNoteBackfillFailed = true;
    }
  }

  return {
    abandonedDeletionsRetried: stats.abandonedDeletionsRetried,
    activeNotesDeleted: stats.activeNotesDeleted,
    attachmentRateLimitsDeleted: stats.attachmentRateLimitsDeleted,
    attachmentQueuesDeleted: stats.attachmentQueuesDeleted,
    attachmentsDeleted: stats.attachmentsDeleted,
    blobObjectsDeleted: stats.blobObjectsDeleted,
    documentDeletesAttempted: stats.documentDeletesAttempted,
    deadlineReached: stats.deadlineReached,
    googleCalendarOAuthStatesDeleted: stats.googleCalendarOAuthStatesDeleted,
    legacyNoteBackfillComplete: stats.legacyNoteBackfillComplete,
    legacyNoteBackfillFailed: stats.legacyNoteBackfillFailed,
    legacyNotesBackfilled: stats.legacyNotesBackfilled,
    legacyNotesScanned: stats.legacyNotesScanned,
    legacyReservationsDeleted: stats.legacyReservationsDeleted,
    noteHistoriesDeleted: stats.noteHistoriesDeleted,
    noteUserStatesDeleted: stats.noteUserStatesDeleted,
    purgeQueuesDeleted: stats.purgeQueuesDeleted,
    purgeQueuesBackfilled: stats.purgeQueuesBackfilled,
    purgeQueuesProcessed: stats.purgeQueuesProcessed,
    purgeQueuesSkipped: stats.purgeQueuesSkipped,
    priorityReservationsDeleted: stats.priorityReservationsDeleted,
    priorityReservationsScanned: stats.priorityReservationsScanned,
    purgedNoteAttachmentsDeleted: stats.purgedNoteAttachmentsDeleted,
    purgedNotesDeleted: stats.purgedNotesDeleted,
    reservationsDeleted: stats.reservationsDeleted,
    reservationIndexesDeleted: stats.reservationIndexesDeleted,
    secureShareAccessSessionsDeleted: stats.secureShareAccessSessionsDeleted,
    secureShareAuditEventsDeleted: stats.secureShareAuditEventsDeleted,
    secureShareCommentsDeleted: stats.secureShareCommentsDeleted,
    secureShareContainersDeleted: stats.secureShareContainersDeleted,
    secureShareCopyGrantRequestsDeleted: stats.secureShareCopyGrantRequestsDeleted,
    secureShareEmailChallengesDeleted: stats.secureShareEmailChallengesDeleted,
    secureShareEmailDeliveriesDeleted: stats.secureShareEmailDeliveriesDeleted,
    secureShareEmailReservationsReconciled:
      stats.secureShareEmailReservationsReconciled,
    secureShareEmailSendAttemptsDeleted: stats.secureShareEmailSendAttemptsDeleted,
    secureShareEmailQuotaBucketsDeleted: stats.secureShareEmailQuotaBucketsDeleted,
    secureShareParticipantCountersDeleted: stats.secureShareParticipantCountersDeleted,
    secureShareParticipantNamesDeleted: stats.secureShareParticipantNamesDeleted,
    secureShareParticipantRenameRequestsDeleted:
      stats.secureShareParticipantRenameRequestsDeleted,
    secureShareParticipantsDeleted: stats.secureShareParticipantsDeleted,
    secureSharePoliciesDeleted: stats.secureSharePoliciesDeleted,
    secureShareRateLimitsDeleted: stats.secureShareRateLimitsDeleted,
    secureShareRecipientsDeleted: stats.secureShareRecipientsDeleted,
    secureShareSourceGuardsDeleted: stats.secureShareSourceGuardsDeleted,
    secureShareUnlockGrantsDeleted: stats.secureShareUnlockGrantsDeleted,
    shareQueuesDeleted: stats.shareQueuesDeleted,
    sharesDeleted: stats.sharesDeleted,
    staleSecureShareCopyJobsAborted: stats.staleSecureShareCopyJobsAborted,
    staleSecureShareCopyJobsActivated: stats.staleSecureShareCopyJobsActivated,
    staleSecureShareCopyJobsRetained: stats.staleSecureShareCopyJobsRetained,
    staleSecureShareCopyJobsScanned: stats.staleSecureShareCopyJobsScanned,
    storageBytesReleased: stats.storageBytesReleased,
    storageObjectsDeleted: stats.storageObjectsDeleted
  };
}

function cleanupDurationBucket(milliseconds) {
  if (milliseconds < 1_000) return "lt_1s";
  if (milliseconds < 10_000) return "lt_10s";
  if (milliseconds < 60_000) return "lt_60s";
  if (milliseconds < 180_000) return "lt_180s";
  return "gte_180s";
}

async function writeAttachmentCleanupHeartbeat({
  accessToken,
  durationMilliseconds,
  projectId,
  stats
}) {
  const heartbeatName = documentNameForPath(projectId, attachmentCleanupHeartbeatDocumentPath);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getDocumentByName(heartbeatName, accessToken);
    const fields = {
      schemaVersion: integerValue(1),
      deadlineReached: { booleanValue: stats.deadlineReached === true },
      durationBucket: { stringValue: cleanupDurationBucket(durationMilliseconds) },
      priorityReservationsDeleted: integerValue(stats.priorityReservationsDeleted),
      priorityReservationsScanned: integerValue(stats.priorityReservationsScanned),
      reservationsDeleted: integerValue(stats.reservationsDeleted),
      reservationIndexesDeleted: integerValue(stats.reservationIndexesDeleted),
      attachmentRateLimitsDeleted: integerValue(stats.attachmentRateLimitsDeleted)
    };
    try {
      await firestoreRequest(firestoreCommitPathFromDocumentName(heartbeatName), accessToken, {
        method: "POST",
        body: JSON.stringify({
          writes: [{
            update: {
              name: heartbeatName,
              fields
            },
            updateMask: { fieldPaths: Object.keys(fields) },
            currentDocument: existing?.updateTime
              ? { updateTime: existing.updateTime }
              : { exists: false },
            updateTransforms: [{ fieldPath: "lastSuccessAt", setToServerValue: "REQUEST_TIME" }]
          }]
        })
      });
      return true;
    } catch (error) {
      if (![400, 409].includes(error.statusCode) || attempt === 2) {
        throw error;
      }
    }
  }
  return false;
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
    const startedAt = Date.now();
    const maxRuntimeSeconds = configuredInteger(
      "PUBLIC_SHARE_CLEANUP_MAX_RUNTIME_SECONDS",
      defaultCleanupMaxRuntimeSeconds,
      1,
      maximumCleanupMaxRuntimeSeconds
    );
    const maxRuntimeMilliseconds = maxRuntimeSeconds * 1000;
    const deadlineAt = startedAt + maxRuntimeMilliseconds;
    const credentials = cleanupCredentials();
    const accessToken = await fetchAccessToken(credentials);

    if (Date.now() >= deadlineAt) {
      jsonResponse(response, 200, {
        ok: true,
        skipped: true,
        reason: "deadline_reached"
      });
      return;
    }

    const lease = await acquireCleanupLease({
      accessToken,
      maxRuntimeMilliseconds,
      projectId: credentials.projectId
    });

    if (!lease) {
      jsonResponse(response, 200, {
        ok: true,
        skipped: true,
        reason: "already_running"
      });
      return;
    }

    let stats;
    try {
      // Public wiki copies share the existing authenticated cron and its lease.
      // A failure here never prevents the established share/attachment cleanup.
      let publishedWikiCopiesDeleted = 0;
      try {
        publishedWikiCopiesDeleted = await cleanupExpiredPublishedWikis({ projectId: credentials.projectId, accessToken }, Math.min(deadlineAt, Date.now() + 5000));
      } catch (error) { console.error("published wiki cleanup failed", safeErrorSummary(error)); }
      stats = await cleanupExpiredPublicShares({
        accessToken,
        credentials,
        deadlineAt
      });
      stats.publishedWikiCopiesDeleted = publishedWikiCopiesDeleted;
      try {
        stats.cleanupHeartbeatWritten = await writeAttachmentCleanupHeartbeat({
          accessToken,
          durationMilliseconds: Date.now() - startedAt,
          projectId: credentials.projectId,
          stats
        });
      } catch (error) {
        stats.cleanupHeartbeatWritten = false;
        console.error("attachment cleanup heartbeat failed", safeErrorSummary(error));
      }
    } finally {
      await releaseCleanupLease(lease, accessToken);
    }
    console.info("public share cleanup completed", {
      attachmentRateLimitsDeleted: stats.attachmentRateLimitsDeleted,
      cleanupHeartbeatWritten: stats.cleanupHeartbeatWritten,
      deadlineReached: stats.deadlineReached,
      durationBucket: cleanupDurationBucket(Date.now() - startedAt),
      priorityReservationsDeleted: stats.priorityReservationsDeleted,
      priorityReservationsScanned: stats.priorityReservationsScanned,
      reservationIndexesDeleted: stats.reservationIndexesDeleted,
      reservationsDeleted: stats.reservationsDeleted
    });
    jsonResponse(response, 200, { ok: true, ...stats });
  } catch (error) {
    console.error("public share cleanup failed", safeErrorSummary(error));
    jsonResponse(response, 500, { ok: false, error: "cleanup_failed" });
  }
}
