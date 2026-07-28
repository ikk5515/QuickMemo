import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyGrantAuthorizesDownload,
  emailDigest,
  hashSharePassword,
  otpCodeDigest,
  sessionTokenDigest,
  sourceShareGuardId,
  verifySignedOpaqueToken
} from "../api/public-shares-v2.js";
import {
  apiHeaders,
  clearSecureShareEmulators,
  configureSecureShareApiEmulatorEnvironment,
  cookiePair,
  createEmulatorOwner,
  listEmulatorCollection,
  metadataBinding,
  readEmulatorDocument,
  seedSecureShare,
  startSecureShareApiHarness,
  type SecureShareApiHarness,
  writeEmulatorDocuments
} from "./helpers/secureShareApiEmulator.js";

const describeEmulator =
  process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
    ? describe
    : describe.skip;

const failureOnlyKeys = ["error", "ok", "requestId"];

function accessUrl(origin: string, shareId: string) {
  return `${origin}/api/public-shares-v2?action=access&shareId=${encodeURIComponent(shareId)}`;
}

function ownerCreateBody(sourceNoteId: string, idempotencyKey: string) {
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
      wrappedKey: Buffer.alloc(256, 5).toString("base64")
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
}) {
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=owner-create`,
    {
      method: "POST",
      headers: apiHeaders(input.harness.origin, {
        authorization: input.idToken,
        networkSuffix: input.networkSuffix
      }),
      body: JSON.stringify(ownerCreateBody(input.sourceNoteId, input.idempotencyKey))
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
}) {
  const response = await fetch(accessUrl(input.harness.origin, input.shareId), {
    method: "POST",
    headers: apiHeaders(input.harness.origin, {
      authorization: input.authorization,
      bindingCookie: input.bindingCookie,
      networkSuffix: input.networkSuffix
    }),
    body: JSON.stringify(input.body)
  });
  const body = await response.json() as Record<string, unknown>;
  return { body, response };
}

async function emailChallengeRequest(input: {
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
      body: JSON.stringify({ email: input.email })
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
  let harness: SecureShareApiHarness;

  beforeAll(async () => {
    configureSecureShareApiEmulatorEnvironment();
    harness = await startSecureShareApiHarness();
  });

  beforeEach(async () => {
    configureSecureShareApiEmulatorEnvironment();
    await clearSecureShareEmulators();
  });

  afterAll(async () => {
    await harness?.close();
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
    expect(shareId).toMatch(/^ss2_[A-Za-z0-9_-]{40}$/u);
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

  it("keeps ambiguous provider outcomes reserved and releases only definitive failures", async () => {
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
      status: "pending"
    });
    expect(concurrent.quotaBuckets).toHaveLength(2);
    expect(concurrent.quotaBuckets.every((bucket) =>
      bucket.reservedCount === 1 && bucket.sentCount === 0
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
    expect(invalid.quotaBuckets).toHaveLength(2);
    expect(invalid.quotaBuckets.every((bucket) =>
      bucket.reservedCount === 0 && bucket.sentCount === 0
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
      status: "pending"
    });
    expect(malformedSuccess.quotaBuckets.every((bucket) =>
      bucket.reservedCount === 1 && bucket.sentCount === 0
    )).toBe(true);
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
    expect(quotaBuckets.every((bucket) =>
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
    expect(quotaBuckets.every((bucket) =>
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
});
