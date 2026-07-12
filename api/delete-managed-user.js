/* global Buffer, URLSearchParams, console, crypto, fetch, process */
import { del } from "@vercel/blob";
import {
  quotaReleaseAfterAttachmentClaim,
  shouldBumpAttachmentRevisionOnDelete
} from "./_attachment-policy.js";

const firestoreBaseUrl = "https://firestore.googleapis.com/v1";
const identityToolkitBaseUrl = "https://identitytoolkit.googleapis.com/v1";
const storageBaseUrl = "https://storage.googleapis.com/storage/v1";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const databaseId = "(default)";
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const managedUserDeleteQueryLimit = 300;
const maxManagedUserDeleteIterations = 50;
const firestoreCommitWriteLimit = 500;
const attachmentCleanupBatchSize = 20;
const historyCleanupBatchSize = 50;
const participantNoteCleanupBatchSize = 50;
const managedUserAttachmentDeleteBudget = 20;
const identityToolkitAccountMethods = {
  delete: "accounts:delete"
};

class ManagedUserCleanupInProgressError extends Error {
  constructor(message = "Managed user attachment cleanup requires another request") {
    super(message);
    this.name = "ManagedUserCleanupInProgressError";
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
    envValue("FIREBASE_CLEANUP_PROJECT_ID") ||
    credentialJson.project_id ||
    envValue("VITE_FIREBASE_PROJECT_ID") ||
    envValue("GOOGLE_CLOUD_PROJECT");

  if (!clientEmail || !privateKey || !projectId) {
    throw new Error("Missing Firebase management credentials");
  }

  return {
    clientEmail,
    privateKey,
    projectId,
    storageBucket: envValue("FIREBASE_STORAGE_BUCKET") || envValue("VITE_FIREBASE_STORAGE_BUCKET") || `${projectId}.appspot.com`
  };
}

function firebaseWebApiKey() {
  return envValue("VITE_FIREBASE_API_KEY") || envValue("FIREBASE_API_KEY");
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

function encodeDocumentPath(documentPath) {
  return documentPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function documentsRoot(projectId) {
  return `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents`;
}

function documentsResourceRoot(projectId) {
  return `projects/${projectId}/databases/${databaseId}/documents`;
}

function documentNameForPath(projectId, documentPath) {
  return `${documentsResourceRoot(projectId)}/${documentPath}`;
}

function documentPathFromName(projectId, documentName) {
  const prefixes = [`${documentsResourceRoot(projectId)}/`, `${documentsRoot(projectId)}/`];
  const prefix = prefixes.find((candidate) => documentName.startsWith(candidate));

  if (!prefix) {
    throw new Error("Invalid Firestore document name");
  }

  return documentName.slice(prefix.length);
}

function documentIdFromName(documentName) {
  const segments = documentName.split("/");
  return segments[segments.length - 1] ?? "";
}

function firestoreCommitPathFromDocumentName(documentName) {
  const marker = "/documents/";
  const markerIndex = documentName.indexOf(marker);

  if (markerIndex < 0) {
    throw new Error("Invalid Firestore document name");
  }

  return `${documentName.slice(0, markerIndex + marker.length - 1)}:commit`;
}

function stringValue(value) {
  return { stringValue: value };
}

function timestampValue(value = new Date()) {
  return { timestampValue: value.toISOString() };
}

function stringArrayValue(values) {
  return {
    arrayValue: values.length
      ? {
          values: values.map((value) => stringValue(value))
        }
      : {}
  };
}

function mapValue(fields) {
  return {
    mapValue: {
      fields
    }
  };
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

async function firestoreCommitDeleteMany(documentNames, accessToken) {
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

async function firestoreGet(projectId, documentPath, accessToken, fieldMask = []) {
  const query = new URLSearchParams();

  for (const fieldPath of fieldMask) {
    query.append("mask.fieldPaths", fieldPath);
  }

  const queryString = query.toString();
  const response = await fetch(`${firestoreBaseUrl}/${documentsRoot(projectId)}/${encodeDocumentPath(documentPath)}${queryString ? `?${queryString}` : ""}`, {
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

async function firestoreDelete(projectId, documentPath, accessToken) {
  const response = await fetch(`${firestoreBaseUrl}/${documentsRoot(projectId)}/${encodeDocumentPath(documentPath)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Firestore delete failed: ${response.status} ${text.slice(0, 300)}`);
  }

  return true;
}

async function firestorePatchFields(projectId, documentPath, fields, accessToken, updateTime) {
  if (typeof updateTime !== "string" || !updateTime) {
    throw new Error("Firestore patch update-time precondition is required");
  }

  const query = new URLSearchParams();

  Object.keys(fields).forEach((fieldPath) => {
    query.append("updateMask.fieldPaths", fieldPath);
  });
  query.append("currentDocument.updateTime", updateTime);

  await firestoreRequest(
    `${documentsRoot(projectId)}/${encodeDocumentPath(documentPath)}?${query.toString()}`,
    accessToken,
    {
      method: "PATCH",
      body: JSON.stringify({ fields })
    }
  );
}

async function firestorePatchProjectedFields(projectId, documentPath, fields, accessToken, document) {
  try {
    await firestorePatchFields(projectId, documentPath, fields, accessToken, document?.updateTime);
  } catch (error) {
    if ([400, 409].includes(errorNumberField(error, "statusCode"))) {
      throw new ManagedUserCleanupInProgressError("Concurrent Firestore update requires a fresh cleanup pass");
    }

    throw error;
  }
}

async function firestorePatchFieldsIfExists(projectId, documentPath, fields, accessToken) {
  const query = new URLSearchParams();

  Object.keys(fields).forEach((fieldPath) => {
    query.append("updateMask.fieldPaths", fieldPath);
  });

  const response = await fetch(
    `${firestoreBaseUrl}/${documentsRoot(projectId)}/${encodeDocumentPath(documentPath)}?${query.toString()}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ fields })
    }
  );

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Firestore patch failed: ${response.status} ${text.slice(0, 300)}`);
  }

  return true;
}

async function listCollection(projectId, collectionId, accessToken, fieldMask = []) {
  const documents = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({ pageSize: "300" });

    for (const fieldPath of fieldMask) {
      query.append("mask.fieldPaths", fieldPath);
    }

    if (pageToken) {
      query.set("pageToken", pageToken);
    }

    const result = await firestoreRequest(
      `${documentsRoot(projectId)}/${encodeURIComponent(collectionId)}?${query.toString()}`,
      accessToken
    );

    documents.push(...(result.documents ?? []));
    pageToken = result.nextPageToken ?? "";
  } while (pageToken);

  return documents;
}

async function listChildDocuments(
  parentName,
  collectionId,
  accessToken,
  maxDocuments = historyCleanupBatchSize,
  fieldMask = ["__name__"]
) {
  const documents = [];
  let pageToken = "";

  do {
    const remaining = Math.max(0, maxDocuments - documents.length);

    if (remaining === 0) {
      break;
    }

    const query = new URLSearchParams({
      pageSize: String(Math.min(managedUserDeleteQueryLimit, remaining))
    });

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

async function runStructuredQuery(projectId, accessToken, structuredQuery) {
  const result = await firestoreRequest(`${documentsRoot(projectId)}:runQuery`, accessToken, {
    method: "POST",
    body: JSON.stringify({ structuredQuery })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

async function queryDocumentsByField({
  accessToken,
  allDescendants = false,
  collectionId,
  fieldPath,
  limit = managedUserDeleteQueryLimit,
  op,
  projectId,
  selectFieldPaths = ["__name__"],
  value
}) {
  return runStructuredQuery(projectId, accessToken, {
    select: {
      fields: selectFieldPaths.map((selectedFieldPath) => ({ fieldPath: selectedFieldPath }))
    },
    from: [{ collectionId, ...(allDescendants ? { allDescendants: true } : {}) }],
    where: {
      fieldFilter: {
        field: { fieldPath },
        op,
        value
      }
    },
    limit
  });
}

async function queryDocumentsByStringField(
  projectId,
  collectionId,
  fieldPath,
  value,
  accessToken,
  options = {}
) {
  return queryDocumentsByField({
    accessToken,
    ...options,
    collectionId,
    fieldPath,
    op: "EQUAL",
    projectId,
    value: stringValue(value)
  });
}

async function queryDocumentsByArrayContains(
  projectId,
  collectionId,
  fieldPath,
  value,
  accessToken,
  options = {}
) {
  return queryDocumentsByField({
    accessToken,
    ...options,
    collectionId,
    fieldPath,
    op: "ARRAY_CONTAINS",
    projectId,
    value: stringValue(value)
  });
}

async function queryOwnedScheduleTasks(projectId, ownerUid, accessToken) {
  return queryDocumentsByStringField(projectId, "scheduleTasks", "ownerUid", ownerUid, accessToken);
}

async function queryOwnedRecurringHabits(projectId, ownerUid, accessToken) {
  return queryDocumentsByStringField(projectId, "recurringHabits", "ownerUid", ownerUid, accessToken);
}

async function queryOwnedRecurringHabitCheckIns(projectId, ownerUid, accessToken) {
  return queryDocumentsByStringField(projectId, "recurringHabitCheckIns", "ownerUid", ownerUid, accessToken);
}

async function queryOwnedNotes(projectId, ownerUid, accessToken) {
  return queryDocumentsByStringField(projectId, "notes", "ownerUid", ownerUid, accessToken);
}

async function queryOwnedNoteFolders(projectId, ownerUid, accessToken) {
  return queryDocumentsByStringField(projectId, "noteFolders", "ownerUid", ownerUid, accessToken);
}

async function queryOwnedPublicShares(projectId, ownerUid, accessToken) {
  return queryDocumentsByStringField(projectId, "publicNoteShares", "ownerUid", ownerUid, accessToken);
}

async function queryParticipantNotes(projectId, uid, accessToken) {
  return queryDocumentsByArrayContains(projectId, "notes", "participantUids", uid, accessToken, {
    limit: participantNoteCleanupBatchSize,
    selectFieldPaths: ["__name__", "ownerUid", "participantUids", "wrappedKeys"]
  });
}

async function queryNoteAttachmentsUploadedBy(projectId, uid, accessToken, limit = attachmentCleanupBatchSize) {
  return queryDocumentsByStringField(projectId, "attachments", "uploadedBy", uid, accessToken, {
    allDescendants: true,
    limit
  });
}

async function queryNoteUserStatesForUid(projectId, uid, accessToken) {
  return queryDocumentsByStringField(projectId, "users", "uid", uid, accessToken, {
    allDescendants: true,
    limit: historyCleanupBatchSize
  });
}

async function queryNoteHistoryByActor(projectId, uid, accessToken) {
  return queryDocumentsByStringField(projectId, "history", "actorUid", uid, accessToken, {
    allDescendants: true,
    limit: historyCleanupBatchSize
  });
}

async function queryNoteHistoryByReader(projectId, uid, accessToken) {
  return queryDocumentsByArrayContains(projectId, "history", "readerUids", uid, accessToken, {
    allDescendants: true,
    limit: historyCleanupBatchSize,
    selectFieldPaths: ["__name__", "readerUids"]
  });
}

async function queryUsersAllowingShareTarget(projectId, uid, accessToken) {
  return queryDocumentsByArrayContains(projectId, "users", "allowedShareTargetUids", uid, accessToken, {
    selectFieldPaths: ["__name__", "uid", "allowedShareTargetUids"]
  });
}

async function queryPublicSharesBySourceNote(projectId, noteId, accessToken) {
  return runStructuredQuery(projectId, accessToken, {
    select: {
      fields: [{ fieldPath: "__name__" }]
    },
    from: [{ collectionId: "publicNoteShares" }],
    where: {
      fieldFilter: {
        field: { fieldPath: "sourceNoteId" },
        op: "EQUAL",
        value: stringValue(noteId)
      }
    },
    limit: managedUserDeleteQueryLimit
  });
}

function boolField(document, fieldName) {
  return document?.fields?.[fieldName]?.booleanValue === true;
}

function hasField(document, fieldName) {
  return Boolean(document?.fields && Object.hasOwn(document.fields, fieldName));
}

function stringField(document, fieldName) {
  const value = document?.fields?.[fieldName]?.stringValue;
  return typeof value === "string" ? value : "";
}

function stringArrayField(document, fieldName) {
  const values = document?.fields?.[fieldName]?.arrayValue?.values ?? [];
  return values.flatMap((value) => (typeof value.stringValue === "string" ? [value.stringValue] : []));
}

function mapField(document, fieldName) {
  return document?.fields?.[fieldName]?.mapValue?.fields ?? {};
}

function integerField(document, fieldName) {
  const value = document?.fields?.[fieldName]?.integerValue;
  const parsed = typeof value === "string" || typeof value === "number"
    ? Number.parseInt(String(value), 10)
    : Number.NaN;

  return Number.isSafeInteger(parsed) ? parsed : 0;
}

async function firestoreGetByName(projectId, documentName, accessToken, fieldMask = []) {
  return firestoreGet(projectId, documentPathFromName(projectId, documentName), accessToken, fieldMask);
}

async function firestoreCommitWrites(documentName, writes, accessToken) {
  return firestoreRequest(firestoreCommitPathFromDocumentName(documentName), accessToken, {
    method: "POST",
    body: JSON.stringify({ writes })
  });
}

function noteNameFromAttachmentName(projectId, attachmentName) {
  const segments = documentPathFromName(projectId, attachmentName).split("/");

  if (segments.length !== 4 || segments[0] !== "notes" || segments[2] !== "attachments") {
    return "";
  }

  return documentNameForPath(projectId, `notes/${segments[1]}`);
}

async function beginManagedAttachmentDeletion({
  accessToken,
  attachmentName,
  bumpSourceNoteRevision,
  deletedOwnerUid,
  projectId,
  stats
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attachment = await firestoreGetByName(projectId, attachmentName, accessToken);

    if (!attachment) {
      return null;
    }

    const deletionStarted = boolField(attachment, "deletionStarted");
    const revisionBumped = boolField(attachment, "attachmentRevisionBumped");
    const noteName = bumpSourceNoteRevision
      ? noteNameFromAttachmentName(projectId, attachmentName)
      : "";
    const note = noteName
      ? await firestoreGetByName(projectId, noteName, accessToken, ["ownerUid", "attachmentRevision"])
      : null;
    const mustProtectSourceRevision = Boolean(
      note
      && stringField(note, "ownerUid")
      && stringField(note, "ownerUid") !== deletedOwnerUid
    );
    const shouldBumpRevision = shouldBumpAttachmentRevisionOnDelete({
      scope: mustProtectSourceRevision ? "note" : "publicShare",
      alreadyBumped: revisionBumped,
      hasReadyField: hasField(attachment, "isReady"),
      isReady: boolField(attachment, "isReady")
    });

    if (deletionStarted && hasField(attachment, "attachmentRevisionBumped") && !shouldBumpRevision) {
      return attachment;
    }

    const writes = [
      {
        update: {
          name: attachmentName,
          fields: {
            deletionStarted: { booleanValue: true },
            attachmentRevisionBumped: { booleanValue: revisionBumped || shouldBumpRevision }
          }
        },
        updateMask: { fieldPaths: ["deletionStarted", "attachmentRevisionBumped"] },
        currentDocument: { updateTime: attachment.updateTime },
        ...(!deletionStarted
          ? { updateTransforms: [{ fieldPath: "deletionStartedAt", setToServerValue: "REQUEST_TIME" }] }
          : {})
      }
    ];

    if (shouldBumpRevision) {
      writes.push({
        update: {
          name: noteName,
          fields: {
            attachmentRevision: { integerValue: String(integerField(note, "attachmentRevision") + 1) }
          }
        },
        updateMask: { fieldPaths: ["attachmentRevision"] },
        currentDocument: { updateTime: note.updateTime }
      });
    }

    try {
      await firestoreCommitWrites(attachmentName, writes, accessToken);

      if (shouldBumpRevision) {
        stats.noteAttachmentRevisionBumps += 1;
      }

      return attachment;
    } catch (error) {
      if (![400, 409].includes(error.statusCode) || attempt === 2) {
        throw error;
      }
    }
  }

  return null;
}

async function deleteManagedAttachmentObjects(attachment, storageBucket, accessToken, stats) {
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

async function finalizeManagedAttachmentDeletion({
  accessToken,
  attachmentName,
  counterName,
  extraCounterName,
  extraDeleteNames = [],
  projectId,
  stats
}) {
  const normalizedExtraDeleteNames = Array.from(new Set(extraDeleteNames.filter(Boolean)));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attachment = await firestoreGetByName(projectId, attachmentName, accessToken);

    if (!attachment) {
      return false;
    }

    if (!boolField(attachment, "deletionStarted")) {
      throw new Error("Attachment deletion must be claimed before finalization");
    }

    const quotaUid = stringField(attachment, "uploadedBy") || stringField(attachment, "ownerUid");
    const quotaName = quotaUid
      ? documentNameForPath(projectId, `userAttachmentUsage/${quotaUid}`)
      : "";
    const quotaDocument = quotaName
      ? await firestoreGetByName(projectId, quotaName, accessToken, ["uid", "attachmentCount", "usedBytes"])
      : null;
    const encryptedSize = Math.max(0, integerField(attachment, "encryptedSize"));
    const quotaReserved = hasField(attachment, "quotaReserved")
      ? boolField(attachment, "quotaReserved")
      : null;
    const legacyBlobReserved = quotaReserved === null
      && stringField(attachment, "storageProvider") === "vercel-blob"
      && Boolean(stringField(attachment, "blobPath"));
    const claim = quotaReleaseAfterAttachmentClaim({
      attachmentExists: true,
      attachmentUpdateTime: attachment.updateTime,
      attachmentCount: integerField(quotaDocument, "attachmentCount"),
      encryptedSize,
      quotaReserved,
      legacyBlobReserved,
      quotaExists: Boolean(quotaDocument),
      quotaUpdateTime: quotaDocument?.updateTime ?? "",
      uid: quotaUid,
      usedBytes: integerField(quotaDocument, "usedBytes")
    });

    if (!claim) {
      return false;
    }

    const writes = [
      {
        delete: attachmentName,
        currentDocument: { updateTime: claim.attachmentUpdateTime }
      },
      ...normalizedExtraDeleteNames.map((name) => ({ delete: name }))
    ];

    if (claim.quota) {
      writes.push({
        update: {
          name: quotaName,
          fields: {
            uid: stringValue(claim.quota.uid),
            attachmentCount: { integerValue: String(claim.quota.attachmentCount) },
            usedBytes: { integerValue: String(claim.quota.usedBytes) }
          }
        },
        updateMask: { fieldPaths: ["uid", "attachmentCount", "usedBytes"] },
        currentDocument: { updateTime: claim.quota.quotaUpdateTime },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      });
    }

    try {
      await firestoreCommitWrites(attachmentName, writes, accessToken);
      stats[counterName] += 1;
      stats.documentsDeleted += 1 + normalizedExtraDeleteNames.length;

      if (extraCounterName) {
        stats[extraCounterName] += normalizedExtraDeleteNames.length;
      }

      if (claim.quota) {
        stats.attachmentQuotaBytesReleased += encryptedSize;

        if (quotaReserved === true) {
          stats.attachmentQuotaReservationsReleased += 1;
        } else if (legacyBlobReserved) {
          stats.legacyAttachmentQuotaBytesReleased += encryptedSize;
        }
      }

      return true;
    } catch (error) {
      if (![400, 409].includes(error.statusCode)) {
        throw error;
      }

      if (attempt === 2) {
        const remainingAttachment = await firestoreGetByName(
          projectId,
          attachmentName,
          accessToken,
          ["deletionStarted"]
        );

        if (!remainingAttachment) {
          return false;
        }

        throw new Error("Attachment deletion finalization conflict");
      }
    }
  }

  return false;
}

async function cleanupManagedAttachmentDocument({
  accessToken,
  attachmentName,
  bumpSourceNoteRevision = false,
  counterName,
  deletedOwnerUid = "",
  extraCounterName = "",
  extraDeleteNames = [],
  projectId,
  stats,
  storageBucket
}) {
  const attachment = await beginManagedAttachmentDeletion({
    accessToken,
    attachmentName,
    bumpSourceNoteRevision,
    deletedOwnerUid,
    projectId,
    stats
  });

  if (!attachment) {
    return true;
  }

  await deleteManagedAttachmentObjects(attachment, storageBucket, accessToken, stats);
  const finalized = await finalizeManagedAttachmentDeletion({
    accessToken,
    attachmentName,
    counterName,
    extraCounterName,
    extraDeleteNames,
    projectId,
    stats
  });

  return finalized || (
    await firestoreGetByName(projectId, attachmentName, accessToken, ["deletionStarted"])
  ) === null;
}

function documentIsUnderPath(projectId, documentName, pathPrefix) {
  return documentPathFromName(projectId, documentName).startsWith(pathPrefix);
}

function authToken(request) {
  const header = request.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/iu.exec(header);
  return match?.[1] ?? "";
}

async function identityToolkitRequest(projectId, method, accessToken, body) {
  const accountMethod = identityToolkitAccountMethods[method];

  if (!accountMethod) {
    throw new Error("Unsupported Identity Toolkit account method");
  }

  const response = await fetch(
    `${identityToolkitBaseUrl}/projects/${encodeURIComponent(projectId)}/${accountMethod}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  const responseBody = await response.text();

  if (!response.ok) {
    const error = new Error(`Identity Toolkit request failed: ${response.status} ${responseBody.slice(0, 300)}`);
    error.status = response.status;
    error.body = responseBody;
    throw error;
  }

  return responseBody ? JSON.parse(responseBody) : {};
}

async function lookupCallerUid(idToken) {
  const apiKey = firebaseWebApiKey();

  if (!apiKey) {
    throw new Error("Missing Firebase web API key");
  }

  const response = await fetch(`${identityToolkitBaseUrl}/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken })
  });
  const responseBody = await response.text();

  if (!response.ok) {
    if (
      responseBody.includes("INVALID_ID_TOKEN") ||
      responseBody.includes("USER_NOT_FOUND") ||
      responseBody.includes("TOKEN_EXPIRED")
    ) {
      return "";
    }

    const error = new Error(`Identity Toolkit token lookup failed: ${response.status} ${responseBody.slice(0, 300)}`);
    error.status = response.status;
    error.body = responseBody;
    throw error;
  }

  const result = responseBody ? JSON.parse(responseBody) : {};

  const [user] = result.users ?? [];
  return typeof user?.localId === "string" ? user.localId : "";
}

async function deleteAuthUser(projectId, accessToken, uid) {
  try {
    await identityToolkitRequest(projectId, "delete", accessToken, {
      localId: uid
    });
  } catch (error) {
    if (String(error.body ?? "").includes("USER_NOT_FOUND")) {
      return false;
    }

    throw error;
  }

  return true;
}

async function deleteDocumentNamesForStat(documentNames, accessToken, stats, counterName) {
  const deletedCount = await firestoreCommitDeleteMany(documentNames, accessToken);

  stats[counterName] += deletedCount;
  stats.documentsDeleted += deletedCount;

  return deletedCount;
}

async function deleteProjectedDocumentForStat(document, accessToken, stats, counterName) {
  if (!document?.name || !document.updateTime) {
    throw new Error("Projected Firestore delete precondition is required");
  }

  try {
    await firestoreCommitWrites(
      document.name,
      [{ delete: document.name, currentDocument: { updateTime: document.updateTime } }],
      accessToken
    );
  } catch (error) {
    if ([400, 409].includes(errorNumberField(error, "statusCode"))) {
      throw new ManagedUserCleanupInProgressError("Concurrent Firestore delete requires a fresh cleanup pass");
    }

    throw error;
  }

  stats[counterName] += 1;
  stats.documentsDeleted += 1;
  return 1;
}

async function deleteDocumentPathForStat(projectId, documentPath, accessToken, stats, counterName) {
  if (!(await firestoreDelete(projectId, documentPath, accessToken))) {
    return 0;
  }

  stats[counterName] += 1;
  stats.documentsDeleted += 1;

  return 1;
}

async function deleteRepeatedQueryDocuments(queryDocuments, accessToken, stats, counterName, errorMessage) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const documents = await queryDocuments();

    if (documents.length === 0) {
      return deleted;
    }

    const deletedThisPass = await deleteDocumentNamesForStat(
      documents.map((document) => document.name),
      accessToken,
      stats,
      counterName
    );

    deleted += deletedThisPass;

    if (deletedThisPass === 0 || documents.length < managedUserDeleteQueryLimit) {
      return deleted;
    }
  }

  throw new ManagedUserCleanupInProgressError(errorMessage);
}

async function deleteChildDocumentsRepeatedly({
  accessToken,
  batchSize = historyCleanupBatchSize,
  collectionId,
  counterName,
  errorMessage,
  parentName,
  stats
}) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const documents = await listChildDocuments(
      parentName,
      collectionId,
      accessToken,
      batchSize
    );

    if (documents.length === 0) {
      return deleted;
    }

    const deletedThisPass = await deleteDocumentNamesForStat(
      documents.map((document) => document.name),
      accessToken,
      stats,
      counterName
    );
    deleted += deletedThisPass;

    if (deletedThisPass === 0) {
      return deleted;
    }
  }

  throw new ManagedUserCleanupInProgressError(errorMessage);
}

async function deleteChildAttachmentsRepeatedly({
  accessToken,
  bumpSourceNoteRevision = false,
  collectionId = "attachments",
  counterName,
  deletedOwnerUid = "",
  errorMessage,
  extraCounterName = "",
  extraDeleteNamesForAttachment = () => [],
  parentName,
  projectId,
  stats,
  storageBucket
}) {
  const remainingBudget = managedUserAttachmentDeleteBudget - stats.attachmentObjectsProcessed;
  const attachments = await listChildDocuments(
    parentName,
    collectionId,
    accessToken,
    Math.max(1, Math.min(attachmentCleanupBatchSize, remainingBudget))
  );

  if (attachments.length === 0) {
    return 0;
  }

  if (remainingBudget <= 0) {
    throw new ManagedUserCleanupInProgressError();
  }

  let deleted = 0;

  for (const attachment of attachments) {
    stats.attachmentObjectsProcessed += 1;

    if (await cleanupManagedAttachmentDocument({
      accessToken,
      attachmentName: attachment.name,
      bumpSourceNoteRevision,
      counterName,
      deletedOwnerUid,
      extraCounterName,
      extraDeleteNames: extraDeleteNamesForAttachment(attachment.name),
      projectId,
      stats,
      storageBucket
    })) {
      deleted += 1;
    }
  }

  if ((await listChildDocuments(parentName, collectionId, accessToken, 1)).length > 0) {
    throw new ManagedUserCleanupInProgressError(errorMessage);
  }

  return deleted;
}

async function deleteOwnedScheduleTasks(projectId, ownerUid, accessToken, stats) {
  return deleteRepeatedQueryDocuments(
    () => queryOwnedScheduleTasks(projectId, ownerUid, accessToken),
    accessToken,
    stats,
    "scheduleTasksDeleted",
    "Too many schedule tasks to delete in one request"
  );
}

async function deleteOwnedRecurringHabits(projectId, ownerUid, accessToken, stats) {
  return deleteRepeatedQueryDocuments(
    () => queryOwnedRecurringHabits(projectId, ownerUid, accessToken),
    accessToken,
    stats,
    "recurringHabitsDeleted",
    "Too many recurring habits to delete in one request"
  );
}

async function deleteOwnedRecurringHabitCheckIns(projectId, ownerUid, accessToken, stats) {
  return deleteRepeatedQueryDocuments(
    () => queryOwnedRecurringHabitCheckIns(projectId, ownerUid, accessToken),
    accessToken,
    stats,
    "recurringHabitCheckInsDeleted",
    "Too many recurring habit check-ins to delete in one request"
  );
}

async function deleteOwnedNoteFolders(projectId, ownerUid, accessToken, stats) {
  return deleteRepeatedQueryDocuments(
    () => queryOwnedNoteFolders(projectId, ownerUid, accessToken),
    accessToken,
    stats,
    "noteFoldersDeleted",
    "Too many note folders to delete in one request"
  );
}

async function deleteUploadedNoteAttachments(projectId, uid, accessToken, storageBucket, stats) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const remainingBudget = managedUserAttachmentDeleteBudget - stats.attachmentObjectsProcessed;
    const attachments = (
      await queryNoteAttachmentsUploadedBy(
        projectId,
        uid,
        accessToken,
        Math.max(1, Math.min(attachmentCleanupBatchSize, remainingBudget))
      )
    ).filter((attachment) => documentIsUnderPath(projectId, attachment.name, "notes/"));

    if (attachments.length === 0) {
      return deleted;
    }

    if (remainingBudget <= 0) {
      throw new ManagedUserCleanupInProgressError();
    }

    for (const attachment of attachments) {
      stats.attachmentObjectsProcessed += 1;

      if (await cleanupManagedAttachmentDocument({
        accessToken,
        attachmentName: attachment.name,
        bumpSourceNoteRevision: true,
        counterName: "uploadedNoteAttachmentsDeleted",
        deletedOwnerUid: uid,
        projectId,
        stats,
        storageBucket
      })) {
        deleted += 1;
      }
    }

    if (stats.attachmentObjectsProcessed >= managedUserAttachmentDeleteBudget) {
      const remainingAttachment = (
        await queryNoteAttachmentsUploadedBy(projectId, uid, accessToken, 1)
      ).find((attachment) => documentIsUnderPath(projectId, attachment.name, "notes/"));

      if (remainingAttachment) {
        throw new ManagedUserCleanupInProgressError();
      }

      return deleted;
    }
  }

  throw new ManagedUserCleanupInProgressError("Too many uploaded note attachments to delete in one request");
}

async function deleteTargetNoteUserStates(projectId, uid, accessToken, stats) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const states = (await queryNoteUserStatesForUid(projectId, uid, accessToken)).filter((state) =>
      documentIsUnderPath(projectId, state.name, "noteUserStates/")
    );

    if (states.length === 0) {
      return deleted;
    }

    deleted += await deleteDocumentNamesForStat(
      states.map((state) => state.name),
      accessToken,
      stats,
      "noteUserStatesDeleted"
    );

  }

  throw new ManagedUserCleanupInProgressError("Too many note user states to delete in one request");
}

function cleanupQueueNameFromShareName(shareName) {
  return shareName.replace("/publicNoteShares/", "/publicShareCleanupQueue/");
}

function cleanupAttachmentQueueNameFromAttachmentName(projectId, attachmentName) {
  const segments = documentPathFromName(projectId, attachmentName).split("/");

  if (segments.length !== 4 || segments[0] !== "publicNoteShares" || segments[2] !== "attachments") {
    return "";
  }

  return documentNameForPath(
    projectId,
    `publicShareCleanupQueue/${segments[1]}/publicShareAttachmentCleanupQueue/${segments[3]}`
  );
}

async function finalizePublicShareTreeDeletion(projectId, shareName, cleanupQueueName, accessToken, stats) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [share, cleanupQueue] = await Promise.all([
      firestoreGetByName(projectId, shareName, accessToken, ["ownerUid"]),
      firestoreGetByName(projectId, cleanupQueueName, accessToken, ["shareId"])
    ]);
    const writes = [
      ...(share
        ? [{ delete: shareName, currentDocument: { updateTime: share.updateTime } }]
        : []),
      ...(cleanupQueue
        ? [{ delete: cleanupQueueName, currentDocument: { updateTime: cleanupQueue.updateTime } }]
        : [])
    ];

    if (writes.length === 0) {
      return;
    }

    try {
      await firestoreCommitWrites(shareName, writes, accessToken);

      if (share) {
        stats.publicSharesDeleted += 1;
        stats.documentsDeleted += 1;
      }

      if (cleanupQueue) {
        stats.publicShareQueuesDeleted += 1;
        stats.documentsDeleted += 1;
      }

      return;
    } catch (error) {
      if (![400, 409].includes(error.statusCode) || attempt === 2) {
        throw error;
      }
    }
  }
}

async function deletePublicShareTreeByName(projectId, shareName, accessToken, storageBucket, stats) {
  const cleanupQueueName = cleanupQueueNameFromShareName(shareName);

  await deleteChildAttachmentsRepeatedly({
    accessToken,
    counterName: "publicShareAttachmentsDeleted",
    errorMessage: "Too many public share attachments to delete in one request",
    extraCounterName: "publicShareAttachmentQueuesDeleted",
    extraDeleteNamesForAttachment: (attachmentName) => [
      cleanupAttachmentQueueNameFromAttachmentName(projectId, attachmentName)
    ],
    parentName: shareName,
    projectId,
    stats,
    storageBucket
  });
  await deleteChildDocumentsRepeatedly({
    accessToken,
    collectionId: "publicShareAttachmentCleanupQueue",
    counterName: "publicShareAttachmentQueuesDeleted",
    errorMessage: "Too many public share attachment cleanup entries to delete in one request",
    parentName: cleanupQueueName,
    stats
  });

  const [remainingAttachment, remainingCleanupAttachment] = await Promise.all([
    listChildDocuments(shareName, "attachments", accessToken, 1),
    listChildDocuments(cleanupQueueName, "publicShareAttachmentCleanupQueue", accessToken, 1)
  ]);

  if (remainingAttachment.length > 0 || remainingCleanupAttachment.length > 0) {
    throw new Error("Public share attachment cleanup did not reach an empty child collection");
  }

  await finalizePublicShareTreeDeletion(projectId, shareName, cleanupQueueName, accessToken, stats);
}

async function deleteOwnedPublicShares(projectId, ownerUid, accessToken, storageBucket, stats) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const shares = await queryOwnedPublicShares(projectId, ownerUid, accessToken);

    if (shares.length === 0) {
      return deleted;
    }

    for (const share of shares) {
      await deletePublicShareTreeByName(projectId, share.name, accessToken, storageBucket, stats);
      deleted += 1;
    }

    if (shares.length < managedUserDeleteQueryLimit) {
      return deleted;
    }
  }

  throw new ManagedUserCleanupInProgressError("Too many public shares to delete in one request");
}

async function deletePublicSharesForOwnedNote(projectId, noteId, accessToken, storageBucket, stats) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const shares = await queryPublicSharesBySourceNote(projectId, noteId, accessToken);

    if (shares.length === 0) {
      return deleted;
    }

    for (const share of shares) {
      await deletePublicShareTreeByName(projectId, share.name, accessToken, storageBucket, stats);
      deleted += 1;
    }

    if (shares.length < managedUserDeleteQueryLimit) {
      return deleted;
    }
  }

  throw new ManagedUserCleanupInProgressError("Too many note public shares to delete in one request");
}

async function finalizeNoteTreeDeletion(projectId, noteName, accessToken, stats) {
  const noteId = documentIdFromName(noteName);
  const cleanupQueueName = documentNameForPath(projectId, `notePurgeCleanupQueue/${noteId}`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [note, cleanupQueue] = await Promise.all([
      firestoreGetByName(projectId, noteName, accessToken, ["ownerUid"]),
      firestoreGetByName(projectId, cleanupQueueName, accessToken, ["noteId"])
    ]);
    const writes = [
      ...(note
        ? [{ delete: noteName, currentDocument: { updateTime: note.updateTime } }]
        : []),
      ...(cleanupQueue
        ? [{ delete: cleanupQueueName, currentDocument: { updateTime: cleanupQueue.updateTime } }]
        : [])
    ];

    if (writes.length === 0) {
      return;
    }

    try {
      await firestoreCommitWrites(noteName, writes, accessToken);

      if (note) {
        stats.notesDeleted += 1;
        stats.documentsDeleted += 1;
      }

      if (cleanupQueue) {
        stats.notePurgeQueuesDeleted += 1;
        stats.documentsDeleted += 1;
      }

      return;
    } catch (error) {
      if (![400, 409].includes(error.statusCode) || attempt === 2) {
        throw error;
      }
    }
  }
}

async function deleteNoteTreeByName(projectId, noteName, accessToken, storageBucket, stats) {
  const noteId = documentIdFromName(noteName);
  const stateParentName = documentNameForPath(projectId, `noteUserStates/${noteId}`);

  await deletePublicSharesForOwnedNote(projectId, noteId, accessToken, storageBucket, stats);
  await deleteChildAttachmentsRepeatedly({
    accessToken,
    counterName: "noteAttachmentsDeleted",
    errorMessage: "Too many note attachments to delete in one request",
    parentName: noteName,
    projectId,
    stats,
    storageBucket
  });
  await deleteChildDocumentsRepeatedly({
    accessToken,
    collectionId: "history",
    counterName: "noteHistoryDeleted",
    errorMessage: "Too many note history entries to delete in one request",
    parentName: noteName,
    stats
  });
  await deleteChildDocumentsRepeatedly({
    accessToken,
    collectionId: "users",
    counterName: "noteUserStatesDeleted",
    errorMessage: "Too many note user states to delete in one request",
    parentName: stateParentName,
    stats
  });

  const remainingAttachment = await listChildDocuments(noteName, "attachments", accessToken, 1);

  if (remainingAttachment.length > 0) {
    throw new Error("Note attachment cleanup did not reach an empty child collection");
  }

  await finalizeNoteTreeDeletion(projectId, noteName, accessToken, stats);
}

async function deleteOwnedNotes(projectId, ownerUid, accessToken, storageBucket, stats) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const notes = await queryOwnedNotes(projectId, ownerUid, accessToken);

    if (notes.length === 0) {
      return deleted;
    }

    for (const note of notes) {
      await deleteNoteTreeByName(projectId, note.name, accessToken, storageBucket, stats);
      deleted += 1;
    }

    if (notes.length < managedUserDeleteQueryLimit) {
      return deleted;
    }
  }

  throw new ManagedUserCleanupInProgressError("Too many notes to delete in one request");
}

async function deleteNoteHistoryByActor(projectId, uid, accessToken, stats) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const historyDocuments = (await queryNoteHistoryByActor(projectId, uid, accessToken)).filter((history) =>
      documentIsUnderPath(projectId, history.name, "notes/")
    );

    if (historyDocuments.length === 0) {
      return deleted;
    }

    deleted += await deleteDocumentNamesForStat(
      historyDocuments.map((history) => history.name),
      accessToken,
      stats,
      "noteHistoryDeleted"
    );

  }

  throw new ManagedUserCleanupInProgressError("Too many note history entries to delete in one request");
}

async function removeDeletedUserFromNoteHistoryReaders(projectId, uid, accessToken, stats) {
  let updated = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const historyDocuments = (await queryNoteHistoryByReader(projectId, uid, accessToken)).filter((history) =>
      documentIsUnderPath(projectId, history.name, "notes/")
    );

    if (historyDocuments.length === 0) {
      return updated;
    }

    for (const history of historyDocuments) {
      const readerUids = stringArrayField(history, "readerUids").filter((readerUid) => readerUid !== uid);
      const historyPath = documentPathFromName(projectId, history.name);

      if (readerUids.length === 0) {
        await deleteProjectedDocumentForStat(history, accessToken, stats, "noteHistoryDeleted");
      } else {
        await firestorePatchProjectedFields(
          projectId,
          historyPath,
          {
            readerUids: stringArrayValue(readerUids)
          },
          accessToken,
          history
        );
        stats.noteHistoryReaderReferencesRemoved += 1;
      }

      updated += 1;
    }

  }

  throw new ManagedUserCleanupInProgressError("Too many note history reader references to update in one request");
}

async function removeDeletedUserFromParticipantNotes(projectId, targetUid, callerUid, accessToken, stats) {
  let updated = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const notes = await queryParticipantNotes(projectId, targetUid, accessToken);
    let updatedThisPass = 0;

    if (notes.length === 0) {
      return updated;
    }

    for (const note of notes) {
      const ownerUid = stringField(note, "ownerUid");

      if (ownerUid === targetUid) {
        continue;
      }

      const participantUids = stringArrayField(note, "participantUids");
      const remainingParticipantUids = participantUids.filter((uid) => uid !== targetUid);

      if (ownerUid && !remainingParticipantUids.includes(ownerUid)) {
        remainingParticipantUids.unshift(ownerUid);
      }

      if (remainingParticipantUids.length === 0) {
        continue;
      }

      const wrappedKeys = { ...mapField(note, "wrappedKeys") };
      delete wrappedKeys[targetUid];
      const normalizedParticipantUids = Array.from(new Set(remainingParticipantUids));

      await firestorePatchProjectedFields(
        projectId,
        documentPathFromName(projectId, note.name),
        {
          participantUids: stringArrayValue(normalizedParticipantUids),
          type: stringValue(normalizedParticipantUids.length > 1 ? "shared" : "personal"),
          updatedAt: timestampValue(),
          updatedBy: stringValue(callerUid),
          wrappedKeys: mapValue(wrappedKeys)
        },
        accessToken,
        note
      );

      updated += 1;
      updatedThisPass += 1;
      stats.sharedNoteMembershipsRemoved += 1;
    }

    if (updatedThisPass === 0 || notes.length < participantNoteCleanupBatchSize) {
      return updated;
    }
  }

  throw new ManagedUserCleanupInProgressError("Too many shared note memberships to update in one request");
}

async function removeDeletedUserFromShareTargets(projectId, targetUid, accessToken, stats) {
  let updated = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const users = await queryUsersAllowingShareTarget(projectId, targetUid, accessToken);
    let updatedThisPass = 0;

    if (users.length === 0) {
      return updated;
    }

    for (const user of users) {
      const uid = stringField(user, "uid") || documentIdFromName(user.name);

      if (uid === targetUid) {
        continue;
      }

      const allowedShareTargetUids = stringArrayField(user, "allowedShareTargetUids").filter((uidValue) => uidValue !== targetUid);

      await firestorePatchProjectedFields(
        projectId,
        documentPathFromName(projectId, user.name),
        {
          allowedShareTargetUids: stringArrayValue(allowedShareTargetUids),
          updatedAt: timestampValue()
        },
        accessToken,
        user
      );

      updated += 1;
      updatedThisPass += 1;
      stats.shareTargetReferencesRemoved += 1;
    }

    if (updatedThisPass === 0 || users.length < managedUserDeleteQueryLimit) {
      return updated;
    }
  }

  throw new ManagedUserCleanupInProgressError("Too many share target references to update in one request");
}

async function reassignBootstrapAdminIfNeeded(projectId, targetUid, callerUid, accessToken) {
  const bootstrap = await firestoreGet(projectId, "system/bootstrap", accessToken, ["adminUid"]);

  if (!bootstrap || stringField(bootstrap, "adminUid") !== targetUid) {
    return false;
  }

  await firestorePatchProjectedFields(
    projectId,
    "system/bootstrap",
    {
      adminUid: stringValue(callerUid),
      updatedAt: timestampValue()
    },
    accessToken,
    bootstrap
  );

  return true;
}

async function deactivateManagedUserBeforeCleanup(projectId, targetUid, quickKey, accessToken, stats) {
  const inactiveFields = {
    isActive: { booleanValue: false },
    updatedAt: timestampValue()
  };

  stats.userProfileDeactivated = await firestorePatchFieldsIfExists(
    projectId,
    `users/${targetUid}`,
    inactiveFields,
    accessToken
  );
  stats.rosterProfileDeactivated = await firestorePatchFieldsIfExists(
    projectId,
    `publicLoginRoster/${targetUid}`,
    inactiveFields,
    accessToken
  );

  if (quickKey) {
    await deleteDocumentPathForStat(projectId, `quickLoginKeys/${quickKey}`, accessToken, stats, "userDocumentsDeleted");
  }

  await deleteDocumentPathForStat(projectId, `activeNotes/${targetUid}`, accessToken, stats, "userDocumentsDeleted");
}

async function deleteManagedUser({ accessToken, projectId, storageBucket, targetUid, callerUid }) {
  const callerProfile = await firestoreGet(
    projectId,
    `users/${callerUid}`,
    accessToken,
    ["isActive", "isAdmin"]
  );

  if (!callerProfile || !boolField(callerProfile, "isActive") || !boolField(callerProfile, "isAdmin")) {
    return { statusCode: 403, body: { ok: false, error: "admin_required" } };
  }

  if (targetUid === callerUid) {
    return { statusCode: 400, body: { ok: false, error: "cannot_delete_self" } };
  }

  const targetProfile = await firestoreGet(
    projectId,
    `users/${targetUid}`,
    accessToken,
    ["isActive", "isAdmin", "quickKey"]
  );

  if (!targetProfile) {
    return { statusCode: 404, body: { ok: false, error: "user_not_found" } };
  }

  if (boolField(targetProfile, "isAdmin") && boolField(targetProfile, "isActive")) {
    const allUsers = await listCollection(projectId, "users", accessToken, ["isAdmin", "isActive"]);
    const activeAdmins = allUsers.filter((user) => boolField(user, "isAdmin") && boolField(user, "isActive")).length;

    if (activeAdmins <= 1) {
      return { statusCode: 400, body: { ok: false, error: "last_active_admin" } };
    }
  }

  const quickKey = integerField(targetProfile, "quickKey");
  const stats = {
    attachmentObjectsProcessed: 0,
    attachmentQuotaBytesReleased: 0,
    attachmentQuotaReservationsReleased: 0,
    authUserDeleted: false,
    blobObjectsDeleted: 0,
    bootstrapAdminReassigned: false,
    documentsDeleted: 0,
    noteAttachmentsDeleted: 0,
    noteAttachmentRevisionBumps: 0,
    noteFoldersDeleted: 0,
    noteHistoryDeleted: 0,
    noteHistoryReaderReferencesRemoved: 0,
    noteUserStatesDeleted: 0,
    notesDeleted: 0,
    notePurgeQueuesDeleted: 0,
    publicShareAttachmentQueuesDeleted: 0,
    publicShareAttachmentsDeleted: 0,
    publicShareQueuesDeleted: 0,
    publicSharesDeleted: 0,
    recurringHabitCheckInsDeleted: 0,
    recurringHabitsDeleted: 0,
    scheduleTasksDeleted: 0,
    shareTargetReferencesRemoved: 0,
    sharedNoteMembershipsRemoved: 0,
    storageObjectsDeleted: 0,
    legacyAttachmentQuotaBytesReleased: 0,
    uploadedNoteAttachmentsDeleted: 0,
    rosterProfileDeactivated: false,
    userProfileDeactivated: false,
    userDocumentsDeleted: 0
  };

  await deactivateManagedUserBeforeCleanup(projectId, targetUid, quickKey, accessToken, stats);
  stats.authUserDeleted = await deleteAuthUser(projectId, accessToken, targetUid);
  stats.bootstrapAdminReassigned = await reassignBootstrapAdminIfNeeded(projectId, targetUid, callerUid, accessToken);

  await removeDeletedUserFromShareTargets(projectId, targetUid, accessToken, stats);
  await deleteOwnedPublicShares(projectId, targetUid, accessToken, storageBucket, stats);
  await deleteOwnedNotes(projectId, targetUid, accessToken, storageBucket, stats);
  await removeDeletedUserFromParticipantNotes(projectId, targetUid, callerUid, accessToken, stats);
  await deleteUploadedNoteAttachments(projectId, targetUid, accessToken, storageBucket, stats);
  await deleteNoteHistoryByActor(projectId, targetUid, accessToken, stats);
  await removeDeletedUserFromNoteHistoryReaders(projectId, targetUid, accessToken, stats);
  await deleteTargetNoteUserStates(projectId, targetUid, accessToken, stats);
  await deleteOwnedNoteFolders(projectId, targetUid, accessToken, stats);
  await deleteOwnedScheduleTasks(projectId, targetUid, accessToken, stats);
  await deleteOwnedRecurringHabitCheckIns(projectId, targetUid, accessToken, stats);
  await deleteOwnedRecurringHabits(projectId, targetUid, accessToken, stats);

  for (const path of [
    `system/bootstrapAttempts/attempts/${targetUid}`,
    `userAttachmentUsage/${targetUid}`,
    `userPreferences/${targetUid}`,
    `userKeys/${targetUid}`,
    `publicLoginRoster/${targetUid}`,
    `users/${targetUid}`
  ].filter(Boolean)) {
    await deleteDocumentPathForStat(projectId, path, accessToken, stats, "userDocumentsDeleted");
  }

  return { statusCode: 200, body: { ok: true, ...stats } };
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > 4096) {
      throw new Error("Request body is too large");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    jsonResponse(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  try {
    const idToken = authToken(request);

    if (!idToken) {
      jsonResponse(response, 401, { ok: false, error: "missing_auth_token" });
      return;
    }

    const { targetUid } = await readJsonBody(request);

    if (typeof targetUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(targetUid)) {
      jsonResponse(response, 400, { ok: false, error: "invalid_target_uid" });
      return;
    }

    const callerUid = await lookupCallerUid(idToken);

    if (!callerUid) {
      jsonResponse(response, 401, { ok: false, error: "invalid_auth_token" });
      return;
    }

    const credentials = firebaseCredentials();
    const accessToken = await fetchAccessToken(credentials);

    const result = await deleteManagedUser({
      accessToken,
      projectId: credentials.projectId,
      storageBucket: credentials.storageBucket,
      targetUid,
      callerUid
    });
    jsonResponse(response, result.statusCode, result.body);
  } catch (error) {
    if (error instanceof ManagedUserCleanupInProgressError) {
      jsonResponse(response, 202, { ok: false, error: "cleanup_in_progress", retryable: true });
      return;
    }

    console.error("managed user delete failed", safeErrorSummary(error));
    jsonResponse(response, 500, { ok: false, error: "delete_failed" });
  }
}
