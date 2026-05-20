/* global Buffer, URLSearchParams, console, crypto, fetch, process */

const firestoreBaseUrl = "https://firestore.googleapis.com/v1";
const identityToolkitBaseUrl = "https://identitytoolkit.googleapis.com/v1";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const databaseId = "(default)";
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const managedUserDeleteQueryLimit = 300;
const maxManagedUserDeleteIterations = 50;
const firestoreCommitWriteLimit = 500;
const identityToolkitAccountMethods = {
  lookup: "accounts:lookup",
  delete: "accounts:delete"
};

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
    envValue("FIREBASE_CLEANUP_PROJECT_ID") ||
    credentialJson.project_id ||
    envValue("VITE_FIREBASE_PROJECT_ID") ||
    envValue("GOOGLE_CLOUD_PROJECT");

  if (!clientEmail || !privateKey || !projectId) {
    throw new Error("Missing Firebase management credentials");
  }

  return { clientEmail, privateKey, projectId };
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
    throw new Error(`Firestore request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  return response.json();
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

async function firestoreGet(projectId, documentPath, accessToken) {
  const response = await fetch(`${firestoreBaseUrl}/${documentsRoot(projectId)}/${encodeDocumentPath(documentPath)}`, {
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

async function firestorePatchFields(projectId, documentPath, fields, accessToken) {
  const query = new URLSearchParams();

  Object.keys(fields).forEach((fieldPath) => {
    query.append("updateMask.fieldPaths", fieldPath);
  });

  await firestoreRequest(
    `${documentsRoot(projectId)}/${encodeDocumentPath(documentPath)}?${query.toString()}`,
    accessToken,
    {
      method: "PATCH",
      body: JSON.stringify({ fields })
    }
  );
}

async function listCollection(projectId, collectionId, accessToken) {
  const documents = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({ pageSize: "300" });

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

async function listChildDocuments(parentName, collectionId, accessToken) {
  const documents = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({ pageSize: String(managedUserDeleteQueryLimit) });

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
  op,
  projectId,
  value
}) {
  return runStructuredQuery(projectId, accessToken, {
    from: [{ collectionId, ...(allDescendants ? { allDescendants: true } : {}) }],
    where: {
      fieldFilter: {
        field: { fieldPath },
        op,
        value
      }
    },
    limit: managedUserDeleteQueryLimit
  });
}

async function queryDocumentsByStringField(projectId, collectionId, fieldPath, value, accessToken, allDescendants = false) {
  return queryDocumentsByField({
    accessToken,
    allDescendants,
    collectionId,
    fieldPath,
    op: "EQUAL",
    projectId,
    value: stringValue(value)
  });
}

async function queryDocumentsByArrayContains(projectId, collectionId, fieldPath, value, accessToken, allDescendants = false) {
  return queryDocumentsByField({
    accessToken,
    allDescendants,
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
  return queryDocumentsByArrayContains(projectId, "notes", "participantUids", uid, accessToken);
}

async function queryNoteAttachmentsUploadedBy(projectId, uid, accessToken) {
  return queryDocumentsByStringField(projectId, "attachments", "uploadedBy", uid, accessToken, true);
}

async function queryNoteUserStatesForUid(projectId, uid, accessToken) {
  return queryDocumentsByStringField(projectId, "users", "uid", uid, accessToken, true);
}

async function queryNoteHistoryByActor(projectId, uid, accessToken) {
  return queryDocumentsByStringField(projectId, "history", "actorUid", uid, accessToken, true);
}

async function queryNoteHistoryByReader(projectId, uid, accessToken) {
  return queryDocumentsByArrayContains(projectId, "history", "readerUids", uid, accessToken, true);
}

async function queryUsersAllowingShareTarget(projectId, uid, accessToken) {
  return queryDocumentsByArrayContains(projectId, "users", "allowedShareTargetUids", uid, accessToken);
}

async function queryPublicSharesBySourceNote(projectId, noteId, accessToken) {
  return runStructuredQuery(projectId, accessToken, {
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
  return typeof value === "string" ? Number.parseInt(value, 10) : Number(value ?? 0);
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

async function lookupCallerUid(projectId, accessToken, idToken) {
  const result = await identityToolkitRequest(projectId, "lookup", accessToken, {
    idToken
  });
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

  throw new Error(errorMessage);
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

async function deleteOwnedNoteFolders(projectId, ownerUid, accessToken, stats) {
  return deleteRepeatedQueryDocuments(
    () => queryOwnedNoteFolders(projectId, ownerUid, accessToken),
    accessToken,
    stats,
    "noteFoldersDeleted",
    "Too many note folders to delete in one request"
  );
}

async function deleteUploadedNoteAttachments(projectId, uid, accessToken, stats) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const attachments = (await queryNoteAttachmentsUploadedBy(projectId, uid, accessToken)).filter((attachment) =>
      documentIsUnderPath(projectId, attachment.name, "notes/")
    );

    if (attachments.length === 0) {
      return deleted;
    }

    deleted += await deleteDocumentNamesForStat(
      attachments.map((attachment) => attachment.name),
      accessToken,
      stats,
      "uploadedNoteAttachmentsDeleted"
    );

    if (attachments.length < managedUserDeleteQueryLimit) {
      return deleted;
    }
  }

  throw new Error("Too many uploaded note attachments to delete in one request");
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

    if (states.length < managedUserDeleteQueryLimit) {
      return deleted;
    }
  }

  throw new Error("Too many note user states to delete in one request");
}

function cleanupQueueNameFromShareName(shareName) {
  return shareName.replace("/publicNoteShares/", "/publicShareCleanupQueue/");
}

async function deletePublicShareTreeByName(shareName, accessToken, stats) {
  const cleanupQueueName = cleanupQueueNameFromShareName(shareName);
  const attachmentDocuments = await listChildDocuments(shareName, "attachments", accessToken);
  const cleanupAttachmentDocuments = await listChildDocuments(
    cleanupQueueName,
    "publicShareAttachmentCleanupQueue",
    accessToken
  );

  await deleteDocumentNamesForStat(
    attachmentDocuments.map((attachment) => attachment.name),
    accessToken,
    stats,
    "publicShareAttachmentsDeleted"
  );
  await deleteDocumentNamesForStat(
    cleanupAttachmentDocuments.map((attachment) => attachment.name),
    accessToken,
    stats,
    "publicShareAttachmentQueuesDeleted"
  );
  await deleteDocumentNamesForStat([shareName], accessToken, stats, "publicSharesDeleted");
  await deleteDocumentNamesForStat([cleanupQueueName], accessToken, stats, "publicShareQueuesDeleted");
}

async function deleteOwnedPublicShares(projectId, ownerUid, accessToken, stats) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const shares = await queryOwnedPublicShares(projectId, ownerUid, accessToken);

    if (shares.length === 0) {
      return deleted;
    }

    for (const share of shares) {
      await deletePublicShareTreeByName(share.name, accessToken, stats);
      deleted += 1;
    }

    if (shares.length < managedUserDeleteQueryLimit) {
      return deleted;
    }
  }

  throw new Error("Too many public shares to delete in one request");
}

async function deletePublicSharesForOwnedNote(projectId, noteId, accessToken, stats) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const shares = await queryPublicSharesBySourceNote(projectId, noteId, accessToken);

    if (shares.length === 0) {
      return deleted;
    }

    for (const share of shares) {
      await deletePublicShareTreeByName(share.name, accessToken, stats);
      deleted += 1;
    }

    if (shares.length < managedUserDeleteQueryLimit) {
      return deleted;
    }
  }

  throw new Error("Too many note public shares to delete in one request");
}

async function deleteNoteTreeByName(projectId, noteName, accessToken, stats) {
  const noteId = documentIdFromName(noteName);
  const stateParentName = documentNameForPath(projectId, `noteUserStates/${noteId}`);
  const attachmentDocuments = await listChildDocuments(noteName, "attachments", accessToken);
  const historyDocuments = await listChildDocuments(noteName, "history", accessToken);
  const stateDocuments = await listChildDocuments(stateParentName, "users", accessToken);

  await deletePublicSharesForOwnedNote(projectId, noteId, accessToken, stats);
  await deleteDocumentNamesForStat(
    attachmentDocuments.map((attachment) => attachment.name),
    accessToken,
    stats,
    "noteAttachmentsDeleted"
  );
  await deleteDocumentNamesForStat(
    historyDocuments.map((history) => history.name),
    accessToken,
    stats,
    "noteHistoryDeleted"
  );
  await deleteDocumentNamesForStat(
    stateDocuments.map((state) => state.name),
    accessToken,
    stats,
    "noteUserStatesDeleted"
  );
  await deleteDocumentNamesForStat([noteName], accessToken, stats, "notesDeleted");
}

async function deleteOwnedNotes(projectId, ownerUid, accessToken, stats) {
  let deleted = 0;

  for (let iteration = 0; iteration < maxManagedUserDeleteIterations; iteration += 1) {
    const notes = await queryOwnedNotes(projectId, ownerUid, accessToken);

    if (notes.length === 0) {
      return deleted;
    }

    for (const note of notes) {
      await deleteNoteTreeByName(projectId, note.name, accessToken, stats);
      deleted += 1;
    }

    if (notes.length < managedUserDeleteQueryLimit) {
      return deleted;
    }
  }

  throw new Error("Too many notes to delete in one request");
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

    if (historyDocuments.length < managedUserDeleteQueryLimit) {
      return deleted;
    }
  }

  throw new Error("Too many note history entries to delete in one request");
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
        await deleteDocumentNamesForStat([history.name], accessToken, stats, "noteHistoryDeleted");
      } else {
        await firestorePatchFields(
          projectId,
          historyPath,
          {
            readerUids: stringArrayValue(readerUids)
          },
          accessToken
        );
        stats.noteHistoryReaderReferencesRemoved += 1;
      }

      updated += 1;
    }

    if (historyDocuments.length < managedUserDeleteQueryLimit) {
      return updated;
    }
  }

  throw new Error("Too many note history reader references to update in one request");
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

      await firestorePatchFields(
        projectId,
        documentPathFromName(projectId, note.name),
        {
          participantUids: stringArrayValue(normalizedParticipantUids),
          type: stringValue(normalizedParticipantUids.length > 1 ? "shared" : "personal"),
          updatedAt: timestampValue(),
          updatedBy: stringValue(callerUid),
          wrappedKeys: mapValue(wrappedKeys)
        },
        accessToken
      );

      updated += 1;
      updatedThisPass += 1;
      stats.sharedNoteMembershipsRemoved += 1;
    }

    if (updatedThisPass === 0 || notes.length < managedUserDeleteQueryLimit) {
      return updated;
    }
  }

  throw new Error("Too many shared note memberships to update in one request");
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

      await firestorePatchFields(
        projectId,
        documentPathFromName(projectId, user.name),
        {
          allowedShareTargetUids: stringArrayValue(allowedShareTargetUids),
          updatedAt: timestampValue()
        },
        accessToken
      );

      updated += 1;
      updatedThisPass += 1;
      stats.shareTargetReferencesRemoved += 1;
    }

    if (updatedThisPass === 0 || users.length < managedUserDeleteQueryLimit) {
      return updated;
    }
  }

  throw new Error("Too many share target references to update in one request");
}

async function reassignBootstrapAdminIfNeeded(projectId, targetUid, callerUid, accessToken) {
  const bootstrap = await firestoreGet(projectId, "system/bootstrap", accessToken);

  if (!bootstrap || stringField(bootstrap, "adminUid") !== targetUid) {
    return false;
  }

  await firestorePatchFields(
    projectId,
    "system/bootstrap",
    {
      adminUid: stringValue(callerUid),
      updatedAt: timestampValue()
    },
    accessToken
  );

  return true;
}

async function deleteManagedUser({ accessToken, projectId, targetUid, callerUid }) {
  const callerProfile = await firestoreGet(projectId, `users/${callerUid}`, accessToken);

  if (!callerProfile || !boolField(callerProfile, "isActive") || !boolField(callerProfile, "isAdmin")) {
    return { statusCode: 403, body: { ok: false, error: "admin_required" } };
  }

  if (targetUid === callerUid) {
    return { statusCode: 400, body: { ok: false, error: "cannot_delete_self" } };
  }

  const targetProfile = await firestoreGet(projectId, `users/${targetUid}`, accessToken);

  if (!targetProfile) {
    return { statusCode: 404, body: { ok: false, error: "user_not_found" } };
  }

  if (boolField(targetProfile, "isAdmin") && boolField(targetProfile, "isActive")) {
    const allUsers = await listCollection(projectId, "users", accessToken);
    const activeAdmins = allUsers.filter((user) => boolField(user, "isAdmin") && boolField(user, "isActive")).length;

    if (activeAdmins <= 1) {
      return { statusCode: 400, body: { ok: false, error: "last_active_admin" } };
    }
  }

  const quickKey = integerField(targetProfile, "quickKey");
  const stats = {
    authUserDeleted: false,
    bootstrapAdminReassigned: false,
    documentsDeleted: 0,
    noteAttachmentsDeleted: 0,
    noteFoldersDeleted: 0,
    noteHistoryDeleted: 0,
    noteHistoryReaderReferencesRemoved: 0,
    noteUserStatesDeleted: 0,
    notesDeleted: 0,
    publicShareAttachmentQueuesDeleted: 0,
    publicShareAttachmentsDeleted: 0,
    publicShareQueuesDeleted: 0,
    publicSharesDeleted: 0,
    scheduleTasksDeleted: 0,
    shareTargetReferencesRemoved: 0,
    sharedNoteMembershipsRemoved: 0,
    uploadedNoteAttachmentsDeleted: 0,
    userDocumentsDeleted: 0
  };

  await removeDeletedUserFromShareTargets(projectId, targetUid, accessToken, stats);
  await deleteOwnedPublicShares(projectId, targetUid, accessToken, stats);
  await deleteOwnedNotes(projectId, targetUid, accessToken, stats);
  await removeDeletedUserFromParticipantNotes(projectId, targetUid, callerUid, accessToken, stats);
  await deleteUploadedNoteAttachments(projectId, targetUid, accessToken, stats);
  await deleteNoteHistoryByActor(projectId, targetUid, accessToken, stats);
  await removeDeletedUserFromNoteHistoryReaders(projectId, targetUid, accessToken, stats);
  await deleteTargetNoteUserStates(projectId, targetUid, accessToken, stats);
  await deleteOwnedNoteFolders(projectId, targetUid, accessToken, stats);
  await deleteOwnedScheduleTasks(projectId, targetUid, accessToken, stats);

  stats.bootstrapAdminReassigned = await reassignBootstrapAdminIfNeeded(projectId, targetUid, callerUid, accessToken);

  for (const path of [
    quickKey ? `quickLoginKeys/${quickKey}` : "",
    `system/bootstrapAttempts/attempts/${targetUid}`,
    `userPreferences/${targetUid}`,
    `activeNotes/${targetUid}`,
    `userKeys/${targetUid}`,
    `publicLoginRoster/${targetUid}`,
    `users/${targetUid}`
  ].filter(Boolean)) {
    await deleteDocumentPathForStat(projectId, path, accessToken, stats, "userDocumentsDeleted");
  }

  stats.authUserDeleted = await deleteAuthUser(projectId, accessToken, targetUid);

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

    const credentials = firebaseCredentials();
    const accessToken = await fetchAccessToken(credentials);
    const callerUid = await lookupCallerUid(credentials.projectId, accessToken, idToken);

    if (!callerUid) {
      jsonResponse(response, 401, { ok: false, error: "invalid_auth_token" });
      return;
    }

    const result = await deleteManagedUser({
      accessToken,
      projectId: credentials.projectId,
      targetUid,
      callerUid
    });
    jsonResponse(response, result.statusCode, result.body);
  } catch (error) {
    console.error("managed user delete failed", error);
    jsonResponse(response, 500, { ok: false, error: "delete_failed" });
  }
}
