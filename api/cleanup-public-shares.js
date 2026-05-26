/* global Buffer, URLSearchParams, console, crypto, fetch, process */
import { createHash, timingSafeEqual } from "node:crypto";

const firestoreBaseUrl = "https://firestore.googleapis.com/v1";
const storageBaseUrl = "https://storage.googleapis.com/storage/v1";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const databaseId = "(default)";
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const defaultBatchSize = 100;
const defaultMaxDocumentDeletes = 18000;
const firestoreCommitWriteLimit = 500;

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
    throw new Error(`Firestore request failed: ${response.status} ${text.slice(0, 300)}`);
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

async function queryExpiredShares({ accessToken, projectId, nowIso, limit }) {
  const runQueryPath = `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`;
  const result = await firestoreRequest(runQueryPath, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
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

async function listChildDocuments(parentName, collectionId, accessToken) {
  const documents = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({ pageSize: "300" });

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
    documents.push(...(result.documents ?? []));
    pageToken = result.nextPageToken ?? "";
  } while (pageToken);

  return documents;
}

function stringField(document, fieldName) {
  const value = document?.fields?.[fieldName]?.stringValue;
  return typeof value === "string" ? value : "";
}

async function deleteStorageObjectsForDocuments(documents, storageBucket, accessToken, stats) {
  const objectNames = Array.from(new Set(documents.map((document) => stringField(document, "storagePath")).filter(Boolean)));

  for (const objectName of objectNames) {
    if (await storageDeleteObject(storageBucket, objectName, accessToken)) {
      stats.storageObjectsDeleted += 1;
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

async function deletePublicShareTreeByName(shareName, accessToken, storageBucket, stats) {
  const cleanupQueueName = cleanupQueueNameFromShareName(shareName);
  const attachmentDocuments = await listChildDocuments(shareName, "attachments", accessToken);
  const cleanupAttachmentDocuments = await listChildDocuments(
    cleanupQueueName,
    "publicShareAttachmentCleanupQueue",
    accessToken
  );

  await deleteStorageObjectsForDocuments(attachmentDocuments, storageBucket, accessToken, stats);
  await deleteDocumentNames(
    attachmentDocuments.map((attachment) => attachment.name),
    accessToken,
    stats,
    "attachmentsDeleted"
  );
  await deleteDocumentNames(
    cleanupAttachmentDocuments.map((cleanupAttachment) => cleanupAttachment.name),
    accessToken,
    stats,
    "attachmentQueuesDeleted"
  );
  await deleteDocumentNames([shareName], accessToken, stats, "sharesDeleted");
  await deleteDocumentNames([cleanupQueueName], accessToken, stats, "shareQueuesDeleted");
}

async function deletePublicShareTree(cleanupQueueDocument, accessToken, storageBucket, stats) {
  const shareName = publicShareNameFromCleanupQueueName(cleanupQueueDocument.name);

  await deletePublicShareTreeByName(shareName, accessToken, storageBucket, stats);
}

async function deleteExpiredPublicShareAttachment(attachmentDocument, accessToken, storageBucket, stats) {
  const cleanupAttachmentQueueName = cleanupAttachmentQueueNameFromAttachmentName(attachmentDocument.name);

  if (!cleanupAttachmentQueueName) {
    return;
  }

  await deleteStorageObjectsForDocuments([attachmentDocument], storageBucket, accessToken, stats);
  await deleteDocumentNames([attachmentDocument.name], accessToken, stats, "attachmentsDeleted");
  await deleteDocumentNames([cleanupAttachmentQueueName], accessToken, stats, "attachmentQueuesDeleted");
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
    attachmentQueuesDeleted: 0,
    attachmentsDeleted: 0,
    documentDeletesAttempted: 0,
    maxDocumentDeletes: configuredInteger("PUBLIC_SHARE_CLEANUP_MAX_DELETES", defaultMaxDocumentDeletes, 10, 18000),
    shareQueuesDeleted: 0,
    sharesDeleted: 0,
    storageObjectsDeleted: 0
  };

  for (let pass = 0; pass < 20 && stats.documentDeletesAttempted < stats.maxDocumentDeletes; pass += 1) {
    let foundExpiredDocuments = false;
    const shareQueues = await queryExpiredShareQueues(config);

    foundExpiredDocuments ||= shareQueues.length > 0;

    for (const shareQueue of shareQueues) {
      if (stats.documentDeletesAttempted >= stats.maxDocumentDeletes) {
        break;
      }

      await deletePublicShareTree(shareQueue, accessToken, config.storageBucket, stats);
    }

    const shares = await queryExpiredShares(config);

    foundExpiredDocuments ||= shares.length > 0;

    for (const share of shares) {
      if (stats.documentDeletesAttempted >= stats.maxDocumentDeletes) {
        break;
      }

      await deletePublicShareTreeByName(share.name, accessToken, config.storageBucket, stats);
    }

    const attachments = await queryExpiredPublicShareAttachments(config);

    foundExpiredDocuments ||= attachments.length > 0;

    for (const attachment of attachments) {
      if (stats.documentDeletesAttempted >= stats.maxDocumentDeletes) {
        break;
      }

      await deleteExpiredPublicShareAttachment(attachment, accessToken, config.storageBucket, stats);
    }

    if (
      !foundExpiredDocuments
      || (shareQueues.length < config.limit && shares.length < config.limit && attachments.length < config.limit)
    ) {
      break;
    }
  }

  return {
    attachmentQueuesDeleted: stats.attachmentQueuesDeleted,
    attachmentsDeleted: stats.attachmentsDeleted,
    documentDeletesAttempted: stats.documentDeletesAttempted,
    shareQueuesDeleted: stats.shareQueuesDeleted,
    sharesDeleted: stats.sharesDeleted,
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
    console.error("public share cleanup denied because CRON_SECRET is not configured");
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
    console.error("public share cleanup failed", error);
    jsonResponse(response, 500, { ok: false, error: "cleanup_failed" });
  }
}
