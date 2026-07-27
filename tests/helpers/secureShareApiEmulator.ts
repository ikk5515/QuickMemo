import { Buffer } from "node:buffer";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import handler from "../../api/public-shares-v2.js";

export const secureShareApiEmulatorProjectId = "quickmemo-share-api-test";

const testSecrets = {
  SHARE_COOKIE_NAME_HMAC_KEY: "cookie-name-emulator-test-key-000000000000000000000001",
  SHARE_CSRF_HMAC_KEY: "csrf-emulator-test-key-0000000000000000000000000001",
  SHARE_EMAIL_HMAC_KEY: "email-emulator-test-key-000000000000000000000000001",
  SHARE_OTP_HMAC_KEY: "otp-emulator-test-key-00000000000000000000000000001",
  SHARE_PASSWORD_PEPPER: "password-emulator-test-pepper-000000000000000000001",
  SHARE_PASSWORD_PEPPER_VERSION: "emulator-v1",
  SHARE_RATE_LIMIT_HMAC_KEY: "rate-emulator-test-key-000000000000000000000000001",
  SHARE_SESSION_HMAC_KEY: "session-emulator-test-key-00000000000000000000000001"
} as const;

type FirestoreValue =
  | { arrayValue: { values?: FirestoreValue[] } }
  | { booleanValue: boolean }
  | { bytesValue: string }
  | { doubleValue: number }
  | { integerValue: string }
  | { mapValue: { fields?: Record<string, FirestoreValue> } }
  | { nullValue: null }
  | { referenceValue: string }
  | { stringValue: string }
  | { timestampValue: string };

interface FirestoreDocument {
  createTime?: string;
  fields?: Record<string, FirestoreValue>;
  name: string;
  updateTime?: string;
}

export interface DecodedEmulatorDocument extends Record<string, unknown> {
  __id: string;
  __name: string;
  __updateTime: string;
}

export interface SecureShareSeedOptions {
  accessMode?: "allowed_emails" | "anyone_with_link" | "authenticated_users";
  allowedEmailHashes?: string[];
  challenge?: {
    attempts?: number;
    codeDigest: string;
    emailHash: string;
    id: string;
    status?: "consumed" | "pending";
  };
  emailVerificationRequired?: boolean;
  oneTimeEnabled?: boolean;
  ownerUid?: string;
  passwordEnabled?: boolean;
  passwordHashRecord?: Record<string, unknown>;
  shareId: string;
}

export interface SecureShareApiHarness {
  close(): Promise<void>;
  origin: string;
}

function requiredLoopbackHost(name: "FIREBASE_AUTH_EMULATOR_HOST" | "FIRESTORE_EMULATOR_HOST") {
  const value = process.env[name] ?? "";
  let url: URL;
  try {
    url = new URL(`http://${value}`);
  } catch {
    throw new Error(`${name} must be supplied by Firebase emulators:exec`);
  }
  if (
    !new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname)
    || !url.port
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(`${name} must point to a loopback emulator`);
  }
  return url.host;
}

export function configureSecureShareApiEmulatorEnvironment() {
  requiredLoopbackHost("FIRESTORE_EMULATOR_HOST");
  requiredLoopbackHost("FIREBASE_AUTH_EMULATOR_HOST");
  Object.assign(process.env, {
    ...testSecrets,
    FIREBASE_APP_CHECK_ENFORCEMENT: "off",
    FIREBASE_CLEANUP_PROJECT_ID: secureShareApiEmulatorProjectId,
    GCLOUD_PROJECT: secureShareApiEmulatorProjectId,
    NODE_ENV: "test",
    SECURE_SHARE_EMAIL_ENABLED: "false",
    SECURE_SHARE_V2_ENABLED: "true",
    VERCEL: "1",
    VITE_FIREBASE_API_KEY: "fake-emulator-api-key",
    VITE_FIREBASE_PROJECT_ID: secureShareApiEmulatorProjectId
  });
}

function firestoreRoot() {
  const host = requiredLoopbackHost("FIRESTORE_EMULATOR_HOST");
  return `http://${host}/v1/projects/${secureShareApiEmulatorProjectId}/databases/(default)/documents`;
}

function firestoreEmulatorRoot() {
  const host = requiredLoopbackHost("FIRESTORE_EMULATOR_HOST");
  return `http://${host}/emulator/v1/projects/${secureShareApiEmulatorProjectId}/databases/(default)`;
}

function authEmulatorRoot() {
  const host = requiredLoopbackHost("FIREBASE_AUTH_EMULATOR_HOST");
  return `http://${host}`;
}

function encodeFirestoreValue(value: unknown): FirestoreValue {
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { bytesValue: Buffer.from(value).toString("base64") };
  }
  if (value === null) {
    return { nullValue: null };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return value.length
      ? { arrayValue: { values: value.map(encodeFirestoreValue) } }
      : { arrayValue: {} };
  }
  if (value && typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).flatMap(([key, child]) => (
            child === undefined ? [] : [[key, encodeFirestoreValue(child)]]
          )
          )
        )
      }
    };
  }
  throw new TypeError("Unsupported Firestore emulator seed value");
}

function decodeFirestoreValue(value: FirestoreValue): unknown {
  if ("stringValue" in value) {
    return value.stringValue;
  }
  if ("booleanValue" in value) {
    return value.booleanValue;
  }
  if ("integerValue" in value) {
    return Number.parseInt(value.integerValue, 10);
  }
  if ("doubleValue" in value) {
    return value.doubleValue;
  }
  if ("timestampValue" in value) {
    return value.timestampValue;
  }
  if ("bytesValue" in value) {
    return value.bytesValue;
  }
  if ("referenceValue" in value) {
    return value.referenceValue;
  }
  if ("nullValue" in value) {
    return null;
  }
  if ("arrayValue" in value) {
    return (value.arrayValue.values ?? []).map(decodeFirestoreValue);
  }
  return Object.fromEntries(
    Object.entries(value.mapValue.fields ?? {}).map(([key, child]) => [
      key,
      decodeFirestoreValue(child)
    ])
  );
}

function decodeDocument(document: FirestoreDocument): DecodedEmulatorDocument {
  return {
    ...Object.fromEntries(
      Object.entries(document.fields ?? {}).map(([key, value]) => [
        key,
        decodeFirestoreValue(value)
      ])
    ),
    __id: document.name.split("/").at(-1) ?? "",
    __name: document.name,
    __updateTime: document.updateTime ?? ""
  };
}

function documentName(path: string) {
  return `${firestoreRoot()}/${path}`.replace(/^https?:\/\/[^/]+\/v1\//u, "");
}

async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Emulator request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

export async function clearSecureShareEmulators() {
  await Promise.all([
    jsonRequest(`${firestoreEmulatorRoot()}/documents`, { method: "DELETE" }),
    jsonRequest(
      `${authEmulatorRoot()}/emulator/v1/projects/${secureShareApiEmulatorProjectId}/accounts`,
      { method: "DELETE" }
    )
  ]);
}

export async function writeEmulatorDocuments(
  documents: Array<{ fields: Record<string, unknown>; path: string }>
) {
  await jsonRequest(`${firestoreRoot()}:commit`, {
    method: "POST",
    headers: {
      authorization: "Bearer owner",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      writes: documents.map(({ fields, path }) => ({
        update: {
          name: documentName(path),
          fields: Object.fromEntries(
            Object.entries(fields).flatMap(([key, value]) => (
              value === undefined ? [] : [[key, encodeFirestoreValue(value)]]
            )
            )
          )
        }
      }))
    })
  });
}

export async function patchEmulatorDocuments(
  documents: Array<{ fields: Record<string, unknown>; path: string }>
) {
  await jsonRequest(`${firestoreRoot()}:commit`, {
    method: "POST",
    headers: {
      authorization: "Bearer owner",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      writes: documents.map(({ fields, path }) => ({
        update: {
          name: documentName(path),
          fields: Object.fromEntries(
            Object.entries(fields).flatMap(([key, value]) => (
              value === undefined ? [] : [[key, encodeFirestoreValue(value)]]
            ))
          )
        },
        updateMask: {
          fieldPaths: Object.keys(fields).filter((key) => fields[key] !== undefined)
        }
      }))
    })
  });
}

export async function readEmulatorDocument(path: string) {
  const response = await fetch(`${firestoreRoot()}/${path}`, {
    headers: { authorization: "Bearer owner" }
  });
  if (response.status === 404) {
    return null;
  }
  const body = await response.json() as FirestoreDocument;
  if (!response.ok) {
    throw new Error(`Emulator document read failed (${response.status})`);
  }
  return decodeDocument(body);
}

export async function listEmulatorCollection(path: string) {
  const response = await jsonRequest(`${firestoreRoot()}/${path}?pageSize=300`, {
    headers: { authorization: "Bearer owner" }
  }) as { documents?: FirestoreDocument[] };
  return (response.documents ?? []).map(decodeDocument);
}

export async function seedSecureShare(options: SecureShareSeedOptions) {
  const now = Date.now();
  const ownerUid = options.ownerUid ?? "owner_user";
  const accessMode = options.accessMode ?? "anyone_with_link";
  const oneTimeEnabled = options.oneTimeEnabled ?? true;
  const emailVerificationRequired = options.emailVerificationRequired ?? false;
  const passwordEnabled = options.passwordEnabled ?? false;
  const noteId = `note_${options.shareId}`;
  const cipherSentinel = `ciphertext-must-never-leak-${options.shareId}`;
  const commonPolicyFields = {
    accessMode,
    allowedEmailCount: options.allowedEmailHashes?.length ?? 0,
    allowedEmailHashes: options.allowedEmailHashes ?? [],
    createdAt: new Date(now - 60_000),
    downloadAllowed: false,
    emailVerificationRequired,
    oneTimeEnabled,
    oneTimeScope: "global",
    oneTimeSessionTtlSeconds: 1_800,
    ownerUid,
    passwordEnabled,
    permissionLevel: "view",
    policyVersion: 1,
    quickCopyButtonVisible: false,
    schemaVersion: 2,
    sessionTtlSeconds: 14_400,
    updatedAt: new Date(now - 60_000)
  };
  const documents: Array<{ fields: Record<string, unknown>; path: string }> = [
    {
      path: `users/${ownerUid}`,
      fields: {
        displayName: "Emulator Owner",
        featureAccess: { notes: true },
        isActive: true,
        isAdmin: false,
        uid: ownerUid
      }
    },
    {
      path: `notes/${noteId}`,
      fields: {
        attachmentRevision: 0,
        encryptedBody: { algorithm: "AES-GCM", cipherText: cipherSentinel, iv: "seed-iv", version: 1 },
        encryptedTitle: { algorithm: "AES-GCM", cipherText: cipherSentinel, iv: "seed-iv", version: 1 },
        isDeleted: false,
        isPurged: false,
        ownerUid,
        revision: 1
      }
    },
    {
      path: `publicNoteShares/${options.shareId}`,
      fields: {
        accessModePublicHint: accessMode,
        attachmentCount: 0,
        createdAt: new Date(now - 60_000),
        downloadAllowed: false,
        encryptedBody: { algorithm: "AES-GCM", cipherText: cipherSentinel, iv: "seed-iv", version: 1 },
        encryptedTitle: { algorithm: "AES-GCM", cipherText: cipherSentinel, iv: "seed-iv", version: 1 },
        expiresAt: new Date(now + 60 * 60 * 1000),
        hasPassword: passwordEnabled,
        oneTimeEnabled,
        ownerUid,
        permissionLevel: "view",
        policyVersion: 1,
        quickCopyButtonVisible: false,
        ready: true,
        requiresEmailVerification: emailVerificationRequired,
        schemaVersion: 2,
        sourceAttachmentRevision: 0,
        sourceNoteId: noteId,
        sourceRevision: 1,
        status: "active",
        successfulAccessCount: 0,
        updatedAt: new Date(now - 60_000)
      }
    },
    {
      path: `publicSharePolicies/${options.shareId}`,
      fields: {
        ...commonPolicyFields,
        ...(options.passwordHashRecord
          ? { passwordHashRecord: options.passwordHashRecord }
          : {})
      }
    }
  ];
  if (options.challenge) {
    documents.push({
      path: `publicShareEmailChallenges/${options.challenge.id}`,
      fields: {
        attempts: options.challenge.attempts ?? 0,
        codeDigest: options.challenge.codeDigest,
        createdAt: new Date(now - 5_000),
        emailHash: options.challenge.emailHash,
        expiresAt: new Date(now + 10 * 60 * 1000),
        ownerUid,
        policyVersion: 1,
        shareId: options.shareId,
        status: options.challenge.status ?? "pending",
        updatedAt: new Date(now - 5_000)
      }
    });
  }
  await writeEmulatorDocuments(documents);
  return { cipherSentinel, noteId, ownerUid };
}

export async function createEmulatorOwner(email: string, password: string) {
  const signup = await jsonRequest(
    `${authEmulatorRoot()}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-emulator-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  ) as { idToken: string; localId: string };
  if (!signup.idToken || !signup.localId) {
    throw new Error("Auth Emulator did not create a test owner");
  }
  return signup;
}

export async function startSecureShareApiHarness(): Promise<SecureShareApiHarness> {
  const server: Server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

export function cookiePair(response: Response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const pair = setCookie.split(";", 1)[0];
  if (!/^[^=]+=[A-Za-z0-9_-]{20,}$/u.test(pair)) {
    throw new Error("Expected a secure-share cookie");
  }
  return pair;
}

export function apiHeaders(
  origin: string,
  options: {
    authorization?: string;
    bindingCookie?: string;
    networkSuffix?: number;
  } = {}
) {
  return {
    ...(options.authorization
      ? { authorization: `Bearer ${options.authorization}` }
      : {}),
    ...(options.bindingCookie ? { cookie: options.bindingCookie } : {}),
    "content-type": "application/json",
    origin,
    "sec-fetch-site": "same-origin",
    "user-agent": "QuickMemo-Secure-Share-Emulator-Test/1.0",
    "x-vercel-forwarded-for": `198.51.100.${options.networkSuffix ?? 1}`
  };
}

export async function metadataBinding(
  origin: string,
  shareId: string,
  options: { authorization?: string; networkSuffix?: number } = {}
) {
  const response = await fetch(
    `${origin}/api/public-shares-v2?action=metadata&shareId=${encodeURIComponent(shareId)}`,
    {
      headers: apiHeaders(origin, options)
    }
  );
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Metadata request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return { bindingCookie: cookiePair(response), body, response };
}
