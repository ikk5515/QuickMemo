/* global Buffer, URLSearchParams, console, crypto, fetch, process */

const firestoreBaseUrl = "https://firestore.googleapis.com/v1";
const identityToolkitBaseUrl = "https://identitytoolkit.googleapis.com/v1";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const databaseId = "(default)";
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
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

async function queryOwnedScheduleTasks(projectId, ownerUid, accessToken) {
  const result = await firestoreRequest(`${documentsRoot(projectId)}:runQuery`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "scheduleTasks" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "ownerUid" },
            op: "EQUAL",
            value: { stringValue: ownerUid }
          }
        },
        limit: 300
      }
    })
  });

  return result.flatMap((entry) => (entry.document ? [entry.document] : []));
}

function boolField(document, fieldName) {
  return document?.fields?.[fieldName]?.booleanValue === true;
}

function integerField(document, fieldName) {
  const value = document?.fields?.[fieldName]?.integerValue;
  return typeof value === "string" ? Number.parseInt(value, 10) : Number(value ?? 0);
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

async function deleteOwnedScheduleTasks(projectId, ownerUid, accessToken) {
  let deleted = 0;

  for (let iteration = 0; iteration < 20; iteration += 1) {
    const scheduleTasks = await queryOwnedScheduleTasks(projectId, ownerUid, accessToken);

    if (scheduleTasks.length === 0) {
      return deleted;
    }

    for (const task of scheduleTasks) {
      if (await firestoreDelete(projectId, task.name.slice(`${documentsRoot(projectId)}/`.length), accessToken)) {
        deleted += 1;
      }
    }

    if (scheduleTasks.length < 300) {
      return deleted;
    }
  }

  throw new Error("Too many schedule tasks to delete in one request");
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
    authUserDeleted: await deleteAuthUser(projectId, accessToken, targetUid),
    documentsDeleted: 0,
    scheduleTasksDeleted: 0
  };

  stats.scheduleTasksDeleted = await deleteOwnedScheduleTasks(projectId, targetUid, accessToken);
  stats.documentsDeleted += stats.scheduleTasksDeleted;

  for (const path of [
    quickKey ? `quickLoginKeys/${quickKey}` : "",
    `userPreferences/${targetUid}`,
    `activeNotes/${targetUid}`,
    `userKeys/${targetUid}`,
    `publicLoginRoster/${targetUid}`,
    `users/${targetUid}`
  ].filter(Boolean)) {
    if (await firestoreDelete(projectId, path, accessToken)) {
      stats.documentsDeleted += 1;
    }
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
