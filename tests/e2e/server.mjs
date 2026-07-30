/* global Buffer, Response, URL, console, process */

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.QUICKMEMO_E2E_PORT ?? "4173", 10);
const origin = `http://${host}:${port}`;
const projectId = "quickmemo-share-api-test";
const nativeFetch = globalThis.fetch.bind(globalThis);
const mailboxes = new Map();
const blobReservations = new Map();
const memoryBlobs = new Map();

Object.assign(process.env, {
  NODE_ENV: "test",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIREBASE_CLEANUP_PROJECT_ID: projectId,
  GCLOUD_PROJECT: projectId,
  GOOGLE_CLOUD_PROJECT: projectId,
  FIREBASE_APP_CHECK_ENFORCEMENT: "off",
  SECURE_SHARE_ALLOWED_ORIGINS: origin,
  SECURE_SHARE_V2_ENABLED: "true",
  SECURE_SHARE_EMAIL_ENABLED: "true",
  SHARE_EMAIL_PROVIDER: "resend",
  SHARE_EMAIL_API_KEY: "re_e2e_local_only_not_a_real_provider_key",
  SHARE_EMAIL_FROM: "QuickMemo E2E <e2e-sender@example.test>",
  SHARE_EMAIL_SENDER_VERIFIED: "true",
  VITE_FIREBASE_API_KEY: "fake-emulator-api-key",
  VITE_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
  VITE_FIREBASE_PROJECT_ID: projectId,
  VITE_FIREBASE_STORAGE_BUCKET: `${projectId}.appspot.com`,
  VITE_FIREBASE_MESSAGING_SENDER_ID: "000000000000",
  VITE_FIREBASE_APP_ID: "1:000000000000:web:quickmemo-e2e",
  VITE_USE_FIREBASE_EMULATORS: "true",
  VITE_E2E_FIRESTORE_FORCE_LONG_POLLING: "true",
  VITE_E2E_NAVIGATION_BRIDGE: "true",
  VITE_SECURE_SHARE_COMPACT_URL_ENABLED: "true",
  VITE_SECURE_SHARE_V2_ENABLED: "true"
});

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

  if (url === "https://api.resend.com/emails") {
    const payload = JSON.parse(String(init?.body ?? "{}"));
    const recipient = Array.isArray(payload.to) ? payload.to[0] : "";
    const code = /인증번호:\s*(\d{6})/u.exec(String(payload.text ?? ""))?.[1] ?? "";

    if (typeof recipient === "string" && code) {
      mailboxes.set(recipient.toLowerCase(), {
        code,
        deliveredAt: new Date().toISOString()
      });
    }
    return new Response(JSON.stringify({ id: `e2e-mail-${Date.now()}` }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  return nativeFetch(input, init);
};

const emulatorHelper = await import("../helpers/secureShareApiEmulator.ts");
emulatorHelper.configureSecureShareApiEmulatorEnvironment();
Object.assign(process.env, {
  SECURE_SHARE_ALLOWED_ORIGINS: origin,
  SECURE_SHARE_COMMENT_IP_PREFIX_ENABLED: "true",
  SECURE_SHARE_EMAIL_ENABLED: "true",
  SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED: "true",
  SHARE_EMAIL_PROVIDER: "resend",
  SHARE_EMAIL_API_KEY: "re_e2e_local_only_not_a_real_provider_key",
  SHARE_EMAIL_FROM: "QuickMemo E2E <e2e-sender@example.test>",
  SHARE_EMAIL_SENDER_VERIFIED: "true",
  VITE_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
  VITE_FIREBASE_STORAGE_BUCKET: `${projectId}.appspot.com`,
  VITE_FIREBASE_MESSAGING_SENDER_ID: "000000000000",
  VITE_FIREBASE_APP_ID: "1:000000000000:web:quickmemo-e2e",
  VITE_USE_FIREBASE_EMULATORS: "true",
  VITE_E2E_FIRESTORE_FORCE_LONG_POLLING: "true",
  VITE_E2E_NAVIGATION_BRIDGE: "true",
  VITE_SECURE_SHARE_COMPACT_URL_ENABLED: "true",
  VITE_SECURE_SHARE_V2_ENABLED: "true"
});

const fixtures = await import("./emulator-fixtures.mjs");
const { default: secureShareHandler } = await import("../../api/public-shares-v2.js");
const { createServer: createViteServer } = await import("vite");
const vite = await createViteServer({
  appType: "spa",
  mode: "test",
  resolve: {
    alias: {
      "@vercel/blob/client": fileURLToPath(
        new URL("./vercel-blob-client.mjs", import.meta.url)
      )
    }
  },
  server: {
    hmr: false,
    middlewareMode: true
  }
});

function loopbackRequest(request) {
  const address = request.socket.remoteAddress ?? "";
  return new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]).has(address);
}

async function readJson(request, maximumBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new Error("E2E request body is too large");
    }
    chunks.push(chunk);
  }
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
    : {};
}

async function readBytes(request, maximumBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new Error("E2E binary request body is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function bearerToken(request) {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/iu.exec(Array.isArray(header) ? header[0] ?? "" : header);
  return match?.[1] ?? "";
}

function json(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

const allowedScenarios = new Set([
  "authenticated-unverified",
  "authenticated-verified",
  "comment",
  "expired",
  "legacy",
  "lifecycle",
  "one-time",
  "open",
  "otp",
  "otp-disallowed",
  "owner-preview",
  "password",
  "responsive",
  "save-copy",
  "save-copy-attachment",
  "standard-v2-one-time",
  "view-attachment"
]);

async function handleE2eBlobApiRequest(request, response) {
  if (!loopbackRequest(request)) {
    json(response, 403, { error: "Forbidden" });
    return;
  }
  if (request.method === "POST") {
    const body = await readJson(request, 64 * 1024);
    const pathname = body?.payload?.pathname;
    const clientPayload = body?.payload?.clientPayload;
    if (
      body?.type !== "blob.generate-client-token"
      || typeof pathname !== "string"
      || typeof clientPayload !== "string"
    ) {
      json(response, 400, { error: "Invalid local upload request." });
      return;
    }
    const reservation = await fixtures.reserveE2eNoteAttachment({
      clientPayload,
      idToken: bearerToken(request),
      pathname
    });
    const token = `e2e_blob_${randomUUID().replaceAll("-", "")}`;
    blobReservations.set(token, {
      ...reservation,
      completed: false,
      token
    });
    json(response, 200, { clientToken: token });
    return;
  }
  if (request.method === "PATCH") {
    const body = await readJson(request, 64 * 1024);
    const pathname = body?.blob?.pathname;
    const reservation = Array.from(blobReservations.values()).find(
      (candidate) => candidate.pathname === pathname && !candidate.completed
    );
    const storedBlob = typeof pathname === "string" ? memoryBlobs.get(pathname) : null;
    if (
      !reservation
      || !storedBlob
      || body.scope !== "note"
      || body.noteId !== reservation.noteId
      || body.attachmentId !== reservation.attachmentId
    ) {
      json(response, 409, { error: "Local upload reservation is unavailable." });
      return;
    }
    await fixtures.completeE2eNoteAttachment({
      blob: storedBlob.blob,
      idToken: bearerToken(request),
      reservation
    });
    reservation.completed = true;
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "DELETE") {
    json(response, 200, { ok: true });
    return;
  }
  json(response, 405, { error: "Method not allowed." });
}

async function handleE2eBlobPut(request, response) {
  if (!loopbackRequest(request) || request.method !== "POST") {
    json(response, 403, { error: "Forbidden" });
    return;
  }
  const token = bearerToken(request);
  const reservation = blobReservations.get(token);
  const encodedPath = request.headers["x-e2e-blob-path"];
  const pathname = typeof encodedPath === "string"
    ? decodeURIComponent(encodedPath)
    : "";
  if (!reservation || reservation.completed || reservation.pathname !== pathname) {
    json(response, 403, { error: "Invalid local Blob token." });
    return;
  }
  const bytes = await readBytes(request);
  if (bytes.byteLength !== reservation.encryptedSize) {
    json(response, 400, { error: "Encrypted upload size does not match its reservation." });
    return;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const blob = {
    contentDisposition: "attachment",
    contentType: "application/octet-stream",
    downloadUrl: `${origin}/__e2e__/blob/${digest}?download=1`,
    etag: `e2e-${digest.slice(0, 24)}`,
    pathname,
    size: bytes.byteLength,
    uploadedAt: new Date().toISOString(),
    url: `${origin}/__e2e__/blob/${digest}`
  };
  memoryBlobs.set(pathname, { blob, bytes, digest });
  json(response, 201, { blob });
}

async function handleE2eRequest(request, response, url) {
  if (!loopbackRequest(request)) {
    json(response, 403, { ok: false });
    return;
  }
  if (request.method === "GET" && url.pathname === "/__e2e__/health") {
    const [firestore, auth] = await Promise.all([
      nativeFetch(
        `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents/__e2e_health__/ready`
      ).catch(() => null),
      nativeFetch(
        `http://127.0.0.1:9099/emulator/v1/projects/${projectId}/accounts`
      ).catch(() => null)
    ]);
    const ready = Boolean(
      firestore
      && firestore.status < 500
      && auth
      && auth.status < 500
    );
    json(response, ready ? 200 : 503, { ok: ready, projectId });
    return;
  }
  if (request.method === "DELETE" && url.pathname === "/__e2e__/reset") {
    await fixtures.resetE2eEmulators();
    mailboxes.clear();
    blobReservations.clear();
    memoryBlobs.clear();
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__e2e__/seed") {
    const body = await readJson(request);
    if (!allowedScenarios.has(body.scenario)) {
      json(response, 400, { ok: false });
      return;
    }
    const fixture = await fixtures.seedE2eScenario(body.scenario);
    json(response, 201, { ok: true, fixture });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__e2e__/quota-hard") {
    await fixtures.seedE2eEmailQuotaAtHardLimit();
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__e2e__/mutate") {
    const body = await readJson(request);
    if (
      typeof body.shareId !== "string"
      || !/^ss2_[A-Za-z0-9_-]{2,124}$/u.test(body.shareId)
      || !new Set(["expire", "policy", "revoke"]).has(body.action)
    ) {
      json(response, 400, { ok: false });
      return;
    }
    await fixtures.mutateE2eScenario(body.shareId, body.action);
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/__e2e__/state") {
    const shareId = url.searchParams.get("shareId") ?? "";
    const uid = url.searchParams.get("uid") ?? "";
    if (!/^ss2_[A-Za-z0-9_-]{2,124}$/u.test(shareId)) {
      json(response, 400, { ok: false });
      return;
    }
    const state = await fixtures.e2eScenarioState(shareId, uid);
    state.copiedNotes = state.copiedNotes.map((note) => ({
      ...note,
      attachments: note.attachments.map((attachment) => {
        const stored = memoryBlobs.get(attachment.blobPath);
        return {
          ...attachment,
          memoryBlobDigest: stored?.digest ?? null,
          memoryBlobSize: stored?.bytes.byteLength ?? null
        };
      })
    }));
    json(response, 200, { ok: true, state });
    return;
  }
  if (request.method === "GET" && url.pathname === "/__e2e__/mail") {
    const email = (url.searchParams.get("email") ?? "").toLowerCase();
    const delivery = mailboxes.get(email) ?? null;
    json(response, 200, { ok: true, delivery });
    return;
  }
  json(response, 404, { ok: false });
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", origin);

  if (url.pathname.startsWith("/__e2e__/")) {
    if (url.pathname === "/__e2e__/blob-put") {
      void handleE2eBlobPut(request, response).catch((error) => {
        console.error("QuickMemo E2E Blob upload failed", {
          error: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message.slice(0, 300) : ""
        });
        if (!response.headersSent) {
          json(response, 500, { error: "Local Blob upload failed." });
        } else {
          response.end();
        }
      });
      return;
    }
    void handleE2eRequest(request, response, url).catch((error) => {
      console.error("QuickMemo E2E control request failed", {
        error: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message.slice(0, 300) : ""
      });
      if (!response.headersSent) {
        json(response, 500, { ok: false });
      } else {
        response.end();
      }
    });
    return;
  }
  if (url.pathname === "/api/public-shares-v2") {
    Object.defineProperty(request, "secureShareTestClientIp", {
      configurable: false,
      enumerable: false,
      value: "203.226.244.27",
      writable: false
    });
    void secureShareHandler(request, response);
    return;
  }
  if (url.pathname === "/api/blob-attachments") {
    void handleE2eBlobApiRequest(request, response).catch((error) => {
      console.error("QuickMemo E2E Blob API request failed", {
        error: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message.slice(0, 300) : ""
      });
      if (!response.headersSent) {
        json(response, 500, { error: "Local Blob API request failed." });
      } else {
        response.end();
      }
    });
    return;
  }

  const secureShareDocument =
    url.pathname.startsWith("/share/") || url.pathname.startsWith("/s/");
  response.setHeader("cache-control", secureShareDocument ? "no-store" : "no-cache");
  if (secureShareDocument) {
    response.setHeader("cross-origin-resource-policy", "same-origin");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
  }
  vite.middlewares(request, response, (error) => {
    if (error) {
      console.error("QuickMemo E2E Vite request failed", {
        error: error instanceof Error ? error.name : "unknown"
      });
      if (!response.headersSent) {
        response.statusCode = 500;
      }
      response.end();
    }
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => {
    server.off("error", reject);
    resolve();
  });
});

console.log(`QuickMemo E2E server listening on ${origin}`);

async function shutdown() {
  await vite.close();
  await new Promise((resolve) => server.close(() => resolve()));
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
