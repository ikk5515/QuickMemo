#!/usr/bin/env node
/* global AbortSignal, Buffer, fetch, process, URLSearchParams */

import { list } from "@vercel/blob";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  GLOBAL_BLOB_USAGE_DOCUMENT_PATH,
  GLOBAL_BLOB_USAGE_SCHEMA_VERSION,
  evaluateFreeTierUpload,
  resolveFreeTierPolicy
} from "../api/_free-tier-policy.js";

const firestoreBaseUrl = "https://firestore.googleapis.com/v1";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const databaseId = "(default)";
const attachmentPathPattern = /\/documents\/(?:notes|publicNoteShares)\/[^/]+\/attachments\/[^/]+$/u;
const blobPathPattern = /^users\/[^/]+\/(?:notes|publicNoteShares)\/[^/]+\/attachments\/[^/]+\/data$/u;

function envValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function parseCredential() {
  const raw = envValue("FIREBASE_CLEANUP_SERVICE_ACCOUNT_JSON");
  const parsed = raw
    ? JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"))
    : {};
  const clientEmail = envValue("FIREBASE_CLEANUP_CLIENT_EMAIL") || parsed.client_email || "";
  const privateKey = (envValue("FIREBASE_CLEANUP_PRIVATE_KEY") || parsed.private_key || "")
    .replace(/\\n/gu, "\n");
  const projectId = envValue("FIREBASE_CLEANUP_PROJECT_ID")
    || parsed.project_id
    || envValue("VITE_FIREBASE_PROJECT_ID")
    || envValue("GOOGLE_CLOUD_PROJECT");
  if (!clientEmail || !privateKey || !projectId) {
    throw new Error("Firebase reconciliation credentials are unavailable");
  }
  return { clientEmail, privateKey, projectId };
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function accessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: credentials.clientEmail,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: oauthTokenUrl,
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(credentials.privateKey));
  const response = await fetch(oauthTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64Url(signature)}`
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`OAuth request failed with status ${response.status}`);
  }
  const body = await response.json();
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("OAuth response did not include an access token");
  }
  return body.access_token;
}

function documentsRoot(projectId) {
  return `projects/${projectId}/databases/${databaseId}/documents`;
}

async function firestoreRequest(projectId, token, suffix, init = {}) {
  const response = await fetch(
    `${firestoreBaseUrl}/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/${suffix}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {})
      },
      signal: AbortSignal.timeout(30_000)
    }
  );
  if (!response.ok) {
    throw new Error(`Firestore request failed with status ${response.status}`);
  }
  return response.json();
}

function integerField(document, fieldName) {
  const value = Number(document?.fields?.[fieldName]?.integerValue);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringField(document, fieldName) {
  const value = document?.fields?.[fieldName]?.stringValue;
  return typeof value === "string" ? value : "";
}

function booleanField(document, fieldName) {
  return document?.fields?.[fieldName]?.booleanValue === true;
}

async function globalCounter(projectId, token) {
  const encodedPath = GLOBAL_BLOB_USAGE_DOCUMENT_PATH
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return firestoreRequest(projectId, token, `documents/${encodedPath}`);
}

async function attachmentMetadata(projectId, token, maximumDocuments) {
  const results = await firestoreRequest(projectId, token, "documents:runQuery", {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "attachments", allDescendants: true }],
        select: {
          fields: [
            { fieldPath: "blobPath" },
            { fieldPath: "encryptedSize" },
            { fieldPath: "isReady" },
            { fieldPath: "quotaReserved" },
            { fieldPath: "storageProvider" }
          ]
        },
        limit: maximumDocuments + 1
      }
    })
  });
  const documents = results.flatMap((entry) => entry.document ? [entry.document] : []);
  if (documents.length > maximumDocuments) {
    throw new Error("Attachment metadata exceeds the reviewed scan limit");
  }
  return documents;
}

async function blobInventory(maximumObjects) {
  const objects = [];
  let scannedObjects = 0;
  let cursor;
  do {
    const page = await list({ cursor, limit: 1000, prefix: "users/" });
    scannedObjects += page.blobs.length;
    if (scannedObjects > maximumObjects) {
      throw new Error("Blob inventory exceeds the reviewed scan limit");
    }
    objects.push(...page.blobs.filter((blob) => blobPathPattern.test(blob.pathname)));
    if (objects.length > maximumObjects) {
      throw new Error("Blob inventory exceeds the reviewed scan limit");
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildReport(counter, metadataDocuments, blobs) {
  const metadata = [];
  let invalidMetadataCount = 0;
  for (const document of metadataDocuments) {
    const encryptedSize = integerField(document, "encryptedSize");
    const blobPath = stringField(document, "blobPath");
    const accounted = booleanField(document, "quotaReserved")
      || (stringField(document, "storageProvider") === "vercel-blob" && Boolean(blobPath));
    if (!accounted) continue;
    if (
      !attachmentPathPattern.test(document.name ?? "")
      || !blobPathPattern.test(blobPath)
      || encryptedSize === null
      || encryptedSize < 1
    ) {
      invalidMetadataCount += 1;
      continue;
    }
    metadata.push({ blobPath, encryptedSize, ready: booleanField(document, "isReady") });
  }
  const metadataPaths = new Set(metadata.map((entry) => entry.blobPath));
  const blobPaths = new Set(blobs.map((blob) => blob.pathname));
  const duplicateMetadataPathCount = metadata.length - metadataPaths.size;
  const duplicateBlobPathCount = blobs.length - blobPaths.size;
  const readyMissingObjectCount = metadata.filter(
    (entry) => entry.ready && !blobPaths.has(entry.blobPath)
  ).length;
  const orphanBlobObjectCount = blobs.filter((blob) => !metadataPaths.has(blob.pathname)).length;
  const metadataUsedBytes = metadata.reduce((total, entry) => total + entry.encryptedSize, 0);
  const blobUsedBytes = blobs.reduce((total, blob) => total + blob.size, 0);
  const currentUsedBytes = integerField(counter, "usedBytes");
  const currentAttachmentCount = integerField(counter, "attachmentCount");
  const schemaVersion = integerField(counter, "schemaVersion");
  const report = {
    schemaVersion: 1,
    counter: {
      attachmentCount: currentAttachmentCount,
      schemaVersion,
      updateTime: typeof counter.updateTime === "string" ? counter.updateTime : "",
      usedBytes: currentUsedBytes
    },
    metadata: {
      attachmentCount: metadata.length,
      duplicatePathCount: duplicateMetadataPathCount,
      invalidCount: invalidMetadataCount,
      readyMissingObjectCount,
      usedBytes: metadataUsedBytes
    },
    blobInventory: {
      duplicatePathCount: duplicateBlobPathCount,
      objectCount: blobs.length,
      orphanObjectCount: orphanBlobObjectCount,
      usedBytes: blobUsedBytes
    },
    mismatch: {
      attachmentCount: currentAttachmentCount !== metadata.length,
      usedBytes: currentUsedBytes !== metadataUsedBytes
    }
  };
  return { report, digest: sha256(stableJson(report)) };
}

export function parseArguments(argv) {
  const valueAfter = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] ?? "" : "";
  };
  const maximumDocuments = Number(valueAfter("--max-documents") || 10_000);
  if (!Number.isSafeInteger(maximumDocuments) || maximumDocuments < 1 || maximumDocuments > 100_000) {
    throw new Error("--max-documents must be between 1 and 100000");
  }
  return {
    apply: argv.includes("--apply"),
    confirmSha256: valueAfter("--confirm-sha256"),
    expectedUpdateTime: valueAfter("--expected-update-time"),
    maximumDocuments
  };
}

export function assertReviewedRepair(report, digest, options) {
  if (!options.expectedUpdateTime || options.expectedUpdateTime !== report.counter.updateTime) {
    throw new Error("--expected-update-time must exactly match the reviewed counter snapshot");
  }
  if (!options.confirmSha256 || options.confirmSha256 !== digest) {
    throw new Error("--confirm-sha256 must exactly match the reviewed report digest");
  }
  if (
    report.counter.schemaVersion !== GLOBAL_BLOB_USAGE_SCHEMA_VERSION
    || report.metadata.invalidCount !== 0
    || report.metadata.duplicatePathCount !== 0
    || report.metadata.readyMissingObjectCount !== 0
    || report.blobInventory.duplicatePathCount !== 0
    || report.blobInventory.orphanObjectCount !== 0
  ) {
    throw new Error("Repair is blocked until inventory integrity findings are resolved");
  }
}

async function applyRepair(credentials, token, report, digest, options) {
  assertReviewedRepair(report, digest, options);
  if (!report.mismatch.attachmentCount && !report.mismatch.usedBytes) {
    return false;
  }
  const policy = resolveFreeTierPolicy(process.env);
  const decision = evaluateFreeTierUpload({
    usedBytes: report.metadata.usedBytes,
    reservedBytes: 0,
    requestedBytes: 0
  }, policy);
  await firestoreRequest(credentials.projectId, token, "documents:commit", {
    method: "POST",
    body: JSON.stringify({
      writes: [{
        update: {
          name: `${documentsRoot(credentials.projectId)}/${GLOBAL_BLOB_USAGE_DOCUMENT_PATH}`,
          fields: {
            schemaVersion: { integerValue: String(GLOBAL_BLOB_USAGE_SCHEMA_VERSION) },
            attachmentCount: { integerValue: String(report.metadata.attachmentCount) },
            usedBytes: { integerValue: String(report.metadata.usedBytes) },
            officialCapacityBytes: { integerValue: String(policy.officialCapacityBytes) },
            operationalCapBytes: { integerValue: String(policy.operationalCapBytes) },
            hardStopBytes: { integerValue: String(policy.hardStopBytes) },
            capacityState: { stringValue: decision.state },
            accountingMode: { stringValue: "ready_and_pending_reservations" }
          }
        },
        updateMask: {
          fieldPaths: [
            "schemaVersion",
            "attachmentCount",
            "usedBytes",
            "officialCapacityBytes",
            "operationalCapBytes",
            "hardStopBytes",
            "capacityState",
            "accountingMode"
          ]
        },
        currentDocument: { updateTime: options.expectedUpdateTime },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      }]
    })
  });
  return true;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const credentials = parseCredential();
  const token = await accessToken(credentials);
  const [counter, metadata, blobs] = await Promise.all([
    globalCounter(credentials.projectId, token),
    attachmentMetadata(credentials.projectId, token, options.maximumDocuments),
    blobInventory(options.maximumDocuments)
  ]);
  const { report, digest } = buildReport(counter, metadata, blobs);
  const applied = options.apply
    ? await applyRepair(credentials, token, report, digest, options)
    : false;
  process.stdout.write(`${JSON.stringify({
    mode: options.apply ? "reviewed_cas_repair" : "read_only",
    report,
    reportSha256: digest,
    repairApplied: applied
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "reconciliation_failed"
    })}\n`);
    process.exitCode = 1;
  });
}
