/* global AbortController, Buffer, Response, URL, URLSearchParams, fetch, process */

import { createHash, randomBytes, timingSafeEqual, webcrypto } from "node:crypto";

export const googleCalendarScope = "https://www.googleapis.com/auth/calendar.events.owned";
export const googleCalendarScopes = ["openid", "email", googleCalendarScope];
export const googleCalendarStateTtlMs = 10 * 60 * 1000;

const firestoreBaseUrl = "https://firestore.googleapis.com/v1";
const identityToolkitBaseUrl = "https://identitytoolkit.googleapis.com/v1";
const googleAuthorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const googleUserInfoUrl = "https://openidconnect.googleapis.com/v1/userinfo";
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const databaseId = "(default)";
const stateCollection = "googleCalendarOAuthStates";
const connectionCollection = "googleCalendarConnections";
const connectionEpochCollection = "googleCalendarConnectionEpochs";
const googleOperationLeaseMs = 3 * 60 * 1000;
const googleDeletionWorkflowLeaseMs = 5 * 60 * 1000;
const oauthSessionCookiePrefix = "qm_google_calendar_oauth";
const upstreamRequestTimeoutMs = 10_000;
const firebaseManagementTokenRefreshSkewMs = 5 * 60 * 1000;
const subtle = webcrypto.subtle;
let cachedFirebaseManagementToken = null;
let pendingFirebaseManagementToken = null;

async function fetchUpstream(input, init = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, upstreamRequestTimeoutMs);

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = response.body ? await response.arrayBuffer() : null;

    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
  } catch (error) {
    if (timedOut) {
      throw upstreamError("Upstream request timed out", 504);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export class HttpError extends Error {
  constructor(statusCode, errorCode, internalMessage = errorCode) {
    super(internalMessage);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export function envValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function jsonResponse(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

export function htmlResponse(response, statusCode, html) {
  const noncePlaceholder = "__QUICKMEMO_CSP_NONCE__";
  const nonce = base64UrlEncode(randomBytes(18));
  const securedHtml = String(html).replaceAll(noncePlaceholder, nonce);

  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(securedHtml);
}

export function googleCalendarResultRedirect(response, kind) {
  if (!new Set(["success", "cancelled", "failed"]).has(kind)) {
    throw new Error("Invalid Google Calendar callback result");
  }
  response.statusCode = 303;
  response.setHeader("location", `/api/google-calendar-auth?result=${kind}`);
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.end();
}

const sensitiveLogPatterns = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /"(?:access_token|refresh_token|id_token|code|code_verifier|state)"\s*:\s*"[^"]+"/giu,
  /"(?:idToken|private_key)"\s*:\s*"[^"]+"/giu,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
  /AIza[0-9A-Za-z_-]{35}/gu
];

export function redactLogMessage(value) {
  return String(value)
    .replace(sensitiveLogPatterns[0], "Bearer [redacted]")
    .replace(sensitiveLogPatterns[1], '"credential":"[redacted]"')
    .replace(sensitiveLogPatterns[2], '"credential":"[redacted]"')
    .replace(sensitiveLogPatterns[3], "[redacted private key]")
    .replace(sensitiveLogPatterns[4], "[redacted api key]")
    .slice(0, 700);
}

export function safeErrorSummary(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactLogMessage(error.message),
      statusCode: Number.isInteger(error.statusCode) ? error.statusCode : undefined,
      upstreamStatus: Number.isInteger(error.upstreamStatus) ? error.upstreamStatus : undefined
    };
  }

  return { message: redactLogMessage(error) };
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
    throw new HttpError(503, "server_not_configured", "Invalid Firebase management credentials");
  }
  const clientEmail = envValue("FIREBASE_CLEANUP_CLIENT_EMAIL") || credentialJson.client_email || "";
  const privateKey = (envValue("FIREBASE_CLEANUP_PRIVATE_KEY") || credentialJson.private_key || "").replace(/\\n/gu, "\n");
  const projectId =
    envValue("FIREBASE_CLEANUP_PROJECT_ID")
    || credentialJson.project_id
    || envValue("VITE_FIREBASE_PROJECT_ID")
    || envValue("GOOGLE_CLOUD_PROJECT");

  if (!clientEmail || !privateKey || !projectId) {
    throw new HttpError(503, "server_not_configured", "Missing Firebase management credentials");
  }

  return { clientEmail, privateKey, projectId };
}

function firebaseWebApiKey() {
  const apiKey = envValue("VITE_FIREBASE_API_KEY") || envValue("FIREBASE_API_KEY");

  if (!apiKey) {
    throw new HttpError(503, "server_not_configured", "Missing Firebase web API key");
  }

  return apiKey;
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Invalid base64url value");
  }

  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function privateKeyDer(privateKey) {
  const base64 = privateKey
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/gu, "");

  return Buffer.from(base64, "base64");
}

async function signJwt(privateKey, unsignedJwt) {
  const cryptoKey = await subtle.importKey(
    "pkcs8",
    privateKeyDer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, Buffer.from(unsignedJwt));
  return base64UrlEncode(Buffer.from(signature));
}

export async function fetchFirebaseManagementAccessToken(credentials) {
  const credentialsFingerprint = createHash("sha256")
    .update(`${credentials.projectId}\0${credentials.clientEmail}\0${credentials.privateKey}`)
    .digest("base64url");

  if (cachedFirebaseManagementToken
    && cachedFirebaseManagementToken.credentialsFingerprint === credentialsFingerprint
    && cachedFirebaseManagementToken.expiresAt > Date.now() + firebaseManagementTokenRefreshSkewMs) {
    return cachedFirebaseManagementToken.accessToken;
  }
  if (pendingFirebaseManagementToken?.credentialsFingerprint === credentialsFingerprint) {
    return pendingFirebaseManagementToken.promise;
  }

  const request = (async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64UrlEncode(JSON.stringify({
      iss: credentials.clientEmail,
      scope: cloudPlatformScope,
      aud: googleTokenUrl,
      iat: nowSeconds,
      exp: nowSeconds + 3600
    }));
    const unsignedJwt = `${header}.${claims}`;
    const assertion = `${unsignedJwt}.${await signJwt(credentials.privateKey, unsignedJwt)}`;
    const tokenResponse = await fetchUpstream(googleTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      })
    });

    if (!tokenResponse.ok) {
      throw upstreamError("Firebase management token request failed", tokenResponse.status);
    }

    const token = await tokenResponse.json();
    const expiresIn = Number(token.expires_in);
    if (typeof token.access_token !== "string"
      || !token.access_token
      || token.access_token.length > 8192
      || !Number.isFinite(expiresIn)
      || expiresIn < 60
      || expiresIn > 7200) {
      throw new Error("Firebase management token response was incomplete");
    }

    cachedFirebaseManagementToken = {
      accessToken: token.access_token,
      credentialsFingerprint,
      expiresAt: Date.now() + expiresIn * 1000
    };
    return token.access_token;
  })();

  pendingFirebaseManagementToken = { credentialsFingerprint, promise: request };
  try {
    return await request;
  } finally {
    if (pendingFirebaseManagementToken?.promise === request) {
      pendingFirebaseManagementToken = null;
    }
  }
}

function authToken(request) {
  const header = request.headers.authorization || request.headers.Authorization || "";
  const normalized = Array.isArray(header) ? header[0] ?? "" : header;
  return /^Bearer\s+(.+)$/iu.exec(normalized)?.[1] ?? "";
}

export async function lookupFirebaseCaller(idToken) {
  const response = await fetchUpstream(
    `${identityToolkitBaseUrl}/accounts:lookup?key=${encodeURIComponent(firebaseWebApiKey())}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );

  if (!response.ok) {
    let errorCode = "";
    try {
      const errorBody = await response.json();
      errorCode = typeof errorBody?.error?.message === "string" ? errorBody.error.message : "";
    } catch {
      // A malformed upstream response is handled as an availability failure.
    }
    if (new Set(["INVALID_ID_TOKEN", "TOKEN_EXPIRED", "USER_DISABLED", "USER_NOT_FOUND"]).has(errorCode)) {
      return null;
    }
    throw upstreamError("Firebase identity lookup failed", response.status);
  }

  const result = await response.json();
  const user = result.users?.[0];
  if (typeof user?.localId !== "string" || !user.localId || user.disabled === true) {
    return null;
  }

  return { uid: user.localId };
}

function encodeDocumentPath(documentPath) {
  return documentPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function documentsRoot(projectId) {
  return `projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents`;
}

function documentName(projectId, documentPath) {
  return `projects/${projectId}/databases/${databaseId}/documents/${documentPath}`;
}

function stringValue(value) {
  return { stringValue: value };
}

function integerValue(value) {
  return { integerValue: String(value) };
}

function timestampValue(value) {
  return { timestampValue: value instanceof Date ? value.toISOString() : value };
}

function arrayStringValue(values) {
  return values.length
    ? { arrayValue: { values: values.map((value) => stringValue(value)) } }
    : { arrayValue: {} };
}

function mapValue(fields) {
  return { mapValue: { fields } };
}

function readString(document, fieldName) {
  const value = document?.fields?.[fieldName]?.stringValue;
  return typeof value === "string" ? value : "";
}

function readInteger(document, fieldName) {
  const value = document?.fields?.[fieldName]?.integerValue;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function readTimestamp(document, fieldName) {
  const value = document?.fields?.[fieldName]?.timestampValue;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function readStringArray(document, fieldName) {
  return (document?.fields?.[fieldName]?.arrayValue?.values ?? [])
    .map((value) => value?.stringValue)
    .filter((value) => typeof value === "string");
}

function readMap(document, fieldName) {
  return document?.fields?.[fieldName]?.mapValue?.fields ?? {};
}

function upstreamError(message, upstreamStatus) {
  const error = new Error(message);
  error.name = "UpstreamError";
  error.upstreamStatus = upstreamStatus;
  return error;
}

async function firestoreGet(projectId, documentPath, accessToken) {
  const response = await fetchUpstream(
    `${firestoreBaseUrl}/${documentsRoot(projectId)}/${encodeDocumentPath(documentPath)}`,
    { headers: { authorization: `Bearer ${accessToken}` } }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw upstreamError("Firestore read failed", response.status);
  }

  return response.json();
}

async function firestoreCommit(projectId, accessToken, writes) {
  const response = await fetchUpstream(`${firestoreBaseUrl}/${documentsRoot(projectId)}:commit`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ writes })
  });

  if (!response.ok) {
    throw upstreamError("Firestore commit failed", response.status);
  }

  return response.json();
}

export async function authenticateActiveUser(request) {
  const idToken = authToken(request);
  if (!idToken) {
    throw new HttpError(401, "authentication_required");
  }

  const caller = await lookupFirebaseCaller(idToken);
  if (!caller) {
    throw new HttpError(401, "authentication_expired");
  }

  const credentials = firebaseManagementCredentials();
  const accessToken = await fetchFirebaseManagementAccessToken(credentials);
  return activeManagementContext(caller.uid, credentials, accessToken);
}

export async function activeManagementContext(uid, credentials, accessToken) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(uid)) {
    throw new HttpError(403, "inactive_user");
  }
  const resolvedCredentials = credentials ?? firebaseManagementCredentials();
  const resolvedAccessToken = accessToken ?? await fetchFirebaseManagementAccessToken(resolvedCredentials);
  const profile = await firestoreGet(resolvedCredentials.projectId, `users/${uid}`, resolvedAccessToken);
  if (!profile || profile.fields?.isActive?.booleanValue !== true) {
    throw new HttpError(403, "inactive_user");
  }
  return { uid, credentials: resolvedCredentials, accessToken: resolvedAccessToken };
}

function headerValue(request, name) {
  const value = request.headers[name] || request.headers[name.toLowerCase()] || "";
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function normalizedOrigin(value) {
  if (typeof value !== "string" || !value || value.length > 300) {
    return "";
  }

  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function requestOrigin(request) {
  const forwardedHost = headerValue(request, "x-forwarded-host") || headerValue(request, "host");
  if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::[0-9]{1,5})?$/u.test(forwardedHost)) {
    return "";
  }

  const forwardedProtocol = headerValue(request, "x-forwarded-proto").split(",")[0]?.trim();
  const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/u.test(forwardedHost);
  const protocol = localHost && forwardedProtocol !== "https" ? "http" : "https";
  return normalizedOrigin(`${protocol}://${forwardedHost}`);
}

function configuredOrigins(request) {
  const origins = new Set();
  const addOrigin = (value) => {
    const origin = normalizedOrigin(value);
    if (origin) {
      origins.add(origin);
    }
  };

  const localRequestOrigin = requestOrigin(request);
  if (/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/u.test(localRequestOrigin)) {
    addOrigin(localRequestOrigin);
  }
  for (const value of envValue("GOOGLE_CALENDAR_ALLOWED_ORIGINS").split(",")) {
    addOrigin(value.trim());
  }

  const productionHost = envValue("VERCEL_PROJECT_PRODUCTION_URL");
  if (productionHost && /^[A-Za-z0-9.-]+$/u.test(productionHost)) {
    addOrigin(`https://${productionHost}`);
  }

  const redirectUri = envValue("GOOGLE_CALENDAR_REDIRECT_URI");
  if (redirectUri) {
    try {
      addOrigin(new URL(redirectUri).origin);
    } catch {
      // Invalid redirect configuration is handled separately.
    }
  }

  return origins;
}

export function ensureSameOrigin(request) {
  const origin = normalizedOrigin(headerValue(request, "origin"));
  if (!origin || !configuredOrigins(request).has(origin)) {
    throw new HttpError(403, "origin_not_allowed");
  }

  const fetchSite = headerValue(request, "sec-fetch-site");
  if (fetchSite && !new Set(["same-origin", "same-site", "none"]).has(fetchSite)) {
    throw new HttpError(403, "origin_not_allowed");
  }
}

export function ensureGoogleRedirectOrigin(request, redirectUri) {
  const requestHeaderOrigin = normalizedOrigin(headerValue(request, "origin"));
  let redirectOrigin = "";

  try {
    redirectOrigin = new URL(redirectUri).origin;
  } catch {
    throw new HttpError(503, "server_not_configured", "Invalid Google Calendar redirect URI");
  }

  if (!requestHeaderOrigin || requestHeaderOrigin !== redirectOrigin) {
    throw new HttpError(403, "google_calendar_canonical_origin_required");
  }
}

export async function readJsonBody(request, maxBytes = 2048) {
  const contentType = headerValue(request, "content-type").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "json_required");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, "request_too_large");
    }
    chunks.push(chunk);
  }

  let value;
  try {
    value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "invalid_json");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request");
  }
  return value;
}

export function assertOnlyKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new HttpError(400, "invalid_request");
  }
}

export function googleRedirectUri(request) {
  const configured = envValue("GOOGLE_CALENDAR_REDIRECT_URI");
  if (configured) {
    let parsed;
    try {
      parsed = new URL(configured);
    } catch {
      throw new HttpError(503, "server_not_configured", "Invalid Google Calendar redirect URI");
    }

    const isLocal = parsed.protocol === "http:"
      && /^(?:localhost|127\.0\.0\.1|\[::1\])$/u.test(parsed.hostname);
    if ((!isLocal && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/api/google-calendar-auth"
      || parsed.search
      || parsed.hash) {
      throw new HttpError(503, "server_not_configured", "Invalid Google Calendar redirect URI");
    }
    return parsed.toString();
  }

  const origin = requestOrigin(request);
  if (/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/u.test(origin)) {
    return `${origin}/api/google-calendar-auth`;
  }

  throw new HttpError(503, "server_not_configured", "Missing Google Calendar redirect URI");
}

function googleEncryptionKey() {
  const raw = envValue("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY");
  if (!raw || !/^[A-Za-z0-9+/_=-]+$/u.test(raw)) {
    throw new HttpError(503, "server_not_configured", "Invalid Google Calendar token encryption key");
  }

  let decoded;
  try {
    decoded = raw.includes("-") || raw.includes("_")
      ? base64UrlDecode(raw.replace(/=+$/u, ""))
      : Buffer.from(raw, "base64");
  } catch {
    throw new HttpError(503, "server_not_configured", "Invalid Google Calendar token encryption key");
  }

  if (decoded.length !== 32) {
    throw new HttpError(503, "server_not_configured", "Google Calendar token encryption key must be 32 bytes");
  }
  return decoded;
}

export function googleCalendarConfig(request) {
  const clientId = envValue("GOOGLE_CALENDAR_CLIENT_ID");
  const clientSecret = envValue("GOOGLE_CALENDAR_CLIENT_SECRET");
  if (!clientId || clientId.length > 300 || !clientSecret || clientSecret.length > 500) {
    throw new HttpError(503, "server_not_configured", "Missing Google Calendar OAuth credentials");
  }

  const redirectUri = googleRedirectUri(request);
  googleEncryptionKey();
  return { clientId, clientSecret, redirectUri };
}

export function isGoogleCalendarConfigured(request) {
  try {
    googleCalendarConfig(request);
    return true;
  } catch {
    return false;
  }
}

export async function buildPkcePair() {
  const verifier = base64UrlEncode(randomBytes(64));
  const challenge = await pkceChallengeForVerifier(verifier);
  return { verifier, challenge };
}

export async function pkceChallengeForVerifier(verifier) {
  if (typeof verifier !== "string" || !/^[A-Za-z0-9_-]{43,128}$/u.test(verifier)) {
    throw new Error("Invalid PKCE verifier");
  }
  return base64UrlEncode(Buffer.from(await subtle.digest("SHA-256", Buffer.from(verifier))));
}

function randomState() {
  return base64UrlEncode(randomBytes(32));
}

export async function createOAuthState(context, codeVerifier, codeChallenge, redirectUri, browserTimeZone) {
  const sessionBinding = randomState();
  const state = randomState();
  const connectionAttemptId = randomState();
  const expiresAt = new Date(Date.now() + googleCalendarStateTtlMs);
  const epochPath = `${connectionEpochCollection}/${context.uid}`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const epochDocument = await firestoreGet(
      context.credentials.projectId,
      epochPath,
      context.accessToken
    );
    if (epochDocument && readString(epochDocument, "ownerUid") !== context.uid) {
      throw new HttpError(403, "permission_denied");
    }
    const connectionEpoch = randomState();

    try {
      await firestoreCommit(context.credentials.projectId, context.accessToken, [
        {
          update: {
            name: documentName(context.credentials.projectId, `${stateCollection}/${state}`),
            fields: {
              ownerUid: stringValue(context.uid),
              codeVerifier: stringValue(codeVerifier),
              codeChallenge: stringValue(codeChallenge),
              redirectUri: stringValue(redirectUri),
              browserTimeZone: stringValue(browserTimeZone),
              connectionAttemptId: stringValue(connectionAttemptId),
              connectionEpoch: stringValue(connectionEpoch),
              sessionBindingHash: stringValue(hashSessionBinding(sessionBinding)),
              expiresAt: timestampValue(expiresAt)
            }
          },
          currentDocument: { exists: false },
          updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]
        },
        {
          update: {
            name: documentName(context.credentials.projectId, epochPath),
            fields: {
              ownerUid: stringValue(context.uid),
              connectionEpoch: stringValue(connectionEpoch)
            }
          },
          currentDocument: epochDocument
            ? { updateTime: epochDocument.updateTime }
            : { exists: false },
          updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
        }
      ]);
      return { state, sessionBinding, connectionAttemptId };
    } catch (error) {
      if (error?.upstreamStatus !== 400 && error?.upstreamStatus !== 409) {
        throw error;
      }
    }
  }

  throw new HttpError(409, "google_connection_changed");
}

export async function consumeOAuthState(projectId, accessToken, state, validateState = () => true) {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(state)) {
    return null;
  }

  const statePath = `${stateCollection}/${state}`;
  const document = await firestoreGet(projectId, statePath, accessToken);
  if (!document) {
    return null;
  }

  const expiresAt = readTimestamp(document, "expiresAt");
  const ownerUid = readString(document, "ownerUid");
  const codeVerifier = readString(document, "codeVerifier");
  const codeChallenge = readString(document, "codeChallenge");
  const redirectUri = readString(document, "redirectUri");
  const sessionBindingHash = readString(document, "sessionBindingHash");
  const browserTimeZone = readString(document, "browserTimeZone");
  const connectionAttemptId = readString(document, "connectionAttemptId");
  const connectionEpoch = readString(document, "connectionEpoch");
  if (!expiresAt
    || Date.parse(expiresAt) <= Date.now()
    || !/^[A-Za-z0-9_-]{43,128}$/u.test(codeVerifier)
    || !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(ownerUid)
    || redirectUri.length > 500
    || !isValidTimeZone(browserTimeZone)
    || !/^[A-Za-z0-9_-]{43}$/u.test(connectionAttemptId)
    || !/^[A-Za-z0-9_-]{43}$/u.test(connectionEpoch)
    || !/^[A-Za-z0-9_-]{43}$/u.test(sessionBindingHash)) {
    return null;
  }

  const parsedState = {
    ownerUid,
    codeVerifier,
    codeChallenge,
    redirectUri,
    sessionBindingHash,
    browserTimeZone,
    connectionAttemptId,
    connectionEpoch
  };
  if (!validateState(parsedState)) {
    return null;
  }

  try {
    await firestoreCommit(projectId, accessToken, [{
      delete: document.name,
      currentDocument: { updateTime: document.updateTime }
    }]);
  } catch (error) {
    if (error?.upstreamStatus === 400 || error?.upstreamStatus === 409) {
      return null;
    }
    throw error;
  }

  return parsedState;
}

function hashSessionBinding(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function parseCookies(request) {
  const result = new Map();
  for (const part of headerValue(request, "cookie").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !result.has(name)) {
      result.set(name, value);
    }
  }
  return result;
}

function oauthSessionCookieName(state) {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(state)) {
    throw new Error("Invalid Google Calendar OAuth state cookie name");
  }
  return `${oauthSessionCookiePrefix}_${state}`;
}

export function oauthSessionCookie(request, state, sessionBinding, clear = false) {
  const secure = requestOrigin(request).startsWith("https://") ? "; Secure" : "";
  const value = clear ? "" : sessionBinding;
  const maxAge = clear ? 0 : Math.floor(googleCalendarStateTtlMs / 1000);
  return `${oauthSessionCookieName(state)}=${value}; Path=/api/google-calendar-auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function oauthSessionCookiePresent(request, state) {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(state)) {
    return false;
  }
  const sessionBinding = parseCookies(request).get(oauthSessionCookieName(state)) ?? "";

  return /^[A-Za-z0-9_-]{43}$/u.test(sessionBinding);
}

export function oauthSessionMatches(request, state, expectedHash) {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(state)) {
    return false;
  }
  const sessionBinding = parseCookies(request).get(oauthSessionCookieName(state)) ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(sessionBinding) || !/^[A-Za-z0-9_-]{43}$/u.test(expectedHash)) {
    return false;
  }
  const actual = Buffer.from(hashSessionBinding(sessionBinding));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function buildGoogleAuthorizationUrl(config, state, challenge) {
  const url = new URL(googleAuthorizationUrl);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: googleCalendarScopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false"
  }).toString();
  return url.toString();
}

export function isValidTimeZone(value) {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > 80
    || !/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+){0,3}$/u.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const googleOAuthErrorCodes = new Set([
  "deleted_client",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "org_internal",
  "unauthorized_client",
  "unsupported_grant_type"
]);

async function googleTokenRequest(body) {
  const response = await fetchUpstream(googleTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body)
  });
  if (!response.ok) {
    let oauthErrorCode = "";
    try {
      const payload = await response.json();
      const candidate = typeof payload?.error === "string" ? payload.error : "";
      oauthErrorCode = googleOAuthErrorCodes.has(candidate) ? candidate : "";
    } catch {
      // Only a fixed OAuth error enum is retained; malformed bodies stay generic.
    }
    const error = upstreamError("Google OAuth token request failed", response.status);
    error.oauthErrorCode = oauthErrorCode;
    error.oauthInvalidGrant = oauthErrorCode === "invalid_grant";
    throw error;
  }
  return response.json();
}

export async function exchangeAuthorizationCode(config, code, codeVerifier) {
  if (typeof code !== "string" || !code || code.length > 4096) {
    throw new HttpError(400, "invalid_callback");
  }
  return googleTokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier
  });
}

export async function fetchGoogleAccount(accessToken) {
  const response = await fetchUpstream(googleUserInfoUrl, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw upstreamError("Google account lookup failed", response.status);
  }
  const account = await response.json();
  if (typeof account.sub !== "string" || !account.sub || account.sub.length > 255) {
    throw new Error("Google account response was incomplete");
  }
  return account;
}

export function maskGoogleEmail(email) {
  if (typeof email !== "string" || email.length > 320) {
    return "Google 계정";
  }
  const match = /^([^@\s]+)@([^@\s]+)$/u.exec(email.trim());
  if (!match) {
    return "Google 계정";
  }
  const local = match[1];
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${match[2].toLowerCase()}`;
}

function refreshTokenAad(uid) {
  return Buffer.from(`${uid}:${envValue("GOOGLE_CALENDAR_CLIENT_ID")}`, "utf8");
}

export async function encryptRefreshToken(refreshToken, uid) {
  if (typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 4096) {
    throw new Error("Invalid Google refresh token");
  }
  const key = await subtle.importKey("raw", googleEncryptionKey(), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = randomBytes(12);
  const cipherText = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: refreshTokenAad(uid), tagLength: 128 },
    key,
    Buffer.from(refreshToken, "utf8")
  );
  return {
    version: 1,
    keyVersion: 1,
    algorithm: "AES-256-GCM",
    iv: base64UrlEncode(iv),
    cipherText: base64UrlEncode(Buffer.from(cipherText))
  };
}

export async function decryptRefreshToken(payload, uid) {
  if (!payload
    || payload.version !== 1
    || payload.keyVersion !== 1
    || payload.algorithm !== "AES-256-GCM"
    || typeof payload.iv !== "string"
    || typeof payload.cipherText !== "string") {
    throw new Error("Invalid encrypted Google refresh token");
  }
  const iv = base64UrlDecode(payload.iv);
  const cipherText = base64UrlDecode(payload.cipherText);
  if (iv.length !== 12 || cipherText.length < 17 || cipherText.length > 8192) {
    throw new Error("Invalid encrypted Google refresh token");
  }
  const key = await subtle.importKey("raw", googleEncryptionKey(), { name: "AES-GCM" }, false, ["decrypt"]);
  const plainText = await subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: refreshTokenAad(uid), tagLength: 128 },
    key,
    cipherText
  );
  return Buffer.from(plainText).toString("utf8");
}

function encryptedTokenValue(payload) {
  return mapValue({
    version: integerValue(payload.version),
    keyVersion: integerValue(payload.keyVersion),
    algorithm: stringValue(payload.algorithm),
    iv: stringValue(payload.iv),
    cipherText: stringValue(payload.cipherText)
  });
}

function encryptedTokenFromDocument(document) {
  const fields = readMap(document, "encryptedRefreshToken");
  return {
    version: Number.parseInt(String(fields.version?.integerValue ?? ""), 10),
    keyVersion: Number.parseInt(String(fields.keyVersion?.integerValue ?? ""), 10),
    algorithm: fields.algorithm?.stringValue,
    iv: fields.iv?.stringValue,
    cipherText: fields.cipherText?.stringValue
  };
}

function normalizedGrantedScopes(scope) {
  if (typeof scope !== "string") {
    return [];
  }
  return [...new Set(scope.split(/\s+/u).filter(Boolean))].sort();
}

export function tokenHasCalendarScope(token) {
  return normalizedGrantedScopes(token?.scope).includes(googleCalendarScope);
}

export async function saveGoogleConnection(
  context,
  token,
  account,
  browserTimeZone,
  connectionAttemptId,
  connectionEpoch
) {
  if (typeof token?.refresh_token !== "string" || !token.refresh_token || !tokenHasCalendarScope(token)) {
    throw new HttpError(400, "google_permission_missing");
  }
  if (!isValidTimeZone(browserTimeZone)) {
    throw new HttpError(400, "invalid_time_zone");
  }
  if (typeof connectionAttemptId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(connectionAttemptId)) {
    throw new HttpError(400, "invalid_connection_attempt");
  }
  if (typeof connectionEpoch !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(connectionEpoch)) {
    throw new HttpError(400, "invalid_connection_attempt");
  }
  const encryptedRefreshToken = await encryptRefreshToken(token.refresh_token, context.uid);
  const emailMasked = maskGoogleEmail(account?.email);
  const subjectHash = createHash("sha256").update(String(account.sub)).digest("base64url");
  const grantedScopes = normalizedGrantedScopes(token.scope);
  const connectionGeneration = randomState();
  const epochDocument = await firestoreGet(
    context.credentials.projectId,
    `${connectionEpochCollection}/${context.uid}`,
    context.accessToken
  );
  if (!epochDocument
    || readString(epochDocument, "ownerUid") !== context.uid
    || readString(epochDocument, "connectionEpoch") !== connectionEpoch) {
    throw new HttpError(409, "google_connection_changed");
  }
  const currentConnection = await getGoogleConnection(context);
  if (connectionOperationLeaseIsActive(currentConnection)
    || connectionDeletionWorkflowLeaseIsActive(currentConnection)) {
    throw new HttpError(409, "google_operation_in_progress");
  }

  await firestoreCommit(context.credentials.projectId, context.accessToken, [
    {
      update: {
        name: documentName(context.credentials.projectId, `${connectionCollection}/${context.uid}`),
        fields: {
          ownerUid: stringValue(context.uid),
          connectionStatus: stringValue("connected"),
          emailMasked: stringValue(emailMasked),
          googleSubjectHash: stringValue(subjectHash),
          connectionGeneration: stringValue(connectionGeneration),
          connectionAttemptId: stringValue(connectionAttemptId),
          connectionEpoch: stringValue(connectionEpoch),
          timeZone: stringValue(browserTimeZone),
          encryptedRefreshToken: encryptedTokenValue(encryptedRefreshToken),
          grantedScopes: arrayStringValue(grantedScopes),
          lastSyncStatus: stringValue("idle"),
          lastReportSequence: integerValue(0),
          syncedCount: integerValue(0),
          lastFailureCode: stringValue("")
        }
      },
      currentDocument: currentConnection
        ? { updateTime: currentConnection.updateTime }
        : { exists: false },
      updateTransforms: [
        { fieldPath: "connectedAt", setToServerValue: "REQUEST_TIME" },
        { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }
      ]
    },
    {
      update: {
        name: epochDocument.name,
        fields: {
          ownerUid: stringValue(context.uid),
          connectionEpoch: stringValue(connectionEpoch)
        }
      },
      updateMask: { fieldPaths: ["ownerUid", "connectionEpoch"] },
      currentDocument: { updateTime: epochDocument.updateTime },
      updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
    }
  ]);
}

export async function getGoogleConnection(context) {
  const document = await firestoreGet(
    context.credentials.projectId,
    `${connectionCollection}/${context.uid}`,
    context.accessToken
  );
  if (!document || readString(document, "ownerUid") !== context.uid) {
    return null;
  }
  return document;
}

function firestoreTimestampRevision(document, fieldName) {
  const value = document?.fields?.[fieldName]?.timestampValue;
  const match = typeof value === "string"
    ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value)
    : null;

  if (!match) {
    return null;
  }
  const milliseconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  const seconds = Math.floor(milliseconds / 1000);
  const nanoseconds = (match[2] ?? "").padEnd(9, "0");
  return `${String(seconds).padStart(12, "0")}.${nanoseconds}`;
}

function assertGoogleCalendarTaskAuthorityInput(taskId, expectedRevision) {
  if (typeof taskId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(taskId)
    || (expectedRevision !== null && (
      typeof expectedRevision !== "string"
      || !/^\d{12}\.\d{9}$/u.test(expectedRevision)
    ))) {
    throw new HttpError(400, "invalid_request");
  }
}

function assertGoogleCalendarConnectionGeneration(expectedGeneration) {
  if (typeof expectedGeneration !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(expectedGeneration)) {
    throw new HttpError(400, "invalid_request");
  }
}

function assertGoogleCalendarLeaseId(leaseId) {
  if (typeof leaseId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(leaseId)) {
    throw new HttpError(400, "invalid_request");
  }
}

export async function getGoogleCalendarTaskAuthority(context, taskId, expectedRevision) {
  assertGoogleCalendarTaskAuthorityInput(taskId, expectedRevision);

  const [tombstone, task] = await Promise.all([
    firestoreGet(
      context.credentials.projectId,
      `googleCalendarTaskTombstones/${taskId}`,
      context.accessToken
    ),
    firestoreGet(
      context.credentials.projectId,
      `scheduleTasks/${taskId}`,
      context.accessToken
    )
  ]);
  const tombstoneLease = tombstone && readString(tombstone, "ownerUid") === context.uid
    && readString(tombstone, "taskId") === taskId
    ? readTimestamp(tombstone, "leaseExpiresAt")
    : null;

  // Authority is evaluated on the server so a slow or fast browser clock cannot
  // keep a lease active after Firestore Rules already consider it expired.
  if (tombstoneLease && Date.parse(tombstoneLease) > Date.now()) {
    return "deleted";
  }
  if (!task || readString(task, "ownerUid") !== context.uid) {
    return "deleted";
  }

  const startDate = readString(task, "startDate") || readString(task, "dueDate");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(startDate)) {
    return "undated";
  }

  const currentRevision = firestoreTimestampRevision(task, "calendarUpdatedAt")
    ?? firestoreTimestampRevision(task, "createdAt")
    ?? firestoreTimestampRevision(task, "updatedAt");
  return expectedRevision === currentRevision ? "current" : "stale";
}

export async function beginGoogleCalendarTaskOperation(
  context,
  expectedGeneration,
  taskId,
  expectedRevision,
  deletionWorkflowLeaseId = null
) {
  assertGoogleCalendarTaskAuthorityInput(taskId, expectedRevision);
  assertGoogleCalendarConnectionGeneration(expectedGeneration);
  if (deletionWorkflowLeaseId !== null) {
    assertGoogleCalendarLeaseId(deletionWorkflowLeaseId);
  }
  const state = await getGoogleCalendarTaskAuthority(context, taskId, expectedRevision);

  // A stale task must be re-read and decrypted by the client before any Google
  // mutation begins. Avoid acquiring a lease that would only block that retry,
  // but still reject an outdated account generation before returning the state.
  if (state === "stale") {
    await requireCurrentGoogleConnection(context, expectedGeneration);
    return {
      state,
      connectionGeneration: expectedGeneration,
      leaseId: null
    };
  }

  const operation = await beginGoogleCalendarOperation(
    context,
    expectedGeneration,
    deletionWorkflowLeaseId
  );
  return { state, ...operation };
}

export async function requireCurrentGoogleConnection(context, expectedGeneration) {
  if (typeof expectedGeneration !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(expectedGeneration)) {
    throw new HttpError(400, "invalid_request");
  }

  const connection = await getGoogleConnection(context);
  if (!connection || readString(connection, "connectionStatus") !== "connected") {
    throw new HttpError(409, "google_calendar_not_connected");
  }
  if (readString(connection, "connectionGeneration") !== expectedGeneration) {
    throw new HttpError(409, "google_connection_changed");
  }
  return connection;
}

function connectionOperationLeaseIsActive(document) {
  const leaseExpiresAt = readTimestamp(document, "operationLeaseExpiresAt");
  return Boolean(leaseExpiresAt && Date.parse(leaseExpiresAt) > Date.now());
}

function connectionDeletionWorkflowLeaseIsActive(document) {
  const leaseExpiresAt = readTimestamp(document, "deletionWorkflowLeaseExpiresAt");
  return Boolean(leaseExpiresAt && Date.parse(leaseExpiresAt) > Date.now());
}

function connectionDeletionWorkflowLeaseMatches(document, expectedGeneration, leaseId) {
  return readString(document, "deletionWorkflowLeaseId") === leaseId
    && readString(document, "deletionWorkflowLeaseGeneration") === expectedGeneration;
}

export async function beginGoogleCalendarDeletionWorkflow(context, expectedGeneration) {
  if (typeof expectedGeneration !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(expectedGeneration)) {
    throw new HttpError(400, "invalid_request");
  }
  const leaseId = randomState();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const connection = await requireCurrentGoogleConnection(context, expectedGeneration);

    if (connectionOperationLeaseIsActive(connection)
      || connectionDeletionWorkflowLeaseIsActive(connection)) {
      throw new HttpError(409, "google_operation_in_progress");
    }

    try {
      await firestoreCommit(context.credentials.projectId, context.accessToken, [{
        update: {
          name: connection.name,
          fields: {
            deletionWorkflowLeaseId: stringValue(leaseId),
            deletionWorkflowLeaseGeneration: stringValue(expectedGeneration),
            deletionWorkflowLeaseExpiresAt: timestampValue(
              new Date(Date.now() + googleDeletionWorkflowLeaseMs)
            )
          }
        },
        updateMask: {
          fieldPaths: [
            "deletionWorkflowLeaseId",
            "deletionWorkflowLeaseGeneration",
            "deletionWorkflowLeaseExpiresAt"
          ]
        },
        currentDocument: { updateTime: connection.updateTime },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      }]);
      return { leaseId, connectionGeneration: expectedGeneration };
    } catch (error) {
      if (error?.upstreamStatus !== 400 && error?.upstreamStatus !== 409) {
        throw error;
      }
    }
  }

  throw new HttpError(409, "google_connection_changed");
}

export async function renewGoogleCalendarDeletionWorkflow(context, expectedGeneration, leaseId) {
  if (typeof expectedGeneration !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(expectedGeneration)
    || typeof leaseId !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(leaseId)) {
    throw new HttpError(400, "invalid_request");
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const connection = await requireCurrentGoogleConnection(context, expectedGeneration);

    if (!connectionDeletionWorkflowLeaseMatches(connection, expectedGeneration, leaseId)
      || !connectionDeletionWorkflowLeaseIsActive(connection)) {
      throw new HttpError(409, "google_operation_expired");
    }

    try {
      await firestoreCommit(context.credentials.projectId, context.accessToken, [{
        update: {
          name: connection.name,
          fields: {
            deletionWorkflowLeaseExpiresAt: timestampValue(
              new Date(Date.now() + googleDeletionWorkflowLeaseMs)
            )
          }
        },
        updateMask: { fieldPaths: ["deletionWorkflowLeaseExpiresAt"] },
        currentDocument: { updateTime: connection.updateTime },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      }]);
    } catch (error) {
      if (error?.upstreamStatus !== 400 && error?.upstreamStatus !== 409) {
        throw error;
      }
      continue;
    }

    const renewedConnection = await requireCurrentGoogleConnection(context, expectedGeneration);
    if (!connectionDeletionWorkflowLeaseMatches(renewedConnection, expectedGeneration, leaseId)
      || !connectionDeletionWorkflowLeaseIsActive(renewedConnection)) {
      throw new HttpError(409, "google_operation_expired");
    }
    return { leaseId, connectionGeneration: expectedGeneration };
  }

  throw new HttpError(409, "google_connection_changed");
}

export async function endGoogleCalendarDeletionWorkflow(context, expectedGeneration, leaseId) {
  if (typeof expectedGeneration !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(expectedGeneration)
    || typeof leaseId !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(leaseId)) {
    throw new HttpError(400, "invalid_request");
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const connection = await getGoogleConnection(context);

    if (!connection
      || readString(connection, "connectionGeneration") !== expectedGeneration
      || readString(connection, "deletionWorkflowLeaseId") !== leaseId) {
      return;
    }

    try {
      await firestoreCommit(context.credentials.projectId, context.accessToken, [{
        update: {
          name: connection.name,
          fields: {
            deletionWorkflowLeaseId: stringValue(""),
            deletionWorkflowLeaseGeneration: stringValue(""),
            deletionWorkflowLeaseExpiresAt: timestampValue("1970-01-01T00:00:00.000Z")
          }
        },
        updateMask: {
          fieldPaths: [
            "deletionWorkflowLeaseId",
            "deletionWorkflowLeaseGeneration",
            "deletionWorkflowLeaseExpiresAt"
          ]
        },
        currentDocument: { updateTime: connection.updateTime },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      }]);
      return;
    } catch (error) {
      if (error?.upstreamStatus !== 400 && error?.upstreamStatus !== 409) {
        throw error;
      }
    }
  }
}

export async function beginGoogleCalendarOperation(
  context,
  expectedGeneration,
  deletionWorkflowLeaseId = null
) {
  if (typeof expectedGeneration !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(expectedGeneration)
    || (deletionWorkflowLeaseId !== null
      && (typeof deletionWorkflowLeaseId !== "string"
        || !/^[A-Za-z0-9_-]{43}$/u.test(deletionWorkflowLeaseId)))) {
    throw new HttpError(400, "invalid_request");
  }
  const leaseId = randomState();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const connection = await requireCurrentGoogleConnection(context, expectedGeneration);

    if (connectionOperationLeaseIsActive(connection)) {
      throw new HttpError(409, "google_operation_in_progress");
    }
    const deletionWorkflowLeaseActive = connectionDeletionWorkflowLeaseIsActive(connection);

    if (deletionWorkflowLeaseActive && !deletionWorkflowLeaseId) {
      throw new HttpError(409, "google_deletion_workflow_in_progress");
    }
    if (deletionWorkflowLeaseId
      && (!connectionDeletionWorkflowLeaseMatches(
        connection,
        expectedGeneration,
        deletionWorkflowLeaseId
      ) || !deletionWorkflowLeaseActive)) {
      throw new HttpError(409, "google_operation_expired");
    }

    const fields = {
      operationLeaseId: stringValue(leaseId),
      operationLeaseGeneration: stringValue(expectedGeneration),
      operationLeaseExpiresAt: timestampValue(new Date(Date.now() + googleOperationLeaseMs)),
      ...(deletionWorkflowLeaseId ? {
        deletionWorkflowLeaseExpiresAt: timestampValue(
          new Date(Date.now() + googleDeletionWorkflowLeaseMs)
        )
      } : {})
    };
    const fieldPaths = [
      "operationLeaseId",
      "operationLeaseGeneration",
      "operationLeaseExpiresAt",
      ...(deletionWorkflowLeaseId ? ["deletionWorkflowLeaseExpiresAt"] : [])
    ];

    try {
      await firestoreCommit(context.credentials.projectId, context.accessToken, [{
        update: {
          name: connection.name,
          fields
        },
        updateMask: { fieldPaths },
        currentDocument: { updateTime: connection.updateTime },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      }]);
      return { leaseId, connectionGeneration: expectedGeneration };
    } catch (error) {
      if (error?.upstreamStatus !== 400 && error?.upstreamStatus !== 409) {
        throw error;
      }
    }
  }

  throw new HttpError(409, "google_connection_changed");
}

export async function requireGoogleCalendarOperation(
  context,
  expectedGeneration,
  leaseId
) {
  if (typeof leaseId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(leaseId)) {
    throw new HttpError(400, "invalid_request");
  }

  // Refresh the lease on every server-side validation. A single logical
  // mutation may span token refreshes, Google conflict retries, and a slow
  // network response; keeping the original fixed deadline would allow an OAuth
  // reconnect to replace the account while that mutation is still in flight.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const connection = await requireCurrentGoogleConnection(context, expectedGeneration);

    if (readString(connection, "operationLeaseId") !== leaseId
      || readString(connection, "operationLeaseGeneration") !== expectedGeneration
      || !connectionOperationLeaseIsActive(connection)) {
      throw new HttpError(409, "google_operation_expired");
    }

    try {
      await firestoreCommit(context.credentials.projectId, context.accessToken, [{
        update: {
          name: connection.name,
          fields: {
            operationLeaseExpiresAt: timestampValue(new Date(Date.now() + googleOperationLeaseMs))
          }
        },
        updateMask: { fieldPaths: ["operationLeaseExpiresAt"] },
        currentDocument: { updateTime: connection.updateTime },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      }]);
    } catch (error) {
      if (error?.upstreamStatus !== 400 && error?.upstreamStatus !== 409) {
        throw error;
      }
      continue;
    }

    const renewedConnection = await requireCurrentGoogleConnection(context, expectedGeneration);
    if (readString(renewedConnection, "operationLeaseId") !== leaseId
      || readString(renewedConnection, "operationLeaseGeneration") !== expectedGeneration
      || !connectionOperationLeaseIsActive(renewedConnection)) {
      throw new HttpError(409, "google_operation_expired");
    }
    return renewedConnection;
  }

  throw new HttpError(409, "google_connection_changed");
}

export async function endGoogleCalendarOperation(context, expectedGeneration, leaseId) {
  if (typeof expectedGeneration !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(expectedGeneration)
    || typeof leaseId !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(leaseId)) {
    throw new HttpError(400, "invalid_request");
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const connection = await getGoogleConnection(context);

    if (!connection
      || readString(connection, "connectionGeneration") !== expectedGeneration
      || readString(connection, "operationLeaseId") !== leaseId) {
      return false;
    }

    try {
      await firestoreCommit(context.credentials.projectId, context.accessToken, [{
        update: {
          name: connection.name,
          fields: {
            operationLeaseId: stringValue(""),
            operationLeaseGeneration: stringValue(""),
            operationLeaseExpiresAt: timestampValue("1970-01-01T00:00:00.000Z")
          }
        },
        updateMask: {
          fieldPaths: ["operationLeaseId", "operationLeaseGeneration", "operationLeaseExpiresAt"]
        },
        currentDocument: { updateTime: connection.updateTime },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      }]);
      return true;
    } catch (error) {
      if (error?.upstreamStatus !== 400 && error?.upstreamStatus !== 409) {
        throw error;
      }
    }
  }

  return false;
}

export async function finishGoogleCalendarTaskOperation(
  context,
  expectedGeneration,
  leaseId,
  taskId,
  expectedRevision
) {
  assertGoogleCalendarTaskAuthorityInput(taskId, expectedRevision);
  assertGoogleCalendarConnectionGeneration(expectedGeneration);
  assertGoogleCalendarLeaseId(leaseId);

  // Preserve the existing convergence order: release the account-bound lease
  // first, then inspect authority. If the authority read times out, the lease is
  // already gone and the durable receipt/tombstone recovery can safely retry.
  const released = await endGoogleCalendarOperation(context, expectedGeneration, leaseId);
  if (!released) {
    throw new HttpError(409, "google_operation_release_failed");
  }

  return getGoogleCalendarTaskAuthority(context, taskId, expectedRevision);
}

export function publicConnectionStatus(document, configured = true) {
  const connectionStatus = readString(document, "connectionStatus");
  const storedConnectionGeneration = document ? readString(document, "connectionGeneration") : "";
  const connectionGeneration = /^[A-Za-z0-9_-]{43}$/u.test(storedConnectionGeneration)
    ? storedConnectionGeneration
    : null;
  const connectionAttemptId = document ? readString(document, "connectionAttemptId") || null : null;
  const hasCalendarScope = document
    ? readStringArray(document, "grantedScopes").includes(googleCalendarScope)
    : false;
  const needsReconnect = connectionStatus === "needs_reconnect"
    || (connectionStatus === "connected" && (!connectionGeneration || !hasCalendarScope));
  const connected = connectionStatus === "connected" && !needsReconnect;
  const rawLastSyncStatus = readString(document, "lastSyncStatus");
  const savedLastSyncStatus = new Set(["idle", "synced", "failed"]).has(rawLastSyncStatus)
    ? rawLastSyncStatus
    : "idle";
  return {
    configured,
    connected,
    hasStoredConnection: Boolean(document),
    needsReconnect,
    connectionGeneration,
    connectionIdentity: googleCalendarConnectionIdentity(document),
    connectionAttemptId,
    connectedAt: readTimestamp(document, "connectedAt"),
    email: document ? readString(document, "emailMasked") || "Google 계정" : null,
    lastSyncStatus: needsReconnect ? "failed" : savedLastSyncStatus,
    lastSyncAt: readTimestamp(document, "lastSyncAt"),
    reportSequence: document ? readInteger(document, "lastReportSequence") : 0,
    syncedCount: document ? readInteger(document, "syncedCount") : 0,
    timeZone: document ? readString(document, "timeZone") || null : null
  };
}

function googleCalendarConnectionIdentity(document) {
  if (!document || typeof document.name !== "string") {
    return null;
  }
  const storedGeneration = readString(document, "connectionGeneration");
  const validGeneration = /^[A-Za-z0-9_-]{43}$/u.test(storedGeneration)
    ? storedGeneration
    : "";
  const stableFields = [
    storedGeneration,
    readString(document, "connectionAttemptId"),
    readString(document, "connectionEpoch")
  ];
  // Modern connections have an immutable random generation, so ordinary sync
  // metadata writes must not make a disconnect request stale. Legacy or
  // malformed connections do not have that invariant: bind their identity to
  // the exact Firestore document version so a replacement cannot be deleted
  // after a CAS retry.
  const stableIdentity = validGeneration
    ? stableFields.join("\0")
    : [
      ...stableFields,
      typeof document.updateTime === "string" ? document.updateTime : "missing-update-time"
    ].join("\0");

  return createHash("sha256")
    .update(`${document.name}\0${stableIdentity}`)
    .digest("base64url");
}

export async function refreshGoogleAccessToken(config, context, document) {
  if (!document || readString(document, "connectionStatus") !== "connected") {
    throw new HttpError(409, "google_calendar_not_connected");
  }
  const connectionGeneration = readString(document, "connectionGeneration");
  if (!connectionGeneration
    || !readStringArray(document, "grantedScopes").includes(googleCalendarScope)) {
    await requireGoogleReconnect(context, document);
  }
  let refreshToken;
  try {
    refreshToken = await decryptRefreshToken(encryptedTokenFromDocument(document), context.uid);
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 503) {
      throw error;
    }
    await requireGoogleReconnect(context, document);
  }
  let token;
  try {
    token = await googleTokenRequest({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });
  } catch (error) {
    if (error?.oauthInvalidGrant) {
      await requireGoogleReconnect(context, document);
    }
    throw error;
  }

  const expiresIn = Number(token?.expires_in);
  if (typeof token?.access_token !== "string"
    || !token.access_token
    || token.access_token.length > 4096
    || !Number.isFinite(expiresIn)
    || expiresIn < 1
    || expiresIn > 7200) {
    throw new Error("Google access token response was incomplete");
  }

  if (typeof token.refresh_token === "string" && token.refresh_token) {
    const rotated = await encryptRefreshToken(token.refresh_token, context.uid);
    let rotationConnection = document;
    let rotationSaved = false;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (readString(rotationConnection, "connectionStatus") !== "connected"
        || readString(rotationConnection, "connectionGeneration") !== connectionGeneration) {
        throw new HttpError(409, "google_connection_changed");
      }

      try {
        await firestoreCommit(context.credentials.projectId, context.accessToken, [{
          update: {
            name: rotationConnection.name,
            fields: { encryptedRefreshToken: encryptedTokenValue(rotated) }
          },
          updateMask: { fieldPaths: ["encryptedRefreshToken"] },
          currentDocument: { updateTime: rotationConnection.updateTime },
          updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
        }]);
        rotationSaved = true;
        break;
      } catch (error) {
        if (error?.upstreamStatus !== 400 && error?.upstreamStatus !== 409) {
          throw error;
        }
        const latestConnection = await getGoogleConnection(context);
        if (!latestConnection) {
          throw new HttpError(409, "google_connection_changed");
        }
        rotationConnection = latestConnection;
      }
    }

    if (!rotationSaved) {
      throw new HttpError(409, "google_connection_changed");
    }
  }

  const currentConnection = await getGoogleConnection(context);
  if (!currentConnection
    || readString(currentConnection, "connectionStatus") !== "connected"
    || readString(currentConnection, "connectionGeneration") !== connectionGeneration) {
    throw new HttpError(409, "google_connection_changed");
  }

  return {
    accessToken: token.access_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    connectionGeneration
  };
}

async function markGoogleReconnectRequired(context, document) {
  await firestoreCommit(context.credentials.projectId, context.accessToken, [{
    update: {
      name: documentName(context.credentials.projectId, `${connectionCollection}/${context.uid}`),
      fields: {
        connectionStatus: stringValue("needs_reconnect"),
        lastSyncStatus: stringValue("failed"),
        lastFailureCode: stringValue("reconnect_required")
      }
    },
    updateMask: { fieldPaths: ["connectionStatus", "lastSyncStatus", "lastFailureCode"] },
    currentDocument: { updateTime: document.updateTime },
    updateTransforms: [
      { fieldPath: "lastSyncAt", setToServerValue: "REQUEST_TIME" },
      { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }
    ]
  }]);
}

async function requireGoogleReconnect(context, document) {
  const expectedGeneration = readString(document, "connectionGeneration");
  let current = document;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const currentStatus = readString(current, "connectionStatus");
    const currentGeneration = readString(current, "connectionGeneration");

    if (currentGeneration !== expectedGeneration) {
      throw new HttpError(409, "google_connection_changed");
    }
    if (currentStatus === "needs_reconnect") {
      throw new HttpError(409, "google_reconnect_required");
    }
    if (currentStatus !== "connected") {
      throw new HttpError(409, "google_calendar_not_connected");
    }

    try {
      await markGoogleReconnectRequired(context, current);
      throw new HttpError(409, "google_reconnect_required");
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      if (error?.upstreamStatus !== 400 && error?.upstreamStatus !== 409) {
        throw error;
      }
      current = await getGoogleConnection(context);
      if (!current) {
        throw new HttpError(409, "google_calendar_not_connected");
      }
    }
  }

  throw new HttpError(409, "google_connection_changed");
}

const allowedFailureCodes = new Set([
  "google_api_error",
  "google_unavailable",
  "network_error",
  "permission_denied",
  "rate_limited",
  "reconnect_required",
  "reauthorization_required",
  "event_conflict",
  "calendar_request_failed",
  "unknown",
  "unknown_error"
]);

export function validateSyncReport(body) {
  assertOnlyKeys(body, ["action", "status", "syncedCount", "failureCode", "connectionGeneration", "reportSequence"]);
  if (!new Set(["synced", "failed"]).has(body.status)
    || !Number.isSafeInteger(body.syncedCount)
    || body.syncedCount < 0
    || body.syncedCount > 100000
    || (body.reportSequence !== undefined && (
      !Number.isSafeInteger(body.reportSequence)
      || body.reportSequence < 1
      || body.reportSequence > Number.MAX_SAFE_INTEGER
    ))
    || typeof body.connectionGeneration !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(body.connectionGeneration)) {
    throw new HttpError(400, "invalid_report");
  }
  if (body.status === "failed" && !allowedFailureCodes.has(body.failureCode)) {
    throw new HttpError(400, "invalid_report");
  }
  if (body.status === "synced" && body.failureCode !== undefined) {
    throw new HttpError(400, "invalid_report");
  }
  return {
    status: body.status,
    syncedCount: body.syncedCount,
    failureCode: body.status === "failed" ? body.failureCode : "",
    connectionGeneration: body.connectionGeneration
  };
}

export async function saveSyncReport(context, report) {
  const requiresReconnect = report.status === "failed"
    && new Set(["permission_denied", "reauthorization_required"]).has(report.failureCode);
  const fieldPaths = ["lastSyncStatus", "lastReportSequence", "syncedCount", "lastFailureCode"];
  if (requiresReconnect) {
    fieldPaths.push("connectionStatus");
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const connection = await getGoogleConnection(context);
    const currentStatus = readString(connection, "connectionStatus");

    if (!connection || readString(connection, "connectionGeneration") !== report.connectionGeneration) {
      throw new HttpError(409, "google_calendar_not_connected");
    }
    if (currentStatus === "needs_reconnect") {
      if (requiresReconnect) {
        return;
      }
      throw new HttpError(409, "google_calendar_not_connected");
    }
    if (currentStatus !== "connected") {
      throw new HttpError(409, "google_calendar_not_connected");
    }

    // The server allocates report order inside the Firestore CAS loop. This avoids
    // cross-tab collisions and permanently large client-clock values.
    const currentSequence = readInteger(connection, "lastReportSequence");
    const nextSequence = currentSequence >= Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : currentSequence + 1;
    const fields = {
      lastSyncStatus: stringValue(report.status),
      lastReportSequence: integerValue(nextSequence),
      syncedCount: integerValue(report.syncedCount),
      lastFailureCode: stringValue(report.failureCode),
      ...(requiresReconnect ? { connectionStatus: stringValue("needs_reconnect") } : {})
    };

    try {
      await firestoreCommit(context.credentials.projectId, context.accessToken, [{
        update: {
          name: connection.name,
          fields
        },
        updateMask: { fieldPaths },
        currentDocument: { updateTime: connection.updateTime },
        updateTransforms: [
          { fieldPath: "lastSyncAt", setToServerValue: "REQUEST_TIME" },
          { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }
        ]
      }]);
      return;
    } catch (error) {
      if (error?.upstreamStatus !== 400 && error?.upstreamStatus !== 409) {
        throw error;
      }
    }
  }

  throw new HttpError(409, "google_connection_changed");
}

export async function disconnectGoogleCalendar(
  context,
  document,
  expectedGeneration = null,
  expectedIdentity = null,
  ignoreOperationLease = false
) {
  if (!ignoreOperationLease && (
    typeof expectedIdentity !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(expectedIdentity)
    || googleCalendarConnectionIdentity(document) !== expectedIdentity
  )) {
    throw new HttpError(409, "google_connection_changed");
  }
  if (expectedGeneration && (!document || readString(document, "connectionGeneration") !== expectedGeneration)) {
    throw new HttpError(409, "google_connection_changed");
  }
  if (!ignoreOperationLease && (
    connectionOperationLeaseIsActive(document)
    || connectionDeletionWorkflowLeaseIsActive(document)
  )) {
    throw new HttpError(409, "google_operation_in_progress");
  }

  // Google's revoke endpoint can invalidate the same Google user's other grants for this OAuth project.
  // Delete only this QuickMemo account's encrypted credential and invalidate every pending OAuth attempt.
  let currentConnection = document;
  const epochPath = `${connectionEpochCollection}/${context.uid}`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!ignoreOperationLease && googleCalendarConnectionIdentity(currentConnection) !== expectedIdentity) {
      throw new HttpError(409, "google_connection_changed");
    }
    if (expectedGeneration
      && (!currentConnection || readString(currentConnection, "connectionGeneration") !== expectedGeneration)) {
      throw new HttpError(409, "google_connection_changed");
    }
    if (!ignoreOperationLease && (
      connectionOperationLeaseIsActive(currentConnection)
      || connectionDeletionWorkflowLeaseIsActive(currentConnection)
    )) {
      throw new HttpError(409, "google_operation_in_progress");
    }
    const epochDocument = await firestoreGet(
      context.credentials.projectId,
      epochPath,
      context.accessToken
    );
    if (epochDocument && readString(epochDocument, "ownerUid") !== context.uid) {
      throw new HttpError(403, "permission_denied");
    }
    const nextEpoch = randomState();
    const writes = [{
      update: {
        name: documentName(context.credentials.projectId, epochPath),
        fields: {
          ownerUid: stringValue(context.uid),
          connectionEpoch: stringValue(nextEpoch)
        }
      },
      currentDocument: epochDocument
        ? { updateTime: epochDocument.updateTime }
        : { exists: false },
      updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
    }];
    if (currentConnection) {
      writes.push({
        delete: currentConnection.name,
        currentDocument: { updateTime: currentConnection.updateTime }
      });
    }

    try {
      await firestoreCommit(context.credentials.projectId, context.accessToken, writes);
      return;
    } catch (error) {
      if (error?.upstreamStatus !== 400 && error?.upstreamStatus !== 409) {
        throw error;
      }
      currentConnection = await getGoogleConnection(context);
    }
  }

  throw new HttpError(409, "google_connection_changed");
}

export async function disconnectGoogleCalendarForManagedUser(projectId, accessToken, uid) {
  const context = { uid, credentials: { projectId }, accessToken };
  const document = await getGoogleConnection(context);
  await disconnectGoogleCalendar(context, document, null, null, true);
}

export function callbackQuery(request) {
  const base = requestOrigin(request) || "https://quickmemo.invalid";
  const parsed = new URL(typeof request.url === "string" ? request.url : "/api/google-calendar-auth", base);
  return {
    code: parsed.searchParams.get("code") ?? "",
    state: parsed.searchParams.get("state") ?? "",
    error: parsed.searchParams.get("error") ?? "",
    result: parsed.searchParams.get("result") ?? ""
  };
}

export function googleCalendarCallbackHtml(kind) {
  const content = {
    success: {
      title: "Google Calendar 연결 완료",
      message: "QuickMemo로 돌아가면 연결 상태가 자동으로 갱신됩니다.",
      badge: "연결 완료",
      tone: "success"
    },
    cancelled: {
      title: "Google Calendar 연결 취소",
      message: "권한을 승인하지 않았습니다. 필요할 때 QuickMemo에서 다시 연결할 수 있습니다.",
      badge: "연결 취소",
      tone: "neutral"
    },
    failed: {
      title: "Google Calendar 연결 실패",
      message: "연결 정보를 확인하지 못했습니다. 이 창을 닫고 QuickMemo에서 다시 시도해주세요.",
      badge: "연결 실패",
      tone: "danger"
    }
  }[kind] ?? null;
  if (!content) {
    throw new Error("Invalid callback page kind");
  }

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${content.title}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f5f6f4; color: #202422; }
    main { width: min(440px, 100%); padding: 34px; border: 1px solid #dde3df; border-radius: 22px; background: #fff; box-shadow: 0 22px 55px rgba(23, 37, 32, .12); }
    .badge { display: inline-flex; padding: 7px 11px; border-radius: 999px; font-size: 13px; font-weight: 750; letter-spacing: -.01em; }
    .success { color: #176556; background: #e5f5ef; }
    .neutral { color: #4f5a55; background: #eef1ef; }
    .danger { color: #a83f36; background: #fdecea; }
    h1 { margin: 20px 0 10px; font-size: 25px; line-height: 1.25; letter-spacing: -.04em; }
    p { margin: 0; color: #5e6863; font-size: 15px; line-height: 1.65; }
    button { display: inline-flex; margin-top: 26px; padding: 11px 16px; border: 0; border-radius: 12px; color: #fff; background: #267567; font: inherit; font-weight: 750; cursor: pointer; }
    button:focus-visible { outline: 3px solid #92cfc4; outline-offset: 3px; }
    button:disabled { cursor: default; opacity: .72; }
    .close-hint { margin-top: 14px; font-size: 13px; }
    @media (prefers-color-scheme: dark) {
      body { background: #111412; color: #f2f5f3; }
      main { border-color: #333a36; background: #1b1f1d; box-shadow: 0 22px 55px rgba(0, 0, 0, .35); }
      p { color: #b6c0bb; }
      .success { color: #8fddca; background: #173a32; }
      .neutral { color: #c4cdc8; background: #303633; }
      .danger { color: #ffaaa1; background: #47241f; }
    }
  </style>
</head>
<body>
  <main>
    <span class="badge ${content.tone}">${content.badge}</span>
    <h1>${content.title}</h1>
    <p>${content.message}</p>
    <button id="close-window" type="button">창 닫기</button>
    <p class="close-hint" id="close-hint" role="status" aria-live="polite" hidden>
      창이 자동으로 닫히지 않으면 브라우저의 닫기 버튼을 눌러주세요.
    </p>
  </main>
  <script nonce="__QUICKMEMO_CSP_NONCE__">
    (() => {
      const closeButton = document.getElementById("close-window");
      const closeHint = document.getElementById("close-hint");
      closeButton.addEventListener("click", () => {
        window.close();
        window.setTimeout(() => {
          closeButton.disabled = true;
          closeButton.textContent = "창을 직접 닫아주세요";
          closeHint.hidden = false;
        }, 150);
      });
    })();
  </script>
</body>
</html>`;
}
