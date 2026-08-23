/* global Buffer, TextEncoder, crypto, fetch, process */

import { createHash } from "node:crypto";
import {
  clearSecureShareEmulators,
  createEmulatorOwner,
  listEmulatorCollection,
  patchEmulatorDocuments,
  readEmulatorDocument,
  secureShareApiEmulatorProjectId,
  writeEmulatorDocuments
} from "../helpers/secureShareApiEmulator.ts";
import {
  emailDigest,
  hashSharePassword
} from "../../api/_secure-share-common.js";

const authApiKey = "fake-emulator-api-key";
const authBaseUrl = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
const encoder = new TextEncoder();
const defaultPassword = "E2e-Share-Password!";
const defaultAllowedEmail = "allowed-e2e@example.test";
const testLoginPassword = "E2e-Login-Password!";

function randomSuffix() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20);
}

export function e2eSeoulEmailQuotaMonthWindow(now) {
  const seoulNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const monthKey = seoulNow.toISOString().slice(0, 7);
  const nextMonth = new Date(Date.UTC(
    seoulNow.getUTCFullYear(),
    seoulNow.getUTCMonth() + 1,
    1
  ) - 9 * 60 * 60 * 1000);

  return { monthKey, nextMonth };
}

export async function seedE2eEmailQuotaAtHardLimit() {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const { monthKey, nextMonth } = e2eSeoulEmailQuotaMonthWindow(now);
  const nextDay = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  ));
  await writeEmulatorDocuments([
    {
      path: `publicShareEmailQuotaBuckets/day_${dayKey}`,
      fields: {
        scope: "daily",
        periodKey: dayKey,
        reservedCount: 0,
        sentCount: 80,
        softLimit: 64,
        hardLimit: 80,
        softLimitReached: true,
        updatedAt: now,
        expiresAt: new Date(nextDay.getTime() + 45 * 24 * 60 * 60 * 1000)
      }
    },
    {
      path: `publicShareEmailQuotaBuckets/month_${monthKey}`,
      fields: {
        scope: "monthly",
        periodKey: monthKey,
        reservedCount: 0,
        sentCount: 2_400,
        softLimit: 1_920,
        hardLimit: 2_400,
        softLimitReached: true,
        updatedAt: now,
        expiresAt: new Date(nextMonth.getTime() + 400 * 24 * 60 * 60 * 1000)
      }
    }
  ]);
}

function toBase64(value) {
  return Buffer.from(value).toString("base64");
}

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function encryptBytes(value, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherText = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    value
  );
  return {
    cipherBytes: new Uint8Array(cipherText),
    payload: {
      version: 1,
      algorithm: "AES-GCM",
      cipherText: toBase64(cipherText),
      iv: toBase64(iv)
    },
    iv
  };
}

async function encryptText(value, key) {
  return (await encryptBytes(encoder.encode(value), key)).payload;
}

async function createShareContent(label) {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const title = `E2E ${label} 보안 공유`;
  const bodyText = `E2E ${label} 본문`;
  const body = [
    "<!--qm-font-size:17-->",
    `<p>${bodyText}</p>`,
    "<img src=\"x\" onerror=\"window.__quickMemoE2eXss = true\">",
    "<script>window.__quickMemoE2eXss = true</script>"
  ].join("");

  return {
    bodyText,
    contentKey: toBase64Url(rawKey),
    encryptedBody: await encryptText(body, key),
    encryptedTitle: await encryptText(title, key),
    key,
    title
  };
}

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`Auth Emulator request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function verifyAuthEmail(idToken, email) {
  await jsonRequest(
    `${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${authApiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken, requestType: "VERIFY_EMAIL" })
    }
  );
  const oobResult = await jsonRequest(
    `${authBaseUrl}/emulator/v1/projects/${secureShareApiEmulatorProjectId}/oobCodes`
  );
  const code = (oobResult.oobCodes ?? [])
    .find((candidate) => candidate.email === email && candidate.requestType === "VERIFY_EMAIL")
    ?.oobCode;

  if (!code) {
    throw new Error("Auth Emulator did not create an email verification code");
  }
  await jsonRequest(
    `${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:update?key=${authApiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oobCode: code })
    }
  );
}

async function signInAuthUser(email, password) {
  return jsonRequest(
    `${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${authApiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
}

async function userKeyBundle(password) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["encrypt", "decrypt"]
  );
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const passwordKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 210_000,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  return {
    encryptedPrivateKeyJwk: await encryptText(JSON.stringify(privateKeyJwk), passwordKey),
    kdfIterations: 210_000,
    kdfSalt: toBase64(salt),
    publicKeyJwk
  };
}

async function createLoginUser({
  displayName,
  initializeVaultIntegrity = false,
  isAdmin = false,
  verified
}) {
  const suffix = randomSuffix();
  const email = `e2e-${suffix}@example.test`;
  const created = await createEmulatorOwner(email, testLoginPassword);

  if (verified) {
    await verifyAuthEmail(created.idToken, email);
  }
  const signedIn = await signInAuthUser(email, testLoginPassword);
  const keys = await userKeyBundle(testLoginPassword);
  const now = new Date();
  const order = Math.floor(Date.now() % 1_000_000);
  const profile = {
    uid: created.localId,
    displayName,
    avatarText: "E2E",
    color: "#2563eb",
    order,
    quickKey: 91,
    loginEmail: email,
    isActive: true,
    isAdmin,
    role: isAdmin ? "admin" : "user",
    publicKeyJwk: keys.publicKeyJwk,
    allowedShareTargetUids: [created.localId],
    featureAccess: {
      notes: true,
      library: true,
      schedule: true
    },
    createdAt: now,
    updatedAt: now,
    needsKeyRecovery: false
  };
  const vaultIntegrityDocument = initializeVaultIntegrity
    ? {
        path: `vaultIntegrity/${created.localId}`,
        fields: {
          createdAt: now,
          cutoverState: "ready",
          cutoverVersion: 1,
          indexVersion: 1,
          ownerUid: created.localId,
          updatedAt: now,
          verifiedAt: now,
          wrappedKey: {
            version: 1,
            algorithm: "RSA-OAEP",
            wrappedKey: toBase64(await crypto.subtle.encrypt(
              { name: "RSA-OAEP" },
              await crypto.subtle.importKey(
                "jwk",
                keys.publicKeyJwk,
                { name: "RSA-OAEP", hash: "SHA-256" },
                false,
                ["encrypt"]
              ),
              crypto.getRandomValues(new Uint8Array(32))
            ))
          }
        }
      }
    : null;
  await writeEmulatorDocuments([
    { path: `users/${created.localId}`, fields: profile },
    {
      path: `publicLoginRoster/${created.localId}`,
      fields: {
        uid: profile.uid,
        displayName: profile.displayName,
        avatarText: profile.avatarText,
        color: profile.color,
        order: profile.order,
        quickKey: profile.quickKey,
        loginEmail: profile.loginEmail,
        isActive: profile.isActive,
        isAdmin: profile.isAdmin
      }
    },
    {
      path: `userKeys/${created.localId}`,
      fields: {
        uid: created.localId,
        publicKeyJwk: keys.publicKeyJwk,
        encryptedPrivateKeyJwk: keys.encryptedPrivateKeyJwk,
        kdfSalt: keys.kdfSalt,
        kdfIterations: keys.kdfIterations,
        updatedAt: now
      }
    },
    ...(vaultIntegrityDocument ? [vaultIntegrityDocument] : [])
  ]);

  return {
    displayName,
    email,
    idToken: signedIn.idToken,
    password: testLoginPassword,
    uid: created.localId,
    verified
  };
}

function scenarioOptions(scenario) {
  const options = {
    accessMode: "anyone_with_link",
    downloadAllowed: true,
    emailVerificationRequired: false,
    expiresOffsetMs: 60 * 60 * 1000,
    oneTimeEnabled: false,
    ownerAuth: false,
    passwordEnabled: false,
    permissionLevel: "view",
    quickCopyButtonVisible: true,
    schemaVersion: 2,
    showCommenterIpPrefix: false,
    standardV2Url: false,
    viewerAdmin: false,
    viewerAuth: null,
    withAttachment: false
  };

  if (scenario === "legacy") {
    options.schemaVersion = 1;
  } else if (scenario === "password") {
    options.passwordEnabled = true;
  } else if (scenario === "otp" || scenario === "otp-disallowed") {
    options.accessMode = "allowed_emails";
    options.emailVerificationRequired = true;
  } else if (scenario === "one-time") {
    options.oneTimeEnabled = true;
  } else if (scenario === "pdf-attachment") {
    options.withAttachment = true;
  } else if (scenario === "standard-v2-one-time") {
    options.oneTimeEnabled = true;
    options.standardV2Url = true;
  } else if (scenario === "view-attachment") {
    options.downloadAllowed = false;
    options.quickCopyButtonVisible = false;
    options.withAttachment = true;
  } else if (scenario === "comment") {
    options.ownerAuth = true;
    options.permissionLevel = "comment";
    options.showCommenterIpPrefix = true;
  } else if (scenario === "save-copy") {
    options.permissionLevel = "save_copy";
    options.viewerAuth = "verified";
  } else if (scenario === "save-copy-attachment") {
    options.permissionLevel = "save_copy";
    options.viewerAuth = "verified";
    options.withAttachment = true;
  } else if (scenario === "admin-layout") {
    options.accessMode = "authenticated_users";
    options.emailVerificationRequired = true;
    options.viewerAdmin = true;
    options.viewerAuth = "verified";
  } else if (scenario === "authenticated-verified") {
    options.accessMode = "authenticated_users";
    options.emailVerificationRequired = true;
    options.viewerAuth = "verified";
  } else if (scenario === "authenticated-unverified") {
    options.accessMode = "authenticated_users";
    options.emailVerificationRequired = true;
    options.viewerAuth = "unverified";
  } else if (scenario === "owner-preview") {
    options.oneTimeEnabled = true;
    options.ownerAuth = true;
    options.permissionLevel = "comment";
    options.showCommenterIpPrefix = true;
  } else if (scenario === "responsive") {
    options.permissionLevel = "comment";
    options.showCommenterIpPrefix = true;
  } else if (scenario === "lifecycle") {
    options.ownerAuth = true;
  } else if (scenario === "expired") {
    options.expiresOffsetMs = -60 * 1000;
  }

  return options;
}

async function sourceDocuments(ownerUid, noteId) {
  const existingOwner = await readEmulatorDocument(`users/${ownerUid}`);
  const now = new Date();
  return [
    ...(existingOwner
      ? []
      : [{
          path: `users/${ownerUid}`,
          fields: {
            uid: ownerUid,
            displayName: "E2E Source Owner",
            featureAccess: { notes: true, library: true, schedule: true },
            isActive: true,
            isAdmin: false
          }
        }]),
    {
      path: `notes/${noteId}`,
      fields: {
        ownerUid,
        revision: 1,
        attachmentRevision: 0,
        isDeleted: false,
        isPurged: false,
        updatedAt: now
      }
    }
  ];
}

function minimalPdfAttachmentBytes() {
  const pageContent = "BT /F1 18 Tf 36 80 Td (QuickMemo PDF worker canvas smoke) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${pageContent.length} >>\nstream\n${pageContent}endstream`
  ];
  const offsets = [0];
  let source = "%PDF-1.4\n";

  objects.forEach((object, index) => {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return encoder.encode(source);
}

async function attachmentDocument(content, shareId, generation, expiresAt, scenario) {
  const attachmentId = `att_${randomSuffix()}`;
  const pdfAttachment = scenario === "pdf-attachment";
  const plainBytes = pdfAttachment
    ? minimalPdfAttachmentBytes()
    : encoder.encode("E2E 독립 첨부파일 본문");
  const encrypted = await encryptBytes(plainBytes, content.key);
  const encryptedFileName = await encryptText(
    pdfAttachment ? "e2e-worker-canvas" : "e2e-attachment",
    content.key
  );
  return {
    attachmentId,
    cipherDigest: createHash("sha256").update(encrypted.cipherBytes).digest("hex"),
    document: {
      path: `publicNoteShares/${shareId}/attachments/${attachmentId}`,
      fields: {
        version: 1,
        privacyVersion: 1,
        algorithm: "AES-GCM",
        fileName: pdfAttachment ? "shared-pdf-attachment" : "shared-txt-attachment",
        encryptedFileName,
        extension: pdfAttachment ? "pdf" : "txt",
        mimeType: pdfAttachment ? "application/pdf" : "text/plain",
        originalSize: plainBytes.byteLength,
        encryptedSize: encrypted.cipherBytes.byteLength,
        encryptedData: toBase64(encrypted.cipherBytes),
        isReady: true,
        iv: toBase64(encrypted.iv),
        generation,
        expiresAt,
        createdAt: new Date()
      }
    }
  };
}

export async function seedE2eScenario(scenario) {
  const options = scenarioOptions(scenario);
  const suffix = randomSuffix();
  const shareId = options.schemaVersion === 1
    ? `legacy_${suffix}`
    : options.standardV2Url
      ? `ss2_e2e_standard_${suffix}`
      : `ss2_e2e_${suffix}`;
  const noteId = `note_${suffix}`;
  const content = await createShareContent(scenario);
  const ownerAuth = options.ownerAuth
    ? await createLoginUser({
        displayName: `E2E Owner ${suffix.slice(0, 5)}`,
        verified: true
      })
    : null;
  const viewerAuth = options.viewerAuth
    ? await createLoginUser({
        displayName: `E2E Viewer ${suffix.slice(0, 5)}`,
        initializeVaultIntegrity: options.permissionLevel === "save_copy",
        isAdmin: options.viewerAdmin,
        verified: options.viewerAuth === "verified"
      })
    : null;
  const ownerUid = ownerAuth?.uid ?? `source_owner_${suffix}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + options.expiresOffsetMs);
  const generation = `gen_${suffix}`;
  const documents = await sourceDocuments(ownerUid, noteId);
  let attachmentId = null;
  let sourceAttachmentCipherDigest = null;

  if (options.schemaVersion === 1) {
    documents.push({
      path: `publicNoteShares/${shareId}`,
      fields: {
        sourceNoteId: noteId,
        sourceRevision: 1,
        sourceAttachmentRevision: 0,
        ownerUid,
        version: 1,
        currentGeneration: generation,
        encryptedTitle: content.encryptedTitle,
        encryptedBody: content.encryptedBody,
        attachmentCount: 0,
        ready: true,
        createdAt: now,
        updatedAt: now,
        expiresAt
      }
    });
  } else {
    const passwordHashRecord = options.passwordEnabled
      ? await hashSharePassword(defaultPassword)
      : undefined;
    const allowedEmailHashes = options.accessMode === "allowed_emails"
      ? [emailDigest(defaultAllowedEmail)]
      : [];
    const attachment = options.withAttachment
      ? await attachmentDocument(content, shareId, generation, expiresAt, scenario)
      : null;
    attachmentId = attachment?.attachmentId ?? null;
    sourceAttachmentCipherDigest = attachment?.cipherDigest ?? null;
    documents.push(
      {
        path: `publicNoteShares/${shareId}`,
        fields: {
          schemaVersion: 2,
          version: 2,
          sourceNoteId: noteId,
          sourceRevision: 1,
          sourceAttachmentRevision: 0,
          ownerUid,
          status: "active",
          ready: true,
          createdAt: now,
          updatedAt: now,
          expiresAt,
          policyVersion: 1,
          encryptedTitle: content.encryptedTitle,
          encryptedBody: content.encryptedBody,
          currentGeneration: generation,
          attachmentCount: attachment ? 1 : 0,
          accessModePublicHint: options.accessMode,
          hasPassword: options.passwordEnabled,
          requiresEmailVerification: options.emailVerificationRequired,
          oneTimeEnabled: options.oneTimeEnabled,
          permissionLevel: options.permissionLevel,
          downloadAllowed: options.downloadAllowed,
          quickCopyButtonVisible: options.quickCopyButtonVisible,
          showCommenterIpPrefix: options.showCommenterIpPrefix,
          successfulAccessCount: 0
        }
      },
      {
        path: `publicSharePolicies/${shareId}`,
        fields: {
          schemaVersion: 2,
          shareId,
          ownerUid,
          accessMode: options.accessMode,
          passwordEnabled: options.passwordEnabled,
          ...(passwordHashRecord ? { passwordHashRecord } : {}),
          emailVerificationRequired: options.emailVerificationRequired,
          allowedEmailHashes,
          allowedEmailCount: allowedEmailHashes.length,
          oneTimeEnabled: options.oneTimeEnabled,
          oneTimeScope: "global",
          permissionLevel: options.permissionLevel,
          downloadAllowed: options.downloadAllowed,
          quickCopyButtonVisible: options.quickCopyButtonVisible,
          showCommenterIpPrefix: options.showCommenterIpPrefix,
          sessionTtlSeconds: 14_400,
          oneTimeSessionTtlSeconds: 1_800,
          policyVersion: 1,
          createdAt: now,
          updatedAt: now,
          expiresAt
        }
      },
      {
        path: `publicShareCleanupQueue/${shareId}`,
        fields: {
          shareId,
          ownerUid,
          expiresAt,
          createdAt: now
        }
      },
      ...(attachment ? [attachment.document] : [])
    );
  }
  if (scenario === "save-copy-attachment") {
    documents.push({
      path: "systemUsage/blobAttachmentsV1",
      fields: {
        schemaVersion: 1,
        usedBytes: 0,
        updatedAt: now
      }
    });
  }
  await writeEmulatorDocuments(documents);

  return {
    allowedEmail: defaultAllowedEmail,
    attachmentId,
    bodyText: content.bodyText,
    contentKey: content.contentKey,
    expiresAt: expiresAt.toISOString(),
    ownerAuth,
    password: options.passwordEnabled ? defaultPassword : null,
    scenario,
    shareId,
    sourceAttachmentCipherDigest,
    title: content.title,
    url: options.schemaVersion === 2 && !options.standardV2Url
      ? `/s/${shareId.slice(4)}#${content.contentKey}`
      : `/share/${shareId}#key=${content.contentKey}`,
    viewerAuth
  };
}

async function e2eAuthUid(idToken) {
  if (typeof idToken !== "string" || !idToken) {
    return "";
  }
  const result = await jsonRequest(
    `${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=${authApiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  ).catch(() => ({}));
  const uid = result.users?.[0]?.localId;
  return typeof uid === "string" ? uid : "";
}

function safeAttachmentUploadPayload(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Missing E2E attachment upload payload");
  }
  const payload = value;
  const validId = (candidate) => (
    typeof candidate === "string"
    && /^[A-Za-z0-9_-]{6,180}$/u.test(candidate)
  );
  const validBase64 = (candidate, decodedBytes) => {
    if (typeof candidate !== "string" || !candidate) {
      return false;
    }
    try {
      return Buffer.from(candidate, "base64").byteLength === decodedBytes;
    } catch {
      return false;
    }
  };

  const singleEncryption = (
    payload.version === 1
    && payload.algorithm === "AES-GCM"
    && validBase64(payload.ivBase64, 12)
    && payload.encryptedSize === payload.originalSize + 16
  );
  const chunkCount = Math.ceil(Number(payload.originalSize) / (4 * 1024 * 1024));
  const chunkedEncryption = (
    payload.version === 2
    && payload.algorithm === "AES-GCM-CHUNKED"
    && payload.chunkSize === 4 * 1024 * 1024
    && payload.chunkCount === chunkCount
    && Array.isArray(payload.chunkIvBase64List)
    && payload.chunkIvBase64List.length === chunkCount
    && payload.chunkIvBase64List.every((iv) => validBase64(iv, 12))
    && payload.encryptedSize === payload.originalSize + 16 * chunkCount
  );

  if (
    payload.scope !== "note"
    || !validId(payload.noteId)
    || !validId(payload.attachmentId)
    || !validId(payload.uploadedBy)
    || !validId(payload.secureShareCopyJobId)
    || !Number.isSafeInteger(payload.originalSize)
    || payload.originalSize <= 0
    || !Number.isSafeInteger(payload.encryptedSize)
    || (!singleEncryption && !chunkedEncryption)
    || typeof payload.fileName !== "string"
    || !payload.fileName
    || typeof payload.extension !== "string"
    || !/^[a-z0-9]{1,10}$/u.test(payload.extension)
    || typeof payload.mimeType !== "string"
    || !payload.mimeType
  ) {
    throw new Error("Invalid E2E note attachment upload payload");
  }
  return payload;
}

export async function reserveE2eNoteAttachment({ clientPayload, idToken, pathname }) {
  const uid = await e2eAuthUid(idToken);
  let parsed;
  try {
    parsed = JSON.parse(clientPayload);
  } catch {
    throw new Error("Invalid E2E attachment client payload");
  }
  const payload = safeAttachmentUploadPayload(parsed);
  const [note, profile, existingAttachment] = await Promise.all([
    readEmulatorDocument(`notes/${payload.noteId}`),
    uid ? readEmulatorDocument(`users/${uid}`) : Promise.resolve(null),
    readEmulatorDocument(`notes/${payload.noteId}/attachments/${payload.attachmentId}`)
  ]);
  const expectedPath =
    `users/${uid}/notes/${payload.noteId}/attachments/${payload.attachmentId}/data`;
  const expectedCount = Number(note?.secureShareCopyExpectedAttachmentCount);
  const reservedCount = Number(note?.secureShareCopyReservedAttachmentCount);

  if (
    !uid
    || uid !== payload.uploadedBy
    || profile?.isActive !== true
    || note?.ownerUid !== uid
    || note?.secureShareCopyState !== "copying"
    || note?.secureShareCopyJobId !== payload.secureShareCopyJobId
    || !Number.isSafeInteger(expectedCount)
    || !Number.isSafeInteger(reservedCount)
    || reservedCount < 0
    || reservedCount >= expectedCount
    || pathname !== expectedPath
    || existingAttachment
  ) {
    throw new Error("E2E attachment reservation authorization failed");
  }

  const now = new Date();
  const encryptionFields = payload.version === 1
    ? {
        iv: new Uint8Array(Buffer.from(payload.ivBase64, "base64"))
      }
    : {
        chunkCount: payload.chunkCount,
        chunkIvs: payload.chunkIvBase64List.map(
          (iv) => new Uint8Array(Buffer.from(iv, "base64"))
        ),
        chunkSize: payload.chunkSize
      };
  await writeEmulatorDocuments([
    {
      path: `notes/${payload.noteId}/attachments/${payload.attachmentId}`,
      fields: {
        noteId: payload.noteId,
        version: payload.version,
        algorithm: payload.algorithm,
        fileName: payload.fileName,
        extension: payload.extension,
        mimeType: payload.mimeType,
        originalSize: payload.originalSize,
        encryptedSize: payload.encryptedSize,
        storageProvider: "vercel-blob",
        blobPath: pathname,
        isReady: false,
        quotaReserved: true,
        reservationExpiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
        uploadedBy: uid,
        secureShareCopyJobId: payload.secureShareCopyJobId,
        ...encryptionFields,
        createdAt: now
      }
    }
  ]);
  await patchEmulatorDocuments([
    {
      path: `notes/${payload.noteId}`,
      fields: {
        secureShareCopyReservedAttachmentCount: reservedCount + 1,
        secureShareCopyUpdatedAt: now
      }
    }
  ]);

  return {
    attachmentId: payload.attachmentId,
    encryptedSize: payload.encryptedSize,
    noteId: payload.noteId,
    pathname,
    uid
  };
}

export async function completeE2eNoteAttachment({ blob, idToken, reservation }) {
  const uid = await e2eAuthUid(idToken);
  const [note, attachment] = await Promise.all([
    readEmulatorDocument(`notes/${reservation.noteId}`),
    readEmulatorDocument(
      `notes/${reservation.noteId}/attachments/${reservation.attachmentId}`
    )
  ]);
  const expectedCount = Number(note?.secureShareCopyExpectedAttachmentCount);
  const reservedCount = Number(note?.secureShareCopyReservedAttachmentCount);
  const readyCount = Number(note?.secureShareCopyReadyAttachmentCount);

  if (
    !uid
    || uid !== reservation.uid
    || note?.ownerUid !== uid
    || note?.secureShareCopyState !== "copying"
    || attachment?.uploadedBy !== uid
    || attachment?.isReady !== false
    || blob?.pathname !== reservation.pathname
    || blob?.size !== reservation.encryptedSize
    || blob?.contentType !== "application/octet-stream"
    || !Number.isSafeInteger(expectedCount)
    || !Number.isSafeInteger(reservedCount)
    || !Number.isSafeInteger(readyCount)
    || readyCount < 0
    || readyCount >= reservedCount
    || reservedCount > expectedCount
  ) {
    throw new Error("E2E attachment completion authorization failed");
  }

  const now = new Date();
  await patchEmulatorDocuments([
    {
      path: `notes/${reservation.noteId}/attachments/${reservation.attachmentId}`,
      fields: {
        isReady: true,
        blobUrl: blob.url,
        blobDownloadUrl: blob.downloadUrl,
        blobEtag: blob.etag
      }
    },
    {
      path: `notes/${reservation.noteId}`,
      fields: {
        attachmentRevision: Number(note.attachmentRevision ?? 0) + 1,
        secureShareCopyReadyAttachmentCount: readyCount + 1,
        secureShareCopyUpdatedAt: now
      }
    }
  ]);
}

function stripMetadata(document) {
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => !key.startsWith("__"))
  );
}

async function mergeDocument(path, updates) {
  const current = await readEmulatorDocument(path);
  if (!current) {
    throw new Error(`Missing Emulator document: ${path}`);
  }
  await writeEmulatorDocuments([
    {
      path,
      fields: {
        ...stripMetadata(current),
        ...updates
      }
    }
  ]);
}

export async function mutateE2eScenario(shareId, action) {
  const sharePath = `publicNoteShares/${shareId}`;
  const policyPath = `publicSharePolicies/${shareId}`;
  const share = await readEmulatorDocument(sharePath);
  const policy = await readEmulatorDocument(policyPath);

  if (!share || !policy) {
    throw new Error("Secure Share fixture does not exist");
  }
  if (action === "revoke") {
    const now = new Date();
    await Promise.all([
      mergeDocument(sharePath, { status: "revoked", revokedAt: now, updatedAt: now }),
      mergeDocument(policyPath, { revokedAt: now, updatedAt: now })
    ]);
  } else if (action === "policy") {
    const nextVersion = Number(policy.policyVersion) + 1;
    const now = new Date();
    await Promise.all([
      mergeDocument(sharePath, { policyVersion: nextVersion, updatedAt: now }),
      mergeDocument(policyPath, {
        policyVersion: nextVersion,
        quickCopyButtonVisible: false,
        updatedAt: now
      })
    ]);
  } else if (action === "expire") {
    const expiredAt = new Date(Date.now() - 60_000);
    await Promise.all([
      mergeDocument(sharePath, { expiresAt: expiredAt, updatedAt: new Date() }),
      mergeDocument(policyPath, { expiresAt: expiredAt, updatedAt: new Date() })
    ]);
  } else {
    throw new Error("Unknown Secure Share fixture mutation");
  }
}

export async function e2eScenarioState(shareId, uid) {
  const [share, policy, notes] = await Promise.all([
    readEmulatorDocument(`publicNoteShares/${shareId}`),
    readEmulatorDocument(`publicSharePolicies/${shareId}`),
    uid ? listEmulatorCollection("notes") : Promise.resolve([])
  ]);
  const activeCopiedNotes = notes.filter(
    (note) => note.ownerUid === uid && note.secureShareCopyState === "active"
  );
  const copiedNotes = await Promise.all(
    activeCopiedNotes.map(async (note) => ({
      attachmentCount: note.secureShareCopyExpectedAttachmentCount ?? 0,
      attachmentRevision: note.attachmentRevision ?? 0,
      attachments: (await listEmulatorCollection(`notes/${note.__id}/attachments`))
        .map((attachment) => ({
          blobPath: attachment.blobPath,
          encryptedSize: attachment.encryptedSize,
          id: attachment.__id,
          isReady: attachment.isReady,
          originalSize: attachment.originalSize,
          storageProvider: attachment.storageProvider
        })),
      expectedCount: note.secureShareCopyExpectedAttachmentCount ?? 0,
      id: note.__id,
      readyCount: note.secureShareCopyReadyAttachmentCount ?? 0,
      reservedCount: note.secureShareCopyReservedAttachmentCount ?? 0,
      state: note.secureShareCopyState
    }))
  );
  return {
    policy: policy
      ? {
          consumedAt: policy.consumedAt ?? null,
          policyVersion: policy.policyVersion
        }
      : null,
    share: share
      ? {
          consumedAt: share.consumedAt ?? null,
          policyVersion: share.policyVersion,
          status: share.status,
          successfulAccessCount: share.successfulAccessCount
        }
      : null,
    copiedNotes
  };
}

export async function resetE2eEmulators() {
  await clearSecureShareEmulators();
}
