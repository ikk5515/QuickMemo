import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGmailSmtpTransportForTests } from "../api/_secure-share-gmail-smtp.js";
import {
  copyGrantAuthorizesDownload,
  emailDigest,
  hashSharePassword,
  otpCodeDigest,
  rateLimitBucketDigest,
  sessionTokenDigest,
  sourceShareGuardId,
  verifySignedOpaqueToken
} from "../api/public-shares-v2.js";
import {
  apiHeaders,
  clearSecureShareEmulators,
  configureSecureShareApiEmulatorEnvironment,
  cookiePair,
  cookiePairs,
  createEmulatorOwner,
  listEmulatorCollection,
  metadataBinding,
  patchEmulatorDocuments,
  readEmulatorDocument,
  seedSecureShare,
  startSecureShareApiHarness,
  type SecureShareApiHarness,
  writeEmulatorDocuments
} from "./helpers/secureShareApiEmulator.js";

const gmailTransportMock = vi.hoisted(() => ({
  close: vi.fn(),
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  verify: vi.fn()
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: gmailTransportMock.createTransport
  }
}));

const describeEmulator =
  process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
    ? describe
    : describe.skip;

const failureOnlyKeys = ["error", "ok", "requestId"];

function accessUrl(origin: string, shareId: string) {
  return `${origin}/api/public-shares-v2?action=access&shareId=${encodeURIComponent(shareId)}`;
}

async function startConfiguredSecureShareApiHarness(
  moduleTag: string
): Promise<SecureShareApiHarness> {
  const moduleUrl = new URL("../api/public-shares-v2.js", import.meta.url);
  moduleUrl.searchParams.set("integration-instance", moduleTag);
  const isolatedModule = await import(
    /* @vite-ignore */ moduleUrl.href
  ) as typeof import("../api/public-shares-v2.js");
  const server = createServer((request, response) => {
    void isolatedModule.default(request, response);
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

async function startAdminEmailSettingsHarness(
  moduleTag: string
): Promise<SecureShareApiHarness> {
  const moduleUrl = new URL("../api/admin-email-settings.js", import.meta.url);
  moduleUrl.searchParams.set("integration-instance", moduleTag);
  const isolatedModule = await import(
    /* @vite-ignore */ moduleUrl.href
  ) as typeof import("../api/admin-email-settings.js");
  const server = createServer((request, response) => {
    void isolatedModule.default(request, response);
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

async function adminEmailSettingsRequest(input: {
  body: Record<string, unknown>;
  harness: SecureShareApiHarness;
  idToken: string;
}) {
  const response = await fetch(
    `${input.harness.origin}/api/admin-email-settings`,
    {
      method: "POST",
      headers: {
        ...apiHeaders(input.harness.origin, {
          authorization: input.idToken
        }),
        "x-quickmemo-admin-email-settings": "1"
      },
      body: JSON.stringify(input.body)
    }
  );
  return {
    body: await response.json() as Record<string, unknown>,
    response
  };
}

async function createEmailSettingsAdmin(emailSuffix: string) {
  const admin = await createEmulatorOwner(
    `email-settings-${emailSuffix}@example.test`,
    "emulator-admin-password"
  );
  await writeEmulatorDocuments([
    {
      path: `users/${admin.localId}`,
      fields: {
        displayName: "Email settings admin",
        featureAccess: { notes: true },
        isActive: true,
        isAdmin: true,
        uid: admin.localId
      }
    }
  ]);
  return admin;
}

function emailSettingsQuotaPeriods(nowMilliseconds = Date.now()) {
  const now = new Date(nowMilliseconds);
  const minuteKey = now.toISOString().slice(0, 16);
  const hourKey = now.toISOString().slice(0, 13);
  const seoul = new Date(nowMilliseconds + 9 * 60 * 60 * 1000);
  const monthKey = seoul.toISOString().slice(0, 7);
  return [
    {
      bucketId: `minute_${minuteKey}`,
      hardLimit: 3,
      periodKey: minuteKey,
      scope: "minute",
      softLimit: 3
    },
    {
      bucketId: `hour_${hourKey}`,
      hardLimit: 20,
      periodKey: hourKey,
      scope: "hourly",
      softLimit: 20
    },
    {
      bucketId: `month_${monthKey}`,
      hardLimit: 700,
      periodKey: monthKey,
      scope: "monthly",
      softLimit: 500
    }
  ];
}

async function forcePendingEmailTestSending(
  testExpiresAt: Date
) {
  const settings = await readEmulatorDocument(
    "secureShareEmailSettings/current"
  );
  const pending = settings?.pending as Record<string, unknown> | undefined;
  if (!pending || typeof pending.generation !== "string") {
    throw new Error("Expected staged email settings");
  }
  const now = Date.now();
  const periods = emailSettingsQuotaPeriods(now);
  const currentBuckets = await Promise.all(periods.map((period) =>
    readEmulatorDocument(`publicShareEmailQuotaBuckets/${period.bucketId}`)
  ));
  await writeEmulatorDocuments(periods.map((period, index) => {
    const current = currentBuckets[index];
    return {
      path: `publicShareEmailQuotaBuckets/${period.bucketId}`,
      fields: {
        schemaVersion: 1,
        scope: period.scope,
        periodKey: period.periodKey,
        reservedCount: Number(current?.reservedCount ?? 0) + 1,
        sentCount: Number(current?.sentCount ?? 0),
        failedCount: Number(current?.failedCount ?? 0),
        ambiguousCount: Number(current?.ambiguousCount ?? 0),
        softLimit: period.softLimit,
        hardLimit: period.hardLimit,
        softLimitReached: false,
        updatedAt: new Date(now),
        expiresAt: new Date(now + 400 * 24 * 60 * 60 * 1000)
      }
    };
  }));
  await patchEmulatorDocuments([
    {
      path: "secureShareEmailSettings/current",
      fields: {
        pending: {
          ...pending,
          testState: "sending",
          testCodeDigest: "a".repeat(64),
          testRequestHash: "b".repeat(64),
          testSentAt: new Date(now - 60_000),
          testExpiresAt,
          testQuotaBucketIds: periods.map((period) => period.bucketId),
          testQuotaState: "reserved"
        }
      }
    }
  ]);
  return {
    bucketIds: periods.map((period) => period.bucketId),
    generation: pending.generation
  };
}

async function patchPendingEmailTestDeadline(testExpiresAt: Date) {
  const settings = await readEmulatorDocument(
    "secureShareEmailSettings/current"
  );
  const pending = settings?.pending as Record<string, unknown> | undefined;
  if (!pending) {
    throw new Error("Expected pending email settings");
  }
  await patchEmulatorDocuments([
    {
      path: "secureShareEmailSettings/current",
      fields: {
        pending: {
          ...pending,
          testExpiresAt
        }
      }
    }
  ]);
}

function ownerCreateBody(
  sourceNoteId: string,
  idempotencyKey: string,
  wrappedKeyBytes = 256
) {
  return {
    sourceNoteId,
    sourceRevision: 1,
    sourceAttachmentRevision: 0,
    encryptedTitle: {
      version: 1,
      algorithm: "AES-GCM",
      cipherText: Buffer.alloc(16, 1).toString("base64"),
      iv: Buffer.alloc(12, 2).toString("base64")
    },
    encryptedBody: {
      version: 1,
      algorithm: "AES-GCM",
      cipherText: Buffer.alloc(32, 3).toString("base64"),
      iv: Buffer.alloc(12, 4).toString("base64")
    },
    ownerWrappedShareKey: {
      version: 1,
      algorithm: "RSA-OAEP",
      wrappedKey: Buffer.alloc(wrappedKeyBytes, 5).toString("base64")
    },
    attachmentCount: 0,
    idempotencyKey,
    policy: {
      accessMode: "anyone_with_link",
      passwordEnabled: false,
      emailVerificationRequired: false,
      oneTimeEnabled: false,
      oneTimeScope: "global",
      expirationPreset: "one_day",
      permissionLevel: "view",
      downloadAllowed: true,
      quickCopyButtonVisible: true
    }
  };
}

async function ownerCreateRequest(input: {
  harness: SecureShareApiHarness;
  idToken: string;
  idempotencyKey: string;
  networkSuffix: number;
  sourceNoteId: string;
  wrappedKeyBytes?: number;
}) {
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=owner-create`,
    {
      method: "POST",
      headers: apiHeaders(input.harness.origin, {
        authorization: input.idToken,
        networkSuffix: input.networkSuffix
      }),
      body: JSON.stringify(ownerCreateBody(
        input.sourceNoteId,
        input.idempotencyKey,
        input.wrappedKeyBytes
      ))
    }
  );
  return {
    body: await response.json() as Record<string, unknown>,
    response
  };
}

async function ownerUpdateRequest(input: {
  harness: SecureShareApiHarness;
  idToken: string;
  idempotencyKey: string;
  networkSuffix: number;
  policy: Record<string, unknown>;
  shareId: string;
}) {
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=owner-update`
    + `&shareId=${encodeURIComponent(input.shareId)}`,
    {
      method: "PATCH",
      headers: apiHeaders(input.harness.origin, {
        authorization: input.idToken,
        networkSuffix: input.networkSuffix
      }),
      body: JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        policy: input.policy
      })
    }
  );
  return {
    body: await response.json() as Record<string, unknown>,
    response
  };
}

async function ownerContentUpdateRequest(input: {
  body: Record<string, unknown>;
  harness: SecureShareApiHarness;
  idToken: string;
  networkSuffix: number;
  shareId: string;
}) {
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=owner-content-update`
    + `&shareId=${encodeURIComponent(input.shareId)}`,
    {
      method: "PATCH",
      headers: apiHeaders(input.harness.origin, {
        authorization: input.idToken,
        networkSuffix: input.networkSuffix
      }),
      body: JSON.stringify(input.body)
    }
  );
  return {
    body: await response.json() as Record<string, unknown>,
    response
  };
}

async function copyGrantRequest(input: {
  bindingCookie: string;
  csrfToken: string;
  harness: SecureShareApiHarness;
  idToken: string;
  idempotencyKey: string;
  networkSuffix: number;
  sessionCookie: string;
  shareId: string;
}) {
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=copy-grant`
    + `&shareId=${encodeURIComponent(input.shareId)}`,
    {
      method: "POST",
      headers: apiHeaders(input.harness.origin, {
        authorization: input.idToken,
        bindingCookie: `${input.bindingCookie}; ${input.sessionCookie}`,
        csrfToken: input.csrfToken,
        networkSuffix: input.networkSuffix
      }),
      body: JSON.stringify({ idempotencyKey: input.idempotencyKey })
    }
  );
  return {
    body: await response.json() as Record<string, unknown>,
    response
  };
}

async function accessRequest(input: {
  authorization?: string;
  bindingCookie: string;
  body: Record<string, unknown>;
  harness: SecureShareApiHarness;
  networkSuffix: number;
  shareId: string;
  testClientIp?: string;
}) {
  const response = await fetch(accessUrl(input.harness.origin, input.shareId), {
    method: "POST",
    headers: apiHeaders(input.harness.origin, {
      authorization: input.authorization,
      bindingCookie: input.bindingCookie,
      networkSuffix: input.networkSuffix,
      testClientIp: input.testClientIp
    }),
    body: JSON.stringify(input.body)
  });
  const body = await response.json() as Record<string, unknown>;
  return { body, response };
}

function enableParticipantFeatures() {
  Object.assign(process.env, {
    SECURE_SHARE_COMMENT_IP_PREFIX_ENABLED: "true",
    SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED: "true"
  });
}

function responseCookie(response: Response, marker: "qmsp_" | "qmss_") {
  const pair = cookiePairs(response).find((candidate) =>
    candidate.slice(0, candidate.indexOf("=")).includes(marker)
  );
  if (!pair) {
    throw new Error(`Expected ${marker} cookie`);
  }
  return pair;
}

interface ParticipantSession {
  bindingCookie: string;
  csrfToken: string;
  participantCookie?: string;
  sessionCookie: string;
}

async function openParticipantSession(input: {
  harness: SecureShareApiHarness;
  networkSuffix: number;
  shareId: string;
  testClientIp?: string;
}): Promise<ParticipantSession> {
  const metadata = await metadataBinding(input.harness.origin, input.shareId, {
    networkSuffix: input.networkSuffix
  });
  const access = await accessRequest({
    bindingCookie: metadata.bindingCookie,
    body: {
      displayName: "Untrusted client label",
      unlockAttemptId: `participant_access_${input.shareId}_${input.networkSuffix}`
    },
    harness: input.harness,
    networkSuffix: input.networkSuffix,
    shareId: input.shareId,
    testClientIp: input.testClientIp
  });
  expect(access.response.status).toBe(200);
  return {
    bindingCookie: metadata.bindingCookie,
    csrfToken: String(access.body.csrfToken),
    participantCookie: responseCookie(access.response, "qmsp_"),
    sessionCookie: responseCookie(access.response, "qmss_")
  };
}

function participantSessionCookies(session: ParticipantSession) {
  return [
    session.bindingCookie,
    session.participantCookie,
    session.sessionCookie
  ].filter((value): value is string => Boolean(value)).join("; ");
}

async function refreshParticipantSession(input: {
  harness: SecureShareApiHarness;
  session: ParticipantSession;
  shareId: string;
}) {
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=session`
    + `&shareId=${encodeURIComponent(input.shareId)}`,
    {
      headers: apiHeaders(input.harness.origin, {
        bindingCookie: participantSessionCookies(input.session)
      })
    }
  );
  return {
    body: await response.json() as Record<string, unknown>,
    response
  };
}

async function participantMeRequest(input: {
  body?: Record<string, unknown>;
  harness: SecureShareApiHarness;
  method?: "GET" | "PATCH";
  session: ParticipantSession;
  shareId: string;
  testClientIp?: string;
}) {
  const method = input.method ?? "GET";
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=participant-me`
    + `&shareId=${encodeURIComponent(input.shareId)}`,
    {
      method,
      headers: apiHeaders(input.harness.origin, {
        bindingCookie: participantSessionCookies(input.session),
        csrfToken: method === "PATCH" ? input.session.csrfToken : undefined,
        testClientIp: input.testClientIp
      }),
      ...(input.body ? { body: JSON.stringify(input.body) } : {})
    }
  );
  return {
    body: await response.json() as Record<string, unknown>,
    response
  };
}

async function commentRequest(input: {
  authorization?: string;
  body: Record<string, unknown>;
  cursor?: string;
  harness: SecureShareApiHarness;
  limit?: number;
  method?: "GET" | "POST";
  session?: ParticipantSession;
  shareId: string;
  testClientIp?: string;
}) {
  const method = input.method ?? "POST";
  const query = new URLSearchParams({
    action: "comments",
    shareId: input.shareId
  });
  if (input.cursor) {
    query.set("cursor", input.cursor);
  }
  if (input.limit !== undefined) {
    query.set("limit", String(input.limit));
  }
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?${query.toString()}`,
    {
      method,
      headers: apiHeaders(input.harness.origin, {
        authorization: input.authorization,
        bindingCookie: input.session
          ? participantSessionCookies(input.session)
          : undefined,
        csrfToken: method === "POST" ? input.session?.csrfToken : undefined,
        testClientIp: input.testClientIp
      }),
      ...(method === "POST" ? { body: JSON.stringify(input.body) } : {})
    }
  );
  return {
    body: await response.json() as Record<string, unknown>,
    response
  };
}

async function emailChallengeRequest(input: {
  clientRequestId?: string;
  email: string;
  harness: SecureShareApiHarness;
  networkSuffix: number;
  shareId: string;
}) {
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=email-challenge`
    + `&shareId=${encodeURIComponent(input.shareId)}`,
    {
      method: "POST",
      headers: apiHeaders(input.harness.origin, {
        networkSuffix: input.networkSuffix
      }),
      body: JSON.stringify({
        clientRequestId: input.clientRequestId ?? crypto.randomUUID(),
        email: input.email
      })
    }
  );
  return {
    body: await response.json() as Record<string, unknown>,
    response
  };
}

async function runEmailDeliveryScenario(
  harness: SecureShareApiHarness,
  shareId: string,
  providerResponse: (attempt: number) => Promise<Response> | Response
) {
  const email = `${shareId}@example.test`;
  Object.assign(process.env, {
    SECURE_SHARE_EMAIL_ENABLED: "true",
    SHARE_EMAIL_PROVIDER: "resend",
    SHARE_EMAIL_API_KEY: "emulator-provider-key",
    SHARE_EMAIL_FROM: "sender@example.test",
    SHARE_EMAIL_SENDER_VERIFIED: "true"
  });
  await seedSecureShare({
    accessMode: "allowed_emails",
    allowedEmailHashes: [emailDigest(email)],
    emailVerificationRequired: true,
    oneTimeEnabled: false,
    shareId
  });

  const realFetch = globalThis.fetch.bind(globalThis);
  let providerCalls = 0;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input) === "https://api.resend.com/emails") {
        providerCalls += 1;
        return providerResponse(providerCalls);
      }
      return realFetch(input, init);
    }
  );
  let result: Awaited<ReturnType<typeof emailChallengeRequest>>;
  try {
    result = await emailChallengeRequest({
      email,
      harness,
      networkSuffix: 73,
      shareId
    });
  } finally {
    fetchSpy.mockRestore();
  }
  return {
    ...result,
    challenges: await listEmulatorCollection("publicShareEmailChallenges"),
    deliveries: await listEmulatorCollection("publicShareEmailDeliveries"),
    providerCalls,
    quotaBuckets: await listEmulatorCollection("publicShareEmailQuotaBuckets")
  };
}

function quotaBucketsWithUsage(
  buckets: Array<Record<string, unknown>>
) {
  return buckets.filter((bucket) =>
    ["reservedCount", "sentCount", "failedCount", "ambiguousCount"]
      .some((field) => Number(bucket[field] ?? 0) > 0)
  );
}

async function waitForStableEmailQuotaMinute() {
  const minuteMilliseconds = 60_000;
  const remainingMilliseconds =
    minuteMilliseconds - (Date.now() % minuteMilliseconds);
  if (remainingMilliseconds < 10_000) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, remainingMilliseconds + 100);
    });
  }
}

function enableGmailSmtpEmail() {
  Object.assign(process.env, {
    SECURE_SHARE_EMAIL_ENABLED: "true",
    SHARE_EMAIL_FREE_TIER_MODE: "true",
    SHARE_EMAIL_FROM: "QuickMemo <quickmemo.smtp.test@gmail.com>",
    SHARE_EMAIL_FROM_NAME: "QuickMemo",
    SHARE_EMAIL_PROVIDER: "gmail_smtp",
    SHARE_EMAIL_PROVIDER_HEALTH_CACHE_SECONDS: "60",
    SHARE_EMAIL_REPLY_TO: "",
    SHARE_SMTP_APP_PASSWORD: "abcdefghijklmnop",
    SHARE_SMTP_HOST: "smtp.gmail.com",
    SHARE_SMTP_PORT: "465",
    SHARE_SMTP_REQUIRE_TLS: "false",
    SHARE_SMTP_SECURE: "true",
    SHARE_SMTP_USERNAME: "quickmemo.smtp.test@gmail.com"
  });
}

function sessionTokenFromCookie(cookie: string) {
  const separator = cookie.indexOf("=");
  return separator > 0 ? cookie.slice(separator + 1) : "";
}

function expectSecretFreeFailure(
  body: Record<string, unknown>,
  forbiddenValues: string[]
) {
  expect(Object.keys(body).sort()).toEqual(failureOnlyKeys);
  const serialized = JSON.stringify(body);
  for (const value of forbiddenValues) {
    expect(serialized).not.toContain(value);
  }
  expect(serialized).not.toMatch(
    /allowedEmailHashes|consumedIdentityHash|passwordHashRecord|policyVersion|sessionToken/iu
  );
}

describeEmulator("Secure Share v2 API with real Firebase Emulators", () => {
  let adminEmailHarness: SecureShareApiHarness;
  let harness: SecureShareApiHarness;

  beforeAll(async () => {
    configureSecureShareApiEmulatorEnvironment();
    process.env.SHARE_EMAIL_SETTINGS_ENCRYPTION_KEY_V1 =
      Buffer.alloc(32, 0x39).toString("base64url");
    harness = await startSecureShareApiHarness();
    adminEmailHarness = await startAdminEmailSettingsHarness(
      `admin-email-${Date.now()}`
    );
  });

  beforeEach(async () => {
    configureSecureShareApiEmulatorEnvironment();
    process.env.SHARE_EMAIL_SETTINGS_ENCRYPTION_KEY_V1 =
      Buffer.alloc(32, 0x39).toString("base64url");
    resetGmailSmtpTransportForTests();
    gmailTransportMock.close.mockReset();
    gmailTransportMock.createTransport.mockReset();
    gmailTransportMock.sendMail.mockReset();
    gmailTransportMock.verify.mockReset();
    gmailTransportMock.verify.mockResolvedValue(true);
    gmailTransportMock.sendMail.mockImplementation(
      async (message: { to?: string }) => ({
        accepted: [message.to],
        rejected: [],
        pending: [],
        response: "250 2.0.0 OK",
        messageId: "<quickmemo-emulator-message@gmail.com>"
      })
    );
    gmailTransportMock.createTransport.mockReturnValue({
      close: gmailTransportMock.close,
      sendMail: gmailTransportMock.sendMail,
      verify: gmailTransportMock.verify
    });
    await clearSecureShareEmulators();
  });

  afterAll(async () => {
    await Promise.all([
      harness?.close(),
      adminEmailHarness?.close()
    ]);
  });

  it("fails closed instead of following emulator variables in production mode", async () => {
    process.env.NODE_ENV = "production";
    try {
      const response = await fetch(
        `${harness.origin}/api/public-shares-v2?action=metadata&shareId=production_guard_share`
      );
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(503);
      expect(body).toMatchObject({ ok: false, error: "request_failed" });
      expect(Object.keys(body).sort()).toEqual(failureOnlyKeys);
    } finally {
      process.env.NODE_ENV = "test";
    }
  });

  it("replays an admin mutation only for the same unexpired canonical payload", async () => {
    const admin = await createEmailSettingsAdmin("idempotency");
    const idempotencyKey = "admin_stage_replay_0001";
    const firstBody = {
      action: "stage",
      username: "quickmemo.admin.replay@gmail.com",
      appPassword: "abcd efgh ijkl mnop",
      replyTo: "reply@example.test",
      idempotencyKey
    };

    const first = await adminEmailSettingsRequest({
      body: firstBody,
      harness: adminEmailHarness,
      idToken: admin.idToken
    });
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      settings: {
        pending: {
          present: true,
          usernameMasked: "q***y@gmail.com"
        }
      }
    });

    const replay = await adminEmailSettingsRequest({
      body: {
        ...firstBody,
        username: " QuickMemo.Admin.Replay@Gmail.com ",
        appPassword: "abcdefghijklmnop",
        replyTo: " reply@example.test "
      },
      harness: adminEmailHarness,
      idToken: admin.idToken
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body).toMatchObject({ ok: true, replayed: true });
    expect(gmailTransportMock.verify).toHaveBeenCalledTimes(1);

    const changedPayload = await adminEmailSettingsRequest({
      body: {
        ...firstBody,
        appPassword: "ponmlkjihgfedcba"
      },
      harness: adminEmailHarness,
      idToken: admin.idToken
    });
    expect(changedPayload.response.status).toBe(409);
    expect(changedPayload.body).toMatchObject({
      ok: false,
      error: "conflict"
    });
    expect(gmailTransportMock.verify).toHaveBeenCalledTimes(1);

    const idempotencyDocuments = await listEmulatorCollection(
      "secureShareEmailAdminIdempotency"
    );
    expect(idempotencyDocuments).toHaveLength(1);
    const serialized = JSON.stringify(idempotencyDocuments);
    expect(serialized).not.toContain("quickmemo.admin.replay@gmail.com");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("reply@example.test");
    await patchEmulatorDocuments([
      {
        path:
          `secureShareEmailAdminIdempotency/${idempotencyDocuments[0].__id}`,
        fields: {
          expiresAt: new Date(Date.now() - 1_000)
        }
      }
    ]);

    const expiredReplay = await adminEmailSettingsRequest({
      body: firstBody,
      harness: adminEmailHarness,
      idToken: admin.idToken
    });
    expect(expiredReplay.response.status).toBe(409);
    expect(expiredReplay.body).toMatchObject({
      ok: false,
      error: "conflict"
    });
    expect(gmailTransportMock.verify).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("recovers expired admin test reservations before stage, discard, and remove", async () => {
    const admin = await createEmailSettingsAdmin("stuck-recovery");
    const request = (body: Record<string, unknown>) =>
      adminEmailSettingsRequest({
        body,
        harness: adminEmailHarness,
        idToken: admin.idToken
      });
    const activeStage = await request({
      action: "stage",
      username: "quickmemo.admin.active@gmail.com",
      appPassword: "abcdefghijklmnop",
      idempotencyKey: "admin_active_stage_0001"
    });
    expect(activeStage.response.status).toBe(200);
    const activeStagedDocument = await readEmulatorDocument(
      "secureShareEmailSettings/current"
    );
    const activePending = activeStagedDocument?.pending as
      | Record<string, unknown>
      | undefined;
    const activeGeneration = String(activePending?.generation ?? "");
    expect(activeGeneration).toMatch(/^[A-Za-z0-9_-]{16,64}$/u);

    const send = await request({
      action: "send-test",
      generation: activeGeneration,
      idempotencyKey: "admin_active_send_test_0002"
    });
    expect(send.response.status).toBe(200);
    const message = gmailTransportMock.sendMail.mock.calls.at(-1)?.[0] as
      | { text?: string }
      | undefined;
    const code = /확인 코드: ([0-9]{6})/u.exec(message?.text ?? "")?.[1] ?? "";
    expect(code).toMatch(/^[0-9]{6}$/u);
    const confirm = await request({
      action: "confirm-test",
      generation: activeGeneration,
      code,
      idempotencyKey: "admin_active_confirm_0003"
    });
    expect(confirm.response.status).toBe(200);

    const pendingStage = await request({
      action: "stage",
      username: "quickmemo.admin.pending@gmail.com",
      appPassword: "ponmlkjihgfedcba",
      idempotencyKey: "admin_pending_stage_0004"
    });
    expect(pendingStage.response.status).toBe(200);
    const futureReservation = await forcePendingEmailTestSending(
      new Date(Date.now() + 60_000)
    );
    const blockedStage = await request({
      action: "stage",
      username: "quickmemo.admin.blocked@gmail.com",
      appPassword: "aaaabbbbccccdddd",
      idempotencyKey: "admin_blocked_stage_0005"
    });
    expect(blockedStage.response.status).toBe(409);
    expect(blockedStage.body).toMatchObject({
      ok: false,
      error: "conflict"
    });
    expect(gmailTransportMock.verify).toHaveBeenCalledTimes(2);
    for (const bucketId of futureReservation.bucketIds) {
      expect(await readEmulatorDocument(
        `publicShareEmailQuotaBuckets/${bucketId}`
      )).toMatchObject({
        reservedCount: 1
      });
    }

    await patchPendingEmailTestDeadline(new Date(Date.now() - 1_000));
    const replacementStage = await request({
      action: "stage",
      username: "quickmemo.admin.replacement@gmail.com",
      appPassword: "aaaabbbbccccdddd",
      idempotencyKey: "admin_replacement_stage_0006"
    });
    expect(replacementStage.response.status).toBe(200);
    let settings = await readEmulatorDocument(
      "secureShareEmailSettings/current"
    );
    expect((settings?.active as Record<string, unknown>)?.generation).toBe(
      activeGeneration
    );
    expect((settings?.pending as Record<string, unknown>)?.generation).not.toBe(
      futureReservation.generation
    );
    for (const bucketId of futureReservation.bucketIds) {
      expect(await readEmulatorDocument(
        `publicShareEmailQuotaBuckets/${bucketId}`
      )).toMatchObject({
        ambiguousCount: 1,
        reservedCount: 0
      });
    }

    const discardReservation = await forcePendingEmailTestSending(
      new Date(Date.now() - 1_000)
    );
    const discard = await request({
      action: "discard-pending",
      generation: discardReservation.generation,
      idempotencyKey: "admin_recovery_discard_0007"
    });
    expect(discard.response.status).toBe(200);
    settings = await readEmulatorDocument(
      "secureShareEmailSettings/current"
    );
    expect(settings?.pending).toBeUndefined();
    expect((settings?.active as Record<string, unknown>)?.generation).toBe(
      activeGeneration
    );

    const removableStage = await request({
      action: "stage",
      username: "quickmemo.admin.remove@gmail.com",
      appPassword: "ddddeeeeffffgggg",
      idempotencyKey: "admin_removable_stage_0008"
    });
    expect(removableStage.response.status).toBe(200);
    const removeReservation = await forcePendingEmailTestSending(
      new Date(Date.now() - 1_000)
    );
    const remove = await request({
      action: "remove",
      target: "pending",
      generation: removeReservation.generation,
      idempotencyKey: "admin_recovery_remove_0009"
    });
    expect(remove.response.status).toBe(200);
    settings = await readEmulatorDocument(
      "secureShareEmailSettings/current"
    );
    expect(settings?.pending).toBeUndefined();
    expect((settings?.active as Record<string, unknown>)?.generation).toBe(
      activeGeneration
    );
    const recoveryAudits = (
      await listEmulatorCollection("secureShareEmailAdminAudit")
    ).filter((document) => document.action === "recover-stuck-test");
    expect(recoveryAudits).toHaveLength(3);
  }, 30_000);

  it("accounts a finalizer-versus-recovery race exactly once", async () => {
    const admin = await createEmailSettingsAdmin("recovery-race");
    const request = (body: Record<string, unknown>) =>
      adminEmailSettingsRequest({
        body,
        harness: adminEmailHarness,
        idToken: admin.idToken
      });
    const staged = await request({
      action: "stage",
      username: "quickmemo.admin.race@gmail.com",
      appPassword: "abcdefghijklmnop",
      idempotencyKey: "admin_race_stage_0001"
    });
    expect(staged.response.status).toBe(200);
    const stagedDocument = await readEmulatorDocument(
      "secureShareEmailSettings/current"
    );
    const generation = String(
      (stagedDocument?.pending as Record<string, unknown>)?.generation ?? ""
    );
    let releaseSend = () => {};
    const sendRelease = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let markSendStarted = () => {};
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    gmailTransportMock.sendMail.mockImplementationOnce(
      async (message: { to?: string }) => {
        markSendStarted();
        await sendRelease;
        return {
          accepted: [message.to],
          rejected: [],
          pending: [],
          response: "250 2.0.0 OK",
          messageId: "<quickmemo-race-message@gmail.com>"
        };
      }
    );
    const sendPromise = request({
      action: "send-test",
      generation,
      idempotencyKey: "admin_race_send_test_0002"
    });
    await sendStarted;
    const reserved = await readEmulatorDocument(
      "secureShareEmailSettings/current"
    );
    const reservedPending = reserved?.pending as
      | Record<string, unknown>
      | undefined;
    const bucketIds = reservedPending?.testQuotaBucketIds as
      | string[]
      | undefined;
    expect(bucketIds).toHaveLength(3);
    await patchPendingEmailTestDeadline(new Date(Date.now() - 1_000));

    const recoveryPromise = request({
      action: "stage",
      username: "quickmemo.admin.after.race@gmail.com",
      appPassword: "ponmlkjihgfedcba",
      idempotencyKey: "admin_race_recovery_stage_0003"
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseSend();
    const [sendResult, recoveryResult] = await Promise.all([
      sendPromise,
      recoveryPromise
    ]);

    expect(recoveryResult.response.status).toBe(200);
    expect(new Set([200, 409])).toContain(sendResult.response.status);
    const finalSettings = await readEmulatorDocument(
      "secureShareEmailSettings/current"
    );
    expect(
      (finalSettings?.pending as Record<string, unknown>)?.generation
    ).not.toBe(generation);
    for (const bucketId of bucketIds ?? []) {
      const bucket = await readEmulatorDocument(
        `publicShareEmailQuotaBuckets/${bucketId}`
      );
      expect(bucket?.reservedCount).toBe(0);
      expect(
        Number(bucket?.sentCount ?? 0)
        + Number(bucket?.ambiguousCount ?? 0)
      ).toBe(1);
    }
  }, 20_000);

  it("creates a share with a new RSA-3072 owner-wrapped content key", async () => {
    const owner = await createEmulatorOwner(
      "rsa-3072-owner@example.test",
      "emulator-owner-password"
    );
    const sourceNoteId = "source_note_rsa_3072";
    await writeEmulatorDocuments([
      {
        path: `users/${owner.localId}`,
        fields: {
          displayName: "RSA 3072 Owner",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: false,
          uid: owner.localId
        }
      },
      {
        path: `notes/${sourceNoteId}`,
        fields: {
          attachmentRevision: 0,
          isDeleted: false,
          isPurged: false,
          ownerUid: owner.localId,
          revision: 1
        }
      }
    ]);

    const { body, response } = await ownerCreateRequest({
      harness,
      idToken: owner.idToken,
      idempotencyKey: "rsa_3072_create_attempt",
      networkSuffix: 79,
      sourceNoteId,
      wrappedKeyBytes: 384
    });

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ ok: true });
  });

  it("updates encrypted content idempotently while preserving the URL session and policy", async () => {
    const owner = await createEmulatorOwner(
      "content-update-owner@example.test",
      "emulator-owner-password"
    );
    const shareId = "content_update_share_0001";
    const seed = await seedSecureShare({
      oneTimeEnabled: false,
      ownerUid: owner.localId,
      shareId
    });
    const metadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 74
    });
    expect(metadata.body).toMatchObject({
      metadata: { hasSessionCandidate: false }
    });
    const granted = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: { unlockAttemptId: "content_update_access_0001" },
      harness,
      networkSuffix: 74,
      shareId
    });
    expect(granted.response.status).toBe(200);
    const sessionCookie = responseCookie(granted.response, "qmss_");
    const viewerCookies = `${metadata.bindingCookie}; ${sessionCookie}`;

    await patchEmulatorDocuments([
      {
        path: `notes/${seed.noteId}`,
        fields: { revision: 2 }
      }
    ]);

    const stillAvailable = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 75
    });
    expect(stillAvailable.response.status).toBe(200);
    const staleContentResponse = await fetch(
      `${harness.origin}/api/public-shares-v2?action=content`
      + `&shareId=${encodeURIComponent(shareId)}`,
      {
        headers: apiHeaders(harness.origin, {
          bindingCookie: viewerCookies,
          networkSuffix: 74
        })
      }
    );
    expect(staleContentResponse.status).toBe(200);
    expect(await staleContentResponse.json()).toMatchObject({
      contentRevision: 1,
      policyVersion: 1
    });

    const encryptedTitle = {
      version: 1,
      algorithm: "AES-GCM",
      cipherText: Buffer.alloc(24, 7).toString("base64"),
      iv: Buffer.alloc(12, 8).toString("base64")
    };
    const encryptedBody = {
      version: 1,
      algorithm: "AES-GCM",
      cipherText: Buffer.alloc(48, 9).toString("base64"),
      iv: Buffer.alloc(12, 10).toString("base64")
    };
    const updateBody = {
      attachmentCount: 0,
      encryptedBody,
      encryptedTitle,
      expectedContentRevision: 1,
      expectedSourceAttachmentRevision: 0,
      expectedSourceRevision: 1,
      generation: "generation_content_update_0001",
      idempotencyKey: "content_update_request_0001",
      sourceAttachmentRevision: 0,
      sourceRevision: 2
    };
    const updated = await ownerContentUpdateRequest({
      body: updateBody,
      harness,
      idToken: owner.idToken,
      networkSuffix: 76,
      shareId
    });
    expect(updated.response.status).toBe(200);
    expect(updated.body).toMatchObject({
      ok: true,
      retiredAttachmentIds: [],
      share: {
        contentRevision: 2,
        policyVersion: 1,
        sourceRevision: 2
      }
    });
    const replayed = await ownerContentUpdateRequest({
      body: updateBody,
      harness,
      idToken: owner.idToken,
      networkSuffix: 76,
      shareId
    });
    expect(replayed.response.status).toBe(200);
    expect(replayed.body).toMatchObject({
      share: { contentRevision: 2, policyVersion: 1 }
    });
    const conflictingReplay = await ownerContentUpdateRequest({
      body: {
        ...updateBody,
        encryptedBody: {
          ...encryptedBody,
          cipherText: Buffer.alloc(48, 11).toString("base64")
        }
      },
      harness,
      idToken: owner.idToken,
      networkSuffix: 76,
      shareId
    });
    expect(conflictingReplay.response.status).toBe(409);
    expect(conflictingReplay.body).toMatchObject({
      ok: false,
      error: "request_conflict"
    });
    const staleCas = await ownerContentUpdateRequest({
      body: {
        ...updateBody,
        idempotencyKey: "content_update_request_stale_0001"
      },
      harness,
      idToken: owner.idToken,
      networkSuffix: 76,
      shareId
    });
    expect(staleCas.response.status).toBe(409);
    expect(staleCas.body).toMatchObject({
      ok: false,
      error: "content_revision_conflict"
    });

    const revision = await fetch(
      `${harness.origin}/api/public-shares-v2?action=revision`
      + `&shareId=${encodeURIComponent(shareId)}`,
      {
        headers: {
          ...apiHeaders(harness.origin, {
            bindingCookie: viewerCookies,
            networkSuffix: 74
          }),
          "x-quickmemo-secure-share-revision": "1"
        }
      }
    );
    expect(revision.status).toBe(200);
    const etag = revision.headers.get("etag");
    expect(etag).toBe("\"ss2-r2-p1\"");
    expect(await revision.json()).toMatchObject({
      contentRevision: 2,
      policyVersion: 1
    });
    const unchanged = await fetch(
      `${harness.origin}/api/public-shares-v2?action=revision`
      + `&shareId=${encodeURIComponent(shareId)}`,
      {
        headers: {
          ...apiHeaders(harness.origin, {
            bindingCookie: viewerCookies,
            networkSuffix: 74
          }),
          "if-none-match": etag ?? "",
          "x-quickmemo-secure-share-revision": "1"
        }
      }
    );
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(await unchanged.text()).toBe("");

    const content = await fetch(
      `${harness.origin}/api/public-shares-v2?action=content`
      + `&shareId=${encodeURIComponent(shareId)}`,
      {
        headers: apiHeaders(harness.origin, {
          bindingCookie: viewerCookies,
          networkSuffix: 74
        })
      }
    );
    expect(content.status).toBe(200);
    expect(content.headers.get("etag")).toBe(etag);
    expect(await content.json()).toMatchObject({
      contentRevision: 2,
      encryptedBody,
      encryptedTitle,
      policyVersion: 1
    });
    expect(await readEmulatorDocument(`publicNoteShares/${shareId}`)).toMatchObject({
      contentRevision: 2,
      policyVersion: 1,
      sourceRevision: 2
    });
    const updateAudits = (await listEmulatorCollection(
      `publicShareAuditEvents/${shareId}/items`
    ))
      .filter((event) => event.eventType === "owner_content_update");
    expect(updateAudits).toHaveLength(1);
  }, 30_000);

  it("rejects legacy automatic source-change revokes without blocking explicit or deleted-source revokes", async () => {
    const owner = await createEmulatorOwner(
      "legacy-revoke-compat-owner@example.test",
      "emulator-owner-password"
    );
    const activeShareId = "legacy_revoke_active_0001";
    await seedSecureShare({
      oneTimeEnabled: false,
      ownerUid: owner.localId,
      shareId: activeShareId
    });
    const revoke = (shareId: string, idempotencyKey: string, networkSuffix: number) =>
      fetch(
        `${harness.origin}/api/public-shares-v2?action=owner-revoke`
        + `&shareId=${encodeURIComponent(shareId)}`,
        {
          method: "POST",
          headers: apiHeaders(harness.origin, {
            authorization: owner.idToken,
            networkSuffix
          }),
          body: JSON.stringify({ idempotencyKey })
        }
      );

    const legacyActive = await revoke(
      activeShareId,
      `source_changed_${"a".repeat(32)}`,
      77
    );
    expect(legacyActive.status).toBe(409);
    expect(await legacyActive.json()).toMatchObject({
      ok: false,
      error: "content_sync_required"
    });
    expect(await readEmulatorDocument(`publicNoteShares/${activeShareId}`)).toMatchObject({
      policyVersion: 1,
      status: "active"
    });

    const explicit = await revoke(
      activeShareId,
      `revoke_${"b".repeat(32)}`,
      78
    );
    expect(explicit.status).toBe(200);
    expect(await readEmulatorDocument(`publicNoteShares/${activeShareId}`)).toMatchObject({
      policyVersion: 2,
      status: "revoked"
    });

    const deletedShareId = "legacy_revoke_deleted_0001";
    const deletedSeed = await seedSecureShare({
      oneTimeEnabled: false,
      ownerUid: owner.localId,
      shareId: deletedShareId
    });
    await patchEmulatorDocuments([
      {
        path: `notes/${deletedSeed.noteId}`,
        fields: { isDeleted: true }
      }
    ]);
    const legacyDeleted = await revoke(
      deletedShareId,
      `source_changed_${"c".repeat(32)}`,
      79
    );
    expect(legacyDeleted.status).toBe(200);
    expect(await readEmulatorDocument(`publicNoteShares/${deletedShareId}`)).toMatchObject({
      policyVersion: 2,
      status: "revoked"
    });
  }, 30_000);

  it("creates at most one live share per source note and replaces stale guards safely", async () => {
    const owner = await createEmulatorOwner(
      "source-guard-owner@example.test",
      "emulator-owner-password"
    );
    const sourceNoteId = "source_note_guard_0001";
    await writeEmulatorDocuments([
      {
        path: `users/${owner.localId}`,
        fields: {
          displayName: "Source Guard Owner",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: false,
          uid: owner.localId
        }
      },
      {
        path: `notes/${sourceNoteId}`,
        fields: {
          attachmentRevision: 0,
          isDeleted: false,
          isPurged: false,
          ownerUid: owner.localId,
          revision: 1
        }
      }
    ]);

    const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      ownerCreateRequest({
        harness,
        idToken: owner.idToken,
        idempotencyKey: `source_create_attempt_${String(index).padStart(4, "0")}`,
        networkSuffix: 80 + index,
        sourceNoteId
      })
    ));
    const created = concurrent.filter(({ response }) => response.status === 201);
    const blocked = concurrent.filter(({ response }) => response.status === 409);
    expect(created).toHaveLength(1);
    expect(blocked).toHaveLength(3);
    expect(blocked.every(({ body }) => body.error === "active_share_exists")).toBe(true);
    expect(await listEmulatorCollection("publicNoteShares")).toHaveLength(1);
    expect(await listEmulatorCollection("publicSharePolicies")).toHaveLength(1);
    expect(await listEmulatorCollection("publicShareSourceGuards")).toHaveLength(1);
    const createRateBuckets = (await listEmulatorCollection("publicShareRateLimits"))
      .filter(({ limitType }) => new Set([
        "share_create_owner_hour",
        "share_create_owner_day"
      ]).has(String(limitType)));
    expect(createRateBuckets).toHaveLength(2);
    expect(createRateBuckets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        count: 4,
        limitType: "share_create_owner_hour"
      }),
      expect.objectContaining({
        count: 4,
        limitType: "share_create_owner_day"
      })
    ]));

    const createdShare = created[0].body.share as Record<string, unknown>;
    const shareId = String(createdShare.shareId);
    const guardId = sourceShareGuardId(owner.localId, sourceNoteId);
    expect(await readEmulatorDocument(`publicShareSourceGuards/${guardId}`)).toMatchObject({
      ownerUid: owner.localId,
      shareId,
      sourceNoteId
    });

    const sourceList = await fetch(
      `${harness.origin}/api/public-shares-v2?action=owner-list`
      + `&sourceNoteId=${encodeURIComponent(sourceNoteId)}&limit=100`,
      {
        headers: apiHeaders(harness.origin, {
          authorization: owner.idToken,
          networkSuffix: 90
        })
      }
    );
    expect(sourceList.status).toBe(200);
    expect(await sourceList.json()).toMatchObject({
      ok: true,
      nextCursor: null,
      shares: [{ shareId, sourceNoteId }]
    });

    const cursorRejected = await fetch(
      `${harness.origin}/api/public-shares-v2?action=owner-list`
      + `&sourceNoteId=${encodeURIComponent(sourceNoteId)}&limit=100&cursor=not-allowed`,
      {
        headers: apiHeaders(harness.origin, {
          authorization: owner.idToken,
          networkSuffix: 91
        })
      }
    );
    expect(cursorRejected.status).toBe(400);
    expect(await cursorRejected.json()).toMatchObject({
      ok: false,
      error: "invalid_request"
    });

    const revoked = await fetch(
      `${harness.origin}/api/public-shares-v2?action=owner-revoke`
      + `&shareId=${encodeURIComponent(shareId)}`,
      {
        method: "POST",
        headers: apiHeaders(harness.origin, {
          authorization: owner.idToken,
          networkSuffix: 92
        }),
        body: JSON.stringify({ idempotencyKey: "source_revoke_attempt_0001" })
      }
    );
    expect(revoked.status).toBe(200);
    expect(await readEmulatorDocument(`publicShareSourceGuards/${guardId}`)).toBeNull();

    await writeEmulatorDocuments([
      {
        path: `publicShareSourceGuards/${guardId}`,
        fields: {
          schemaVersion: 1,
          ownerUid: owner.localId,
          sourceNoteId,
          shareId,
          createdAt: new Date(Date.now() - 60_000),
          updatedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000)
        }
      }
    ]);
    const replacement = await ownerCreateRequest({
      harness,
      idToken: owner.idToken,
      idempotencyKey: "source_create_replacement_0001",
      networkSuffix: 93,
      sourceNoteId
    });
    expect(replacement.response.status).toBe(201);
    const replacementShare = replacement.body.share as Record<string, unknown>;
    expect(replacementShare.shareId).not.toBe(shareId);
    expect(await readEmulatorDocument(`publicShareSourceGuards/${guardId}`)).toMatchObject({
      shareId: replacementShare.shareId
    });

    await writeEmulatorDocuments(Array.from({ length: 99 }, (_, index) => ({
      path: `publicNoteShares/source_history_noise_${String(index).padStart(3, "0")}`,
      fields: {
        schemaVersion: 1,
        ownerUid: "another_owner",
        sourceNoteId,
        status: "revoked"
      }
    })));
    const ownerHistoryUnaffected = await fetch(
      `${harness.origin}/api/public-shares-v2?action=owner-list`
      + `&sourceNoteId=${encodeURIComponent(sourceNoteId)}&limit=100`,
      {
        headers: apiHeaders(harness.origin, {
          authorization: owner.idToken,
          networkSuffix: 94
        })
      }
    );
    expect(ownerHistoryUnaffected.status).toBe(200);
    expect((await ownerHistoryUnaffected.json() as {
      shares: unknown[];
    }).shares).toHaveLength(2);

    await writeEmulatorDocuments(Array.from({ length: 99 }, (_, index) => ({
      path: `publicNoteShares/source_owner_history_${String(index).padStart(3, "0")}`,
      fields: {
        schemaVersion: 1,
        ownerUid: owner.localId,
        sourceNoteId,
        status: "revoked"
      }
    })));
    const oversizedHistory = await fetch(
      `${harness.origin}/api/public-shares-v2?action=owner-list`
      + `&sourceNoteId=${encodeURIComponent(sourceNoteId)}&limit=100`,
      {
        headers: apiHeaders(harness.origin, {
          authorization: owner.idToken,
          networkSuffix: 95
        })
      }
    );
    expect(oversizedHistory.status).toBe(409);
    expect(await oversizedHistory.json()).toMatchObject({
      ok: false,
      error: "source_share_history_too_large"
    });
  }, 30_000);

  it("moves the cleanup queue expiry atomically with an owner expiration update", async () => {
    const owner = await createEmulatorOwner(
      "owner-expiry-update@example.test",
      "emulator-owner-password"
    );
    const sourceNoteId = "source_note_expiry_update_0001";
    await writeEmulatorDocuments([
      {
        path: `users/${owner.localId}`,
        fields: {
          displayName: "Expiry Update Owner",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: false,
          uid: owner.localId
        }
      },
      {
        path: `notes/${sourceNoteId}`,
        fields: {
          attachmentRevision: 0,
          isDeleted: false,
          isPurged: false,
          ownerUid: owner.localId,
          revision: 1
        }
      }
    ]);
    const created = await ownerCreateRequest({
      harness,
      idToken: owner.idToken,
      idempotencyKey: "owner_expiry_create_0001",
      networkSuffix: 96,
      sourceNoteId
    });
    expect(created.response.status).toBe(201);
    const shareId = String(
      (created.body.share as Record<string, unknown>).shareId
    );
    const initialShare = await readEmulatorDocument(`publicNoteShares/${shareId}`);
    const initialQueue = await readEmulatorDocument(
      `publicShareCleanupQueue/${shareId}`
    );
    expect(initialQueue?.expiresAt).toBe(initialShare?.expiresAt);

    const updated = await ownerUpdateRequest({
      harness,
      idToken: owner.idToken,
      idempotencyKey: "owner_expiry_update_0001",
      networkSuffix: 97,
      policy: { expirationPreset: "seven_days" },
      shareId
    });
    expect(updated.response.status).toBe(200);

    const share = await readEmulatorDocument(`publicNoteShares/${shareId}`);
    const policy = await readEmulatorDocument(`publicSharePolicies/${shareId}`);
    const queue = await readEmulatorDocument(`publicShareCleanupQueue/${shareId}`);
    expect(queue?.expiresAt).toBe(share?.expiresAt);
    expect(policy?.expiresAt).toBe(share?.expiresAt);
    expect(Date.parse(String(share?.expiresAt))).toBeGreaterThan(
      Date.parse(String(initialShare?.expiresAt))
    );
  }, 30_000);

  it("replays four parallel creates with one idempotency key as a single share", async () => {
    const owner = await createEmulatorOwner(
      "source-idempotency-owner@example.test",
      "emulator-owner-password"
    );
    const sourceNoteId = "source_note_idempotency_0001";
    await writeEmulatorDocuments([
      {
        path: `users/${owner.localId}`,
        fields: {
          displayName: "Source Idempotency Owner",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: false,
          uid: owner.localId
        }
      },
      {
        path: `notes/${sourceNoteId}`,
        fields: {
          attachmentRevision: 0,
          isDeleted: false,
          isPurged: false,
          ownerUid: owner.localId,
          revision: 1
        }
      }
    ]);

    const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      ownerCreateRequest({
        harness,
        idToken: owner.idToken,
        idempotencyKey: "source_create_same_key_0001",
        networkSuffix: 96 + index,
        sourceNoteId
      })
    ));
    expect(
      concurrent
        .map(({ response }) => response.status)
        .sort((left, right) => left - right)
    ).toEqual([200, 200, 200, 201]);
    expect(concurrent.filter(({ body }) => body.created === true)).toHaveLength(1);
    expect(concurrent.filter(({ body }) => body.created === false)).toHaveLength(3);

    const shares = concurrent.map(({ body }) => body.share as Record<string, unknown>);
    const shareIds = new Set(shares.map((share) => String(share.shareId)));
    expect(shareIds.size).toBe(1);
    const [shareId] = shareIds;
    expect(shareId).toMatch(/^ss2_[A-Za-z0-9_-]{24}$/u);
    expect(await listEmulatorCollection("publicNoteShares")).toHaveLength(1);
    expect(await listEmulatorCollection("publicSharePolicies")).toHaveLength(1);
    expect(await listEmulatorCollection("publicShareSourceGuards")).toHaveLength(1);
    const createRateBuckets = (await listEmulatorCollection("publicShareRateLimits"))
      .filter(({ limitType }) => new Set([
        "share_create_owner_hour",
        "share_create_owner_day"
      ]).has(String(limitType)));
    expect(createRateBuckets).toHaveLength(2);
    expect(createRateBuckets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        count: 1,
        limitType: "share_create_owner_hour"
      }),
      expect.objectContaining({
        count: 1,
        limitType: "share_create_owner_day"
      })
    ]));

    const guardId = sourceShareGuardId(owner.localId, sourceNoteId);
    expect(await readEmulatorDocument(`publicShareSourceGuards/${guardId}`)).toMatchObject({
      ownerUid: owner.localId,
      shareId,
      sourceNoteId
    });
  }, 30_000);

  it("persistently replays one copy grant and renews it once per session or expiry window", async () => {
    const shareId = "persistent_copy_grant_share";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "save_copy",
      shareId
    });
    const requester = await createEmulatorOwner(
      "copy-requester@example.test",
      "emulator-requester-password"
    );
    await writeEmulatorDocuments([
      {
        path: `users/${requester.localId}`,
        fields: {
          displayName: "Copy Requester",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: false,
          uid: requester.localId
        }
      }
    ]);

    const firstMetadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 100
    });
    const firstAccess = await accessRequest({
      bindingCookie: firstMetadata.bindingCookie,
      body: {
        displayName: "Copy viewer",
        unlockAttemptId: "copy_access_attempt_0001"
      },
      harness,
      networkSuffix: 100,
      shareId
    });
    expect(firstAccess.response.status).toBe(200);
    const firstSessionCookie = cookiePair(firstAccess.response);
    const firstCsrfToken = String(firstAccess.body.csrfToken);
    const stableRequestKey = "persistent_copy_request_0001";

    const realFetch = globalThis.fetch.bind(globalThis);
    let commitResponseLost = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const upstream = await realFetch(input, init);
        if (
          !commitResponseLost
          && String(input).endsWith("/documents:commit")
          && String(init?.body).includes("publicShareCopyGrantRequests/")
        ) {
          commitResponseLost = true;
          return new Response("{", {
            headers: { "content-type": "application/json" },
            status: 200
          });
        }
        return upstream;
      }
    );
    let concurrent: Awaited<ReturnType<typeof copyGrantRequest>>[];
    try {
      concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        copyGrantRequest({
          bindingCookie: firstMetadata.bindingCookie,
          csrfToken: firstCsrfToken,
          harness,
          idToken: requester.idToken,
          idempotencyKey: stableRequestKey,
          networkSuffix: 101 + index,
          sessionCookie: firstSessionCookie,
          shareId
        })
      ));
    } finally {
      fetchSpy.mockRestore();
    }
    expect(commitResponseLost).toBe(true);
    expect(
      concurrent
        .filter(({ response }) => response.status !== 200)
        .map(({ body, response }) => ({
          error: body.error,
          status: response.status
        }))
    ).toEqual([]);
    const firstTokens = new Set(concurrent.map(({ body }) => body.copyGrant));
    const firstExpirations = new Set(concurrent.map(({ body }) => body.expiresAt));
    expect(firstTokens.size).toBe(1);
    expect(firstExpirations.size).toBe(1);
    const firstToken = String(concurrent[0].body.copyGrant);
    const firstExpiration = String(concurrent[0].body.expiresAt);
    const firstGrant = verifySignedOpaqueToken(
      firstToken,
      "quickmemo/secure-share/copy-grant/v1"
    );
    expect(new Date(Number(firstGrant?.exp) * 1000).toISOString()).toBe(firstExpiration);

    let requestDocuments = await listEmulatorCollection("publicShareCopyGrantRequests");
    let copyAudits = (await listEmulatorCollection(
      `publicShareAuditEvents/${shareId}/items`
    )).filter((audit) => audit.eventType === "copy_grant");
    let copyRateBuckets = (await listEmulatorCollection("publicShareRateLimits"))
      .filter((bucket) => bucket.limitType === "copy_grant_session_minute");
    expect(requestDocuments).toHaveLength(1);
    expect(requestDocuments[0]).toMatchObject({ issuanceGeneration: 1 });
    expect(copyAudits).toHaveLength(1);
    expect(copyRateBuckets).toHaveLength(1);
    expect(copyRateBuckets[0]).toMatchObject({ count: 1 });

    await writeEmulatorDocuments([
      {
        path: `userAttachmentUsage/${requester.localId}`,
        fields: {
          attachmentCount: -1,
          uid: requester.localId,
          usedBytes: -1
        }
      }
    ]);
    const replayAfterDiscard = await copyGrantRequest({
      bindingCookie: firstMetadata.bindingCookie,
      csrfToken: firstCsrfToken,
      harness,
      idToken: requester.idToken,
      idempotencyKey: stableRequestKey,
      networkSuffix: 114,
      sessionCookie: firstSessionCookie,
      shareId
    });
    expect(replayAfterDiscard.response.status).toBe(200);
    expect(replayAfterDiscard.body).toMatchObject({
      copyGrant: firstToken,
      expiresAt: firstExpiration
    });
    const quotaBlocked = await copyGrantRequest({
      bindingCookie: firstMetadata.bindingCookie,
      csrfToken: firstCsrfToken,
      harness,
      idToken: requester.idToken,
      idempotencyKey: "persistent_copy_request_0002",
      networkSuffix: 115,
      sessionCookie: firstSessionCookie,
      shareId
    });
    expect(quotaBlocked.response.status).toBe(503);
    expect(await listEmulatorCollection("publicShareCopyGrantRequests")).toHaveLength(1);
    expect((await listEmulatorCollection(
      `publicShareAuditEvents/${shareId}/items`
    )).filter((audit) => audit.eventType === "copy_grant")).toHaveLength(1);
    await writeEmulatorDocuments([
      {
        path: `userAttachmentUsage/${requester.localId}`,
        fields: {
          attachmentCount: 0,
          uid: requester.localId,
          usedBytes: 0
        }
      }
    ]);

    const secondMetadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 116
    });
    const secondAccess = await accessRequest({
      bindingCookie: secondMetadata.bindingCookie,
      body: {
        displayName: "Copy viewer renewed",
        unlockAttemptId: "copy_access_attempt_0002"
      },
      harness,
      networkSuffix: 116,
      shareId
    });
    expect(secondAccess.response.status).toBe(200);
    const secondSessionCookie = cookiePair(secondAccess.response);
    const sessionRenewal = await copyGrantRequest({
      bindingCookie: secondMetadata.bindingCookie,
      csrfToken: String(secondAccess.body.csrfToken),
      harness,
      idToken: requester.idToken,
      idempotencyKey: stableRequestKey,
      networkSuffix: 117,
      sessionCookie: secondSessionCookie,
      shareId
    });
    expect(sessionRenewal.response.status).toBe(200);
    const secondToken = String(sessionRenewal.body.copyGrant);
    expect(secondToken).not.toBe(firstToken);
    requestDocuments = await listEmulatorCollection("publicShareCopyGrantRequests");
    expect(requestDocuments[0]).toMatchObject({ issuanceGeneration: 2 });

    const secondSessionToken = sessionTokenFromCookie(secondSessionCookie);
    const secondSession = await readEmulatorDocument(
      `publicShareAccessSessions/${sessionTokenDigest(secondSessionToken)}`
    );
    expect(copyGrantAuthorizesDownload(firstGrant, {
      ownerPreview: false,
      permissionLevel: "save_copy",
      policyVersion: 1,
      sessionReferenceHash: String(secondSession?.sessionReferenceHash),
      shareId,
      uid: requester.localId
    })).toBe(false);

    const clock = vi.spyOn(Date, "now");
    const advancedNow = Date.now() + 291_000;
    clock.mockReturnValue(advancedNow);
    try {
      const expiringRetries = await Promise.all(Array.from({ length: 6 }, (_, index) =>
        copyGrantRequest({
          bindingCookie: secondMetadata.bindingCookie,
          csrfToken: String(secondAccess.body.csrfToken),
          harness,
          idToken: requester.idToken,
          idempotencyKey: stableRequestKey,
          networkSuffix: 118 + index,
          sessionCookie: secondSessionCookie,
          shareId
        })
      ));
      expect(
        expiringRetries
          .filter(({ response }) => response.status !== 200)
          .map(({ body, response }) => ({
            error: body.error,
            status: response.status
          }))
      ).toEqual([]);
      expect(new Set(expiringRetries.map(({ body }) => body.copyGrant)).size).toBe(1);
      expect(expiringRetries[0].body.copyGrant).not.toBe(secondToken);
    } finally {
      clock.mockRestore();
    }

    requestDocuments = await listEmulatorCollection("publicShareCopyGrantRequests");
    copyAudits = (await listEmulatorCollection(
      `publicShareAuditEvents/${shareId}/items`
    )).filter((audit) => audit.eventType === "copy_grant");
    copyRateBuckets = (await listEmulatorCollection("publicShareRateLimits"))
      .filter((bucket) => bucket.limitType === "copy_grant_session_minute");
    expect(requestDocuments[0]).toMatchObject({ issuanceGeneration: 3 });
    expect(copyAudits).toHaveLength(3);
    expect(copyRateBuckets.reduce(
      (total, bucket) => total + Number(bucket.count),
      0
    )).toBe(3);
  }, 30_000);

  it("does not consume a one-time share during metadata or an authenticated owner preview", async () => {
    const owner = await createEmulatorOwner(
      "secure-share-owner@example.test",
      "emulator-owner-password"
    );
    const shareId = "owner_preview_share";
    await seedSecureShare({ shareId, ownerUid: owner.localId });

    const anonymousMetadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 2
    });
    expect(anonymousMetadata.body).toMatchObject({
      ok: true,
      metadata: { oneTimeEnabled: true, ownerPreview: false }
    });
    expect(await readEmulatorDocument(`publicNoteShares/${shareId}`)).not.toHaveProperty(
      "consumedAt"
    );
    expect(await readEmulatorDocument(`publicSharePolicies/${shareId}`)).not.toHaveProperty(
      "consumedAt"
    );

    const ownerMetadata = await metadataBinding(harness.origin, shareId, {
      authorization: owner.idToken,
      networkSuffix: 3
    });
    expect(ownerMetadata.body).toMatchObject({
      ok: true,
      metadata: { oneTimeEnabled: true, ownerPreview: true }
    });

    const preview = await accessRequest({
      authorization: owner.idToken,
      bindingCookie: ownerMetadata.bindingCookie,
      body: {
        ownerPreview: true,
        unlockAttemptId: "owner_preview_attempt_000001"
      },
      harness,
      networkSuffix: 3,
      shareId
    });
    expect(preview.response.status).toBe(200);
    expect(preview.body).toMatchObject({ ok: true, ownerPreview: true });

    const share = await readEmulatorDocument(`publicNoteShares/${shareId}`);
    const policy = await readEmulatorDocument(`publicSharePolicies/${shareId}`);
    const sessions = await listEmulatorCollection("publicShareAccessSessions");
    const grants = await listEmulatorCollection("publicShareUnlockGrants");
    expect(share).not.toHaveProperty("consumedAt");
    expect(share).toMatchObject({ status: "active", successfulAccessCount: 0 });
    expect(policy).not.toHaveProperty("consumedAt");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ ownerPreview: true, oneTimeGrant: false });
    expect(grants).toHaveLength(0);
  });

  it("accounts ambiguous provider outcomes without treating them as successful sends", async () => {
    const concurrent = await runEmailDeliveryScenario(
      harness,
      "email_concurrent_409_share",
      () => new Response(
        JSON.stringify({ name: "concurrent_idempotent_requests" }),
        {
          headers: { "content-type": "application/json" },
          status: 409
        }
      )
    );
    expect(concurrent.response.status).toBe(202);
    expect(concurrent.providerCalls).toBe(2);
    expect(concurrent.deliveries).toHaveLength(1);
    expect(concurrent.deliveries[0]).toMatchObject({ status: "ambiguous" });
    expect(concurrent.challenges[0]).toMatchObject({
      deliveryStatus: "ambiguous",
      status: "ambiguous"
    });
    expect(concurrent.quotaBuckets).toHaveLength(4);
    expect(quotaBucketsWithUsage(concurrent.quotaBuckets)).toHaveLength(3);
    expect(quotaBucketsWithUsage(concurrent.quotaBuckets).every((bucket) =>
      bucket.ambiguousCount === 1
      && bucket.reservedCount === 0
      && bucket.sentCount === 0
    )).toBe(true);

    await clearSecureShareEmulators();
    const invalid = await runEmailDeliveryScenario(
      harness,
      "email_invalid_409_share",
      () => new Response(
        JSON.stringify({ name: "invalid_idempotent_request" }),
        {
          headers: { "content-type": "application/json" },
          status: 409
        }
      )
    );
    expect(invalid.response.status).toBe(202);
    expect(invalid.providerCalls).toBe(1);
    expect(invalid.deliveries).toHaveLength(1);
    expect(invalid.deliveries[0]).toMatchObject({ status: "failed" });
    expect(invalid.challenges[0]).toMatchObject({
      deliveryStatus: "failed",
      status: "send_failed"
    });
    expect(invalid.quotaBuckets).toHaveLength(4);
    expect(quotaBucketsWithUsage(invalid.quotaBuckets)).toHaveLength(3);
    expect(quotaBucketsWithUsage(invalid.quotaBuckets).every((bucket) =>
      bucket.failedCount === 1
      && bucket.reservedCount === 0
      && bucket.sentCount === 0
    )).toBe(true);

    await clearSecureShareEmulators();
    const malformedSuccess = await runEmailDeliveryScenario(
      harness,
      "email_malformed_success_share",
      () => new Response("{}", {
        headers: { "content-type": "application/json" },
        status: 200
      })
    );
    expect(malformedSuccess.response.status).toBe(202);
    expect(malformedSuccess.providerCalls).toBe(1);
    expect(malformedSuccess.deliveries[0]).toMatchObject({ status: "ambiguous" });
    expect(malformedSuccess.challenges[0]).toMatchObject({
      deliveryStatus: "ambiguous",
      status: "ambiguous"
    });
    expect(quotaBucketsWithUsage(malformedSuccess.quotaBuckets)).toHaveLength(3);
    expect(quotaBucketsWithUsage(malformedSuccess.quotaBuckets).every((bucket) =>
      bucket.ambiguousCount === 1
      && bucket.reservedCount === 0
      && bucket.sentCount === 0
    )).toBe(true);
  }, 30_000);

  it("sends at most once when the same client request is retried concurrently", async () => {
    const shareId = "email_client_request_replay_share";
    const email = "email-client-request-replay@example.test";
    const clientRequestId = "email_client_request_replay_0001";
    Object.assign(process.env, {
      SECURE_SHARE_EMAIL_ENABLED: "true",
      SHARE_EMAIL_PROVIDER: "resend",
      SHARE_EMAIL_API_KEY: "emulator-provider-key",
      SHARE_EMAIL_FROM: "sender@example.test",
      SHARE_EMAIL_SENDER_VERIFIED: "true"
    });
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailDigest(email)],
      emailVerificationRequired: true,
      oneTimeEnabled: false,
      shareId
    });

    const realFetch = globalThis.fetch.bind(globalThis);
    let providerCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        if (String(input) === "https://api.resend.com/emails") {
          providerCalls += 1;
          return new Response(JSON.stringify({
            id: "client_request_replay_message_0001"
          }), {
            headers: { "content-type": "application/json" },
            status: 200
          });
        }
        return realFetch(input, init);
      }
    );
    let results: Awaited<ReturnType<typeof emailChallengeRequest>>[];
    try {
      results = await Promise.all([
        emailChallengeRequest({
          clientRequestId,
          email,
          harness,
          networkSuffix: 79,
          shareId
        }),
        emailChallengeRequest({
          clientRequestId,
          email,
          harness,
          networkSuffix: 79,
          shareId
        })
      ]);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(results.every(({ response }) => response.status === 202)).toBe(true);
    expect(providerCalls).toBe(1);
    expect(await listEmulatorCollection("publicShareEmailChallenges")).toHaveLength(1);
    expect(await listEmulatorCollection("publicShareEmailDeliveries")).toHaveLength(1);
    expect(await listEmulatorCollection("publicShareEmailSendAttempts")).toEqual([
      expect.objectContaining({ state: "sent" })
    ]);
    const quotaBuckets = await listEmulatorCollection("publicShareEmailQuotaBuckets");
    expect(quotaBucketsWithUsage(quotaBuckets)).toHaveLength(3);
    expect(quotaBucketsWithUsage(quotaBuckets).every((bucket) =>
      bucket.reservedCount === 0
      && bucket.sentCount === 1
    )).toBe(true);
  }, 30_000);

  it("uses the Gmail adapter at runtime and records only redacted provider health", async () => {
    enableGmailSmtpEmail();
    const shareId = "gmail_smtp_health_success_share";
    const email = "gmail-smtp-health-success@example.test";
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailDigest(email)],
      emailVerificationRequired: true,
      oneTimeEnabled: false,
      shareId
    });

    const result = await emailChallengeRequest({
      email,
      harness,
      networkSuffix: 80,
      shareId
    });

    expect(result.response.status).toBe(202);
    expect(gmailTransportMock.createTransport).toHaveBeenCalledTimes(1);
    expect(gmailTransportMock.verify).not.toHaveBeenCalled();
    expect(gmailTransportMock.sendMail).toHaveBeenCalledTimes(1);
    expect(gmailTransportMock.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "QuickMemo 공유 노트 인증번호",
        to: email
      })
    );
    const health = await readEmulatorDocument(
      "publicShareEmailProviderHealth/gmail-smtp"
    );
    expect(health).toMatchObject({
      consecutiveFailures: 0,
      lastReasonCode: "",
      status: "healthy"
    });
    const serializedHealth = JSON.stringify(health);
    expect(serializedHealth).not.toContain(email);
    expect(serializedHealth).not.toContain("quickmemo.smtp.test@gmail.com");
    expect(serializedHealth).not.toContain("abcdefghijklmnop");
    expect(await listEmulatorCollection("publicShareEmailSendAttempts")).toEqual([
      expect.objectContaining({ state: "sent" })
    ]);
  }, 15_000);

  it("blocks Gmail after authentication failure without exposing or retrying it", async () => {
    enableGmailSmtpEmail();
    const firstShareId = "gmail_smtp_auth_failure_share";
    const secondShareId = "gmail_smtp_auth_blocked_share";
    const firstEmail = "gmail-smtp-auth-failure@example.test";
    const secondEmail = "gmail-smtp-auth-blocked@example.test";
    for (const [shareId, email] of [
      [firstShareId, firstEmail],
      [secondShareId, secondEmail]
    ]) {
      await seedSecureShare({
        accessMode: "allowed_emails",
        allowedEmailHashes: [emailDigest(email)],
        emailVerificationRequired: true,
        oneTimeEnabled: false,
        shareId
      });
    }
    gmailTransportMock.sendMail.mockRejectedValue(Object.assign(
      new Error("private SMTP authentication detail"),
      {
        code: "EAUTH",
        response: "535 private SMTP authentication detail",
        responseCode: 535
      }
    ));

    const first = await emailChallengeRequest({
      email: firstEmail,
      harness,
      networkSuffix: 81,
      shareId: firstShareId
    });
    const second = await emailChallengeRequest({
      email: secondEmail,
      harness,
      networkSuffix: 82,
      shareId: secondShareId
    });

    expect(first.response.status).toBe(202);
    expect(second.response.status).toBe(202);
    expect(gmailTransportMock.sendMail).toHaveBeenCalledTimes(1);
    expect(await readEmulatorDocument(
      "publicShareEmailProviderHealth/gmail-smtp"
    )).toMatchObject({
      consecutiveFailures: 1,
      lastReasonCode: "auth_error",
      status: "blocked"
    });
    expect(await listEmulatorCollection("publicShareEmailDeliveries")).toEqual([
      expect.objectContaining({ status: "failed" })
    ]);
    expect(await listEmulatorCollection("publicShareEmailSendAttempts")).toEqual([
      expect.objectContaining({ state: "failed" })
    ]);
    const challenges = await listEmulatorCollection("publicShareEmailChallenges");
    expect(challenges).toEqual(expect.arrayContaining([
      expect.objectContaining({ shareId: firstShareId, status: "send_failed" }),
      expect.objectContaining({ shareId: secondShareId, status: "suppressed" })
    ]));
    const serialized = JSON.stringify({
      challenges,
      health: await readEmulatorDocument(
        "publicShareEmailProviderHealth/gmail-smtp"
      )
    });
    expect(serialized).not.toContain(firstEmail);
    expect(serialized).not.toContain(secondEmail);
    expect(serialized).not.toContain("private SMTP authentication detail");
    expect(serialized).not.toContain("abcdefghijklmnop");
  }, 15_000);

  it("preserves an authentication hard block after a concurrent connection failure", async () => {
    enableGmailSmtpEmail();
    const scenarios = [
      {
        email: "gmail-smtp-concurrent-auth@example.test",
        shareId: "gmail_smtp_concurrent_auth_share"
      },
      {
        email: "gmail-smtp-concurrent-connection@example.test",
        shareId: "gmail_smtp_concurrent_connection_share"
      }
    ];
    for (const scenario of scenarios) {
      await seedSecureShare({
        accessMode: "allowed_emails",
        allowedEmailHashes: [emailDigest(scenario.email)],
        emailVerificationRequired: true,
        oneTimeEnabled: false,
        shareId: scenario.shareId
      });
    }

    const rejectors: Array<(reason?: unknown) => void> = [];
    gmailTransportMock.sendMail.mockImplementation(() =>
      new Promise((_, reject) => {
        rejectors.push(reject);
      })
    );
    const startedAt = Date.now();
    const pendingResults = Promise.all(scenarios.map((scenario, index) =>
      emailChallengeRequest({
        ...scenario,
        harness,
        networkSuffix: 83 + index
      })
    ));
    await vi.waitFor(() => {
      expect(gmailTransportMock.sendMail).toHaveBeenCalledTimes(2);
      expect(rejectors).toHaveLength(2);
    }, { timeout: 10_000 });

    rejectors[0](Object.assign(new Error("private auth detail"), {
      code: "EAUTH",
      responseCode: 535
    }));
    await vi.waitFor(async () => {
      expect(await readEmulatorDocument(
        "publicShareEmailProviderHealth/gmail-smtp"
      )).toMatchObject({
        lastReasonCode: "auth_error",
        status: "blocked"
      });
    }, { timeout: 10_000 });
    rejectors[1](Object.assign(new Error("private connection detail"), {
      code: "ECONNECTION"
    }));

    const results = await pendingResults;
    expect(results.every(({ response }) => response.status === 202)).toBe(true);
    const health = await readEmulatorDocument(
      "publicShareEmailProviderHealth/gmail-smtp"
    );
    expect(health).toMatchObject({
      consecutiveFailures: 2,
      lastReasonCode: "auth_error",
      status: "blocked"
    });
    expect(Date.parse(String(health?.blockedUntil))).toBeGreaterThan(
      startedAt + 23 * 60 * 60 * 1000
    );
    expect(gmailTransportMock.sendMail).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("never exceeds the global minute quota under twenty concurrent Gmail requests", async () => {
    enableGmailSmtpEmail();
    const scenarios = Array.from({ length: 20 }, (_, index) => ({
      email: `gmail-quota-${index}@example.test`,
      shareId: `gmail_global_quota_share_${String(index).padStart(2, "0")}`
    }));
    for (const scenario of scenarios) {
      await seedSecureShare({
        accessMode: "allowed_emails",
        allowedEmailHashes: [emailDigest(scenario.email)],
        emailVerificationRequired: true,
        oneTimeEnabled: false,
        shareId: scenario.shareId
      });
    }

    await waitForStableEmailQuotaMinute();
    const results = await Promise.all(scenarios.map((scenario, index) =>
      emailChallengeRequest({
        ...scenario,
        harness,
        networkSuffix: 100 + index
      })
    ));

    expect(gmailTransportMock.sendMail).toHaveBeenCalledTimes(3);
    expect(results.filter(({ response }) => response.status === 202)).toHaveLength(3);
    expect(results.filter(({ response }) => response.status === 429)).toHaveLength(17);
    expect(await listEmulatorCollection("publicShareEmailDeliveries")).toHaveLength(3);
    expect(await listEmulatorCollection("publicShareEmailSendAttempts")).toHaveLength(3);
    const quotaBuckets = await listEmulatorCollection("publicShareEmailQuotaBuckets");
    expect(quotaBucketsWithUsage(quotaBuckets)).toHaveLength(3);
    expect(quotaBucketsWithUsage(quotaBuckets).every((bucket) =>
      bucket.reservedCount === 0
      && bucket.sentCount === 3
    )).toBe(true);
  }, 60_000);

  it("does not refund the global minute quota after clear Gmail recipient failures", async () => {
    enableGmailSmtpEmail();
    gmailTransportMock.sendMail.mockRejectedValue(Object.assign(
      new Error("private invalid-recipient detail"),
      {
        code: "EENVELOPE",
        response: "550 5.1.1 invalid recipient",
        responseCode: 550
      }
    ));
    const scenarios = Array.from({ length: 20 }, (_, index) => ({
      email: `gmail-invalid-quota-${index}@example.test`,
      shareId: `gmail_invalid_global_quota_share_${String(index).padStart(2, "0")}`
    }));
    for (const scenario of scenarios) {
      await seedSecureShare({
        accessMode: "allowed_emails",
        allowedEmailHashes: [emailDigest(scenario.email)],
        emailVerificationRequired: true,
        oneTimeEnabled: false,
        shareId: scenario.shareId
      });
    }

    await waitForStableEmailQuotaMinute();
    const results = await Promise.all(scenarios.map((scenario, index) =>
      emailChallengeRequest({
        ...scenario,
        harness,
        networkSuffix: 130 + index
      })
    ));

    expect(gmailTransportMock.sendMail).toHaveBeenCalledTimes(3);
    expect(results.filter(({ response }) => response.status === 202)).toHaveLength(3);
    expect(results.filter(({ response }) => response.status === 429)).toHaveLength(17);
    const quotaBuckets = await listEmulatorCollection("publicShareEmailQuotaBuckets");
    expect(quotaBucketsWithUsage(quotaBuckets)).toHaveLength(3);
    expect(quotaBucketsWithUsage(quotaBuckets).every((bucket) =>
      bucket.failedCount === 3
      && bucket.reservedCount === 0
      && bucket.sentCount === 0
    )).toBe(true);
  }, 60_000);

  it("enforces the Share and Email rolling limit across hourly boundaries", async () => {
    enableGmailSmtpEmail();
    const shareId = "gmail_share_email_rolling_limit_share";
    const email = "gmail-share-email-rolling-limit@example.test";
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailDigest(email)],
      emailVerificationRequired: true,
      oneTimeEnabled: false,
      shareId
    });
    const currentHourStartSeconds =
      Math.floor(Date.now() / 1000 / (60 * 60)) * 60 * 60;
    const historicalHourStartSeconds = currentHourStartSeconds - 23 * 60 * 60;
    const bucketId = rateLimitBucketDigest(
      "otp_share_email_rolling_24h",
      [shareId, emailDigest(email), String(historicalHourStartSeconds)]
    );
    await writeEmulatorDocuments([{
      path: `publicShareRateLimits/${bucketId}`,
      fields: {
        count: 10,
        expiresAt: new Date((currentHourStartSeconds + 3 * 60 * 60) * 1000),
        limitType: "otp_share_email_rolling_24h",
        ownerUid: "",
        shareId,
        updatedAt: new Date(),
        windowStart: new Date(historicalHourStartSeconds * 1000)
      }
    }]);

    const result = await emailChallengeRequest({
      email,
      harness,
      networkSuffix: 151,
      shareId
    });
    expect(result.response.status).toBe(429);
    expect(gmailTransportMock.sendMail).not.toHaveBeenCalled();
  }, 30_000);

  it("enforces both the KST monthly and conservative rolling 24-hour hard stops", async () => {
    enableGmailSmtpEmail();
    const monthlyShareId = "gmail_monthly_hard_stop_share";
    const monthlyEmail = "gmail-monthly-hard-stop@example.test";
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailDigest(monthlyEmail)],
      emailVerificationRequired: true,
      oneTimeEnabled: false,
      shareId: monthlyShareId
    });
    const seoulMonth = new Date(Date.now() + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 7);
    await writeEmulatorDocuments([{
      path: `publicShareEmailQuotaBuckets/month_${seoulMonth}`,
      fields: {
        ambiguousCount: 0,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        failedCount: 0,
        hardLimit: 700,
        periodKey: seoulMonth,
        reservedCount: 0,
        scope: "monthly",
        sentCount: 700,
        softLimit: 500,
        softLimitReached: true,
        updatedAt: new Date()
      }
    }]);

    const monthly = await emailChallengeRequest({
      email: monthlyEmail,
      harness,
      networkSuffix: 120,
      shareId: monthlyShareId
    });
    expect(monthly.response.status).toBe(429);
    expect(gmailTransportMock.sendMail).not.toHaveBeenCalled();

    await clearSecureShareEmulators();
    const rollingShareId = "gmail_rolling_hard_stop_share";
    const rollingEmail = "gmail-rolling-hard-stop@example.test";
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailDigest(rollingEmail)],
      emailVerificationRequired: true,
      oneTimeEnabled: false,
      shareId: rollingShareId
    });
    const hourStart = new Date();
    hourStart.setUTCMinutes(0, 0, 0);
    await writeEmulatorDocuments([1, 2].map((hoursAgo) => {
      const start = new Date(hourStart.getTime() - hoursAgo * 60 * 60 * 1000);
      const periodKey = start.toISOString().slice(0, 13);
      return {
        path: `publicShareEmailQuotaBuckets/hour_${periodKey}`,
        fields: {
          ambiguousCount: 0,
          expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
          failedCount: 0,
          hardLimit: 20,
          periodKey,
          reservedCount: 0,
          scope: "hourly",
          sentCount: 15,
          softLimit: 20,
          softLimitReached: false,
          updatedAt: new Date()
        }
      };
    }));

    const rolling = await emailChallengeRequest({
      email: rollingEmail,
      harness,
      networkSuffix: 121,
      shareId: rollingShareId
    });
    expect(rolling.response.status).toBe(429);
    expect(gmailTransportMock.sendMail).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps quota reserved when an accepted delivery cannot be finalized", async () => {
    const shareId = "email_finalize_failure_share";
    const email = "email-finalize-failure@example.test";
    Object.assign(process.env, {
      SECURE_SHARE_EMAIL_ENABLED: "true",
      SHARE_EMAIL_PROVIDER: "resend",
      SHARE_EMAIL_API_KEY: "emulator-provider-key",
      SHARE_EMAIL_FROM: "sender@example.test",
      SHARE_EMAIL_SENDER_VERIFIED: "true"
    });
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailDigest(email)],
      emailVerificationRequired: true,
      oneTimeEnabled: false,
      shareId
    });

    const realFetch = globalThis.fetch.bind(globalThis);
    let providerAccepted = false;
    let finalizationRejected = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.resend.com/emails") {
          providerAccepted = true;
          return new Response(JSON.stringify({ id: "accepted_message_123456" }), {
            headers: { "content-type": "application/json" },
            status: 200
          });
        }
        if (
          providerAccepted
          && url.endsWith("/documents:commit")
          && String(init?.body).includes("providerMessageIdHash")
          && String(init?.body).includes('"sent"')
        ) {
          finalizationRejected = true;
          return new Response(JSON.stringify({
            error: { code: 503, message: "synthetic finalization outage" }
          }), {
            headers: { "content-type": "application/json" },
            status: 503
          });
        }
        return realFetch(input, init);
      }
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let result: Awaited<ReturnType<typeof emailChallengeRequest>>;
    try {
      result = await emailChallengeRequest({
        email,
        harness,
        networkSuffix: 74,
        shareId
      });
    } finally {
      fetchSpy.mockRestore();
      consoleError.mockRestore();
    }
    expect(result.response.status).toBe(202);
    expect(providerAccepted).toBe(true);
    expect(finalizationRejected).toBe(true);
    const deliveries = await listEmulatorCollection("publicShareEmailDeliveries");
    const challenges = await listEmulatorCollection("publicShareEmailChallenges");
    const quotaBuckets = await listEmulatorCollection("publicShareEmailQuotaBuckets");
    expect(deliveries[0]).toMatchObject({ status: "reserved" });
    expect(challenges[0]).toMatchObject({
      deliveryStatus: "reserved",
      status: "pending"
    });
    expect(quotaBucketsWithUsage(quotaBuckets)).toHaveLength(3);
    expect(quotaBucketsWithUsage(quotaBuckets).every((bucket) =>
      bucket.reservedCount === 1 && bucket.sentCount === 0
    )).toBe(true);
  }, 15_000);

  it("allows at most two real provider attempts in one distributed second", async () => {
    Object.assign(process.env, {
      SECURE_SHARE_EMAIL_ENABLED: "true",
      SHARE_EMAIL_PROVIDER: "resend",
      SHARE_EMAIL_API_KEY: "emulator-provider-key",
      SHARE_EMAIL_FROM: "sender@example.test",
      SHARE_EMAIL_SENDER_VERIFIED: "true"
    });
    const scenarios = Array.from({ length: 3 }, (_, index) => ({
      email: `global-rate-${index}@example.test`,
      shareId: `email_global_rate_share_${index}`
    }));
    for (const scenario of scenarios) {
      await seedSecureShare({
        accessMode: "allowed_emails",
        allowedEmailHashes: [emailDigest(scenario.email)],
        emailVerificationRequired: true,
        oneTimeEnabled: false,
        shareId: scenario.shareId
      });
    }

    const fixedNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const realFetch = globalThis.fetch.bind(globalThis);
    let providerCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        if (String(input) === "https://api.resend.com/emails") {
          providerCalls += 1;
          return new Response(
            JSON.stringify({ id: `global_rate_message_${providerCalls}` }),
            {
              headers: { "content-type": "application/json" },
              status: 200
            }
          );
        }
        return realFetch(input, init);
      }
    );
    let results: Awaited<ReturnType<typeof emailChallengeRequest>>[];
    try {
      results = await Promise.all(scenarios.map((scenario, index) =>
        emailChallengeRequest({
          ...scenario,
          harness,
          networkSuffix: 75 + index
        })
      ));
    } finally {
      fetchSpy.mockRestore();
      clock.mockRestore();
    }
    expect(results.every(({ response }) => response.status === 202)).toBe(true);
    expect(providerCalls).toBe(2);
    const deliveries = await listEmulatorCollection("publicShareEmailDeliveries");
    expect(deliveries.filter((delivery) => delivery.status === "sent")).toHaveLength(2);
    expect(deliveries.filter((delivery) => delivery.status === "failed")).toHaveLength(1);
    const quotaBuckets = await listEmulatorCollection("publicShareEmailQuotaBuckets");
    expect(quotaBucketsWithUsage(quotaBuckets)).toHaveLength(3);
    expect(quotaBucketsWithUsage(quotaBuckets).every((bucket) =>
      bucket.reservedCount === 0 && bucket.sentCount === 2
    )).toBe(true);
  }, 15_000);

  it("does not consume on a wrong password or OTP and keeps failure responses secret-free", async () => {
    const passwordShareId = "wrong_password_share";
    const passwordRecord = await hashSharePassword("correct-password-for-test");
    const passwordSeed = await seedSecureShare({
      passwordEnabled: true,
      passwordHashRecord: passwordRecord as unknown as Record<string, unknown>,
      shareId: passwordShareId
    });
    const passwordMetadata = await metadataBinding(harness.origin, passwordShareId, {
      networkSuffix: 70
    });
    const wrongPassword = await accessRequest({
      bindingCookie: passwordMetadata.bindingCookie,
      body: {
        oneTimeOpenConfirmed: true,
        password: "wrong-password-for-test",
        unlockAttemptId: "wrong_password_attempt_0001"
      },
      harness,
      networkSuffix: 70,
      shareId: passwordShareId
    });
    expect(wrongPassword.response.status).toBe(403);
    expect(wrongPassword.body).toMatchObject({ ok: false, error: "access_denied" });
    expectSecretFreeFailure(wrongPassword.body, [
      passwordSeed.cipherSentinel,
      "wrong-password-for-test",
      "correct-password-for-test"
    ]);

    const otpShareId = "wrong_otp_share";
    Object.assign(process.env, {
      SECURE_SHARE_EMAIL_ENABLED: "true",
      SHARE_EMAIL_PROVIDER: "resend",
      SHARE_EMAIL_API_KEY: "emulator-provider-key",
      SHARE_EMAIL_FROM: "sender@example.test",
      SHARE_EMAIL_SENDER_VERIFIED: "true"
    });
    const challengeId = "challenge_wrong_otp_0001";
    const normalizedEmailHash = emailDigest("viewer@example.test");
    const correctOtp = "135790";
    const otpSeed = await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [normalizedEmailHash],
      challenge: {
        codeDigest: otpCodeDigest(
          challengeId,
          otpShareId,
          normalizedEmailHash,
          correctOtp
        ),
        emailHash: normalizedEmailHash,
        id: challengeId
      },
      emailVerificationRequired: true,
      shareId: otpShareId
    });
    const otpMetadata = await metadataBinding(harness.origin, otpShareId, {
      networkSuffix: 71
    });
    const wrongOtp = await accessRequest({
      bindingCookie: otpMetadata.bindingCookie,
      body: {
        challengeId,
        displayName: "OTP viewer",
        oneTimeOpenConfirmed: true,
        otp: "246801",
        unlockAttemptId: "wrong_otp_attempt_0000001"
      },
      harness,
      networkSuffix: 71,
      shareId: otpShareId
    });
    expect(wrongOtp.response.status).toBe(403);
    expect(wrongOtp.body).toMatchObject({ ok: false, error: "access_denied" });
    expectSecretFreeFailure(wrongOtp.body, [
      otpSeed.cipherSentinel,
      correctOtp,
      "246801",
      normalizedEmailHash
    ]);

    for (const shareId of [passwordShareId, otpShareId]) {
      expect(await readEmulatorDocument(`publicNoteShares/${shareId}`)).toMatchObject({
        status: "active",
        successfulAccessCount: 0
      });
      expect(await readEmulatorDocument(`publicNoteShares/${shareId}`)).not.toHaveProperty(
        "consumedAt"
      );
      expect(await readEmulatorDocument(`publicSharePolicies/${shareId}`)).not.toHaveProperty(
        "consumedAt"
      );
    }
    expect(await listEmulatorCollection("publicShareAccessSessions")).toHaveLength(0);
    expect(await listEmulatorCollection("publicShareUnlockGrants")).toHaveLength(0);
    expect(await readEmulatorDocument(`publicShareEmailChallenges/${challengeId}`)).toMatchObject({
      attempts: 1,
      status: "pending"
    });
  }, 15_000);

  it("recovers the same bound OTP attempt without duplicating its participant", async () => {
    Object.assign(process.env, {
      SECURE_SHARE_EMAIL_ENABLED: "true",
      SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED: "true",
      SHARE_EMAIL_API_KEY: "emulator-provider-key",
      SHARE_EMAIL_FROM: "sender@example.test",
      SHARE_EMAIL_PROVIDER: "resend",
      SHARE_EMAIL_SENDER_VERIFIED: "true"
    });
    const shareId = "otp_same_attempt_recovery";
    const challengeId = "otp_same_attempt_challenge";
    const emailHash = emailDigest("otp-recovery@example.test");
    const otp = "135790";
    const unlockAttemptId = "otp_recovery_attempt_0001";
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailHash],
      challenge: {
        codeDigest: otpCodeDigest(challengeId, shareId, emailHash, otp),
        emailHash,
        id: challengeId
      },
      emailVerificationRequired: true,
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId
    });
    const metadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 72
    });
    const body = {
      challengeId,
      displayName: "OTP recovery viewer",
      otp,
      unlockAttemptId
    };

    const first = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body,
      harness,
      networkSuffix: 72,
      shareId
    });
    expect(first.response.status).toBe(200);
    const firstSessionCookie = responseCookie(first.response, "qmss_");
    const consumedChallenge = await readEmulatorDocument(
      `publicShareEmailChallenges/${challengeId}`
    );
    expect(consumedChallenge).toMatchObject({
      status: "consumed"
    });

    const recovered = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body,
      harness,
      networkSuffix: 72,
      shareId
    });
    expect(recovered.response.status).toBe(200);
    expect(responseCookie(recovered.response, "qmss_")).toBe(firstSessionCookie);
    expect(recovered.body.csrfToken).toBe(first.body.csrfToken);
    expect(await readEmulatorDocument(
      `publicShareEmailChallenges/${challengeId}`
    )).toMatchObject({
      __updateTime: consumedChallenge?.__updateTime,
      consumedAttemptHash: consumedChallenge?.consumedAttemptHash,
      status: "consumed"
    });
    expect(await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    )).toHaveLength(1);
    expect(await listEmulatorCollection("publicShareAccessSessions")).toHaveLength(1);
    expect(await readEmulatorDocument(`publicNoteShares/${shareId}`)).toMatchObject({
      successfulAccessCount: 1
    });
    expect((await listEmulatorCollection(
      `publicShareAuditEvents/${shareId}/items`
    )).filter((event) => event.eventType === "viewer_access")).toHaveLength(1);

    const refreshed = await refreshParticipantSession({
      harness,
      session: {
        bindingCookie: metadata.bindingCookie,
        csrfToken: String(first.body.csrfToken),
        sessionCookie: firstSessionCookie
      },
      shareId
    });
    expect(refreshed.response.status).toBe(200);
    const reusedAfterCsrfRotation = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body,
      harness,
      networkSuffix: 72,
      shareId
    });
    expect(reusedAfterCsrfRotation.response.status).toBe(409);
    expect(reusedAfterCsrfRotation.body).toMatchObject({
      error: "access_denied",
      ok: false
    });

    const differentAttempt = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        ...body,
        unlockAttemptId: "otp_recovery_attempt_0002"
      },
      harness,
      networkSuffix: 72,
      shareId
    });
    expect(differentAttempt.response.status).toBe(409);
    expect(differentAttempt.body).toMatchObject({
      error: "access_denied",
      ok: false
    });
    expect(await listEmulatorCollection("publicShareAccessSessions")).toHaveLength(1);

    const reissuedOtp = "246801";
    const reissuedSendAttemptId = "send_otp_recovery_reissued_0002";
    await writeEmulatorDocuments([
      {
        path: `publicShareEmailChallenges/${challengeId}`,
        fields: {
          attempts: 0,
          codeDigest: otpCodeDigest(
            challengeId,
            shareId,
            emailHash,
            reissuedOtp
          ),
          createdAt: new Date(),
          emailHash,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          ownerUid: "owner_user",
          policyVersion: 1,
          sendAttemptId: reissuedSendAttemptId,
          shareId,
          status: "pending",
          updatedAt: new Date()
        }
      }
    ]);
    const reissued = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        ...body,
        otp: reissuedOtp
      },
      harness,
      networkSuffix: 72,
      shareId
    });
    expect(reissued.response.status).toBe(200);
    expect(responseCookie(reissued.response, "qmss_")).not.toBe(firstSessionCookie);
    expect(reissued.body.csrfToken).not.toBe(first.body.csrfToken);
    expect(await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    )).toHaveLength(1);
    expect(await listEmulatorCollection("publicShareAccessSessions")).toHaveLength(2);
    expect(await readEmulatorDocument(`publicNoteShares/${shareId}`)).toMatchObject({
      successfulAccessCount: 2
    });
    expect((await listEmulatorCollection(
      `publicShareAuditEvents/${shareId}/items`
    )).filter((event) => event.eventType === "viewer_access")).toHaveLength(2);
  }, 30_000);

  it("preserves a consumed one-time OTP issuance when another email request arrives", async () => {
    Object.assign(process.env, {
      SECURE_SHARE_EMAIL_ENABLED: "true",
      SHARE_EMAIL_API_KEY: "emulator-provider-key",
      SHARE_EMAIL_FROM: "sender@example.test",
      SHARE_EMAIL_PROVIDER: "resend",
      SHARE_EMAIL_SENDER_VERIFIED: "true"
    });
    const shareId = "otp_consumed_issuance_preserved";
    const email = "otp-consumed-preserved@example.test";
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailDigest(email)],
      emailVerificationRequired: true,
      oneTimeEnabled: true,
      shareId
    });

    const realFetch = globalThis.fetch.bind(globalThis);
    let issuedOtp = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        if (String(input) === "https://api.resend.com/emails") {
          const payload = JSON.parse(String(init?.body)) as { text?: string };
          issuedOtp = /인증번호:\s*(\d{6})/u.exec(payload.text ?? "")?.[1] ?? "";
          return new Response(JSON.stringify({ id: "one_time_message_0001" }), {
            headers: { "content-type": "application/json" },
            status: 200
          });
        }
        return realFetch(input, init);
      }
    );
    let challengeResponse: Awaited<ReturnType<typeof emailChallengeRequest>>;
    try {
      challengeResponse = await emailChallengeRequest({
        email,
        harness,
        networkSuffix: 79,
        shareId
      });
    } finally {
      fetchSpy.mockRestore();
    }
    expect(challengeResponse.response.status).toBe(202);
    expect(issuedOtp).toMatch(/^\d{6}$/u);
    const challengeId = String(challengeResponse.body.challengeId);
    const metadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 80
    });
    const body = {
      challengeId,
      oneTimeOpenConfirmed: true,
      otp: issuedOtp,
      unlockAttemptId: "otp_consumed_preserved_attempt_0001"
    };
    const first = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body,
      harness,
      networkSuffix: 80,
      shareId
    });
    expect(first.response.status).toBe(200);
    const firstSessionCookie = responseCookie(first.response, "qmss_");

    await patchEmulatorDocuments([
      {
        path: `publicShareEmailChallenges/${challengeId}`,
        fields: {
          resendNotBefore: new Date(Date.now() - 1_000)
        }
      }
    ]);
    const protectedChallenge = await readEmulatorDocument(
      `publicShareEmailChallenges/${challengeId}`
    );
    expect(protectedChallenge).toMatchObject({
      status: "consumed"
    });
    const suppressedRetry = await emailChallengeRequest({
      email,
      harness,
      networkSuffix: 81,
      shareId
    });
    expect(suppressedRetry.response.status).toBe(202);
    expect(await readEmulatorDocument(
      `publicShareEmailChallenges/${challengeId}`
    )).toMatchObject({
      __updateTime: protectedChallenge?.__updateTime,
      consumedAttemptHash: protectedChallenge?.consumedAttemptHash,
      sendAttemptId: protectedChallenge?.sendAttemptId,
      status: "consumed"
    });

    const recovered = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body,
      harness,
      networkSuffix: 80,
      shareId
    });
    expect(recovered.response.status).toBe(200);
    expect(responseCookie(recovered.response, "qmss_")).toBe(firstSessionCookie);
    expect(recovered.body.csrfToken).toBe(first.body.csrfToken);
    expect(await listEmulatorCollection("publicShareAccessSessions")).toHaveLength(1);
    expect(await readEmulatorDocument(`publicNoteShares/${shareId}`)).toMatchObject({
      successfulAccessCount: 1
    });
  }, 30_000);

  it("does not reopen an OTP challenge consumed while its provider result is pending", async () => {
    Object.assign(process.env, {
      SECURE_SHARE_EMAIL_ENABLED: "true",
      SHARE_EMAIL_API_KEY: "emulator-provider-key",
      SHARE_EMAIL_FROM: "sender@example.test",
      SHARE_EMAIL_PROVIDER: "resend",
      SHARE_EMAIL_SENDER_VERIFIED: "true"
    });
    const shareId = "otp_provider_finalize_consumed_race";
    const email = "otp-finalize-race@example.test";
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailDigest(email)],
      emailVerificationRequired: true,
      oneTimeEnabled: false,
      shareId
    });

    const realFetch = globalThis.fetch.bind(globalThis);
    let issuedOtp = "";
    let signalProviderStarted: () => void = () => undefined;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    let resolveProvider: (response: Response) => void = () => undefined;
    const providerResult = new Promise<Response>((resolve) => {
      resolveProvider = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        if (String(input) === "https://api.resend.com/emails") {
          const payload = JSON.parse(String(init?.body)) as { text?: string };
          issuedOtp = /인증번호:\s*(\d{6})/u.exec(payload.text ?? "")?.[1] ?? "";
          signalProviderStarted();
          return providerResult;
        }
        return realFetch(input, init);
      }
    );
    const pendingChallenge = emailChallengeRequest({
      email,
      harness,
      networkSuffix: 82,
      shareId
    });
    try {
      await providerStarted;
      expect(issuedOtp).toMatch(/^\d{6}$/u);
      const challenge = (await listEmulatorCollection(
        "publicShareEmailChallenges"
      ))[0];
      expect(challenge).toMatchObject({
        deliveryStatus: "reserved",
        status: "pending"
      });
      const metadata = await metadataBinding(harness.origin, shareId, {
        networkSuffix: 83
      });
      const access = await accessRequest({
        bindingCookie: metadata.bindingCookie,
        body: {
          challengeId: challenge.__id,
          otp: issuedOtp,
          unlockAttemptId: "otp_finalize_race_attempt_0001"
        },
        harness,
        networkSuffix: 83,
        shareId
      });
      expect(access.response.status).toBe(200);
      expect(await readEmulatorDocument(
        `publicShareEmailChallenges/${challenge.__id}`
      )).toMatchObject({
        status: "consumed"
      });

      resolveProvider(new Response(JSON.stringify({
        id: "finalize_race_message_0001"
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      }));
      const challengeResponse = await pendingChallenge;
      expect(challengeResponse.response.status).toBe(202);
      expect(await readEmulatorDocument(
        `publicShareEmailChallenges/${challenge.__id}`
      )).toMatchObject({
        consumedAttemptHash: expect.any(String),
        deliveryStatus: "reserved",
        status: "consumed"
      });
      expect((await listEmulatorCollection(
        "publicShareEmailDeliveries"
      ))[0]).toMatchObject({
        status: "sent"
      });
      const quotaBuckets = await listEmulatorCollection(
        "publicShareEmailQuotaBuckets"
      );
      expect(quotaBucketsWithUsage(quotaBuckets)).toHaveLength(3);
      expect(quotaBucketsWithUsage(quotaBuckets).every((bucket) => (
        bucket.reservedCount === 0
        && bucket.sentCount === 1
      ))).toBe(true);
    } finally {
      resolveProvider(new Response("{}", { status: 503 }));
      fetchSpy.mockRestore();
    }
  }, 30_000);

  it("keeps a signed-in caller on one QuickMemo participant after required OTPs", async () => {
    Object.assign(process.env, {
      SECURE_SHARE_EMAIL_ENABLED: "true",
      SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED: "true",
      SHARE_EMAIL_API_KEY: "emulator-provider-key",
      SHARE_EMAIL_FROM: "sender@example.test",
      SHARE_EMAIL_PROVIDER: "resend",
      SHARE_EMAIL_SENDER_VERIFIED: "true"
    });
    const caller = await createEmulatorOwner(
      "signed-in-otp-caller@example.test",
      "emulator-owner-password"
    );
    await writeEmulatorDocuments([
      {
        path: `users/${caller.localId}`,
        fields: {
          displayName: "Signed-in OTP caller",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: false,
          uid: caller.localId
        }
      }
    ]);
    const shareId = "signed_in_caller_otp_identity";
    const emailHash = emailDigest("allowed-otp@example.test");
    const firstChallengeId = "signed_in_otp_challenge_0001";
    const secondChallengeId = "signed_in_otp_challenge_0002";
    const firstOtp = "135790";
    const secondOtp = "246801";
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailHash],
      challenge: {
        codeDigest: otpCodeDigest(
          firstChallengeId,
          shareId,
          emailHash,
          firstOtp
        ),
        emailHash,
        id: firstChallengeId
      },
      emailVerificationRequired: true,
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId
    });
    await writeEmulatorDocuments([
      {
        path: `publicShareEmailChallenges/${secondChallengeId}`,
        fields: {
          attempts: 0,
          codeDigest: otpCodeDigest(
            secondChallengeId,
            shareId,
            emailHash,
            secondOtp
          ),
          createdAt: new Date(Date.now() - 5_000),
          emailHash,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          ownerUid: "owner_user",
          policyVersion: 1,
          sendAttemptId: "send_signed_in_otp_challenge_0002",
          shareId,
          status: "pending",
          updatedAt: new Date(Date.now() - 5_000)
        }
      }
    ]);

    const attempts = [
      {
        challengeId: firstChallengeId,
        networkSuffix: 73,
        otp: firstOtp,
        unlockAttemptId: "signed_in_otp_access_0001"
      },
      {
        challengeId: secondChallengeId,
        networkSuffix: 74,
        otp: secondOtp,
        unlockAttemptId: "signed_in_otp_access_0002"
      }
    ];
    const accesses = [];
    for (const attempt of attempts) {
      const metadata = await metadataBinding(harness.origin, shareId, {
        networkSuffix: attempt.networkSuffix
      });
      accesses.push(await accessRequest({
        authorization: caller.idToken,
        bindingCookie: metadata.bindingCookie,
        body: {
          challengeId: attempt.challengeId,
          displayName: "Untrusted email label",
          otp: attempt.otp,
          unlockAttemptId: attempt.unlockAttemptId
        },
        harness,
        networkSuffix: attempt.networkSuffix,
        shareId
      }));
    }

    expect(accesses.every(({ response }) => response.status === 200)).toBe(true);
    expect(accesses.every(({ body }) => (
      (body.capabilities as Record<string, unknown>).participantIdentityEnabled === true
      && (body.capabilities as Record<string, unknown>).participantLimitReached === false
    ))).toBe(true);
    expect(accesses.every(({ response }) =>
      cookiePairs(response).every((cookie) => !cookie.includes("qmsp_"))
    )).toBe(true);
    const participants = await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    );
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({
      identityType: "quickmemo_user",
      status: "active"
    });
    const sessions = await listEmulatorCollection("publicShareAccessSessions");
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) =>
      session.authorUid === caller.localId
      && session.identityType === "quickmemo_user"
      && session.participantId === participants[0].participantId
    )).toBe(true);
    expect(await readEmulatorDocument(
      `publicShareEmailChallenges/${firstChallengeId}`
    )).toMatchObject({ status: "consumed" });
    expect(await readEmulatorDocument(
      `publicShareEmailChallenges/${secondChallengeId}`
    )).toMatchObject({ status: "consumed" });
  }, 30_000);

  it("fails closed for an existing email policy and session after email is disabled", async () => {
    Object.assign(process.env, {
      SECURE_SHARE_EMAIL_ENABLED: "true",
      SHARE_EMAIL_PROVIDER: "resend",
      SHARE_EMAIL_API_KEY: "emulator-provider-key",
      SHARE_EMAIL_FROM: "sender@example.test",
      SHARE_EMAIL_SENDER_VERIFIED: "true"
    });
    const shareId = "email_disabled_existing_share";
    const challengeId = "email_disabled_challenge_0001";
    const emailHash = emailDigest("viewer@example.test");
    const otp = "135790";
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailHash],
      challenge: {
        codeDigest: otpCodeDigest(challengeId, shareId, emailHash, otp),
        emailHash,
        id: challengeId
      },
      emailVerificationRequired: true,
      shareId
    });
    const metadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 72
    });
    const granted = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        challengeId,
        displayName: "OTP viewer",
        oneTimeOpenConfirmed: true,
        otp,
        unlockAttemptId: "email_enabled_attempt_0001"
      },
      harness,
      networkSuffix: 72,
      shareId
    });
    expect(granted.response.status).toBe(200);
    const sessionCookie = cookiePair(granted.response);

    process.env.SECURE_SHARE_EMAIL_ENABLED = "false";

    const blockedMetadata = await fetch(
      `${harness.origin}/api/public-shares-v2?action=metadata&shareId=${encodeURIComponent(shareId)}`,
      { headers: apiHeaders(harness.origin, { networkSuffix: 72 }) }
    );
    expect(blockedMetadata.status).toBe(503);
    expect(await blockedMetadata.json()).toMatchObject({
      ok: false,
      error: "email_feature_unavailable"
    });

    const blockedAccess = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        challengeId,
        displayName: "OTP viewer",
        oneTimeOpenConfirmed: true,
        otp,
        unlockAttemptId: "email_disabled_attempt_0001"
      },
      harness,
      networkSuffix: 72,
      shareId
    });
    expect(blockedAccess.response.status).toBe(503);
    expect(blockedAccess.body).toMatchObject({
      ok: false,
      error: "email_feature_unavailable"
    });

    const blockedSession = await fetch(
      `${harness.origin}/api/public-shares-v2?action=session&shareId=${encodeURIComponent(shareId)}`,
      {
        headers: apiHeaders(harness.origin, {
          bindingCookie: `${metadata.bindingCookie}; ${sessionCookie}`,
          networkSuffix: 72
        })
      }
    );
    expect(blockedSession.status).toBe(503);
    expect(await blockedSession.json()).toMatchObject({
      ok: false,
      error: "email_feature_unavailable"
    });
  }, 15_000);

  it("atomically grants exactly one of 20 parallel identities and preserves same-attempt grace", async () => {
    const shareId = "parallel_one_time_share";
    const seed = await seedSecureShare({ shareId });
    const guardId = sourceShareGuardId(seed.ownerUid, seed.noteId);
    await writeEmulatorDocuments([
      {
        path: `publicShareSourceGuards/${guardId}`,
        fields: {
          schemaVersion: 1,
          ownerUid: seed.ownerUid,
          sourceNoteId: seed.noteId,
          shareId,
          createdAt: new Date(Date.now() - 60_000),
          updatedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000)
        }
      }
    ]);
    const candidates = await Promise.all(
      Array.from({ length: 20 }, (_, index) => (
        metadataBinding(harness.origin, shareId, { networkSuffix: index + 10 })
      ))
    );
    expect(await readEmulatorDocument(`publicNoteShares/${shareId}`)).not.toHaveProperty(
      "consumedAt"
    );

    const attempts = candidates.map((candidate, index) => ({
      bindingCookie: candidate.bindingCookie,
      networkSuffix: index + 10,
      unlockAttemptId: `parallel_attempt_${String(index).padStart(4, "0")}_secure`
    }));
    const results = await Promise.all(
      attempts.map((attempt) => accessRequest({
        bindingCookie: attempt.bindingCookie,
        body: {
          displayName: `Parallel viewer ${attempt.networkSuffix}`,
          oneTimeOpenConfirmed: true,
          unlockAttemptId: attempt.unlockAttemptId
        },
        harness,
        networkSuffix: attempt.networkSuffix,
        shareId
      }))
    );

    const successes = results
      .map((result, index) => ({ ...result, index }))
      .filter(({ response }) => response.status === 200);
    const failures = results.filter(({ response }) => response.status !== 200);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(19);
    expect(failures.every(({ response }) => response.status === 409)).toBe(true);
    for (const failure of failures) {
      expect(failure.body).toMatchObject({ ok: false, error: "share_unavailable" });
      expectSecretFreeFailure(failure.body, [seed.cipherSentinel]);
    }

    const winner = successes[0];
    const winnerCookie = cookiePair(winner.response);
    const winnerToken = sessionTokenFromCookie(winnerCookie);
    expect(winner.body).not.toHaveProperty("sessionToken");
    expect(JSON.stringify(winner.body)).not.toContain(winnerToken);

    const shareAfterParallel = await readEmulatorDocument(`publicNoteShares/${shareId}`);
    const policyAfterParallel = await readEmulatorDocument(`publicSharePolicies/${shareId}`);
    const sessionsAfterParallel = await listEmulatorCollection("publicShareAccessSessions");
    const grantsAfterParallel = await listEmulatorCollection("publicShareUnlockGrants");
    const auditsAfterParallel = await listEmulatorCollection(
      `publicShareAuditEvents/${shareId}/items`
    );
    expect(shareAfterParallel).toMatchObject({
      status: "consumed",
      successfulAccessCount: 1
    });
    expect(await readEmulatorDocument(`publicShareSourceGuards/${guardId}`)).toBeNull();
    expect(shareAfterParallel?.consumedAt).toEqual(policyAfterParallel?.consumedAt);
    expect(typeof shareAfterParallel?.consumedAt).toBe("string");
    expect(sessionsAfterParallel).toHaveLength(1);
    expect(sessionsAfterParallel[0]).toMatchObject({
      oneTimeGrant: true,
      ownerPreview: false
    });
    expect(sessionsAfterParallel[0].__id).toBe(sessionTokenDigest(winnerToken));
    expect(grantsAfterParallel).toHaveLength(1);
    expect(grantsAfterParallel[0].activeSessionDigest).toBe(sessionsAfterParallel[0].__id);
    expect(auditsAfterParallel).toHaveLength(1);
    expect(auditsAfterParallel[0]).toMatchObject({
      eventType: "viewer_access",
      result: "success"
    });

    const winningAttempt = attempts[winner.index];
    const graceRetry = await accessRequest({
      bindingCookie: winningAttempt.bindingCookie,
      body: {
        displayName: `Parallel viewer ${winningAttempt.networkSuffix}`,
        oneTimeOpenConfirmed: true,
        unlockAttemptId: winningAttempt.unlockAttemptId
      },
      harness,
      networkSuffix: winningAttempt.networkSuffix,
      shareId
    });
    expect(graceRetry.response.status).toBe(200);
    const replacementToken = sessionTokenFromCookie(cookiePair(graceRetry.response));
    const sessionsAfterGrace = await listEmulatorCollection("publicShareAccessSessions");
    const activeSessions = sessionsAfterGrace.filter((session) => !session.revokedAt);
    const revokedSessions = sessionsAfterGrace.filter((session) => Boolean(session.revokedAt));
    const grantsAfterGrace = await listEmulatorCollection("publicShareUnlockGrants");
    expect(sessionsAfterGrace).toHaveLength(2);
    expect(activeSessions).toHaveLength(1);
    expect(revokedSessions).toHaveLength(1);
    expect(activeSessions[0].__id).toBe(sessionTokenDigest(replacementToken));
    expect(grantsAfterGrace).toHaveLength(1);
    expect(grantsAfterGrace[0].activeSessionDigest).toBe(activeSessions[0].__id);
    expect(await readEmulatorDocument(`publicNoteShares/${shareId}`)).toMatchObject({
      consumedAt: shareAfterParallel?.consumedAt,
      successfulAccessCount: 1
    });

    const losingIndex = attempts.findIndex((_, index) => index !== winner.index);
    const differentIdentity = await accessRequest({
      bindingCookie: attempts[losingIndex].bindingCookie,
      body: {
        displayName: "Different identity",
        oneTimeOpenConfirmed: true,
        unlockAttemptId: attempts[losingIndex].unlockAttemptId
      },
      harness,
      networkSuffix: attempts[losingIndex].networkSuffix,
      shareId
    });
    expect(differentIdentity.response.status).toBe(409);
    expect(differentIdentity.body).toMatchObject({
      ok: false,
      error: "share_unavailable"
    });
    expectSecretFreeFailure(differentIdentity.body, [seed.cipherSentinel, replacementToken]);
    expect(await listEmulatorCollection("publicShareAccessSessions")).toHaveLength(2);
  }, 30_000);

  it("keeps feature status on the exact backward-compatible two-boolean contract", async () => {
    enableParticipantFeatures();

    const response = await fetch(
      `${harness.origin}/api/public-shares-v2?action=feature-status`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      emailEnabled: false,
      v2Enabled: true
    });
  });

  it("fails a colliding participant HMAC key closed without exposing it", async () => {
    const shareId = "participant_secret_collision";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId
    });
    const metadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 17
    });
    const collidedSecret = String(process.env.SHARE_SESSION_HMAC_KEY);
    process.env.SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED = "true";
    process.env.SHARE_PARTICIPANT_HMAC_KEY = collidedSecret;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const blocked = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        displayName: "Collision viewer",
        unlockAttemptId: "participant_collision_access_0001"
      },
      harness,
      networkSuffix: 17,
      shareId
    });
    expect(blocked.response.status).toBe(503);
    expect(blocked.body).toMatchObject({
      error: "request_failed",
      ok: false
    });
    expect(JSON.stringify({
      body: blocked.body,
      logs: errorSpy.mock.calls
    })).not.toContain(collidedSecret);
    errorSpy.mockRestore();
    expect(await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    )).toHaveLength(0);
    expect(await listEmulatorCollection("publicShareAccessSessions"))
      .toHaveLength(0);

    process.env.SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED = "false";
    const legacy = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        displayName: "Legacy collision-safe viewer",
        unlockAttemptId: "participant_collision_access_0002"
      },
      harness,
      networkSuffix: 17,
      shareId
    });
    expect(legacy.response.status).toBe(200);
    expect(legacy.body.capabilities).toMatchObject({
      canComment: true,
      participantIdentityEnabled: false,
      participantLimitReached: false
    });
  }, 15_000);

  it("keeps a pre-rollout session on legacy comment semantics after flags turn on", async () => {
    const shareId = "participant_legacy_session_rollout";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId,
      showCommenterIpPrefix: true
    });
    const metadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 18
    });
    const access = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        displayName: "Legacy viewer",
        unlockAttemptId: "legacy_rollout_access_0001"
      },
      harness,
      networkSuffix: 18,
      shareId,
      testClientIp: "203.226.244.27"
    });
    expect(access.response.status).toBe(200);
    expect(access.body.capabilities).toMatchObject({
      canComment: true,
      commentIpPrefixEnabled: false,
      participantIdentityEnabled: false,
      participantLimitReached: false,
      permissionLevel: "comment"
    });
    expect(cookiePairs(access.response).some((cookie) => cookie.includes("qmsp_")))
      .toBe(false);
    const legacySession: ParticipantSession = {
      bindingCookie: metadata.bindingCookie,
      csrfToken: String(access.body.csrfToken),
      sessionCookie: responseCookie(access.response, "qmss_")
    };

    enableParticipantFeatures();
    const refreshed = await refreshParticipantSession({
      harness,
      session: legacySession,
      shareId
    });
    expect(refreshed.response.status).toBe(200);
    expect(refreshed.body.capabilities).toMatchObject({
      canComment: true,
      commentIpPrefixEnabled: false,
      participantIdentityEnabled: false,
      participantLimitReached: false,
      permissionLevel: "comment"
    });
    legacySession.csrfToken = String(refreshed.body.csrfToken);
    const created = await commentRequest({
      body: {
        body: "legacy session comment",
        clientRequestId: "legacy_rollout_comment_0001"
      },
      harness,
      session: legacySession,
      shareId,
      testClientIp: "203.226.244.27"
    });
    expect(created.response.status).toBe(201);
    expect(created.body.comment).not.toHaveProperty("authorParticipantId");
    expect(created.body.comment).not.toHaveProperty("ipPrefix");
    const comments = await listEmulatorCollection(
      `publicShareComments/${shareId}/items`
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]).toEqual(expect.objectContaining({
      authorIdentityHash: expect.any(String)
    }));
    expect(comments[0]).not.toHaveProperty("authorParticipantId");
    expect(comments[0]).not.toHaveProperty("ipPrefixSnapshot");
    expect(await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    )).toHaveLength(0);

    await writeEmulatorDocuments([{
      path: `publicShareComments/${shareId}/items/c_legacy_prefixed_snapshot`,
      fields: {
        authorBadge: "guest",
        authorDisplayNameSnapshot: "guest1",
        authorParticipantId: "p_legacy_removed_participant",
        body: "기존 Prefix 댓글",
        createdAt: new Date(Date.now() - 1_000),
        ipPrefixSnapshot: "203.226",
        ipPrefixVersion: 1,
        ownerUid: "owner_user",
        shareId,
        updatedAt: new Date(Date.now() - 1_000)
      }
    }]);
    const listed = await commentRequest({
      body: {},
      harness,
      method: "GET",
      session: legacySession,
      shareId
    });
    expect(listed.response.status).toBe(200);
    expect(listed.body.items).toHaveLength(2);
    expect((listed.body.items as Array<Record<string, unknown>>).every(
      (comment) => !Object.prototype.hasOwnProperty.call(comment, "ipPrefix")
    )).toBe(true);
  }, 30_000);

  it("lists owner comments with bearer auth only and hides them from unrelated users", async () => {
    enableParticipantFeatures();
    const owner = await createEmulatorOwner(
      "owner-direct-comments@example.test",
      "owner-password-123"
    );
    const outsider = await createEmulatorOwner(
      "outsider-direct-comments@example.test",
      "outsider-password-123"
    );
    const shareId = "owner_direct_comment_list";
    const commentId = "comment_owner_direct_123456";

    await seedSecureShare({
      oneTimeEnabled: true,
      ownerUid: owner.localId,
      permissionLevel: "comment",
      shareId,
      showCommenterIpPrefix: true
    });
    await writeEmulatorDocuments([
      {
        path: `users/${outsider.localId}`,
        fields: {
          displayName: "Unrelated User",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: false,
          uid: outsider.localId
        }
      },
      {
        path: `publicShareComments/${shareId}/items/${commentId}`,
        fields: {
          authorBadge: "guest",
          authorDisplayNameSnapshot: "guest7",
          authorIdentityHash: "must-not-cross-identity-hash",
          authorParticipantId: "participant_owner_direct_123456",
          authorUid: "must-not-cross-author-uid",
          body: "URL 없이 관리 화면에서 보는 댓글",
          carrier: "must-not-cross-carrier",
          createdAt: new Date(),
          email: "must-not-cross@example.test",
          ipAddress: "203.226.244.27",
          ipPrefixSnapshot: "203.226",
          ipPrefixVersion: 1,
          ownerUid: owner.localId,
          shareId,
          updatedAt: new Date()
        }
      }
    ]);

    const shareBefore = await readEmulatorDocument(`publicNoteShares/${shareId}`);
    expect(await listEmulatorCollection("publicShareAccessSessions")).toHaveLength(0);

    const ownerListed = await commentRequest({
      authorization: owner.idToken,
      body: {},
      harness,
      method: "GET",
      shareId
    });
    expect(ownerListed.response.status).toBe(200);
    expect(ownerListed.response.headers.get("cache-control")).toContain("no-store");
    expect(cookiePairs(ownerListed.response)).toHaveLength(0);
    expect(ownerListed.body.items).toEqual([
      {
        authorParticipantId: "participant_owner_direct_123456",
        badge: "guest",
        body: "URL 없이 관리 화면에서 보는 댓글",
        canDelete: true,
        createdAt: expect.any(String),
        displayName: "guest7",
        id: commentId,
        ipPrefix: "203.226"
      }
    ]);
    expect(JSON.stringify(ownerListed.body)).not.toMatch(
      /must-not-cross|authorUid|identityHash|ipAddress|carrier|email/iu
    );

    const outsiderListed = await commentRequest({
      authorization: outsider.idToken,
      body: {},
      harness,
      method: "GET",
      shareId
    });
    expect(outsiderListed.response.status).toBe(404);
    expectSecretFreeFailure(outsiderListed.body, [
      commentId,
      "URL 없이 관리 화면에서 보는 댓글",
      "guest7",
      "203.226"
    ]);

    expect(await readEmulatorDocument(`publicNoteShares/${shareId}`))
      .toEqual(shareBefore);
    expect(await listEmulatorCollection("publicShareAccessSessions")).toHaveLength(0);
  }, 30_000);

  it("paginates owner comments with the full server cursor contract", async () => {
    enableParticipantFeatures();
    const owner = await createEmulatorOwner(
      "owner-comment-pagination@example.test",
      "owner-password-123"
    );
    const shareId = `ss2_${"p".repeat(80)}`;
    const baseTime = Date.now();
    const commentIds = Array.from(
      { length: 21 },
      (_, index) => `comment_${String(index).padStart(2, "0")}_${"c".repeat(48)}`
    );

    await seedSecureShare({
      oneTimeEnabled: false,
      ownerUid: owner.localId,
      permissionLevel: "comment",
      shareId,
      showCommenterIpPrefix: true
    });
    await writeEmulatorDocuments(commentIds.map((commentId, index) => ({
      path: `publicShareComments/${shareId}/items/${commentId}`,
      fields: {
        authorBadge: "guest",
        authorDisplayNameSnapshot: `guest${index + 1}`,
        body: `페이지네이션 댓글 ${index + 1}`,
        createdAt: new Date(baseTime - index * 1_000),
        ownerUid: owner.localId,
        shareId,
        updatedAt: new Date(baseTime - index * 1_000)
      }
    })));

    const firstPage = await commentRequest({
      authorization: owner.idToken,
      body: {},
      harness,
      limit: 20,
      method: "GET",
      shareId
    });
    expect(firstPage.response.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(20);
    expect((firstPage.body.items as Array<{ id: string }>).map(({ id }) => id))
      .toEqual(commentIds.slice(0, 20));
    const nextCursor = String(firstPage.body.nextCursor);
    expect(nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(nextCursor.length).toBeGreaterThan(256);
    expect(nextCursor.length).toBeLessThanOrEqual(1_000);

    const secondPage = await commentRequest({
      authorization: owner.idToken,
      body: {},
      cursor: nextCursor,
      harness,
      limit: 20,
      method: "GET",
      shareId
    });
    expect(secondPage.response.status).toBe(200);
    expect(secondPage.body.items).toEqual([
      expect.objectContaining({ id: commentIds[20] })
    ]);
    expect(secondPage.body.nextCursor).toBeNull();
  }, 30_000);

  it("marks only a newly capped participant session read-only for comments", async () => {
    enableParticipantFeatures();
    const shareId = "participant_limit_capabilities";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId,
      showCommenterIpPrefix: true
    });
    await writeEmulatorDocuments([
      {
        path: `publicShareParticipantCounters/${shareId}`,
        fields: {
          nextGuestNumber: 1001,
          ownerUid: "owner_user",
          participantCount: 1000,
          schemaVersion: 1,
          shareId,
          updatedAt: new Date()
        }
      }
    ]);

    const metadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 19
    });
    const access = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        displayName: "Capped viewer",
        unlockAttemptId: "participant_cap_access_0001"
      },
      harness,
      networkSuffix: 19,
      shareId
    });
    expect(access.response.status).toBe(200);
    expect(access.body.capabilities).toMatchObject({
      canComment: false,
      participantIdentityEnabled: true,
      participantLimitReached: true,
      permissionLevel: "comment"
    });
    expect(cookiePairs(access.response).some((cookie) => cookie.includes("qmsp_")))
      .toBe(false);
    const cappedSession: ParticipantSession = {
      bindingCookie: metadata.bindingCookie,
      csrfToken: String(access.body.csrfToken),
      sessionCookie: responseCookie(access.response, "qmss_")
    };
    const refreshed = await refreshParticipantSession({
      harness,
      session: cappedSession,
      shareId
    });
    expect(refreshed.response.status).toBe(200);
    expect(refreshed.body.capabilities).toMatchObject({
      canComment: false,
      participantIdentityEnabled: true,
      participantLimitReached: true,
      permissionLevel: "comment"
    });
    cappedSession.csrfToken = String(refreshed.body.csrfToken);

    const listed = await commentRequest({
      body: {},
      harness,
      method: "GET",
      session: cappedSession,
      shareId
    });
    expect(listed.response.status).toBe(200);
    const blocked = await commentRequest({
      body: {
        body: "must not be written",
        clientRequestId: "participant_cap_comment_0001"
      },
      harness,
      session: cappedSession,
      shareId
    });
    expect(blocked.response.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: "participant_limit_reached" });
    expect(await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    )).toHaveLength(0);
    expect(await listEmulatorCollection(
      `publicShareComments/${shareId}/items`
    )).toHaveLength(0);
  }, 30_000);

  it("allocates one participant for twenty parallel accesses from the same browser identity", async () => {
    enableParticipantFeatures();
    const shareId = "participant_same_identity_20";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId,
      showCommenterIpPrefix: true
    });
    const metadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 21
    });
    expect(await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    )).toHaveLength(0);
    expect(await readEmulatorDocument(`publicShareParticipantCounters/${shareId}`))
      .toBeNull();

    const accesses = await Promise.all(
      Array.from({ length: 20 }, (_, index) => accessRequest({
        bindingCookie: metadata.bindingCookie,
        body: {
          displayName: `Ignored label ${index}`,
          unlockAttemptId: "same_identity_parallel_0001"
        },
        harness,
        networkSuffix: 21,
        shareId
      }))
    );

    expect(accesses.every(({ response }) => response.status === 200)).toBe(true);
    const participants = await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    );
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({
      displayName: "guest1",
      guestNumber: 1,
      identityType: "browser",
      status: "active"
    });
    expect(participants[0]).not.toHaveProperty("expiresAt");
    const participantCounter = await readEmulatorDocument(
      `publicShareParticipantCounters/${shareId}`
    );
    expect(participantCounter).toMatchObject({
      nextGuestNumber: 2,
      participantCount: 1,
      shareId
    });
    expect(participantCounter).not.toHaveProperty("expiresAt");
    const participantCookies = accesses.map(({ response }) =>
      responseCookie(response, "qmsp_")
    );
    expect(new Set(participantCookies).size).toBe(participantCookies.length);
    for (const participantCookie of participantCookies) {
      const rawParticipantToken = participantCookie.slice(
        participantCookie.indexOf("=") + 1
      );
      expect(JSON.stringify(participants)).not.toContain(rawParticipantToken);
    }
    const sessions = await listEmulatorCollection("publicShareAccessSessions");
    expect(sessions).toHaveLength(20);
    expect(new Set(sessions.map((session) => session.participantId))).toEqual(
      new Set([participants[0].participantId])
    );

    const reuses = await Promise.all(
      participantCookies.slice(0, 3).map((participantCookie, index) =>
        accessRequest({
          bindingCookie: `${metadata.bindingCookie}; ${participantCookie}`,
          body: {
            displayName: "Ignored reusable cookie label",
            unlockAttemptId:
              `same_identity_cookie_reuse_${String(index).padStart(4, "0")}`
          },
          harness,
          networkSuffix: 121 + index,
          shareId
        })
      )
    );
    expect(reuses.every(({ response }) => response.status === 200)).toBe(true);
    expect(await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    )).toHaveLength(1);
    expect(await readEmulatorDocument(
      `publicShareParticipantCounters/${shareId}`
    )).toMatchObject({
      nextGuestNumber: 2,
      participantCount: 1
    });
    const sessionsAfterReuse = await listEmulatorCollection(
      "publicShareAccessSessions"
    );
    expect(sessionsAfterReuse).toHaveLength(23);
    expect(new Set(sessionsAfterReuse.map((session) => session.participantId)))
      .toEqual(new Set([participants[0].participantId]));
  }, 60_000);

  it("reuses one participant for repeated successful accesses by the same verified email", async () => {
    enableParticipantFeatures();
    Object.assign(process.env, {
      SECURE_SHARE_EMAIL_ENABLED: "true",
      SHARE_EMAIL_API_KEY: "emulator-provider-key",
      SHARE_EMAIL_FROM: "sender@example.test",
      SHARE_EMAIL_PROVIDER: "resend",
      SHARE_EMAIL_SENDER_VERIFIED: "true"
    });
    const shareId = "participant_same_verified_email";
    const emailHash = emailDigest("same-participant@example.test");
    const challenges = [
      {
        challengeId: "participant_same_email_challenge_0001",
        networkSuffix: 23,
        otp: "135790",
        unlockAttemptId: "participant_same_email_access_0001"
      },
      {
        challengeId: "participant_same_email_challenge_0002",
        networkSuffix: 24,
        otp: "246801",
        unlockAttemptId: "participant_same_email_access_0002"
      }
    ];
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailHash],
      challenge: {
        codeDigest: otpCodeDigest(
          challenges[0].challengeId,
          shareId,
          emailHash,
          challenges[0].otp
        ),
        emailHash,
        id: challenges[0].challengeId
      },
      emailVerificationRequired: true,
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId
    });
    await writeEmulatorDocuments([
      {
        path: `publicShareEmailChallenges/${challenges[1].challengeId}`,
        fields: {
          attempts: 0,
          codeDigest: otpCodeDigest(
            challenges[1].challengeId,
            shareId,
            emailHash,
            challenges[1].otp
          ),
          createdAt: new Date(Date.now() - 5_000),
          emailHash,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          ownerUid: "owner_user",
          policyVersion: 1,
          sendAttemptId: "send_participant_same_email_challenge_0002",
          shareId,
          status: "pending",
          updatedAt: new Date(Date.now() - 5_000)
        }
      }
    ]);

    const accesses = [];
    for (const challenge of challenges) {
      const metadata = await metadataBinding(harness.origin, shareId, {
        networkSuffix: challenge.networkSuffix
      });
      accesses.push(await accessRequest({
        bindingCookie: metadata.bindingCookie,
        body: {
          challengeId: challenge.challengeId,
          displayName: "Untrusted verified email label",
          otp: challenge.otp,
          unlockAttemptId: challenge.unlockAttemptId
        },
        harness,
        networkSuffix: challenge.networkSuffix,
        shareId
      }));
    }

    expect(accesses.every(({ response }) => response.status === 200)).toBe(true);
    expect(accesses.every(({ response }) =>
      cookiePairs(response).every((cookie) => !cookie.includes("qmsp_"))
    )).toBe(true);
    const participants = await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    );
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({
      displayName: "guest1",
      guestNumber: 1,
      identityType: "verified_email",
      status: "active"
    });
    expect(await readEmulatorDocument(
      `publicShareParticipantCounters/${shareId}`
    )).toMatchObject({
      nextGuestNumber: 2,
      participantCount: 1
    });
    const sessions = await listEmulatorCollection("publicShareAccessSessions");
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) =>
      session.identityType === "verified_email"
      && session.participantId === participants[0].participantId
    )).toBe(true);
  }, 30_000);

  it("allocates distinct guests after participant-cookie deletion at the same public IP", async () => {
    enableParticipantFeatures();
    const shareId = "participant_same_ip_distinct_tokens";
    const publicIp = "8.8.8.8";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId
    });
    const metadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 25
    });
    const first = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        displayName: "Ignored first anonymous label",
        unlockAttemptId: "same_ip_distinct_token_access_0001"
      },
      harness,
      networkSuffix: 25,
      shareId,
      testClientIp: publicIp
    });
    expect(first.response.status).toBe(200);
    const firstParticipantCookie = responseCookie(first.response, "qmsp_");

    const second = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        displayName: "Ignored second anonymous label",
        unlockAttemptId: "same_ip_distinct_token_access_0002"
      },
      harness,
      networkSuffix: 25,
      shareId,
      testClientIp: publicIp
    });
    expect(second.response.status).toBe(200);
    const secondParticipantCookie = responseCookie(second.response, "qmsp_");
    expect(secondParticipantCookie).not.toBe(firstParticipantCookie);

    const participants = await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    );
    expect(participants).toHaveLength(2);
    expect(participants.map((participant) => participant.guestNumber).sort())
      .toEqual([1, 2]);
    expect(new Set(participants.map((participant) => participant.participantId)).size)
      .toBe(2);
    expect(participants.every((participant) =>
      participant.identityType === "browser"
    )).toBe(true);
    expect(await readEmulatorDocument(
      `publicShareParticipantCounters/${shareId}`
    )).toMatchObject({
      nextGuestNumber: 3,
      participantCount: 2
    });
  }, 30_000);

  it("reuses the participant cookie across browser-binding and public IP changes without incrementing the counter", async () => {
    enableParticipantFeatures();
    const shareId = "participant_cookie_ip_change";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId
    });
    const metadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 26
    });
    const first = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        displayName: "Ignored stable participant label",
        unlockAttemptId: "participant_ip_change_access_0001"
      },
      harness,
      networkSuffix: 26,
      shareId,
      testClientIp: "8.8.8.8"
    });
    expect(first.response.status).toBe(200);
    const participantCookie = responseCookie(first.response, "qmsp_");
    const firstParticipants = await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    );
    expect(firstParticipants).toHaveLength(1);
    const counterPath = `publicShareParticipantCounters/${shareId}`;
    const initialCounter = await readEmulatorDocument(counterPath);
    const rotatedMetadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 27
    });
    expect(rotatedMetadata.bindingCookie).not.toBe(metadata.bindingCookie);

    const second = await accessRequest({
      bindingCookie: `${rotatedMetadata.bindingCookie}; ${participantCookie}`,
      body: {
        displayName: "Ignored changed network label",
        unlockAttemptId: "participant_ip_change_access_0002"
      },
      harness,
      networkSuffix: 27,
      shareId,
      testClientIp: "1.1.1.1"
    });
    expect(second.response.status).toBe(200);
    expect(cookiePairs(second.response).some((cookie) => cookie.includes("qmsp_")))
      .toBe(false);

    const participants = await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    );
    expect(participants).toHaveLength(1);
    expect(participants[0].participantId).toBe(firstParticipants[0].participantId);
    const counter = await readEmulatorDocument(counterPath);
    expect(counter).toMatchObject({
      nextGuestNumber: 2,
      participantCount: 1
    });
    expect(counter?.__updateTime).toBe(initialCounter?.__updateTime);
    const sessions = await listEmulatorCollection("publicShareAccessSessions");
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((session) => session.participantId))).toEqual(
      new Set([participants[0].participantId])
    );
  }, 30_000);

  it("starts guest numbering independently at guest1 for each share", async () => {
    enableParticipantFeatures();
    const shareIds = [
      "participant_numbering_share_a",
      "participant_numbering_share_b"
    ];
    await Promise.all(shareIds.map((shareId) =>
      seedSecureShare({
        oneTimeEnabled: false,
        permissionLevel: "comment",
        shareId
      })
    ));

    const accesses = [];
    for (const [index, shareId] of shareIds.entries()) {
      const networkSuffix = 28 + index;
      const metadata = await metadataBinding(harness.origin, shareId, {
        networkSuffix
      });
      accesses.push(await accessRequest({
        bindingCookie: metadata.bindingCookie,
        body: {
          displayName: "Ignored share-local label",
          unlockAttemptId: `participant_share_local_access_000${index + 1}`
        },
        harness,
        networkSuffix,
        shareId
      }));
    }
    expect(accesses.every(({ response }) => response.status === 200)).toBe(true);

    const participantsByShare = await Promise.all(shareIds.map((shareId) =>
      listEmulatorCollection(`publicShareParticipants/${shareId}/items`)
    ));
    expect(participantsByShare.every((participants) =>
      participants.length === 1
      && participants[0].guestNumber === 1
      && participants[0].displayName === "guest1"
    )).toBe(true);
    expect(participantsByShare[0][0].participantId)
      .not.toBe(participantsByShare[1][0].participantId);
    const counters = await Promise.all(shareIds.map((shareId) =>
      readEmulatorDocument(`publicShareParticipantCounters/${shareId}`)
    ));
    expect(counters).toEqual([
      expect.objectContaining({
        nextGuestNumber: 2,
        participantCount: 1,
        shareId: shareIds[0]
      }),
      expect.objectContaining({
        nextGuestNumber: 2,
        participantCount: 1,
        shareId: shareIds[1]
      })
    ]);
  }, 30_000);

  it("atomically grants one remaining participant slot and makes every race loser read-only", async () => {
    enableParticipantFeatures();
    process.env.SECURE_SHARE_MAX_PARTICIPANTS_PER_SHARE = "2";
    const cappedHarness = await startConfiguredSecureShareApiHarness(
      "participant-cap-2"
    );
    try {
      const shareId = "participant_remaining_slot_race";
      await seedSecureShare({
        oneTimeEnabled: false,
        permissionLevel: "comment",
        shareId
      });
      await openParticipantSession({
        harness: cappedHarness,
        networkSuffix: 30,
        shareId
      });

      const contenderCount = 6;
      const metadata = await Promise.all(
        Array.from({ length: contenderCount }, (_, index) =>
          metadataBinding(cappedHarness.origin, shareId, {
            networkSuffix: 31 + index
          })
        )
      );
      const contenders = await Promise.all(
        metadata.map((candidate, index) => accessRequest({
          bindingCookie: candidate.bindingCookie,
          body: {
            displayName: `Ignored capped contender ${index}`,
            unlockAttemptId:
              `participant_remaining_slot_${String(index).padStart(4, "0")}`
          },
          harness: cappedHarness,
          networkSuffix: 31 + index,
          shareId
        }))
      );

      expect(contenders.every(({ response }) => response.status === 200)).toBe(true);
      const winners = contenders.filter(({ body }) => {
        const capabilities = body.capabilities as Record<string, unknown>;
        return capabilities.canComment === true
          && capabilities.participantLimitReached === false;
      });
      const capped = contenders.filter(({ body }) => {
        const capabilities = body.capabilities as Record<string, unknown>;
        return capabilities.canComment === false
          && capabilities.participantIdentityEnabled === true
          && capabilities.participantLimitReached === true;
      });
      expect(winners).toHaveLength(1);
      expect(capped).toHaveLength(contenderCount - 1);
      expect(cookiePairs(winners[0].response).filter((cookie) =>
        cookie.includes("qmsp_")
      )).toHaveLength(1);
      expect(capped.every(({ response }) =>
        cookiePairs(response).every((cookie) => !cookie.includes("qmsp_"))
      )).toBe(true);

      const participants = await listEmulatorCollection(
        `publicShareParticipants/${shareId}/items`
      );
      expect(participants).toHaveLength(2);
      expect(participants.map((participant) => participant.guestNumber).sort())
        .toEqual([1, 2]);
      expect(new Set(participants.map((participant) => participant.participantId)).size)
        .toBe(2);
      const counter = await readEmulatorDocument(
        `publicShareParticipantCounters/${shareId}`
      );
      expect(counter).toMatchObject({
        nextGuestNumber: 3,
        participantCount: 2,
        shareId
      });
      expect(counter?.participantCount).toBe(participants.length);
      const sessions = await listEmulatorCollection("publicShareAccessSessions");
      expect(sessions).toHaveLength(contenderCount + 1);
      expect(sessions.filter((session) => session.participantId)).toHaveLength(2);
      expect(sessions.filter((session) =>
        session.participantIdentityEnabled === true
        && session.participantLimitReached === true
        && !session.participantId
      )).toHaveLength(contenderCount - 1);
    } finally {
      await cappedHarness.close();
    }
  }, 90_000);

  it("requires owners and administrators to opt into preview without allocating participants", async () => {
    enableParticipantFeatures();
    const owner = await createEmulatorOwner(
      "participant-preview-owner@example.test",
      "emulator-owner-password"
    );
    const admin = await createEmulatorOwner(
      "participant-preview-admin@example.test",
      "emulator-admin-password"
    );
    const shareId = "participant_privileged_preview_required";
    await seedSecureShare({
      oneTimeEnabled: false,
      ownerUid: owner.localId,
      permissionLevel: "comment",
      shareId
    });
    await writeEmulatorDocuments([
      {
        path: `users/${admin.localId}`,
        fields: {
          displayName: "Participant Preview Admin",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: true,
          uid: admin.localId
        }
      }
    ]);

    const privilegedCallers = [
      {
        body: {
          displayName: "Owner must not become a guest",
          unlockAttemptId: "participant_owner_preview_required_0001"
        },
        idToken: owner.idToken,
        networkSuffix: 38
      },
      {
        body: {
          displayName: "Admin must not become a guest",
          ownerPreview: false,
          unlockAttemptId: "participant_admin_preview_required_0001"
        },
        idToken: admin.idToken,
        networkSuffix: 39
      }
    ];
    for (const caller of privilegedCallers) {
      const metadata = await metadataBinding(harness.origin, shareId, {
        authorization: caller.idToken,
        networkSuffix: caller.networkSuffix
      });
      const access = await accessRequest({
        authorization: caller.idToken,
        bindingCookie: metadata.bindingCookie,
        body: caller.body,
        harness,
        networkSuffix: caller.networkSuffix,
        shareId
      });
      expect(access.response.status).toBe(409);
      expect(access.body).toMatchObject({
        ok: false,
        error: "owner_preview_required"
      });
      expect(cookiePairs(access.response).some((cookie) =>
        cookie.includes("qmsp_") || cookie.includes("qmss_")
      )).toBe(false);
    }
    expect(await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    )).toHaveLength(0);
    expect(await readEmulatorDocument(
      `publicShareParticipantCounters/${shareId}`
    )).toBeNull();
    expect(await listEmulatorCollection("publicShareAccessSessions"))
      .toHaveLength(0);
  }, 30_000);

  it("throttles reusable participant last-seen writes without touching its counter", async () => {
    enableParticipantFeatures();
    const shareId = "participant_last_seen_throttle";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId
    });
    const metadata = await metadataBinding(harness.origin, shareId, {
      networkSuffix: 22
    });
    const first = await accessRequest({
      bindingCookie: metadata.bindingCookie,
      body: {
        displayName: "Last-seen viewer",
        unlockAttemptId: "participant_last_seen_initial_0001"
      },
      harness,
      networkSuffix: 22,
      shareId
    });
    expect(first.response.status).toBe(200);
    const participantCookie = responseCookie(first.response, "qmsp_");
    const reusableCookies = `${metadata.bindingCookie}; ${participantCookie}`;
    const [createdParticipant] = await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    );
    const participantPath =
      `publicShareParticipants/${shareId}/items/${createdParticipant.participantId}`;
    const counterPath = `publicShareParticipantCounters/${shareId}`;
    const freshParticipant = await readEmulatorDocument(participantPath);
    const initialCounter = await readEmulatorDocument(counterPath);

    const freshReuse = await accessRequest({
      bindingCookie: reusableCookies,
      body: {
        displayName: "Ignored fresh label",
        unlockAttemptId: "participant_last_seen_fresh_0002"
      },
      harness,
      networkSuffix: 22,
      shareId
    });
    expect(freshReuse.response.status).toBe(200);
    expect((await readEmulatorDocument(participantPath))?.__updateTime)
      .toBe(freshParticipant?.__updateTime);
    expect((await readEmulatorDocument(counterPath))?.__updateTime)
      .toBe(initialCounter?.__updateTime);

    await patchEmulatorDocuments([
      {
        path: participantPath,
        fields: {
          lastSeenAt: new Date(Date.now() - 61 * 60 * 1000)
        }
      }
    ]);
    const staleParticipant = await readEmulatorDocument(participantPath);
    const staleReuse = await accessRequest({
      bindingCookie: reusableCookies,
      body: {
        displayName: "Ignored stale label",
        unlockAttemptId: "participant_last_seen_stale_0003"
      },
      harness,
      networkSuffix: 22,
      shareId
    });
    expect(staleReuse.response.status).toBe(200);
    const refreshedParticipant = await readEmulatorDocument(participantPath);
    expect(refreshedParticipant?.__updateTime).not.toBe(
      staleParticipant?.__updateTime
    );
    expect(Date.parse(String(refreshedParticipant?.lastSeenAt)))
      .toBeGreaterThan(Date.now() - 60_000);
    expect((await readEmulatorDocument(counterPath))?.__updateTime)
      .toBe(initialCounter?.__updateTime);

    await patchEmulatorDocuments([
      {
        path: participantPath,
        fields: {
          lastSeenAt: new Date(Date.now() - 61 * 60 * 1000)
        }
      }
    ]);
    const concurrentBaseline = await readEmulatorDocument(participantPath);
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) => accessRequest({
        bindingCookie: reusableCookies,
        body: {
          displayName: "Ignored concurrent label",
          unlockAttemptId:
            `participant_last_seen_concurrent_${String(index).padStart(4, "0")}`
        },
        harness,
        networkSuffix: 22,
        shareId
      }))
    );
    expect(concurrent.every(({ response }) => response.status === 200)).toBe(true);
    const concurrentParticipant = await readEmulatorDocument(participantPath);
    expect(concurrentParticipant?.__updateTime).not.toBe(
      concurrentBaseline?.__updateTime
    );
    expect(Date.parse(String(concurrentParticipant?.lastSeenAt)))
      .toBeGreaterThan(Date.now() - 60_000);
    expect((await readEmulatorDocument(counterPath))?.__updateTime)
      .toBe(initialCounter?.__updateTime);
    expect(await readEmulatorDocument(counterPath)).toMatchObject({
      nextGuestNumber: 2,
      participantCount: 1
    });
  }, 60_000);

  it("allocates unique sequential guest numbers for twenty parallel browser identities", async () => {
    enableParticipantFeatures();
    const shareId = "participant_different_identity_20";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId
    });
    const metadata = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        metadataBinding(harness.origin, shareId, { networkSuffix: 40 + index })
      )
    );
    const accesses = await Promise.all(
      metadata.map((candidate, index) => accessRequest({
        bindingCookie: candidate.bindingCookie,
        body: {
          displayName: `Ignored distinct label ${index}`,
          unlockAttemptId: `different_identity_${String(index).padStart(4, "0")}`
        },
        harness,
        networkSuffix: 40 + index,
        shareId
      }))
    );

    expect(accesses.map(({ body, response }) => ({
      body,
      retryAfter: response.headers.get("retry-after"),
      status: response.status
    }))).toEqual(Array.from({ length: 20 }, () => ({
      body: expect.objectContaining({ ok: true }),
      retryAfter: null,
      status: 200
    })));
    const participants = await listEmulatorCollection(
      `publicShareParticipants/${shareId}/items`
    );
    expect(participants).toHaveLength(20);
    expect(
      participants
        .map((participant) => Number(participant.guestNumber))
        .sort((left, right) => left - right)
    ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(new Set(
      participants.map((participant) => participant.participantId)
    ).size).toBe(20);
    expect(new Set(accesses.map(({ response }) =>
      responseCookie(response, "qmsp_")
    )).size).toBe(20);
    expect(await readEmulatorDocument(
      `publicShareParticipantCounters/${shareId}`
    )).toMatchObject({
      nextGuestNumber: 21,
      participantCount: 20
    });
  }, 90_000);

  it("does not allocate participants for metadata, failed gates, or owner preview", async () => {
    enableParticipantFeatures();

    const passwordShareId = "participant_failed_password";
    await seedSecureShare({
      oneTimeEnabled: false,
      passwordEnabled: true,
      passwordHashRecord: {
        ...(await hashSharePassword("correct-password"))
      },
      permissionLevel: "comment",
      shareId: passwordShareId
    });
    const passwordMetadata = await metadataBinding(harness.origin, passwordShareId, {
      networkSuffix: 61
    });
    const failedPassword = await accessRequest({
      bindingCookie: passwordMetadata.bindingCookie,
      body: {
        password: "wrong-password",
        unlockAttemptId: "failed_password_participant_0001"
      },
      harness,
      networkSuffix: 61,
      shareId: passwordShareId
    });
    expect(failedPassword.response.status).toBe(403);
    expect(await listEmulatorCollection(
      `publicShareParticipants/${passwordShareId}/items`
    )).toHaveLength(0);
    expect(await readEmulatorDocument(
      `publicShareParticipantCounters/${passwordShareId}`
    )).toBeNull();

    Object.assign(process.env, {
      SECURE_SHARE_EMAIL_ENABLED: "true",
      SHARE_EMAIL_API_KEY: "emulator-provider-key",
      SHARE_EMAIL_FROM: "sender@example.test",
      SHARE_EMAIL_PROVIDER: "resend",
      SHARE_EMAIL_SENDER_VERIFIED: "true"
    });
    const otpShareId = "participant_failed_otp";
    const challengeId = "participant_failed_otp_challenge";
    const emailHash = emailDigest("participant@example.test");
    await seedSecureShare({
      accessMode: "allowed_emails",
      allowedEmailHashes: [emailHash],
      challenge: {
        codeDigest: otpCodeDigest(
          challengeId,
          otpShareId,
          emailHash,
          "135790"
        ),
        emailHash,
        id: challengeId
      },
      emailVerificationRequired: true,
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId: otpShareId
    });
    const otpMetadata = await metadataBinding(harness.origin, otpShareId, {
      networkSuffix: 62
    });
    const failedOtp = await accessRequest({
      bindingCookie: otpMetadata.bindingCookie,
      body: {
        challengeId,
        otp: "000000",
        unlockAttemptId: "failed_otp_participant_0001"
      },
      harness,
      networkSuffix: 62,
      shareId: otpShareId
    });
    expect(failedOtp.response.status).toBe(403);
    expect(await listEmulatorCollection(
      `publicShareParticipants/${otpShareId}/items`
    )).toHaveLength(0);

    const owner = await createEmulatorOwner(
      "participant-owner@example.test",
      "owner-password-123"
    );
    const ownerShareId = "participant_owner_preview";
    await seedSecureShare({
      oneTimeEnabled: false,
      ownerUid: owner.localId,
      permissionLevel: "comment",
      shareId: ownerShareId,
      showCommenterIpPrefix: true
    });
    const ownerMetadata = await metadataBinding(harness.origin, ownerShareId, {
      authorization: owner.idToken,
      networkSuffix: 63
    });
    const preview = await accessRequest({
      authorization: owner.idToken,
      bindingCookie: ownerMetadata.bindingCookie,
      body: {
        ownerPreview: true,
        unlockAttemptId: "owner_preview_no_participant_0001"
      },
      harness,
      networkSuffix: 63,
      shareId: ownerShareId
    });
    expect(preview.response.status).toBe(200);
    expect(preview.body.capabilities).toMatchObject({
      commentIpPrefixEnabled: true,
      participantIdentityEnabled: false
    });
    expect(cookiePairs(preview.response).some((cookie) => cookie.includes("qmsp_")))
      .toBe(false);
    await writeEmulatorDocuments([{
      path: `publicShareComments/${ownerShareId}/items/c_owner_preview_prefix`,
      fields: {
        authorBadge: "guest",
        authorDisplayNameSnapshot: "guest1",
        authorParticipantId: "p_removed_owner_preview_guest",
        body: "Owner preview prefix comment",
        createdAt: new Date(),
        ipPrefixSnapshot: "203.226",
        ipPrefixVersion: 1,
        ownerUid: owner.localId,
        shareId: ownerShareId,
        updatedAt: new Date()
      }
    }]);
    const ownerPreviewSession: ParticipantSession = {
      bindingCookie: ownerMetadata.bindingCookie,
      csrfToken: String(preview.body.csrfToken),
      sessionCookie: responseCookie(preview.response, "qmss_")
    };
    const ownerListed = await commentRequest({
      authorization: owner.idToken,
      body: {},
      harness,
      method: "GET",
      session: ownerPreviewSession,
      shareId: ownerShareId
    });
    expect(ownerListed.response.status).toBe(200);
    expect(ownerListed.body.items).toEqual([
      expect.objectContaining({
        body: "Owner preview prefix comment",
        ipPrefix: "203.226"
      })
    ]);
    expect(await listEmulatorCollection(
      `publicShareParticipants/${ownerShareId}/items`
    )).toHaveLength(0);
  }, 30_000);

  it("renames transactionally and hydrates old comments while preserving IP snapshots", async () => {
    enableParticipantFeatures();
    const shareId = "participant_comment_hydration";
    const firstFullIp = "203.226.244.27";
    const secondFullIp = "2001:2d8:1234::99";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId,
      showCommenterIpPrefix: true
    });
    const session = await openParticipantSession({
      harness,
      networkSuffix: 64,
      shareId,
      testClientIp: firstFullIp
    });
    const initial = await participantMeRequest({
      harness,
      session,
      shareId,
      testClientIp: firstFullIp
    });
    expect(initial.response.status).toBe(200);
    expect(initial.body).toMatchObject({
      participant: {
        currentIpPrefix: "203.226",
        displayName: "guest1",
        guestNumber: 1,
        isSystemDefaultName: true
      }
    });
    const participantId = String(
      (initial.body.participant as Record<string, unknown>).participantId
    );

    const firstRenameBody = {
      clientRequestId: "rename_tester_a_request_0001",
      displayName: "테스터가"
    };
    const renamed = await participantMeRequest({
      body: firstRenameBody,
      harness,
      method: "PATCH",
      session,
      shareId,
      testClientIp: firstFullIp
    });
    expect(renamed.response.status).toBe(200);
    expect(renamed.body).toMatchObject({
      participant: { displayName: "테스터가", isSystemDefaultName: false }
    });
    const replay = await participantMeRequest({
      body: firstRenameBody,
      harness,
      method: "PATCH",
      session,
      shareId,
      testClientIp: firstFullIp
    });
    expect(replay.response.status).toBe(200);
    const renameRequests = await listEmulatorCollection(
      `publicShareParticipantRenameRequests/${shareId}/items`
    );
    expect(renameRequests).toHaveLength(1);
    expect(renameRequests[0]).not.toHaveProperty("expiresAt");
    const participantNames = await listEmulatorCollection(
      `publicShareParticipantNames/${shareId}/items`
    );
    expect(participantNames).toHaveLength(1);
    expect(participantNames[0]).not.toHaveProperty("expiresAt");

    const firstComment = await commentRequest({
      body: {
        body: "첫 번째 댓글",
        clientRequestId: "participant_comment_request_0001"
      },
      harness,
      session,
      shareId,
      testClientIp: firstFullIp
    });
    expect(firstComment.response.status).toBe(201);
    expect(firstComment.body).toMatchObject({
      comment: {
        authorParticipantId: participantId,
        displayName: "테스터가",
        ipPrefix: "203.226"
      }
    });

    await patchEmulatorDocuments([
      {
        path: `publicShareParticipants/${shareId}/items/${participantId}`,
        fields: { lastRenamedAt: new Date(Date.now() - 61_000) }
      }
    ]);
    const secondRename = await participantMeRequest({
      body: {
        clientRequestId: "rename_tester_b_request_0002",
        displayName: "테스터나"
      },
      harness,
      method: "PATCH",
      session,
      shareId,
      testClientIp: secondFullIp
    });
    expect(secondRename.response.status).toBe(200);

    const historicalReplay = await participantMeRequest({
      body: firstRenameBody,
      harness,
      method: "PATCH",
      session,
      shareId,
      testClientIp: secondFullIp
    });
    expect(historicalReplay.response.status).toBe(200);
    expect(historicalReplay.body).toMatchObject({
      participant: { displayName: "테스터나" }
    });
    expect(await readEmulatorDocument(
      `publicShareParticipants/${shareId}/items/${participantId}`
    )).toMatchObject({
      displayName: "테스터나",
      renameCount: 2
    });
    const compactedRenameRequests = await listEmulatorCollection(
      `publicShareParticipantRenameRequests/${shareId}/items`
    );
    expect(compactedRenameRequests).toHaveLength(1);
    expect(compactedRenameRequests[0].recentRequests).toHaveLength(2);

    const secondComment = await commentRequest({
      body: {
        body: "두 번째 댓글",
        clientRequestId: "participant_comment_request_0002"
      },
      harness,
      session,
      shareId,
      testClientIp: secondFullIp
    });
    expect(secondComment.response.status).toBe(201);
    expect(secondComment.body).toMatchObject({
      comment: { displayName: "테스터나", ipPrefix: "2001:2d8" }
    });

    const listed = await commentRequest({
      body: {},
      harness,
      method: "GET",
      session,
      shareId
    });
    expect(listed.response.status).toBe(200);
    const items = listed.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.displayName === "테스터나")).toBe(true);
    expect(new Set(items.map((item) => item.ipPrefix))).toEqual(
      new Set(["203.226", "2001:2d8"])
    );

    const storedComments = await listEmulatorCollection(
      `publicShareComments/${shareId}/items`
    );
    expect(storedComments).toHaveLength(2);
    expect(storedComments.every((comment) =>
      comment.authorParticipantId === participantId
      && !Object.prototype.hasOwnProperty.call(comment, "authorUid")
      && !Object.prototype.hasOwnProperty.call(comment, "authorIdentityHash")
    )).toBe(true);
    const serialized = JSON.stringify(storedComments);
    expect(serialized).not.toContain(firstFullIp);
    expect(serialized).not.toContain(secondFullIp);
    expect(serialized).not.toMatch(/rawForwardedFor|rawVercelIpHeader|carrier|asn/iu);
  }, 30_000);

  it("charges no-op renames atomically against cooldown and hourly/daily counters", async () => {
    enableParticipantFeatures();
    const shareId = "participant_noop_rename_limits";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId
    });
    const session = await openParticipantSession({
      harness,
      networkSuffix: 68,
      shareId
    });
    const initial = await participantMeRequest({ harness, session, shareId });
    expect(initial.response.status).toBe(200);
    const participant = initial.body.participant as Record<string, unknown>;
    const participantId = String(participant.participantId);
    const displayName = "Alice";
    const participantPath =
      `publicShareParticipants/${shareId}/items/${participantId}`;
    const initialRename = await participantMeRequest({
      body: {
        clientRequestId: "rename_initial_custom_request_0001",
        displayName
      },
      harness,
      method: "PATCH",
      session,
      shareId
    });
    expect(initialRename.response.status).toBe(200);
    expect(await readEmulatorDocument(participantPath)).toMatchObject({
      displayName,
      renameCount: 1,
      renameDayCount: 1,
      renameHourCount: 1
    });

    await patchEmulatorDocuments([
      {
        path: participantPath,
        fields: { lastRenamedAt: new Date(Date.now() - 61_000) }
      }
    ]);
    const firstNoopBody = {
      clientRequestId: "rename_noop_request_0001",
      displayName
    };

    const firstNoop = await participantMeRequest({
      body: firstNoopBody,
      harness,
      method: "PATCH",
      session,
      shareId
    });
    expect(firstNoop.response.status).toBe(200);
    expect(firstNoop.body).toMatchObject({
      participant: { displayName, renameCooldownEndsAt: expect.any(String) }
    });
    expect(await readEmulatorDocument(participantPath)).toMatchObject({
      renameCount: 2,
      renameDayCount: 2,
      renameHourCount: 2
    });
    const requestsAfterNoop = await listEmulatorCollection(
      `publicShareParticipantRenameRequests/${shareId}/items`
    );
    expect(requestsAfterNoop).toHaveLength(1);
    expect(requestsAfterNoop[0]).toMatchObject({
      noChange: true,
      recentRequests: [
        expect.objectContaining({ noChange: false, status: "succeeded" }),
        expect.objectContaining({ noChange: true, status: "succeeded" })
      ],
      status: "succeeded"
    });

    const replay = await participantMeRequest({
      body: firstNoopBody,
      harness,
      method: "PATCH",
      session,
      shareId
    });
    expect(replay.response.status).toBe(200);
    expect(await readEmulatorDocument(participantPath)).toMatchObject({
      renameCount: 2,
      renameDayCount: 2,
      renameHourCount: 2
    });

    const blockedByCooldownBody = {
      clientRequestId: "rename_noop_request_0003",
      displayName
    };
    const blockedByCooldown = await participantMeRequest({
      body: blockedByCooldownBody,
      harness,
      method: "PATCH",
      session,
      shareId
    });
    expect(blockedByCooldown.response.status).toBe(429);
    expect(blockedByCooldown.body).toMatchObject({ error: "rate_limited" });
    expect(await listEmulatorCollection(
      `publicShareParticipantRenameRequests/${shareId}/items`
    )).toHaveLength(1);

    await patchEmulatorDocuments([
      {
        path: participantPath,
        fields: { lastRenamedAt: new Date(Date.now() - 61_000) }
      }
    ]);
    const secondNoop = await participantMeRequest({
      body: blockedByCooldownBody,
      harness,
      method: "PATCH",
      session,
      shareId
    });
    expect(secondNoop.response.status).toBe(200);
    expect(await readEmulatorDocument(participantPath)).toMatchObject({
      renameCount: 3,
      renameDayCount: 3,
      renameHourCount: 3
    });
    const compactedRequest = (await listEmulatorCollection(
      `publicShareParticipantRenameRequests/${shareId}/items`
    ))[0];
    expect(compactedRequest.__id).toBe(participantId);
    expect(compactedRequest.recentRequests).toHaveLength(3);

    await patchEmulatorDocuments([
      {
        path: participantPath,
        fields: { lastRenamedAt: new Date(Date.now() - 61_000) }
      }
    ]);
    const blockedByHourlyLimit = await participantMeRequest({
      body: {
        clientRequestId: "rename_noop_request_0004",
        displayName
      },
      harness,
      method: "PATCH",
      session,
      shareId
    });
    expect(blockedByHourlyLimit.response.status).toBe(429);
    expect(blockedByHourlyLimit.body).toMatchObject({ error: "rate_limited" });
    expect(await readEmulatorDocument(participantPath)).toMatchObject({
      renameCount: 3,
      renameDayCount: 3,
      renameHourCount: 3
    });
  }, 30_000);

  it("enforces rename ownership, uniqueness, reserved names, and URL rejection", async () => {
    enableParticipantFeatures();
    const shareId = "participant_rename_security";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId
    });
    const first = await openParticipantSession({
      harness,
      networkSuffix: 65,
      shareId
    });
    const second = await openParticipantSession({
      harness,
      networkSuffix: 66,
      shareId
    });
    const firstParticipant = await participantMeRequest({
      harness,
      session: first,
      shareId
    });
    const firstParticipantId = String(
      (firstParticipant.body.participant as Record<string, unknown>).participantId
    );

    const claimed = await participantMeRequest({
      body: {
        clientRequestId: "rename_unique_name_request_0001",
        displayName: "테스터가"
      },
      harness,
      method: "PATCH",
      session: first,
      shareId
    });
    expect(claimed.response.status).toBe(200);

    const duplicate = await participantMeRequest({
      body: {
        clientRequestId: "rename_duplicate_name_request_0002",
        displayName: "테스터가"
      },
      harness,
      method: "PATCH",
      session: second,
      shareId
    });
    expect(duplicate.response.status).toBe(409);
    expect(duplicate.body).toMatchObject({ error: "display_name_unavailable" });

    const forged = await participantMeRequest({
      body: {
        clientRequestId: "rename_forged_participant_0003",
        displayName: "테스터나",
        participantId: firstParticipantId
      },
      harness,
      method: "PATCH",
      session: second,
      shareId
    });
    expect(forged.response.status).toBe(400);

    for (const [displayName, requestId] of [
      ["emulator owner", "rename_owner_name_casefold_request_0001"],
      ["Ｅｍｕｌａｔｏｒ　Ｏｗｎｅｒ", "rename_owner_name_nfkc_request_0002"]
    ]) {
      const ownerImpersonation = await participantMeRequest({
        body: { clientRequestId: requestId, displayName },
        harness,
        method: "PATCH",
        session: second,
        shareId
      });
      expect(ownerImpersonation.response.status, displayName).toBe(409);
      expect(ownerImpersonation.body).toMatchObject({
        error: "display_name_unavailable"
      });
    }

    for (const [displayName, requestId] of [
      ["guest99", "rename_reserved_guest_request_0004"],
      ["owner", "rename_reserved_owner_request_0005"],
      ["www.example.com", "rename_url_like_request_0006"],
      ["<script>alert(1)</script>", "rename_xss_request_0007"],
      ["Alice\u034f", "rename_invisible_cgj_request_0008"],
      ["Alice\u180b", "rename_invisible_mongolian_request_0009"],
      ["Alice\u17b4", "rename_invisible_khmer_request_0010"],
      ["8.8.8.8", "rename_ipv4_literal_request_0011"],
      ["evil.dev", "rename_domain_request_0012"],
      ["QuickMemo Support", "rename_quickmemo_support_request_0013"],
      ["Admin Team", "rename_admin_team_request_0014"],
      ["guest١", "rename_guest_arabic_digit_request_0015"],
      ["guest۱", "rename_guest_persian_digit_request_0016"],
      ["guest१", "rename_guest_devanagari_digit_request_0017"],
      ["guestI", "rename_guest_ascii_i_request_0018"],
      ["Guestl", "rename_guest_ascii_l_request_0019"],
      ["guestO", "rename_guest_ascii_o_request_0020"],
      ["0wner", "rename_owner_ascii_zero_request_0021"],
      ["adm1n", "rename_admin_ascii_one_request_0022"],
      ["supp0rt", "rename_support_ascii_zero_request_0023"],
      ["qu1ckmemo", "rename_quickmemo_ascii_one_request_0024"],
      ["quickmem0", "rename_quickmemo_ascii_zero_request_0025"],
      ["systern", "rename_system_ascii_rn_request_0026"],
      ["테스터Admin", "rename_mixed_admin_request_0027"],
      ["Quick메모", "rename_mixed_brand_request_0028"],
      ["所有者", "rename_japanese_owner_request_0029"]
    ]) {
      const rejected = await participantMeRequest({
        body: { clientRequestId: requestId, displayName },
        harness,
        method: "PATCH",
        session: second,
        shareId
      });
      expect(rejected.response.status, displayName).toBe(400);
    }

    const failedAttemptLimit = await participantMeRequest({
      body: {
        clientRequestId: "rename_failed_attempt_limit_request_0030",
        displayName: "another.dev"
      },
      harness,
      method: "PATCH",
      session: second,
      shareId
    });
    expect(failedAttemptLimit.response.status).toBe(429);
    expect(failedAttemptLimit.body).toMatchObject({ error: "rate_limited" });
    expect(Number(failedAttemptLimit.response.headers.get("retry-after")))
      .toBeGreaterThan(0);
  }, 30_000);

  it("omits reserved coarse prefixes from participant DTOs and new comments", async () => {
    enableParticipantFeatures();
    const shareId = "participant_reserved_prefix_omission";
    const reservedIp = "203.0.114.1";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId,
      showCommenterIpPrefix: true
    });
    const session = await openParticipantSession({
      harness,
      networkSuffix: 69,
      shareId,
      testClientIp: reservedIp
    });
    const participantMe = await participantMeRequest({
      harness,
      session,
      shareId,
      testClientIp: reservedIp
    });
    expect(participantMe.response.status).toBe(200);
    expect(participantMe.body.participant).not.toHaveProperty("currentIpPrefix");

    const created = await commentRequest({
      body: {
        body: "reserved prefix must stay absent",
        clientRequestId: "participant_reserved_prefix_comment_0001"
      },
      harness,
      session,
      shareId,
      testClientIp: reservedIp
    });
    expect(created.response.status).toBe(201);
    expect(created.body.comment).not.toHaveProperty("ipPrefix");
    const comments = await listEmulatorCollection(
      `publicShareComments/${shareId}/items`
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]).not.toHaveProperty("ipPrefixSnapshot");
    expect(JSON.stringify({
      response: participantMe.body,
      stored: comments
    })).not.toContain("203.0");
  }, 15_000);

  it("keeps IP snapshots absent when the independent IP kill switch is off", async () => {
    process.env.SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED = "true";
    process.env.SECURE_SHARE_COMMENT_IP_PREFIX_ENABLED = "false";
    const shareId = "participant_ip_kill_switch";
    await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId,
      showCommenterIpPrefix: true
    });
    const session = await openParticipantSession({
      harness,
      networkSuffix: 67,
      shareId
    });
    const created = await commentRequest({
      body: {
        body: "prefix disabled",
        clientRequestId: "participant_comment_no_prefix_0001"
      },
      harness,
      session,
      shareId,
      testClientIp: "203.226.244.27"
    });
    expect(created.response.status).toBe(201);
    expect(created.body.comment).not.toHaveProperty("ipPrefix");
    const comments = await listEmulatorCollection(
      `publicShareComments/${shareId}/items`
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]).not.toHaveProperty("ipPrefixSnapshot");
    expect(comments[0]).not.toHaveProperty("ipPrefixVersion");
  }, 15_000);
});
