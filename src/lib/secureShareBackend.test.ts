import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import handler, {
  HttpError,
  assertOnlyKeys,
  assertEmailPolicyAvailable,
  buildPolicySettings,
  contentUpdateDisposition,
  contentUpdateRetryAfterSeconds,
  contentUpdateRequestDigest,
  copyGrantAuthorizesDownload,
  copyGrantAuditEventId,
  copyGrantRequestDisposition,
  copyGrantRequestId,
  copyGrantRequestKeyHash,
  copyGrantTokenHash,
  createResendEmailAdapter,
  emailChallengeMinimumResponseMilliseconds,
  emailDigest,
  emailQuotaExceeded,
  emailQuotaPeriods,
  etagMatches,
  ensureRevisionReadRequest,
  ensureSameOrigin,
  evaluateCopyAttachmentQuota,
  gmailProviderHealthStateAllowsSend,
  gmailProviderHealthTransition,
  handleApiError,
  hashSharePassword,
  issueAnonymousParticipantToken,
  issueAccessSession,
  legacyAutomaticSourceRevokeBlocked,
  normalizeAllowedEmails,
  normalizeEmail,
  ownerAttachmentReuseManifest,
  otpCodeDigest,
  participantAllocationQueueSnapshot,
  otpVerificationFailureMinimumResponseMilliseconds,
  padEmailChallengeResponse,
  padOtpVerificationFailureResponse,
  rateLimitWindowStarts,
  recordGmailProviderHealth,
  readJsonBody,
  revalidateParticipantAllocationChallenge,
  resolveAccessIdentity,
  resolveEmailQuotaPolicy,
  resolveSecureShareLiveContentSyncServerFlag,
  safeDisplayName,
  safeParticipantDisplayName,
  secureShareAttachmentBlobPath,
  secureShareEmailReadiness,
  secureShareLiveContentSyncEnabled,
  secureShareLiveContentSyncServerProductionDefault,
  shareManagedBy,
  shareOwnedBy,
  signedOpaqueToken,
  sourceShareGuardId,
  sourceLifecycleAvailable,
  sourceReadAvailable,
  sourceRevisionMatches,
  sourceSnapshotAvailable,
  secureShareRevisionEtag,
  validateCommentBody,
  verificationEmailText,
  verifiedAnonymousParticipantToken,
  verifyDocumentSnapshotWrite,
  verifySharePassword,
  verifySignedOpaqueToken,
  withParticipantAllocationQueue
} from "../../api/public-shares-v2.js";

const backendSource = readFileSync(join(process.cwd(), "api/public-shares-v2.js"), "utf8");
const commonSource = readFileSync(join(process.cwd(), "api/_secure-share-common.js"), "utf8");
const blobSource = readFileSync(join(process.cwd(), "api/blob-attachments.js"), "utf8");

interface TestResponse {
  body: string;
  destroyed: boolean;
  headers: Map<string, string | string[]>;
  headersSent: boolean;
  statusCode: number;
  destroy(): void;
  end(value?: unknown): void;
  setHeader(name: string, value: string | string[]): void;
}

function testResponse(): TestResponse {
  return {
    body: "",
    destroyed: false,
    headers: new Map(),
    headersSent: false,
    statusCode: 0,
    destroy() {
      this.destroyed = true;
    },
    end(value) {
      this.body = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
      this.headersSent = true;
    },
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    }
  };
}

function firestoreValue(value: unknown): Record<string, unknown> {
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number") {
    return { integerValue: String(value) };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, firestoreValue(child)])
        )
      }
    };
  }
  throw new TypeError("Unsupported test Firestore value");
}

function firestoreDocument(
  path: string,
  fields: Record<string, unknown>,
  updateTime = "2026-07-28T00:00:00.000000Z"
) {
  return {
    name: `projects/test-project/databases/(default)/documents/${path}`,
    updateTime,
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, firestoreValue(value)])
    )
  };
}

function fetchResponse(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function stubReadyEmailDelivery() {
  vi.stubEnv("SECURE_SHARE_V2_ENABLED", "true");
  vi.stubEnv("SECURE_SHARE_EMAIL_ENABLED", "true");
  vi.stubEnv("SHARE_EMAIL_PROVIDER", "resend");
  vi.stubEnv("SHARE_EMAIL_API_KEY", "test-provider-key");
  vi.stubEnv("SHARE_EMAIL_FROM", "QuickMemo <share@example.com>");
  vi.stubEnv("SHARE_EMAIL_SENDER_VERIFIED", "true");
  vi.stubEnv("SHARE_OTP_HMAC_KEY", "o".repeat(48));
  vi.stubEnv("SHARE_EMAIL_HMAC_KEY", "e".repeat(48));
  vi.stubEnv("SHARE_RATE_LIMIT_HMAC_KEY", "r".repeat(48));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Secure Share v2 cryptographic primitives", () => {
  it("issues independent CSPRNG participant cookies for one idempotent access identity", () => {
    vi.stubEnv("SHARE_PARTICIPANT_HMAC_KEY", "p".repeat(48));
    const shareId = "share_participant_token_v2";
    const browserBinding = "b".repeat(43);
    const unlockAttemptId = "participant_token_attempt_0001";
    const first = issueAnonymousParticipantToken(
      shareId,
      browserBinding,
      unlockAttemptId
    );
    const second = issueAnonymousParticipantToken(
      shareId,
      browserBinding,
      unlockAttemptId
    );
    const nextAttempt = issueAnonymousParticipantToken(
      shareId,
      browserBinding,
      "participant_token_attempt_0002"
    );

    expect(first.token).toMatch(/^p2_[A-Za-z0-9_-]{129}$/u);
    expect(second.token).toMatch(/^p2_[A-Za-z0-9_-]{129}$/u);
    expect(first.token).not.toBe(second.token);
    expect(first.issuanceIdentity).toBe(second.issuanceIdentity);
    expect(nextAttempt.issuanceIdentity).not.toBe(first.issuanceIdentity);
    expect(verifiedAnonymousParticipantToken(
      shareId,
      first.token
    )).toEqual({
      issuanceIdentity: first.issuanceIdentity,
      version: 2
    });
    expect(verifiedAnonymousParticipantToken(
      shareId,
      second.token
    )).toEqual({
      issuanceIdentity: first.issuanceIdentity,
      version: 2
    });

    const tamperedToken = `${first.token.slice(0, -1)}${
      first.token.endsWith("A") ? "B" : "A"
    }`;
    expect(() => verifiedAnonymousParticipantToken(
      shareId,
      tamperedToken
    )).toThrowError(expect.objectContaining({
      code: "participant_identity_invalid",
      statusCode: 401
    }));
    expect(() => verifiedAnonymousParticipantToken(
      "other-share",
      first.token
    )).toThrowError(expect.objectContaining({
      code: "participant_identity_invalid",
      statusCode: 401
    }));
    expect(() => verifiedAnonymousParticipantToken(
      shareId,
      "a".repeat(43)
    )).toThrowError(expect.objectContaining({
      code: "participant_identity_invalid",
      statusCode: 401
    }));
    expect(() => verifiedAnonymousParticipantToken(
      shareId,
      `p3_${first.token.slice(3)}`
    )).toThrowError(expect.objectContaining({
      code: "participant_identity_invalid",
      statusCode: 401
    }));
  });

  it("derives stable source-share guard ids without exposing owner or note ids", () => {
    vi.stubEnv("SHARE_SESSION_HMAC_KEY", "s".repeat(48));
    const first = sourceShareGuardId("owner_123", "note_123");

    expect(first).toMatch(/^source_[A-Za-z0-9_-]{43}$/u);
    expect(sourceShareGuardId("owner_123", "note_123")).toBe(first);
    expect(sourceShareGuardId("owner_124", "note_123")).not.toBe(first);
    expect(sourceShareGuardId("owner_123", "note_124")).not.toBe(first);
    expect(first).not.toContain("owner_123");
    expect(first).not.toContain("note_123");
  });

  it("derives isolated persistent copy-grant request ids without exposing the raw key", () => {
    vi.stubEnv("SHARE_SESSION_HMAC_KEY", "s".repeat(48));
    const requestKey = "copy_request_attempt_0001";
    const first = copyGrantRequestId("share_123", "user_123", requestKey);

    expect(first).toMatch(/^copy_[A-Za-z0-9_-]{43}$/u);
    expect(copyGrantRequestId("share_123", "user_123", requestKey)).toBe(first);
    expect(copyGrantRequestId("share_124", "user_123", requestKey)).not.toBe(first);
    expect(copyGrantRequestId("share_123", "user_124", requestKey)).not.toBe(first);
    expect(copyGrantRequestId("share_123", "user_123", "copy_request_attempt_0002"))
      .not.toBe(first);
    expect(first).not.toContain(requestKey);
  });

  it("classifies exact copy-grant replay, renewal, and malformed request conflicts", () => {
    const secret = "s".repeat(48);
    const now = 2_000_000_000;
    const requestKey = "copy_request_attempt_0001";
    const requestKeyHash = copyGrantRequestKeyHash(
      "share_123",
      "user_123",
      requestKey,
      secret
    );
    const expected = {
      ownerUid: "owner_123",
      policyVersion: 7,
      requesterUid: "user_123",
      requestKeyHash,
      sessionReferenceHash: "session_reference_123",
      shareId: "share_123"
    };
    const copyGrant = signedOpaqueToken({
      kind: "secure_share_copy_grant",
      shareId: expected.shareId,
      uid: expected.requesterUid,
      policyVersion: expected.policyVersion,
      idempotencyHash: requestKeyHash,
      sessionReferenceHash: expected.sessionReferenceHash
    }, "quickmemo/secure-share/copy-grant/v1", 300, secret, now);
    const requestDocument = {
      schemaVersion: 1,
      shareId: expected.shareId,
      ownerUid: expected.ownerUid,
      requesterUid: expected.requesterUid,
      requestKeyHash,
      sessionReferenceHash: expected.sessionReferenceHash,
      policyVersion: expected.policyVersion,
      grantToken: copyGrant,
      grantTokenHash: copyGrantTokenHash(copyGrant, secret),
      grantIssuedAt: new Date(now * 1000).toISOString(),
      grantExpiresAt: new Date((now + 300) * 1000).toISOString(),
      issuanceGeneration: 1,
      expiresAt: new Date((now + 300 + 24 * 60 * 60) * 1000).toISOString()
    };

    expect(copyGrantRequestDisposition(
      requestDocument,
      expected,
      now,
      secret
    )).toEqual({
      status: "replay",
      copyGrant,
      expiresAt: new Date((now + 300) * 1000).toISOString()
    });
    expect(copyGrantRequestDisposition(
      requestDocument,
      expected,
      now + 285,
      secret
    )).toEqual({ status: "renew" });
    expect(copyGrantRequestDisposition(
      requestDocument,
      { ...expected, sessionReferenceHash: "renewed_session_reference" },
      now,
      secret
    )).toEqual({ status: "renew" });
    expect(copyGrantRequestDisposition(
      requestDocument,
      { ...expected, policyVersion: 8 },
      now,
      secret
    )).toEqual({ status: "renew" });
    expect(copyGrantRequestDisposition(
      { ...requestDocument, grantTokenHash: "tampered" },
      expected,
      now,
      secret
    )).toEqual({ status: "conflict" });

    const auditId = copyGrantAuditEventId("copy_request_doc", copyGrant, secret);
    expect(auditId).toMatch(/^evt_cg_[A-Za-z0-9_-]{43}$/u);
    expect(copyGrantAuditEventId("copy_request_doc", copyGrant, secret)).toBe(auditId);
    expect(copyGrantAuditEventId("copy_request_other", copyGrant, secret)).not.toBe(auditId);
  });

  it("preserves password whitespace and rejects a changed record or pepper version", async () => {
    const pepper = "p".repeat(48);
    const record = await hashSharePassword("  correct horse  ", pepper, "2026-07");

    expect(record).toMatchObject({
      algorithm: "scrypt",
      hashVersion: 1,
      pepperVersion: "2026-07",
      parameters: { N: 131072, r: 8, p: 2, keyLength: 32 }
    });
    expect(await verifySharePassword("  correct horse  ", record, pepper, "2026-07")).toBe(true);
    expect(await verifySharePassword("correct horse", record, pepper, "2026-07")).toBe(false);
    expect(await verifySharePassword("  correct horse  ", record, pepper, "old")).toBe(false);
    expect(await verifySharePassword("  correct horse  ", {
      ...record,
      digest: `${record.digest.startsWith("A") ? "B" : "A"}${record.digest.slice(1)}`
    }, pepper, "2026-07")).toBe(false);
  }, 15_000);

  it("canonicalizes IDN email domains without provider-specific alias rewriting", () => {
    expect(normalizeEmail(" User.Name+tag@BÜCHER.DE ")).toBe(
      "user.name+tag@xn--bcher-kva.de"
    );
    expect(normalizeAllowedEmails([
      "USER@example.com",
      "user@example.com",
      "second@example.com"
    ])).toEqual(["second@example.com", "user@example.com"]);
    expect(() => normalizeEmail("user@localhost")).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    );
    for (const invalid of [
      ".user@example.com",
      "user..name@example.com",
      "user\u00a0@example.com"
    ]) {
      expect(() => normalizeEmail(invalid)).toThrowError(
        expect.objectContaining({ statusCode: 400, code: "invalid_email" })
      );
    }
  });

  it("does not let a verified Firebase caller bypass a required email OTP", async () => {
    vi.stubEnv("VITE_FIREBASE_API_KEY", "test-web-api-key");
    stubReadyEmailDelivery();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/accounts:lookup")) {
        return fetchResponse(200, {
          users: [{
            email: "verified@example.com",
            emailVerified: true,
            localId: "user-a",
            providerUserInfo: [{ providerId: "password" }]
          }]
        });
      }
      if (url.includes("/documents/users/user-a")) {
        return fetchResponse(200, firestoreDocument("users/user-a", {
          displayName: "Verified user",
          featureAccess: { notes: true },
          isActive: true
        }));
      }
      if (url.includes("/documents/secureShareEmailSettings/current")) {
        return fetchResponse(404);
      }
      throw new Error(`Unexpected identity request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const accessMode of ["anyone_with_link", "allowed_emails"]) {
      await expect(resolveAccessIdentity(
        { headers: { authorization: "Bearer firebase-id-token-for-test" } },
        { accessToken: "management-token", projectId: "test-project" },
        "share-a",
        {
          accessMode,
          allowedEmailHashes: [],
          emailVerificationRequired: true,
          policyVersion: 1
        },
        {},
        {
          now: () => 0,
          random: () => 3_000,
          wait: async () => undefined
        }
      )).rejects.toMatchObject({ statusCode: 403, code: "access_denied" });
    }

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("prefers an active QuickMemo caller identity after the required OTP succeeds", async () => {
    stubReadyEmailDelivery();
    vi.stubEnv("VITE_FIREBASE_API_KEY", "test-web-api-key");
    vi.stubEnv("SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED", "true");
    vi.stubEnv("SHARE_PARTICIPANT_HMAC_KEY", "p".repeat(48));
    vi.stubEnv("SHARE_SESSION_HMAC_KEY", "s".repeat(48));
    const shareId = "share-caller-otp";
    const firstChallengeId = "ch_caller_otp_a";
    const secondChallengeId = "ch_caller_otp_b";
    const firstEmailHash = emailDigest("first@example.test");
    const secondEmailHash = emailDigest("second@example.test");
    const challenges = new Map([
      [
        firstChallengeId,
        firestoreDocument(`publicShareEmailChallenges/${firstChallengeId}`, {
          attempts: 0,
          codeDigest: otpCodeDigest(
            firstChallengeId,
            shareId,
            firstEmailHash,
            "135790"
          ),
          emailHash: firstEmailHash,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          policyVersion: 3,
          sendAttemptId: "send_caller_otp_a",
          shareId,
          status: "pending"
        })
      ],
      [
        secondChallengeId,
        firestoreDocument(`publicShareEmailChallenges/${secondChallengeId}`, {
          attempts: 0,
          codeDigest: otpCodeDigest(
            secondChallengeId,
            shareId,
            secondEmailHash,
            "246801"
          ),
          emailHash: secondEmailHash,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          policyVersion: 3,
          sendAttemptId: "send_caller_otp_b",
          shareId,
          status: "pending"
        })
      ]
    ]);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/accounts:lookup")) {
        return fetchResponse(200, {
          users: [{
            email: "signed-in@example.test",
            emailVerified: true,
            localId: "user-caller-otp",
            providerUserInfo: [{ providerId: "password" }]
          }]
        });
      }
      if (url.includes("/documents/users/user-caller-otp")) {
        return fetchResponse(200, firestoreDocument("users/user-caller-otp", {
          displayName: "Signed-in caller",
          featureAccess: { notes: true },
          isActive: true
        }));
      }
      const challenge = challenges.get(url.split("/").at(-1) ?? "");
      return challenge ? fetchResponse(200, challenge) : fetchResponse(404);
    }));
    const policy = {
      accessMode: "allowed_emails",
      allowedEmailHashes: [firstEmailHash, secondEmailHash],
      emailVerificationRequired: true,
      permissionLevel: "comment",
      policyVersion: 3
    };
    const request = {
      headers: { authorization: "Bearer firebase-id-token-for-test" }
    };

    const first = await resolveAccessIdentity(
      request,
      { accessToken: "management-token", projectId: "test-project" },
      shareId,
      policy,
      { challengeId: firstChallengeId, otp: "135790" }
    );
    const second = await resolveAccessIdentity(
      request,
      { accessToken: "management-token", projectId: "test-project" },
      shareId,
      policy,
      { challengeId: secondChallengeId, otp: "246801" }
    );

    expect(first).toMatchObject({
      authorUid: "user-caller-otp",
      challenge: expect.objectContaining({ __id: firstChallengeId }),
      identityType: "quickmemo_user"
    });
    expect(second).toMatchObject({
      authorUid: "user-caller-otp",
      challenge: expect.objectContaining({ __id: secondChallengeId }),
      identityType: "quickmemo_user"
    });
    expect(first.identityHash).toBe(second.identityHash);
    expect(first.participantIdentityHash).toBe(second.participantIdentityHash);
    expect(first.participantIdentityHash).not.toBe("");
  });

  it("rejects share owners and administrators inside public identity resolution", async () => {
    vi.stubEnv("VITE_FIREBASE_API_KEY", "test-web-api-key");
    const ownerToken = "firebaseownertokenfortest";
    const adminToken = "firebaseadmintokenfortest";
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/accounts:lookup")) {
        const token = String(JSON.parse(String(init?.body)).idToken);
        const localId = token === adminToken ? "admin-a" : "owner-a";
        return fetchResponse(200, {
          users: [{
            email: `${localId}@example.test`,
            emailVerified: true,
            localId,
            providerUserInfo: [{ providerId: "password" }]
          }]
        });
      }
      if (url.includes("/documents/users/owner-a")) {
        return fetchResponse(200, firestoreDocument("users/owner-a", {
          displayName: "Share owner",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: false
        }));
      }
      if (url.includes("/documents/users/admin-a")) {
        return fetchResponse(200, firestoreDocument("users/admin-a", {
          displayName: "Administrator",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: true
        }));
      }
      throw new Error(`Unexpected manager identity request: ${url}`);
    }));
    const state = {
      share: {
        __id: "share-manager-guard",
        ownerUid: "owner-a"
      },
      policy: {
        accessMode: "anyone_with_link",
        emailVerificationRequired: false,
        ownerUid: "owner-a",
        permissionLevel: "comment",
        policyVersion: 1
      }
    };

    for (const token of [ownerToken, adminToken]) {
      await expect(resolveAccessIdentity(
        { headers: { authorization: `Bearer ${token}` } },
        { accessToken: "management-token", projectId: "test-project" },
        "share-manager-guard",
        state,
        { unlockAttemptId: "manager_public_access_attempt_0001" }
      )).rejects.toMatchObject({
        code: "owner_preview_required",
        statusCode: 409
      });
    }
  });

  it("keeps a signed participant cookie valid after the browser binding rotates", async () => {
    const {
      browserBindingCookieName,
      participantCookieName
    } = await vi.importActual<{
      browserBindingCookieName(
        shareId: string,
        request: { headers?: Record<string, string> }
      ): string;
      participantCookieName(
        shareId: string,
        request: { headers?: Record<string, string> }
      ): string;
    }>("../../api/_secure-share-common.js");
    vi.stubEnv("SECURE_SHARE_V2_ENABLED", "true");
    vi.stubEnv("SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED", "true");
    vi.stubEnv("SHARE_COOKIE_NAME_HMAC_KEY", "k".repeat(48));
    vi.stubEnv("SHARE_PARTICIPANT_HMAC_KEY", "p".repeat(48));
    vi.stubEnv("SHARE_SESSION_HMAC_KEY", "s".repeat(48));
    const shareId = "share-binding-rotation";
    const policy = {
      accessMode: "anyone_with_link",
      emailVerificationRequired: false,
      permissionLevel: "comment",
      policyVersion: 1
    };
    const requestShape = { headers: { host: "localhost" } };
    const bindingName = browserBindingCookieName(shareId, requestShape);
    const participantName = participantCookieName(shareId, requestShape);
    const firstBinding = "a".repeat(43);
    const rotatedBinding = "b".repeat(43);
    const first = await resolveAccessIdentity(
      {
        headers: {
          cookie: `${bindingName}=${firstBinding}`,
          host: "localhost"
        }
      },
      { accessToken: "management-token", projectId: "test-project" },
      shareId,
      policy,
      { unlockAttemptId: "binding_rotation_initial_attempt_0001" }
    );
    const reused = await resolveAccessIdentity(
      {
        headers: {
          cookie: `${bindingName}=${rotatedBinding}; ${participantName}=${first.participantToken}`,
          host: "localhost"
        }
      },
      { accessToken: "management-token", projectId: "test-project" },
      shareId,
      policy,
      { unlockAttemptId: "binding_rotation_reuse_attempt_0002" }
    );

    expect(first.participantToken).toMatch(/^p2_[A-Za-z0-9_-]{129}$/u);
    expect(reused).toMatchObject({
      identityHash: first.identityHash,
      participantIdentityHash: first.participantIdentityHash,
      participantTokenDigest: first.participantTokenDigest,
      setParticipantCookie: false
    });
  });

  it("reuses a caller verified by the access guard without a second auth lookup", async () => {
    vi.stubEnv("SHARE_SESSION_HMAC_KEY", "s".repeat(48));
    const fetchMock = vi.fn(async () => {
      throw new Error("preverified caller must not trigger another lookup");
    });
    vi.stubGlobal("fetch", fetchMock);
    const caller = {
      uid: "viewer-a",
      email: "viewer-a@example.test",
      emailVerified: true,
      displayName: "Viewer A",
      profileDisplayName: "Viewer A",
      isAdmin: false
    };
    const identity = await resolveAccessIdentity(
      { headers: { authorization: "Bearer already-verified-token" } },
      { accessToken: "management-token", projectId: "test-project" },
      "share-preverified-caller",
      {
        share: {
          __id: "share-preverified-caller",
          ownerUid: "owner-a"
        },
        policy: {
          accessMode: "anyone_with_link",
          emailVerificationRequired: false,
          permissionLevel: "comment",
          policyVersion: 1
        }
      },
      { unlockAttemptId: "preverified_caller_access_attempt_0001" },
      undefined,
      caller
    );

    expect(identity).toMatchObject({
      authorUid: "viewer-a",
      caller,
      identityType: "quickmemo_user"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("domain-separates email and OTP HMACs without embedding the raw value", () => {
    const emailKey = "e".repeat(48);
    const otpKey = "o".repeat(48);
    const normalized = normalizeEmail("person@example.com");
    const first = emailDigest(normalized, emailKey);
    const second = emailDigest(normalized, emailKey);

    expect(first).toBe(second);
    expect(first).not.toContain(normalized);
    expect(emailDigest("other@example.com", emailKey)).not.toBe(first);
    expect(otpCodeDigest("challenge-a", "share-a", first, "123456", otpKey)).not.toBe(
      otpCodeDigest("challenge-b", "share-a", first, "123456", otpKey)
    );
  });

  it("signs short-lived grants and fails closed on tamper, expiry, user, session, and policy changes", () => {
    const secret = "s".repeat(48);
    const purpose = "quickmemo/test/copy-grant/v1";
    const now = Math.floor(Date.now() / 1000);
    const token = signedOpaqueToken({
      kind: "secure_share_copy_grant",
      shareId: "share-a",
      uid: "user-a",
      policyVersion: 7,
      sessionReferenceHash: "session-reference"
    }, purpose, 300, secret, now);
    const grant = verifySignedOpaqueToken(token, purpose, secret, now);
    const context = {
      ownerPreview: false,
      permissionLevel: "save_copy",
      policyVersion: 7,
      sessionReferenceHash: "session-reference",
      shareId: "share-a",
      uid: "user-a"
    };

    expect(grant).not.toBeNull();
    expect(copyGrantAuthorizesDownload(grant, context)).toBe(true);
    expect(copyGrantAuthorizesDownload(grant, { ...context, uid: "user-b" })).toBe(false);
    expect(copyGrantAuthorizesDownload(grant, { ...context, policyVersion: 8 })).toBe(false);
    expect(copyGrantAuthorizesDownload(grant, {
      ...context,
      sessionReferenceHash: "other-session"
    })).toBe(false);
    expect(copyGrantAuthorizesDownload(grant, { ...context, ownerPreview: true })).toBe(false);
    expect(verifySignedOpaqueToken(
      `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
      purpose,
      secret,
      now
    )).toBeNull();
    expect(verifySignedOpaqueToken(token, purpose, secret, now + 301)).toBeNull();
  });
});

describe("Secure Share participant allocation queue", () => {
  it("serializes one share, keeps different shares parallel, and advances after predecessor failure", async () => {
    let sameShareActive = 0;
    let sameShareMaximum = 0;
    const completionOrder: number[] = [];
    const sameShareResults = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        withParticipantAllocationQueue("queue_same_share", async () => {
          sameShareActive += 1;
          sameShareMaximum = Math.max(sameShareMaximum, sameShareActive);
          await new Promise((resolve) => setTimeout(resolve, 1));
          completionOrder.push(index);
          sameShareActive -= 1;
          return index;
        })
      )
    );
    expect(sameShareMaximum).toBe(1);
    expect(completionOrder).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(sameShareResults).toEqual(completionOrder);

    let differentShareActive = 0;
    let differentShareMaximum = 0;
    await Promise.all(["queue_share_a", "queue_share_b"].map((shareId) =>
      withParticipantAllocationQueue(shareId, async () => {
        differentShareActive += 1;
        differentShareMaximum = Math.max(
          differentShareMaximum,
          differentShareActive
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        differentShareActive -= 1;
      })
    ));
    expect(differentShareMaximum).toBe(2);

    let rejectPredecessor: (error: Error) => void = () => undefined;
    const predecessorBlocker = new Promise<never>((_resolve, reject) => {
      rejectPredecessor = reject;
    });
    const predecessor = withParticipantAllocationQueue(
      "queue_error_release",
      async () => {
        await predecessorBlocker;
      }
    );
    let successorStarted = false;
    const successor = withParticipantAllocationQueue(
      "queue_error_release",
      async () => {
        successorStarted = true;
        return "released";
      }
    );
    rejectPredecessor(new Error("synthetic queue failure"));
    await expect(predecessor).rejects.toThrow("synthetic queue failure");
    await expect(successor).resolves.toBe("released");
    expect(successorStarted).toBe(true);
    expect(participantAllocationQueueSnapshot()).toEqual({
      liveShareKeys: 0,
      totalEntries: 0
    });
  });

  it("caps each share at 32 entries including active and returns a randomized Retry-After", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstBlocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queued = Array.from({ length: 32 }, (_, index) =>
      withParticipantAllocationQueue("queue_pending_cap", async () => {
        if (index === 0) {
          await firstBlocker;
        }
        return index;
      })
    );

    await expect(withParticipantAllocationQueue(
      "queue_pending_cap",
      async () => 33
    )).rejects.toSatisfy((error: unknown) =>
      error instanceof HttpError
      && error.statusCode === 429
      && error.code === "rate_limited"
      && Number.isInteger(error.retryAfter)
      && (error.retryAfter ?? 0) >= 2
      && (error.retryAfter ?? 0) <= 5
    );
    releaseFirst();
    await expect(Promise.all(queued)).resolves.toEqual(
      Array.from({ length: 32 }, (_, index) => index)
    );
    expect(participantAllocationQueueSnapshot()).toEqual({
      liveShareKeys: 0,
      totalEntries: 0
    });
  });

  it("caps live share keys at 64 and total queued plus active work at 256", async () => {
    let releaseShareCap: () => void = () => undefined;
    const shareCapBlocker = new Promise<void>((resolve) => {
      releaseShareCap = resolve;
    });
    const liveShares = Array.from({ length: 64 }, (_, index) =>
      withParticipantAllocationQueue(`queue_live_share_${index}`, async () => {
        await shareCapBlocker;
        return index;
      })
    );
    expect(participantAllocationQueueSnapshot()).toEqual({
      liveShareKeys: 64,
      totalEntries: 64
    });
    await expect(withParticipantAllocationQueue(
      "queue_live_share_overflow",
      async () => "overflow"
    )).rejects.toMatchObject({
      code: "rate_limited",
      statusCode: 429
    });
    releaseShareCap();
    await Promise.all(liveShares);

    let releaseTotalCap: () => void = () => undefined;
    const totalCapBlocker = new Promise<void>((resolve) => {
      releaseTotalCap = resolve;
    });
    const totalEntries = Array.from({ length: 8 }, (_, shareIndex) =>
      Array.from({ length: 32 }, (_, entryIndex) =>
        withParticipantAllocationQueue(
          `queue_total_share_${shareIndex}`,
          async () => {
            if (entryIndex === 0) {
              await totalCapBlocker;
            }
            return `${shareIndex}:${entryIndex}`;
          }
        )
      )
    ).flat();
    expect(participantAllocationQueueSnapshot()).toEqual({
      liveShareKeys: 8,
      totalEntries: 256
    });
    await expect(withParticipantAllocationQueue(
      "queue_total_overflow",
      async () => "overflow"
    )).rejects.toMatchObject({
      code: "rate_limited",
      statusCode: 429
    });
    releaseTotalCap();
    await Promise.all(totalEntries);
    expect(participantAllocationQueueSnapshot()).toEqual({
      liveShareKeys: 0,
      totalEntries: 0
    });
  });

  it("removes disconnected pending request/response work without cancelling active work", async () => {
    let releaseActive: () => void = () => undefined;
    const activeBlocker = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const active = withParticipantAllocationQueue(
      "queue_disconnect",
      async () => {
        await activeBlocker;
        return "active-finished";
      }
    );
    const request = Object.assign(new EventEmitter(), {
      aborted: false,
      complete: false,
      destroyed: false
    });
    let requestPendingStarted = false;
    const requestPending = withParticipantAllocationQueue(
      "queue_disconnect",
      async () => {
        requestPendingStarted = true;
        return "should-not-run";
      },
      request
    );
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false
    });
    let responsePendingStarted = false;
    const responsePending = withParticipantAllocationQueue(
      "queue_disconnect",
      async () => {
        responsePendingStarted = true;
        return "should-not-run";
      },
      undefined,
      response
    );
    request.aborted = true;
    request.destroyed = true;
    request.emit("aborted");
    response.destroyed = true;
    response.emit("close");
    await expect(requestPending).rejects.toMatchObject({
      code: "rate_limited",
      statusCode: 429
    });
    await expect(responsePending).rejects.toMatchObject({
      code: "rate_limited",
      statusCode: 429
    });
    expect(requestPendingStarted).toBe(false);
    expect(responsePendingStarted).toBe(false);
    expect(participantAllocationQueueSnapshot()).toEqual({
      liveShareKeys: 1,
      totalEntries: 1
    });
    releaseActive();
    await expect(active).resolves.toBe("active-finished");
    expect(participantAllocationQueueSnapshot()).toEqual({
      liveShareKeys: 0,
      totalEntries: 0
    });
  });

  it("times pending work out after 15 seconds", async () => {
    vi.useFakeTimers();
    try {
      let releaseActive: () => void = () => undefined;
      const activeBlocker = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      const active = withParticipantAllocationQueue(
        "queue_wait_timeout",
        async () => {
          await activeBlocker;
          return "active";
        }
      );
      const pending = withParticipantAllocationQueue(
        "queue_wait_timeout",
        async () => "pending"
      );
      const pendingResult = expect(pending).rejects.toMatchObject({
        code: "rate_limited",
        statusCode: 429
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await pendingResult;
      expect(participantAllocationQueueSnapshot()).toEqual({
        liveShareKeys: 1,
        totalEntries: 1
      });
      releaseActive();
      await expect(active).resolves.toBe("active");
      expect(participantAllocationQueueSnapshot()).toEqual({
        liveShareKeys: 0,
        totalEntries: 0
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports a timeout while active work may still commit and holds the gate", async () => {
    vi.useFakeTimers();
    try {
      let releaseActive: () => void = () => undefined;
      const activeBlocker = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      let activeSignal: AbortSignal | undefined;
      const active = withParticipantAllocationQueue(
        "queue_settlement_budget",
        async ({ signal }) => {
          activeSignal = signal;
          await activeBlocker;
          return "late-success";
        }
      );
      let activeSettled = false;
      void active.then(
        () => {
          activeSettled = true;
        },
        () => {
          activeSettled = true;
        }
      );
      await vi.advanceTimersByTimeAsync(14_000);
      let successorStarted = false;
      const successor = withParticipantAllocationQueue(
        "queue_settlement_budget",
        async () => {
          successorStarted = true;
          return "successor";
        }
      );
      await vi.advanceTimersByTimeAsync(11_000);
      expect(activeSettled).toBe(false);
      expect(successorStarted).toBe(false);
      expect(activeSignal?.aborted).toBe(false);
      expect(participantAllocationQueueSnapshot()).toEqual({
        liveShareKeys: 1,
        totalEntries: 2
      });
      releaseActive();
      await vi.advanceTimersByTimeAsync(0);
      await expect(active).resolves.toBe("late-success");
      await expect(successor).resolves.toBe("successor");
      expect(successorStarted).toBe(true);
      expect(participantAllocationQueueSnapshot()).toEqual({
        liveShareKeys: 0,
        totalEntries: 0
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("revalidates queued policy state at execution time and documents cross-isolate authority", async () => {
    let releasePredecessor: () => void = () => undefined;
    const predecessorBlocker = new Promise<void>((resolve) => {
      releasePredecessor = resolve;
    });
    const predecessor = withParticipantAllocationQueue(
      "queue_policy_change",
      async () => {
        await predecessorBlocker;
      }
    );
    let policyActive = true;
    const successor = withParticipantAllocationQueue(
      "queue_policy_change",
      async () => {
        if (!policyActive) {
          throw new HttpError(404, "share_unavailable");
        }
        return "unsafe-success";
      }
    );
    policyActive = false;
    releasePredecessor();
    await predecessor;
    await expect(successor).rejects.toMatchObject({
      code: "share_unavailable",
      statusCode: 404
    });

    const queueSource = backendSource.match(
      /function participantAllocationQueueRetryAfter[\s\S]*?async function issueAccessSession/u
    )?.[0] ?? "";
    const issueSource = backendSource.match(
      /async function issueAccessSession[\s\S]*?async function handleAccess/u
    )?.[0] ?? "";
    expect(queueSource).toContain(
      "Every operation keeps\n  // its Firestore transaction as the cross-isolate authorization authority."
    );
    expect(issueSource).toContain("const state = await loadShareState(context, shareId)");
    expect(issueSource).toContain("assertPublicShareAvailable(state)");
    expect(issueSource).toContain(
      "firestoreCommit(context, writes, participantAllocation.transaction)"
    );
  });
});

describe("Secure Share v2 request boundary", () => {
  it("enables live sync from the trusted source default with exact false rollback", async () => {
    expect(secureShareLiveContentSyncServerProductionDefault).toBe(true);
    expect(secureShareLiveContentSyncEnabled()).toBe(true);
    expect(secureShareLiveContentSyncEnabled("true")).toBe(true);
    expect(secureShareLiveContentSyncEnabled("false")).toBe(false);
    expect(resolveSecureShareLiveContentSyncServerFlag(false, "true")).toBe(false);
    expect(resolveSecureShareLiveContentSyncServerFlag(true, undefined)).toBe(true);
    expect(resolveSecureShareLiveContentSyncServerFlag(true, "true")).toBe(true);
    expect(resolveSecureShareLiveContentSyncServerFlag(true, "false")).toBe(false);
    expect(resolveSecureShareLiveContentSyncServerFlag(true, "TRUE")).toBe(false);

    vi.stubEnv("SECURE_SHARE_V2_ENABLED", "true");
    vi.stubEnv("SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED", "true");

    const statusResponse = testResponse();
    await handler({
      method: "GET",
      url: "/api/public-shares-v2?action=live-sync-status",
      headers: {}
    }, statusResponse);
    expect(statusResponse.statusCode).toBe(200);
    expect(JSON.parse(statusResponse.body)).toEqual({ enabled: true });

    vi.stubEnv("SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED", "false");
    const rollbackStatusResponse = testResponse();
    await handler({
      method: "GET",
      url: "/api/public-shares-v2?action=live-sync-status",
      headers: {}
    }, rollbackStatusResponse);
    expect(rollbackStatusResponse.statusCode).toBe(200);
    expect(JSON.parse(rollbackStatusResponse.body)).toEqual({ enabled: false });
  });

  it("serves feature status with all other backend configuration absent", async () => {
    vi.stubEnv("SECURE_SHARE_V2_ENABLED", "false");
    vi.stubEnv("SECURE_SHARE_EMAIL_ENABLED", "true");
    const response = testResponse();

    await handler({
      method: "GET",
      url: "/api/public-shares-v2?action=feature-status",
      headers: {}
    }, response);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ v2Enabled: false, emailEnabled: false });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("rejects wrong methods and unknown query fields before backend credentials are used", async () => {
    const wrongMethod = testResponse();
    await handler({
      method: "POST",
      url: "/api/public-shares-v2?action=feature-status",
      headers: {}
    }, wrongMethod);
    expect(wrongMethod.statusCode).toBe(405);
    expect(JSON.parse(wrongMethod.body)).toMatchObject({ ok: false, error: "method_not_allowed" });

    const unknownQuery = testResponse();
    await handler({
      method: "GET",
      url: "/api/public-shares-v2?action=feature-status&extra=1",
      headers: {}
    }, unknownQuery);
    expect(unknownQuery.statusCode).toBe(400);
    expect(JSON.parse(unknownQuery.body)).toMatchObject({ ok: false, error: "invalid_request" });
  });

  it("rejects malformed JSON, prototype keys, and unknown fields", async () => {
    await expect(readJsonBody({
      body: "{\"broken\":",
      headers: { "content-type": "application/json" }
    })).rejects.toMatchObject({ statusCode: 400, code: "invalid_request" });
    await expect(readJsonBody({
      body: "{\"__proto__\":{\"polluted\":true}}",
      headers: { "content-type": "application/json" }
    })).rejects.toMatchObject({ statusCode: 400, code: "invalid_request" });
    expect(() => assertOnlyKeys({ allowed: true, extra: true }, ["allowed"])).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("requires an exact allowlisted same origin and same-origin fetch metadata", () => {
    vi.stubEnv("SECURE_SHARE_ALLOWED_ORIGINS", "https://quickmemo.example");
    expect(() => ensureSameOrigin({
      headers: {
        origin: "https://quickmemo.example",
        "sec-fetch-site": "same-origin"
      }
    })).not.toThrow();
    expect(() => ensureSameOrigin({
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site"
      }
      })).toThrowError(expect.objectContaining({ statusCode: 403 }));
  });

  it("requires the revision marker and same-origin fetch metadata without requiring Origin", () => {
    vi.stubEnv("SECURE_SHARE_ALLOWED_ORIGINS", "https://quickmemo.example");
    expect(() => ensureRevisionReadRequest({
      headers: {
        "sec-fetch-site": "same-origin",
        "x-quickmemo-secure-share-revision": "1"
      }
    })).not.toThrow();
    expect(() => ensureRevisionReadRequest({
      headers: {
        "sec-fetch-site": "same-origin"
      }
    })).toThrowError(expect.objectContaining({ statusCode: 403 }));
    expect(() => ensureRevisionReadRequest({
      headers: {
        "sec-fetch-site": "cross-site",
        "x-quickmemo-secure-share-revision": "1"
      }
    })).toThrowError(expect.objectContaining({ statusCode: 403 }));
    expect(() => ensureRevisionReadRequest({
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "same-origin",
        "x-quickmemo-secure-share-revision": "1"
      }
    })).toThrowError(expect.objectContaining({ statusCode: 403 }));
  });

  it("returns generic retry metadata and never writes a second response after streaming starts", () => {
    const rateLimited = testResponse();
    handleApiError(
      new HttpError(429, "rate_limited", "internal bucket detail", { retryAfter: 37 }),
      rateLimited,
      "request-a"
    );
    expect(rateLimited.statusCode).toBe(429);
    expect(rateLimited.headers.get("retry-after")).toBe("37");
    expect(JSON.parse(rateLimited.body)).toEqual({
      ok: false,
      error: "rate_limited",
      requestId: "request-a"
    });

    const streaming = testResponse();
    streaming.headersSent = true;
    handleApiError(
      new HttpError(502, "upstream_stream_failed", "generic stream failure", { expose: false }),
      streaming,
      "request-b"
    );
    expect(streaming.destroyed).toBe(true);
    expect(streaming.body).toBe("");
  });

  it("fails closed when an email policy is requested while email delivery is not ready", async () => {
    vi.stubEnv("SECURE_SHARE_V2_ENABLED", "true");
    vi.stubEnv("SECURE_SHARE_EMAIL_ENABLED", "false");
    await expect(buildPolicySettings({
      accessMode: "allowed_emails",
      allowedEmails: ["person@example.com"],
      passwordEnabled: false
    })).rejects.toMatchObject({ statusCode: 503, code: "email_feature_unavailable" });
  });

  it("fails closed for existing email-gated policies and sessions while email is disabled", () => {
    vi.stubEnv("SECURE_SHARE_V2_ENABLED", "true");
    vi.stubEnv("SECURE_SHARE_EMAIL_ENABLED", "false");
    expect(() => assertEmailPolicyAvailable({
      accessMode: "allowed_emails",
      emailVerificationRequired: true
    })).toThrowError(expect.objectContaining({
      statusCode: 503,
      code: "email_feature_unavailable"
    }));
    expect(() => assertEmailPolicyAvailable({
      accessMode: "authenticated_users",
      emailVerificationRequired: true
    })).toThrowError(expect.objectContaining({
      statusCode: 503,
      code: "email_feature_unavailable"
    }));
    expect(() => assertEmailPolicyAvailable({
      accessMode: "authenticated_users",
      emailVerificationRequired: false
    })).not.toThrow();
  });
});

describe("Secure Share v2 email and identity defenses", () => {
  it("pads both fast and slower provider paths to the same randomized envelope", async () => {
    const target = emailChallengeMinimumResponseMilliseconds(() => 3_042);
    const fastWait = vi.fn(async () => undefined);
    const slowWait = vi.fn(async () => undefined);

    await expect(padEmailChallengeResponse(0, target, () => 100, fastWait)).resolves.toBe(target);
    await expect(padEmailChallengeResponse(0, target, () => 700, slowWait)).resolves.toBe(target);
    expect(fastWait).toHaveBeenCalledWith(target - 100);
    expect(slowWait).toHaveBeenCalledWith(target - 700);
    expect(target).toBe(3_042);
    expect(() => emailChallengeMinimumResponseMilliseconds(() => 2_799)).toThrowError(
      expect.objectContaining({ statusCode: 500 })
    );
    const challengeHandler = backendSource.match(
      /async function handleEmailChallenge[\s\S]*?async function verifiedChallengeIdentity/u
    )?.[0] ?? "";
    expect(challengeHandler).toContain(
      "const minimumResponseMilliseconds = emailChallengeMinimumResponseMilliseconds()"
    );
    expect(challengeHandler).not.toContain("emailChallengeMinimumResponseMilliseconds(code)");
  });

  it("uses one randomized envelope and equal-cost state updates for rejected OTP candidates", async () => {
    const target = otpVerificationFailureMinimumResponseMilliseconds(() => 3_017);
    const fastWait = vi.fn(async () => undefined);
    const slowWait = vi.fn(async () => undefined);

    await expect(
      padOtpVerificationFailureResponse(0, target, () => 125, fastWait)
    ).resolves.toBe(target);
    await expect(
      padOtpVerificationFailureResponse(0, target, () => 1_125, slowWait)
    ).resolves.toBe(target);
    expect(fastWait).toHaveBeenCalledWith(target - 125);
    expect(slowWait).toHaveBeenCalledWith(target - 1_125);
    expect(() => otpVerificationFailureMinimumResponseMilliseconds(() => 3_201)).toThrowError(
      expect.objectContaining({ statusCode: 500 })
    );

    const failureRecorder = backendSource.match(
      /async function incrementChallengeFailure[\s\S]*?async function verifiedChallengeIdentity/u
    )?.[0] ?? "";
    const verifier = backendSource.match(
      /async function verifiedChallengeIdentity[\s\S]*?async function resolveAccessIdentity/u
    )?.[0] ?? "";
    expect(failureRecorder).toContain('new Set(["pending", "suppressed", "send_failed"])');
    expect(failureRecorder).toContain('const status = attempts >= 5 ? "locked" : challenge.status');
    expect(verifier).toContain(
      "const minimumResponseMilliseconds = otpVerificationFailureMinimumResponseMilliseconds(random)"
    );
    expect(verifier.indexOf("otpVerificationFailureMinimumResponseMilliseconds(random)")).toBeLessThan(
      verifier.indexOf("await firestoreGet(")
    );
    expect(verifier).toContain("await incrementChallengeFailure(context, challengeId)");
    expect(verifier).toContain(
      "await padOtpVerificationFailureResponse("
    );
    expect(verifier).not.toContain('challenge.status === "pending"');
    expect(verifier).not.toContain("const digestMatches = validShape &&");
    expect(verifier.match(/return rejectVerification\(\)/gu)).toHaveLength(3);
    expect(verifier.match(/new HttpError\(403/gu)).toHaveLength(1);
    expect(verifier).toContain('new Set(["pending", "consumed"]).has(challenge.status)');
  });

  it("rejects pending and suppressed OTP candidates with the same padded failure contract", async () => {
    stubReadyEmailDelivery();
    const pendingChallengeId = "ch_pending_candidate";
    const suppressedChallengeId = "ch_suppressed_candidate";
    const pendingEmailHash = "pending-email-hash";
    const suppressedEmailHash = "suppressed-email-hash";
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const challenges = new Map([
      [
        pendingChallengeId,
        firestoreDocument(`publicShareEmailChallenges/${pendingChallengeId}`, {
          attempts: 0,
          codeDigest: otpCodeDigest(
            pendingChallengeId,
            "share-a",
            pendingEmailHash,
            "654321"
          ),
          emailHash: pendingEmailHash,
          expiresAt,
          policyVersion: 7,
          shareId: "share-a",
          status: "pending"
        })
      ],
      [
        suppressedChallengeId,
        firestoreDocument(`publicShareEmailChallenges/${suppressedChallengeId}`, {
          attempts: 0,
          codeDigest: "",
          emailHash: suppressedEmailHash,
          expiresAt,
          policyVersion: 7,
          shareId: "share-a",
          status: "suppressed"
        })
      ]
    ]);
    const commitBodies: Array<{
      writes: Array<{ update?: { fields?: Record<string, { stringValue?: string }> } }>;
    }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      if (url.endsWith("/documents:commit")) {
        commitBodies.push(JSON.parse(String(init?.body)));
        return fetchResponse(200, { commitTime: new Date().toISOString() });
      }
      const challengeId = url.split("/").at(-1) ?? "";
      const challenge = challenges.get(challengeId);
      return challenge ? fetchResponse(200, challenge) : fetchResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const pendingWait = vi.fn(async () => undefined);
    const suppressedWait = vi.fn(async () => undefined);
    const policy = {
      accessMode: "allowed_emails",
      allowedEmailHashes: [pendingEmailHash],
      emailVerificationRequired: true,
      policyVersion: 7
    };
    const context = { accessToken: "management-token", projectId: "test-project" };
    const request = { headers: {} };

    await expect(resolveAccessIdentity(
      request,
      context,
      "share-a",
      policy,
      { challengeId: pendingChallengeId, otp: "000000" },
      {
        now: () => 0,
        random: () => 3_000,
        wait: pendingWait
      }
    )).rejects.toMatchObject({ statusCode: 403, code: "access_denied" });
    await expect(resolveAccessIdentity(
      request,
      context,
      "share-a",
      policy,
      { challengeId: suppressedChallengeId, otp: "000000" },
      {
        now: () => 0,
        random: () => 3_000,
        wait: suppressedWait
      }
    )).rejects.toMatchObject({ statusCode: 403, code: "access_denied" });

    expect(pendingWait).toHaveBeenCalledExactlyOnceWith(3_000);
    expect(suppressedWait).toHaveBeenCalledExactlyOnceWith(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(commitBodies).toHaveLength(2);
    expect(commitBodies[0]?.writes[0]?.update?.fields?.status?.stringValue).toBe("pending");
    expect(commitBodies[1]?.writes[0]?.update?.fields?.status?.stringValue).toBe("suppressed");
  });

  it("reports provider readiness without exposing credentials and formats the configured OTP TTL", () => {
    stubReadyEmailDelivery();
    vi.stubEnv("SHARE_EMAIL_API_KEY", "test-key-never-returned");

    expect(secureShareEmailReadiness()).toEqual({
      ready: true,
      v2Enabled: true,
      featureEnabled: true,
      providerConfigured: true,
      secretsConfigured: true,
      senderVerified: true,
      freeTierMode: false
    });
    expect(JSON.stringify(secureShareEmailReadiness())).not.toContain("test-key-never-returned");
    vi.stubEnv("SHARE_EMAIL_SENDER_VERIFIED", "false");
    expect(secureShareEmailReadiness()).toMatchObject({
      ready: false,
      providerConfigured: true,
      secretsConfigured: true,
      senderVerified: false
    });
    vi.stubEnv("SHARE_EMAIL_SENDER_VERIFIED", "true");
    vi.stubEnv("SHARE_EMAIL_HMAC_KEY", "o".repeat(48));
    expect(secureShareEmailReadiness()).toMatchObject({
      ready: false,
      secretsConfigured: false
    });
    vi.stubEnv("SHARE_EMAIL_HMAC_KEY", "e".repeat(48));
    vi.stubEnv("SHARE_EMAIL_FROM", "QuickMemo <share@example.com>\r\nBcc: attacker@example.com");
    expect(secureShareEmailReadiness()).toMatchObject({
      ready: false,
      providerConfigured: false
    });
    expect(verificationEmailText("123456", 600)).toContain("10분 동안 유효");
    expect(verificationEmailText("123456", 301)).toContain("301초 동안 유효");
    expect(verificationEmailText("123456", 600)).toBe([
      "QuickMemo 공유 노트를 열기 위한 인증번호입니다.",
      "",
      "인증번호: 123456",
      "",
      "이 인증번호는 10분 동안 유효합니다.",
      "본인이 요청하지 않았다면 이 메일을 무시하세요.",
      "",
      "서비스 주소:",
      "https://quickmemo-tan.vercel.app"
    ].join("\n"));
  });

  it("uses a bounded provider adapter retry with an idempotency key", async () => {
    vi.stubEnv("SHARE_EMAIL_API_KEY", "provider-key");
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "email_message_123456" })
      });
    const wait = vi.fn(async () => undefined);
    const beforeAttempt = vi.fn(async () => undefined);
    const adapter = createResendEmailAdapter(
      request as unknown as typeof fetch,
      wait,
      beforeAttempt
    );

    await expect(adapter.send({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-delivery-key",
      text: "generic message",
      to: "person@example.com"
    })).resolves.toEqual({
      accepted: true,
      messageId: "email_message_123456"
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    const init = request.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      "idempotency-key": "opaque-delivery-key",
      "user-agent": "QuickMemo-Secure-Share/2"
    });

    request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "email_health_123456" })
    });
    await expect(adapter.healthCheck({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-health-key",
      to: "health@example.com"
    })).resolves.toEqual({
      accepted: true,
      messageId: "email_health_123456"
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(beforeAttempt).toHaveBeenCalledTimes(3);
    const healthInit = request.mock.calls[2]?.[1] as RequestInit;
    expect(String(healthInit.body)).toContain("상태 확인");
  });

  it("fails before provider I/O when the distributed request gate rejects an attempt", async () => {
    vi.stubEnv("SHARE_EMAIL_API_KEY", "provider-key");
    const request = vi.fn();
    const beforeAttempt = vi.fn().mockRejectedValue(
      new HttpError(429, "rate_limited", "Provider request capacity is exhausted")
    );
    const adapter = createResendEmailAdapter(
      request as unknown as typeof fetch,
      async () => undefined,
      beforeAttempt
    );

    await expect(adapter.send({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-rate-gated-provider-key",
      text: "generic message",
      to: "person@example.com"
    })).rejects.toMatchObject({
      code: "rate_limited",
      deliveryAmbiguous: false,
      statusCode: 429
    });
    expect(beforeAttempt).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();

    const networkThenGateFailure = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection reset"));
    const retryGate = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new HttpError(429, "rate_limited", "Provider request capacity is exhausted")
      );
    await expect(createResendEmailAdapter(
      networkThenGateFailure as unknown as typeof fetch,
      async () => undefined,
      retryGate
    ).send({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-ambiguous-before-rate-gate",
      text: "generic message",
      to: "person@example.com"
    })).rejects.toMatchObject({
      code: "rate_limited",
      deliveryAmbiguous: true,
      statusCode: 429
    });
    expect(retryGate).toHaveBeenCalledTimes(2);
    expect(networkThenGateFailure).toHaveBeenCalledOnce();
  });

  it("treats malformed provider success as ambiguous and never retries a definitive 4xx", async () => {
    vi.stubEnv("SHARE_EMAIL_API_KEY", "provider-key");
    const malformedSuccess = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({})
    });
    await expect(createResendEmailAdapter(
      malformedSuccess as unknown as typeof fetch
    ).send({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-malformed-success-key",
      text: "generic message",
      to: "person@example.com"
    })).rejects.toMatchObject({
      code: "email_feature_unavailable",
      deliveryAmbiguous: true,
      upstreamStatus: 200
    });
    expect(malformedSuccess).toHaveBeenCalledOnce();

    const rejected = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    await expect(createResendEmailAdapter(
      rejected as unknown as typeof fetch
    ).send({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-definitive-rejection-key",
      text: "generic message",
      to: "person@example.com"
    })).rejects.toMatchObject({
      code: "email_feature_unavailable",
      deliveryAmbiguous: false,
      upstreamStatus: 400
    });
    expect(rejected).toHaveBeenCalledOnce();

    const timeoutError = Object.assign(new Error("provider timeout"), {
      name: "AbortError"
    });
    const timedOut = vi.fn().mockRejectedValue(timeoutError);
    await expect(createResendEmailAdapter(
      timedOut as unknown as typeof fetch
    ).send({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-provider-timeout-key",
      text: "generic message",
      to: "person@example.com"
    })).rejects.toMatchObject({
      code: "email_feature_unavailable",
      deliveryAmbiguous: true
    });
    expect(timedOut).toHaveBeenCalledOnce();

    const repeatedServerFailure = vi.fn()
      .mockResolvedValue({ ok: false, status: 503 });
    await expect(createResendEmailAdapter(
      repeatedServerFailure as unknown as typeof fetch,
      async () => undefined
    ).send({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-repeated-server-failure",
      text: "generic message",
      to: "person@example.com"
    })).rejects.toMatchObject({
      deliveryAmbiguous: true,
      upstreamStatus: 503
    });
    expect(repeatedServerFailure).toHaveBeenCalledTimes(2);

    const networkThenRejected = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce({ ok: false, status: 400 });
    await expect(createResendEmailAdapter(
      networkThenRejected as unknown as typeof fetch,
      async () => undefined
    ).send({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-network-then-rejection",
      text: "generic message",
      to: "person@example.com"
    })).rejects.toMatchObject({
      deliveryAmbiguous: true,
      upstreamStatus: 400
    });
    expect(networkThenRejected).toHaveBeenCalledTimes(2);

    const concurrentIdempotentRequest = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ name: "concurrent_idempotent_requests" })
    });
    await expect(createResendEmailAdapter(
      concurrentIdempotentRequest as unknown as typeof fetch,
      async () => undefined
    ).send({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-concurrent-idempotent-request",
      text: "generic message",
      to: "person@example.com"
    })).rejects.toMatchObject({
      deliveryAmbiguous: true,
      upstreamStatus: 409
    });
    expect(concurrentIdempotentRequest).toHaveBeenCalledTimes(2);

    const invalidIdempotentRequest = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ name: "invalid_idempotent_request" })
    });
    await expect(createResendEmailAdapter(
      invalidIdempotentRequest as unknown as typeof fetch,
      async () => undefined
    ).send({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-invalid-idempotent-request",
      text: "generic message",
      to: "person@example.com"
    })).rejects.toMatchObject({
      deliveryAmbiguous: false,
      upstreamStatus: 409
    });
    expect(invalidIdempotentRequest).toHaveBeenCalledOnce();

    const unknownIdempotentConflict = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => {
        throw new SyntaxError("malformed provider error");
      }
    });
    await expect(createResendEmailAdapter(
      unknownIdempotentConflict as unknown as typeof fetch,
      async () => undefined
    ).send({
      from: "QuickMemo <share@example.com>",
      idempotencyKey: "opaque-unknown-idempotent-conflict",
      text: "generic message",
      to: "person@example.com"
    })).rejects.toMatchObject({
      deliveryAmbiguous: true,
      upstreamStatus: 409
    });
    expect(unknownIdempotentConflict).toHaveBeenCalledTimes(2);
  });

  it("caps email quota configuration below the provider free tier and counts reservations", () => {
    expect(resolveEmailQuotaPolicy({})).toEqual({
      globalHourlyLimit: 20,
      globalMinuteLimit: 3,
      rolling24hHardLimit: 30,
      rolling24hSoftLimit: 20,
      monthlyHardLimit: 700,
      monthlySoftLimit: 500
    });
    expect(() => resolveEmailQuotaPolicy({
      SHARE_EMAIL_GLOBAL_HOURLY_LIMIT: "999",
      SHARE_EMAIL_GLOBAL_MINUTE_LIMIT: "999",
      SHARE_EMAIL_ROLLING_24H_HARD_LIMIT: "999",
      SHARE_EMAIL_ROLLING_24H_SOFT_LIMIT: "999",
      SHARE_EMAIL_MONTHLY_HARD_LIMIT: "9999",
      SHARE_EMAIL_MONTHLY_SOFT_LIMIT: "9999"
    })).toThrow("free-tier cap");
    expect(resolveEmailQuotaPolicy({
      SHARE_EMAIL_GLOBAL_HOURLY_LIMIT: "8",
      SHARE_EMAIL_GLOBAL_MINUTE_LIMIT: "2",
      SHARE_EMAIL_ROLLING_24H_HARD_LIMIT: "12",
      SHARE_EMAIL_ROLLING_24H_SOFT_LIMIT: "10",
      SHARE_EMAIL_MONTHLY_HARD_LIMIT: "300",
      SHARE_EMAIL_MONTHLY_SOFT_LIMIT: "200"
    })).toEqual({
      globalHourlyLimit: 8,
      globalMinuteLimit: 2,
      rolling24hHardLimit: 12,
      rolling24hSoftLimit: 10,
      monthlyHardLimit: 300,
      monthlySoftLimit: 200
    });

    const [minute, hourly, monthly] = emailQuotaPeriods(
      Date.parse("2026-07-29T12:34:56.000Z")
    );
    expect(minute).toMatchObject({
      bucketId: "minute_2026-07-29T12:34",
      periodKey: "2026-07-29T12:34",
      scope: "minute",
      softLimit: 3,
      hardLimit: 3
    });
    expect(minute.expiresAt.getTime()).toBe(
      Date.parse("2026-07-29T12:34:00.000Z") + 72 * 60 * 60 * 1000
    );
    expect(hourly).toMatchObject({
      bucketId: "hour_2026-07-29T12",
      periodKey: "2026-07-29T12",
      scope: "hourly",
      softLimit: 20,
      hardLimit: 20
    });
    expect(monthly).toMatchObject({
      bucketId: "month_2026-07",
      periodKey: "2026-07",
      scope: "monthly",
      softLimit: 500,
      hardLimit: 700
    });
    expect(emailQuotaExceeded(
      { ambiguousCount: 1, reservedCount: 1, sentCount: 1 },
      minute
    )).toMatchObject({
      exceeded: true,
      softLimitReached: true,
      total: 3
    });
    expect(emailQuotaExceeded(
      { failedCount: 3, reservedCount: 0, sentCount: 0 },
      minute
    )).toMatchObject({
      exceeded: true,
      softLimitReached: true,
      total: 3
    });
    expect(emailQuotaExceeded(
      { failedCount: 20, reservedCount: 0, sentCount: 0 },
      hourly
    )).toMatchObject({
      exceeded: true,
      softLimitReached: true,
      total: 20
    });
    expect(emailQuotaExceeded(
      { failedCount: 700, reservedCount: 0, sentCount: 0 },
      monthly
    )).toMatchObject({
      exceeded: false,
      total: 0
    });
    expect(emailQuotaExceeded(
      { reservedCount: 0, sentCount: 699 },
      monthly
    )).toMatchObject({
      exceeded: false,
      softLimitReached: true,
      total: 699
    });
    expect(emailQuotaExceeded(
      { reservedCount: 1, sentCount: 699 },
      monthly
    )).toMatchObject({
      exceeded: true,
      total: 700
    });
    expect(emailQuotaPeriods(
      Date.parse("2026-07-31T15:00:00.000Z")
    ).map((period) => period.bucketId)).toEqual([
      "minute_2026-07-31T15:00",
      "hour_2026-07-31T15",
      "month_2026-08"
    ]);
  });

  it("preserves an active Gmail hard block across weaker concurrent failures", () => {
    const now = new Date("2026-07-29T12:00:00.000Z");
    const existing = {
      blockedUntil: new Date("2026-07-30T11:59:00.000Z"),
      consecutiveFailures: 1,
      lastFailureAt: new Date("2026-07-29T11:59:00.000Z"),
      lastReasonCode: "auth_error",
      status: "blocked" as const
    };
    expect(gmailProviderHealthStateAllowsSend(
      existing,
      now.getTime()
    )).toBe(false);
    expect(gmailProviderHealthStateAllowsSend(
      {
        consecutiveFailures: 1,
        status: "blocked"
      },
      now.getTime()
    )).toBe(false);
    expect(gmailProviderHealthStateAllowsSend(
      {
        blockedUntil: "invalid",
        consecutiveFailures: 1,
        status: "blocked"
      },
      now.getTime()
    )).toBe(false);
    expect(gmailProviderHealthStateAllowsSend(
      {
        blockedUntil: new Date(now.getTime() - 1),
        consecutiveFailures: 1,
        settingsGeneration: "generation-current",
        status: "blocked"
      },
      now.getTime(),
      "generation-current"
    )).toBe(true);
    expect(gmailProviderHealthStateAllowsSend(
      {
        consecutiveFailures: 0,
        settingsGeneration: "generation-old",
        status: "healthy"
      },
      now.getTime(),
      "generation-current"
    )).toBe(false);
    expect(gmailProviderHealthStateAllowsSend(
      null,
      now.getTime(),
      "generation-current"
    )).toBe(false);
    const connectionFailure = gmailProviderHealthTransition(
      existing,
      "failed",
      {
        providerBlockedSeconds: 5 * 60,
        providerReasonCode: "connection_error"
      },
      now
    );
    expect(connectionFailure).toMatchObject({
      blockedUntil: existing.blockedUntil,
      consecutiveFailures: 2,
      lastReasonCode: "auth_error",
      status: "blocked"
    });

    const invalidRecipient = gmailProviderHealthTransition(
      existing,
      "failed",
      {
        providerBlockedSeconds: 0,
        providerReasonCode: "invalid_recipient"
      },
      now
    );
    expect(invalidRecipient).toMatchObject({
      blockedUntil: existing.blockedUntil,
      consecutiveFailures: 1,
      lastReasonCode: "auth_error",
      status: "blocked"
    });

    expect(gmailProviderHealthTransition(
      existing,
      "sent",
      null,
      now
    )).toMatchObject({
      blockedUntil: undefined,
      consecutiveFailures: 0,
      lastReasonCode: "",
      status: "healthy"
    });
  });

  it("does not let a stale in-flight SMTP result overwrite rotated or removed provider health", async () => {
    const context = {
      accessToken: "management-token",
      projectId: "test-project"
    };
    const staleRuntime = {
      environment: {},
      generation: "generation_g1_stale",
      provider: "gmail_smtp" as const,
      ready: true as const
    };
    const rotatedHealth = firestoreDocument(
      "publicShareEmailProviderHealth/gmail-smtp",
      {
        consecutiveFailures: 0,
        settingsGeneration: "generation_g2_current",
        status: "healthy",
        updatedAt: new Date("2026-07-30T00:00:00.000Z")
      }
    );
    const rotatedFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          throw new Error("stale health must not be committed");
        }
        return fetchResponse(200, rotatedHealth);
      }
    );
    vi.stubGlobal("fetch", rotatedFetch);

    await recordGmailProviderHealth(context, staleRuntime, "sent");

    expect(rotatedFetch).toHaveBeenCalledTimes(1);

    const removedFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          throw new Error("removed health must not be recreated");
        }
        return fetchResponse(404);
      }
    );
    vi.stubGlobal("fetch", removedFetch);

    await recordGmailProviderHealth(
      context,
      staleRuntime,
      "failed",
      { providerReasonCode: "connection_error" }
    );

    expect(removedFetch).toHaveBeenCalledTimes(1);

    const legacyCommitBodies: Array<Record<string, unknown>> = [];
    const legacyFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          legacyCommitBodies.push(JSON.parse(String(init.body)));
          return fetchResponse(200, {
            commitTime: "2026-07-30T00:00:00.000Z"
          });
        }
        return fetchResponse(404);
      }
    );
    vi.stubGlobal("fetch", legacyFetch);

    await recordGmailProviderHealth(
      context,
      {
        environment: { NODE_ENV: "test" },
        generation: "",
        provider: "gmail_smtp",
        ready: true
      },
      "sent"
    );

    expect(legacyFetch).toHaveBeenCalledTimes(2);
    expect(legacyCommitBodies).toHaveLength(1);
  });

  it("uses conservative hourly shards for the Share and Email rolling limit", () => {
    const currentHourStart = Date.parse("2026-07-29T12:00:00.000Z") / 1000;
    const starts = rateLimitWindowStarts(
      Date.parse("2026-07-29T12:34:56.000Z"),
      { rollingWindowHours: 24, windowSeconds: 60 * 60 }
    );
    expect(starts).toHaveLength(25);
    expect(starts[0]).toBe(currentHourStart);
    expect(starts[24]).toBe(currentHourStart - 24 * 60 * 60);
    expect(new Set(starts).size).toBe(25);
    expect(rateLimitWindowStarts(
      Date.parse("2026-07-29T12:34:56.000Z"),
      { windowSeconds: 15 * 60 }
    )).toEqual([
      Date.parse("2026-07-29T12:30:00.000Z") / 1000
    ]);
  });

  it("binds email finalization and consumed one-time preservation to the issuance", () => {
    const commitSource = backendSource.match(
      /async function commitEmailChallenge[\s\S]*?async function finalizeEmailDelivery/u
    )?.[0] ?? "";
    const finalizerSource = backendSource.match(
      /async function finalizeEmailDelivery[\s\S]*?function emailChallengeMinimumResponseMilliseconds/u
    )?.[0] ?? "";

    expect(commitSource).toContain("state?.policy?.oneTimeEnabled === true");
    expect(commitSource).toContain('state.share.status === "consumed"');
    expect(finalizerSource).toContain('latestChallenge.status === "pending"');
    expect(finalizerSource).toContain(
      'latestChallenge.deliveryStatus === "reserved"'
    );
    expect(finalizerSource).toContain(
      "latestChallenge.sendAttemptId === challenge.sendAttemptId"
    );
  });

  it("normalizes display names before blocking controls, bidi marks, and reserved impersonation", () => {
    expect(safeDisplayName("  Ａｌｉｃｅ   Kim  ")).toBe("Alice Kim");
    expect(() => safeDisplayName("Quick\u200BMemo")).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    );
    expect(() => safeDisplayName("\u202Eowner")).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    );
    expect(() => safeDisplayName("ＱｕｉｃｋＭｅｍｏ")).toThrowError(
      expect.objectContaining({ statusCode: 400, code: "invalid_request" })
    );
    expect(() => safeDisplayName("소유자")).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    );
    expect(safeDisplayName("Owner", "Owner", true)).toBe("Owner");
  });

  it("rejects participant-name invisibles, URL forms, and trusted-role impersonation", () => {
    expect(safeParticipantDisplayName("  Ａｌｉｃｅ   Kim  ")).toMatchObject({
      displayName: "Alice Kim",
      normalizedDisplayName: "alice kim"
    });
    expect(safeParticipantDisplayName("Alice_2").displayName).toBe("Alice_2");
    expect(safeParticipantDisplayName("테스터김").displayName).toBe("테스터김");
    expect(safeParticipantDisplayName("테스터A").displayName).toBe("테스터A");
    expect(safeParticipantDisplayName("テスト利用者").displayName).toBe("テスト利用者");
    expect(safeParticipantDisplayName("テスターB").displayName).toBe("テスターB");
    expect(safeParticipantDisplayName("ユーザー").displayName).toBe("ユーザー");
    expect(safeParticipantDisplayName("비공식 연구자").displayName).toBe("비공식 연구자");
    expect(safeParticipantDisplayName("非公式研究者").displayName).toBe("非公式研究者");
    expect(safeParticipantDisplayName("王小明").displayName).toBe("王小明");
    expect(safeParticipantDisplayName("李系统").displayName).toBe("李系统");
    for (const invalid of [
      "Alice\u034f",
      "Alice\u180b",
      "Alice\u17b4",
      "Alice\u0301",
      "Alice\nBob",
      "Alice\tBob",
      "A\u2028B",
      "8.8.8.8",
      "123.com",
      "1.co",
      "2026.kr",
      "evil.dev",
      "QuickMemo Support",
      "Admin Team",
      "System Admin",
      "System Administrator",
      "System Owner",
      "System Manager",
      "System Staff",
      "System Help",
      "System X",
      "Administrator",
      "Owner",
      "guest١",
      "guest۱",
      "guest१",
      "guestI",
      "Guestl",
      "guestO",
      "0wner",
      "adm1n",
      "supp0rt",
      "qu1ckmemo",
      "quickmem0",
      "systern",
      "테스터Admin",
      "Support테스터",
      "퀵Memo",
      "Quick메모",
      "クイックMemo",
      "Quickメモ",
      "오너",
      "어드민",
      "서포트",
      "アドミン",
      "サポート",
      "所有者",
      "공식",
      "공식계정",
      "공식계정1",
      "공식안내",
      "公式",
      "公式アカウント",
      "公式アカウント1",
      "公式案内",
      "管理员",
      "管理员1",
      "管理員通知",
      "系统",
      "系统通知",
      "系統通知",
      "官方",
      "官方账号1",
      "官方帳號通知",
      "admın",
      "admɪn",
      "ᴀdmin",
      "adᴍin",
      "ᴏwner",
      "quıckmemo",
      "quickmem〇",
      "ーー"
    ]) {
      expect(() => safeParticipantDisplayName(invalid), invalid).toThrowError(
        expect.objectContaining({
          code: "invalid_display_name",
          statusCode: 400
        })
      );
    }
  });

  it("keeps comments plain text and rejects control, bidi, and zero-width spoofing", () => {
    expect(validateCommentBody("  줄 1\n줄 2  ")).toBe("줄 1\n줄 2");
    for (const invalid of [
      "<b>html</b>",
      "hidden\u0000control",
      "c1\u0085control",
      "arabic\u061cmark",
      "bidi\u202eoverride",
      "isolate\u2066spoof",
      "zero\u200bwidth",
      "bom\ufeffmark"
    ]) {
      expect(() => validateCommentBody(invalid)).toThrowError(
        expect.objectContaining({ statusCode: 400, code: "invalid_request" })
      );
    }
  });
});

describe("Secure Share v2 owner, source, quota, and attachment policy", () => {
  it("does not let an unrelated administrator become the share owner", () => {
    const state = { share: { ownerUid: "owner-a" } };
    expect(shareOwnedBy(state, { uid: "owner-a" })).toBe(true);
    expect(shareOwnedBy(state, { uid: "admin-b", isAdmin: true })).toBe(false);
    expect(shareManagedBy(state, { uid: "owner-a" })).toBe(true);
    expect(shareManagedBy(state, { uid: "admin-b", isAdmin: true })).toBe(true);
    expect(shareManagedBy(state, { uid: "user-b" })).toBe(false);
  });

  it("projects only the owner attachment reuse fingerprint and verifies uploaded snapshots", () => {
    const manifest = ownerAttachmentReuseManifest({
      __id: "attachment_public_123456",
      sourceAttachmentId: "attachment_source_123456",
      sourceAttachmentDigest: "D".repeat(43),
      sourceEncryptionVersion: 2,
      blobPath: "users/owner/private",
      encryptedFileName: { cipherText: "private" },
      storagePath: "private/path"
    });

    expect(manifest).toEqual({
      id: "attachment_public_123456",
      sourceAttachmentId: "attachment_source_123456",
      digest: "D".repeat(43),
      sourceEncryptionVersion: 2
    });
    expect(ownerAttachmentReuseManifest({
      __id: "attachment_legacy_123456",
      sourceAttachmentId: "attachment_source_123456"
    })).toEqual({ id: "attachment_legacy_123456" });
    expect(verifyDocumentSnapshotWrite(
      "test-project",
      "publicNoteShares/share_123456/attachments/attachment_123456",
      "2026-07-29T00:00:00.000000Z"
    )).toEqual({
      verify:
        "projects/test-project/databases/(default)/documents/"
        + "publicNoteShares/share_123456/attachments/attachment_123456",
      currentDocument: { updateTime: "2026-07-29T00:00:00.000000Z" }
    });
  });

  it("keeps reads bound to the source lifecycle while checking revisions separately", () => {
    const share = {
      ownerUid: "owner-a",
      sourceRevision: 9,
      sourceAttachmentRevision: 4
    };
    const note = {
      ownerUid: "owner-a",
      revision: 9,
      attachmentRevision: 4,
      isDeleted: false,
      isPurged: false
    };
    const profile = {
      isActive: true,
      featureAccess: { notes: true }
    };

    expect(sourceSnapshotAvailable(share, note, profile)).toBe(true);
    expect(sourceLifecycleAvailable(share, { ...note, revision: 10 }, profile)).toBe(true);
    expect(sourceSnapshotAvailable(share, { ...note, revision: 10 }, profile)).toBe(true);
    expect(sourceRevisionMatches(share, note)).toBe(true);
    expect(sourceRevisionMatches(share, { ...note, revision: 10 })).toBe(false);
    expect(sourceReadAvailable(share, note, profile, false)).toBe(true);
    expect(sourceReadAvailable(
      share,
      { ...note, revision: 10 },
      profile,
      false
    )).toBe(false);
    expect(sourceReadAvailable(
      share,
      { ...note, revision: 10 },
      profile,
      true
    )).toBe(true);
    expect(sourceReadAvailable(
      share,
      { ...note, attachmentRevision: 5 },
      profile,
      false
    )).toBe(false);
    expect(sourceSnapshotAvailable(share, note, { ...profile, isActive: false })).toBe(false);
    expect(sourceSnapshotAvailable(share, note, {
      ...profile,
      featureAccess: { notes: false }
    })).toBe(false);
  });

  it("blocks only legacy automatic revokes for active live-sync sources", () => {
    const share = { ownerUid: "owner-a" };
    const note = {
      ownerUid: "owner-a",
      isDeleted: false,
      isPurged: false
    };
    const profile = {
      isActive: true,
      featureAccess: { notes: true }
    };
    const legacyKey = `source_changed_${"a".repeat(32)}`;

    expect(legacyAutomaticSourceRevokeBlocked(
      legacyKey,
      share,
      note,
      profile,
      true
    )).toBe(true);
    expect(legacyAutomaticSourceRevokeBlocked(
      legacyKey,
      share,
      { ...note, isDeleted: true },
      profile,
      true
    )).toBe(false);
    expect(legacyAutomaticSourceRevokeBlocked(
      legacyKey,
      share,
      { ...note, isPurged: true },
      profile,
      true
    )).toBe(false);
    expect(legacyAutomaticSourceRevokeBlocked(
      legacyKey,
      share,
      null,
      profile,
      true
    )).toBe(false);
    expect(legacyAutomaticSourceRevokeBlocked(
      `revoke_${"b".repeat(32)}`,
      share,
      note,
      profile,
      true
    )).toBe(false);
    expect(legacyAutomaticSourceRevokeBlocked(
      legacyKey,
      share,
      note,
      profile,
      false
    )).toBe(false);
  });

  it("uses monotonic content/source CAS and payload-bound idempotency", () => {
    const input = {
      attachmentCount: 0,
      encryptedBody: {
        version: 1,
        algorithm: "AES-GCM",
        cipherText: "Ym9keS1jaXBoZXJ0ZXh0",
        iv: "MDEyMzQ1Njc4OWFi"
      },
      encryptedTitle: {
        version: 1,
        algorithm: "AES-GCM",
        cipherText: "dGl0bGUtY2lwaGVydGV4dA==",
        iv: "MDEyMzQ1Njc4OWFi"
      },
      expectedContentRevision: 7,
      expectedSourceAttachmentRevision: 3,
      expectedSourceRevision: 11,
      generation: "generation_123456",
      idempotencyKey: "content-update-request-123456",
      retainedAttachmentIds: ["attachment_retained_123456"],
      sourceAttachmentRevision: 3,
      sourceRevision: 12
    };
    const digest = contentUpdateRequestDigest(input);
    const share = {
      contentRevision: 7,
      sourceAttachmentRevision: 3,
      sourceRevision: 11
    };

    expect(contentUpdateDisposition(share, input, digest)).toBe("apply");
    expect(contentUpdateDisposition({ ...share, contentRevision: 8 }, input, digest))
      .toBe("stale");
    expect(contentUpdateDisposition({
      ...share,
      lastContentMutationId: input.idempotencyKey,
      lastContentMutationDigest: digest
    }, input, digest)).toBe("replay");
    expect(contentUpdateDisposition({
      ...share,
      lastContentMutationId: input.idempotencyKey,
      lastContentMutationDigest: "different-request-digest"
    }, input, digest)).toBe("conflict");
    expect(contentUpdateRequestDigest({
      ...input,
      retainedAttachmentIds: ["attachment_other_123456"]
    })).not.toBe(digest);
    expect(contentUpdateRequestDigest({
      ...input,
      encryptedBody: {
        ...input.encryptedBody,
        cipherText: "ZGlmZmVyZW50LWNpcGhlcnRleHQ="
      }
    })).not.toBe(digest);
  });

  it("derives a write-free owner content-update throttle from contentUpdatedAt", () => {
    const now = Date.parse("2026-07-29T00:00:00.000Z");

    expect(contentUpdateRetryAfterSeconds({}, now)).toBe(0);
    expect(contentUpdateRetryAfterSeconds({
      contentUpdatedAt: "2026-07-28T23:59:59.499Z"
    }, now)).toBe(0);
    expect(contentUpdateRetryAfterSeconds({
      contentUpdatedAt: "2026-07-28T23:59:59.501Z"
    }, now)).toBe(1);
    expect(contentUpdateRetryAfterSeconds({
      contentUpdatedAt: "2026-07-29T00:00:00.000Z"
    }, now)).toBe(1);
  });

  it("uses a bounded revision ETag with weak conditional GET comparison", () => {
    const etag = secureShareRevisionEtag({ contentRevision: 7, policyVersion: 3 });

    expect(etag).toBe("\"ss2-r7-p3\"");
    expect(secureShareRevisionEtag({ policyVersion: 3 })).toBe("\"ss2-r1-p3\"");
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(`W/${etag}`, etag)).toBe(true);
    expect(etagMatches(`"other", ${etag}`, etag)).toBe(true);
    expect(etagMatches("\"ss2-r8-p3\"", etag)).toBe(false);
    expect(etagMatches("x".repeat(1025), etag)).toBe(false);
  });

  it("preflights the same user and global boundaries enforced by final uploads", () => {
    expect(evaluateCopyAttachmentQuota({
      additionalBytes: 24,
      additionalCount: 2,
      usedBytes: 1024 * 1024 * 1024 - 24,
      usedCount: 498
    })).toMatchObject({ allowed: true, remainingBytes: 0, remainingCount: 0 });
    expect(evaluateCopyAttachmentQuota({
      additionalBytes: 25,
      additionalCount: 2,
      usedBytes: 1024 * 1024 * 1024 - 24,
      usedCount: 498
    })).toEqual({ allowed: false, reason: "bytes_exceeded" });
    expect(evaluateCopyAttachmentQuota({
      additionalBytes: 1,
      additionalCount: 3,
      usedBytes: 0,
      usedCount: 498
    })).toEqual({ allowed: false, reason: "count_exceeded" });
    expect(evaluateCopyAttachmentQuota({
      additionalBytes: 1,
      additionalCount: 1,
      usedBytes: -1,
      usedCount: 0
    })).toEqual({ allowed: false, reason: "invalid_usage" });
    const copyPreflightSource = backendSource.match(
      /async function preflightCopyAttachmentQuota[\s\S]*?function copyGrantAuthorizesDownload/u
    )?.[0] ?? "";
    expect(copyPreflightSource).toContain("GLOBAL_BLOB_USAGE_DOCUMENT_PATH");
    expect(copyPreflightSource).toContain("evaluateFreeTierUpload");
    expect(copyPreflightSource).toContain("Global Blob usage counter is missing or invalid");
  });

  it("derives the only accepted private attachment path from server-owned identifiers", () => {
    expect(secureShareAttachmentBlobPath("owner-a", "share-a", "attachment-a")).toBe(
      "users/owner-a/publicNoteShares/share-a/attachments/attachment-a/data"
    );
    expect(() => secureShareAttachmentBlobPath("owner-a", "../share", "attachment-a")).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("keeps the final atomic quota reservation in the existing upload boundary", () => {
    const reservation = blobSource.match(
      /async function reserveUserAttachmentBytes[\s\S]*?async function claimAttachmentDeletion/u
    )?.[0] ?? "";
    expect(reservation).toContain("userBlobAttachmentQuotaBytes");
    expect(reservation).toContain("userBlobAttachmentCountLimit");
    expect(reservation).toContain("currentDocument: quotaDocument ? { updateTime: quotaDocument.updateTime }");
    expect(reservation).toContain(
      "[quotaWrite, ...(globalWrite ? [globalWrite] : []), ...resolvedExtraWrites]"
    );
  });

  it("throttles session last-seen metadata to at most once per hour", () => {
    const sessionHandler = backendSource.match(
      /async function handleSession[\s\S]*?function safeAttachmentMetadata/u
    )?.[0] ?? "";

    expect(backendSource).toContain(
      "const sessionLastSeenWriteIntervalMilliseconds = 60 * 60 * 1000"
    );
    expect(sessionHandler).toContain(
      "lastSeenAt <= Date.now() - sessionLastSeenWriteIntervalMilliseconds"
    );
    expect(sessionHandler).toContain('const sessionUpdateFieldPaths = ["csrfDigest"]');
    expect(sessionHandler).toContain('sessionUpdateFieldPaths.push("lastSeenAt")');
  });
});

describe("Secure Share v2 transactional source contracts", () => {
  it("accepts a consumed OTP only when the same bound attempt is recovering", async () => {
    const challengeId = "queue_otp_recovery";
    const attemptHash = "same-bound-attempt";
    const challenge = {
      __id: challengeId,
      __updateTime: "2026-07-29T00:00:00.000000Z",
      attempts: 0,
      codeDigest: "otp-code-digest",
      consumedAttemptHash: attemptHash,
      emailHash: "email-hash",
      expiresAt: new Date(Date.now() + 60_000),
      policyVersion: 7,
      shareId: "share-a",
      status: "consumed"
    };
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse(
      200,
      firestoreDocument(`publicShareEmailChallenges/${challengeId}`, challenge)
    )));

    await expect(revalidateParticipantAllocationChallenge(
      { accessToken: "management-token", projectId: "test-project" },
      "share-a",
      7,
      {
        challenge,
        identityHash: "verified-email-identity"
      },
      attemptHash
    )).resolves.toMatchObject({
      challenge: {
        consumedAttemptHash: attemptHash,
        status: "consumed"
      }
    });
  });

  it("revalidates an OTP challenge at the queue head and stops on a consumed predecessor", async () => {
    const challengeId = "queue_otp_challenge";
    const originalChallenge = {
      __id: challengeId,
      __updateTime: "2026-07-29T00:00:00.000000Z",
      attempts: 0,
      codeDigest: "otp-code-digest",
      emailHash: "email-hash",
      expiresAt: new Date(Date.now() + 60_000),
      policyVersion: 7,
      shareId: "share-a",
      status: "pending"
    };
    const fetchMock = vi.fn(async () => fetchResponse(200, firestoreDocument(
      `publicShareEmailChallenges/${challengeId}`,
      {
        ...originalChallenge,
        consumedAttemptHash: "different-attempt",
        status: "consumed"
      }
    )));
    vi.stubGlobal("fetch", fetchMock);

    await expect(revalidateParticipantAllocationChallenge(
      { accessToken: "management-token", projectId: "test-project" },
      "share-a",
      7,
      {
        challenge: originalChallenge,
        identityHash: "verified-email-identity"
      },
      "current-attempt"
    )).rejects.toMatchObject({
      code: "access_denied",
      statusCode: 409
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const issueSource = backendSource.match(
      /async function issueAccessSession[\s\S]*?async function handleAccess/u
    )?.[0] ?? "";
    const firstRevalidation = issueSource.indexOf(
      "identity = await revalidateParticipantAllocationChallenge("
    );
    const retryRevalidation = issueSource.lastIndexOf(
      "identity = await revalidateParticipantAllocationChallenge("
    );
    expect(firstRevalidation).toBeGreaterThanOrEqual(0);
    expect(firstRevalidation).toBeLessThan(
      issueSource.indexOf(
        "for (let attempt = 0; attempt < participantAllocationMaximumAttempts; attempt += 1)"
      )
    );
    expect(retryRevalidation).toBeGreaterThan(
      issueSource.indexOf("isOptimisticConflict(error)")
    );
    expect(retryRevalidation).toBeLessThan(
      issueSource.indexOf("await waitBeforeOptimisticRetry", retryRevalidation)
    );
    expect(issueSource).toContain(
      "identity.challenge.consumedAttemptHash === attemptHash"
    );
    expect(issueSource).toContain("if (challengeCanBeConsumed)");
    expect(issueSource).toContain("idempotentChallengeSessionCredentials(");
    expect(issueSource).toContain("return recoverConsumedChallengeSession(");
    expect(issueSource.indexOf("return recoverConsumedChallengeSession(")).toBeLessThan(
      issueSource.indexOf("const participantAllocation = await beginParticipantAllocation")
    );
  });

  it("gives one concurrent one-time attempt the initial grant and permits only its grace replacement", async () => {
    const concurrentAttemptCount = 20;
    vi.stubEnv("SHARE_SESSION_HMAC_KEY", "s".repeat(48));
    vi.stubEnv("SHARE_CSRF_HMAC_KEY", "c".repeat(48));
    vi.stubEnv("SHARE_RATE_LIMIT_HMAC_KEY", "r".repeat(48));
    vi.stubEnv("SHARE_ONE_TIME_GRACE_SECONDS", "120");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const context = { accessToken: "management-token", projectId: "test-project" };
    const request = {
      headers: {
        "user-agent": "secure-share-test",
        "x-forwarded-for": "192.0.2.10"
      }
    };
    const identity = {
      authorUid: "",
      challenge: null,
      displayName: "Guest",
      identityHash: "identity-a",
      identityType: "browser",
      participantIdentityHash: "",
      participantToken: "",
      participantTokenDigest: "",
      setParticipantCookie: false
    };
    let consumed = false;
    let winningAttempt = "";
    let initialGrantDocument: {
      fields: Record<string, unknown>;
      name: string;
      updateTime: string;
    } | null = null;
    let initialSessionDocument: {
      fields: Record<string, unknown>;
      name: string;
      updateTime: string;
    } | null = null;
    const commitBodies: Array<{ writes: Array<{
      currentDocument?: { exists?: boolean; updateTime?: string };
      update?: { fields: Record<string, unknown>; name: string };
    }> }> = [];
    let announceAllCompetingCommits: () => void = () => {};
    let announceFirstCompletion: () => void = () => {};
    const allCompetingCommitsSeen = new Promise<void>((resolve) => {
      announceAllCompetingCommits = resolve;
    });
    const firstCommitCompleted = new Promise<void>((resolve) => {
      announceFirstCompletion = resolve;
    });

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      if (url.endsWith("/documents:batchGet")) {
        return fetchResponse(200, [
          {
            found: firestoreDocument("publicNoteShares/share-a", {
              schemaVersion: 2,
              ownerUid: "owner-a",
              sourceNoteId: "note-a",
              sourceRevision: 9,
              sourceAttachmentRevision: 4,
              ready: true,
              status: "consumed",
              expiresAt,
              policyVersion: 7,
              successfulAccessCount: 1,
              consumedAt: new Date()
            }),
            transaction: "transaction-replay-state-token"
          },
          {
            found: firestoreDocument("publicSharePolicies/share-a", {
              schemaVersion: 2,
              ownerUid: "owner-a",
              policyVersion: 7,
              oneTimeEnabled: true,
              permissionLevel: "view",
              downloadAllowed: false,
              quickCopyButtonVisible: true,
              consumedAt: new Date(),
              consumedAttemptHash: winningAttempt,
              consumedIdentityHash: identity.identityHash
            })
          }
        ]);
      }
      if (url.endsWith("/documents:commit")) {
        const body = JSON.parse(String(init?.body)) as {
          writes: Array<{
            currentDocument?: { exists?: boolean; updateTime?: string };
            update?: { fields: Record<string, unknown>; name: string };
          }>;
        };
        commitBodies.push(body);
        const commitIndex = commitBodies.length;
        if (commitIndex === concurrentAttemptCount) {
          announceAllCompetingCommits();
        }
        if (commitIndex === 1) {
          await allCompetingCommitsSeen;
          const grantWrite = body.writes.find((write) =>
            write.update?.name.includes("/publicShareUnlockGrants/")
          );
          const sessionWrite = body.writes.find((write) =>
            write.update?.name.includes("/publicShareAccessSessions/")
            && write.currentDocument?.exists === false
          );
          if (!grantWrite?.update || !sessionWrite?.update) {
            throw new Error("Initial one-time commit is missing grant or session");
          }
          winningAttempt = grantWrite.update.name.split("/").at(-1) ?? "";
          initialGrantDocument = {
            ...grantWrite.update,
            updateTime: "2026-07-28T00:00:01.000000Z"
          };
          initialSessionDocument = {
            ...sessionWrite.update,
            updateTime: "2026-07-28T00:00:01.000000Z"
          };
          consumed = true;
          announceFirstCompletion();
          return fetchResponse(200, { commitTime: "2026-07-28T00:00:01.000000Z" });
        }
        if (commitIndex <= concurrentAttemptCount) {
          await firstCommitCompleted;
          return fetchResponse(409, { error: { status: "ABORTED" } });
        }
        return fetchResponse(200, { commitTime: "2026-07-28T00:00:02.000000Z" });
      }

      if (url.includes("/documents/publicNoteShares/share-a")) {
        return fetchResponse(200, firestoreDocument("publicNoteShares/share-a", {
          schemaVersion: 2,
          ownerUid: "owner-a",
          sourceNoteId: "note-a",
          sourceRevision: 9,
          sourceAttachmentRevision: 4,
          ready: true,
          status: consumed ? "consumed" : "active",
          expiresAt,
          policyVersion: 7,
          successfulAccessCount: consumed ? 1 : 0,
          ...(consumed ? { consumedAt: new Date() } : {})
        }));
      }
      if (url.includes("/documents/publicSharePolicies/share-a")) {
        return fetchResponse(200, firestoreDocument("publicSharePolicies/share-a", {
          schemaVersion: 2,
          ownerUid: "owner-a",
          policyVersion: 7,
          oneTimeEnabled: true,
          permissionLevel: "view",
          downloadAllowed: false,
          quickCopyButtonVisible: true,
          ...(consumed ? {
            consumedAt: new Date(),
            consumedAttemptHash: winningAttempt,
            consumedIdentityHash: identity.identityHash
          } : {})
        }));
      }
      if (url.includes("/documents/notes/note-a")) {
        return fetchResponse(200, firestoreDocument("notes/note-a", {
          ownerUid: "owner-a",
          revision: 9,
          attachmentRevision: 4,
          isDeleted: false,
          isPurged: false
        }));
      }
      if (url.includes("/documents/users/owner-a")) {
        return fetchResponse(200, firestoreDocument("users/owner-a", {
          isActive: true,
          featureAccess: { notes: true }
        }));
      }
      if (url.includes("/documents/publicShareUnlockGrants/")) {
        const attempt = url.split("/").at(-1) ?? "";
        return attempt === winningAttempt && initialGrantDocument
          ? fetchResponse(200, initialGrantDocument)
          : fetchResponse(404);
      }
      if (url.includes("/documents/publicShareAccessSessions/") && initialSessionDocument) {
        const digest = url.split("/").at(-1);
        return digest === initialSessionDocument.name.split("/").at(-1)
          ? fetchResponse(200, initialSessionDocument)
          : fetchResponse(404);
      }
      if (url.includes("/documents/publicShareSourceGuards/")) {
        return fetchResponse(404);
      }
      throw new Error(`Unexpected test Firestore request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const competing = await Promise.allSettled(Array.from(
      { length: concurrentAttemptCount },
      (_, index) => issueAccessSession(
        request,
        context,
        "share-a",
        7,
        identity,
        "browser-binding-a",
        `attempt-${index + 1}`,
        "network-hash-a",
        `request-${index + 1}`
      )
    ));

    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = competing.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { statusCode: 409, code: "share_unavailable" }
    });
    expect(winningAttempt).toMatch(/^attempt-(?:[1-9]|1\d|20)$/u);
    expect(commitBodies).toHaveLength(concurrentAttemptCount);

    await expect(issueAccessSession(
      request,
      context,
      "share-a",
      7,
      identity,
      "browser-binding-a",
      winningAttempt,
      "network-hash-a",
      "request-retry"
    )).resolves.toMatchObject({ policy: { oneTimeEnabled: true, policyVersion: 7 } });

    expect(commitBodies).toHaveLength(concurrentAttemptCount + 1);
    const replacementWrites = commitBodies[concurrentAttemptCount]?.writes ?? [];
    expect(replacementWrites.filter((write) =>
      write.update?.name.includes("/publicShareUnlockGrants/")
    )).toHaveLength(1);
    expect(replacementWrites.some(({ update }) => {
      if (!update) {
        return false;
      }
      return update.name === initialSessionDocument?.name
        && Object.prototype.hasOwnProperty.call(update.fields, "revokedAt");
    })).toBe(true);
    expect(replacementWrites.some((write) =>
      write.update?.name.includes("/publicShareUnlockGrants/")
      && write.currentDocument?.updateTime === initialGrantDocument?.updateTime
    )).toBe(true);
  });

  it("consumes a one-time share, policy, grant, session, and audit in one optimistic commit", () => {
    const issue = backendSource.match(
      /async function issueAccessSession[\s\S]*?async function handleAccess/u
    )?.[0] ?? "";
    expect(backendSource).toContain("const participantAllocationMaximumAttempts = 32");
    expect(issue).toContain(
      "for (let attempt = 0; attempt < participantAllocationMaximumAttempts; attempt += 1)"
    );
    expect(issue).toContain("state.share.__updateTime");
    expect(issue).toContain("state.policy.__updateTime");
    expect(issue).toContain("`publicShareUnlockGrants/${attemptHash}`");
    expect(issue).toContain("createDocumentWrite(context.projectId, `publicShareAccessSessions/${digest}`");
    expect(issue).toContain(
      "await firestoreCommit(context, writes, participantAllocation.transaction)"
    );
    expect(issue).toContain("isOptimisticConflict(error)");
    expect(issue.indexOf("createAuditWrite(")).toBeLessThan(
      issue.indexOf("await firestoreCommit(context, writes, participantAllocation.transaction)")
    );
  });

  it("updates the cleanup queue expiry with a precondition in the owner-update commit", () => {
    const ownerUpdate = backendSource.match(
      /async function handleOwnerUpdate[\s\S]*?async function handleOwnerActivate/u
    )?.[0] ?? "";

    expect(ownerUpdate).toContain(
      "const cleanupQueuePath = `publicShareCleanupQueue/${shareId}`"
    );
    expect(ownerUpdate).toContain(
      "const cleanupQueue = await firestoreGet(user.context, cleanupQueuePath)"
    );
    expect(ownerUpdate).toContain("cleanupQueue.shareId !== shareId");
    expect(ownerUpdate).toContain("cleanupQueue.ownerUid !== state.share.ownerUid");
    expect(ownerUpdate).toContain(
      'updateDocumentWrite(\n        user.context.projectId,\n        cleanupQueuePath,\n        { expiresAt, updatedAt: now },\n        ["expiresAt", "updatedAt"],\n        cleanupQueue.__updateTime'
    );
    expect(ownerUpdate.indexOf("cleanupQueuePath")).toBeLessThan(
      ownerUpdate.indexOf("await firestoreCommit(user.context, writes)")
    );
  });

  it("updates encrypted content with lifecycle checks, revision CAS, and one transaction", () => {
    const contentUpdate = backendSource.match(
      /function validateContentUpdateBody[\s\S]*?async function handleOwnerActivate/u
    )?.[0] ?? "";

    expect(contentUpdate).toContain('requireMethod(request, ["PATCH"])');
    expect(contentUpdate).toContain("ensureSameOrigin(request)");
    expect(contentUpdate).toContain("contentUpdateRequestDigest(input)");
    expect(contentUpdate).toContain("expectedContentRevision");
    expect(contentUpdate).toContain("expectedSourceRevision");
    expect(contentUpdate).toContain("expectedSourceAttachmentRevision");
    expect(contentUpdate).toContain("sourceNoteMatchesContentUpdate(");
    expect(contentUpdate).toContain("contentUpdateAttachmentSnapshot(");
    expect(contentUpdate).toContain("firestoreBatchGetNewTransaction(");
    expect(contentUpdate).toContain("`notes/${sourceNoteId}`");
    expect(contentUpdate).toContain("`users/${ownerUid}`");
    expect(contentUpdate).toContain("contentRevisionValue(state.share) + 1");
    expect(contentUpdate).toContain("assertContentUpdateRate(initialState.share)");
    expect(contentUpdate).toContain("assertContentUpdateRate(state.share)");
    expect(contentUpdate).toContain("lastContentMutationDigest: requestDigest");
    expect(contentUpdate).toContain("retiredAttachmentIds");
    expect(contentUpdate).toContain("firestoreCommit(");
    expect(contentUpdate).toContain("transactionSnapshot.transaction");
    expect(contentUpdate).not.toContain("consumeRateLimits(");
    expect(contentUpdate).not.toContain("ownerWrappedShareKey");
    expect(contentUpdate).not.toContain("contentKey");
  });

  it("serves conditional revisions without attachment reads and exposes content revisions", () => {
    const revision = backendSource.match(
      /async function handleRevision[\s\S]*?async function handleContent/u
    )?.[0] ?? "";
    const revisionValidation = backendSource.match(
      /async function validatedRevisionSession[\s\S]*?async function handleSession/u
    )?.[0] ?? "";
    const content = backendSource.match(
      /async function handleContent[\s\S]*?function participantPublicDto/u
    )?.[0] ?? "";
    const access = backendSource.match(
      /async function handleAccess[\s\S]*?async function validatedSession/u
    )?.[0] ?? "";
    const metadata = backendSource.match(
      /async function handleMetadata[\s\S]*?async function emailChallengeEligibility/u
    )?.[0] ?? "";

    expect(revision).toContain("validatedRevisionSession(request, context, shareId)");
    expect(revision).toContain("ensureRevisionReadRequest(request)");
    expect(revision).toContain('response.setHeader("etag", etag)');
    expect(revision).toContain("response.statusCode = 304");
    expect(revision).not.toContain("currentAttachments(");
    expect(revisionValidation).toContain(
      "firestoreGet(context, `publicNoteShares/${shareId}`)"
    );
    expect(revisionValidation).toContain(
      "requireSourceAvailable(context, share, validatedOwner)"
    );
    expect(backendSource.match(
      /async function requireSourceAvailable[\s\S]*?function publicShareAvailable/u
    )?.[0]).toContain("sourceReadAvailable(share, note, ownerProfile)");
    expect(revisionValidation).not.toContain("loadShareState(");
    expect(revisionValidation).not.toContain("publicSharePolicies/");
    expect(content).toContain("contentRevision: contentRevisionValue(state.share)");
    expect(content).toContain("policyVersion: state.policy.policyVersion");
    expect(content).toContain('response.setHeader("etag", secureShareRevisionEtag(state.share))');
    expect(access).not.toContain("one_time_confirmation_required");
    expect(metadata).toContain("hasSessionCandidate: Boolean(sessionTokenFromRequest(request, shareId))");
  });

  it("allows only the bound same-attempt grace replacement and revokes its prior session", () => {
    const issue = backendSource.match(
      /async function issueAccessSession[\s\S]*?async function handleAccess/u
    )?.[0] ?? "";
    expect(issue).toContain("grant.identityHash !== identity.identityHash");
    expect(issue).toContain("grant.browserBindingHash !== browserBindingHash");
    expect(issue).toContain("grant.policyVersion !== state.policy.policyVersion");
    expect(issue).toContain("timestampMilliseconds(grant.graceExpiresAt) <= now");
    expect(issue).toContain("activeSessionDigest: digest");
    expect(issue).toContain("{ revokedAt: new Date(now), updatedAt: new Date(now) }");
  });

  it("invalidates old sessions on revoke or policy version change and never consumes owner preview", () => {
    const validation = backendSource.match(
      /async function validatedSession[\s\S]*?async function handleSession/u
    )?.[0] ?? "";
    const ownerPreview = backendSource.match(
      /async function issueOwnerPreviewSession[\s\S]*?function participantAllocationQueueRetryAfter/u
    )?.[0] ?? "";
    expect(validation).toContain("state.share.status === \"revoked\"");
    expect(validation).toContain("session.policyVersion !== state.policy.policyVersion");
    expect(validation).toContain("requireShareManager(state, owner)");
    expect(ownerPreview).not.toContain("consumedAt");
    expect(ownerPreview).not.toContain("successfulAccessCount");
    expect(ownerPreview).toContain("\"owner_preview\"");
  });

  it("allows consumed metadata only for the bound one-time session refresh", () => {
    const metadata = backendSource.match(
      /async function handleMetadata[\s\S]*?async function emailChallengeEligibility/u
    )?.[0] ?? "";
    expect(metadata).toContain("await validatedSession(request, context, shareId)");
    expect(metadata).toContain("session.oneTimeGrant !== true");
    expect(metadata).toContain("throw new HttpError(404, \"share_unavailable\"");
    expect(metadata).toContain("sourceAlreadyValidated = true");
  });

  it("requires owner-preview comment mutations to revalidate the owner session and CSRF", () => {
    const access = backendSource.match(
      /async function commentAccess[\s\S]*?async function handleComments/u
    )?.[0] ?? "";
    const comments = backendSource.match(
      /async function handleComments[\s\S]*?async function handleCommentDelete/u
    )?.[0] ?? "";
    expect(access.indexOf("if (mutation)")).toBeLessThan(access.indexOf("if (authorizationToken(request))"));
    expect(access).toContain("validatedSession(request, context, shareId)");
    expect(access).toContain("requireCsrf(request, validated.session)");
    expect(comments).toContain('session.ownerPreview !== true && state.policy.permissionLevel !== "comment"');
    expect(comments).toContain('? "owner"');
    expect(comments).toContain("ownerUid: state.share.ownerUid");
  });

  it("returns narrow DTOs without raw email, key, storage path, or deletion metadata", () => {
    const metadata = backendSource.match(
      /async function handleMetadata[\s\S]*?async function emailChallengeEligibility/u
    )?.[0] ?? "";
    const content = backendSource.match(
      /async function handleContent[\s\S]*?function validateCommentBody/u
    )?.[0] ?? "";
    const publicComment = backendSource.match(
      /function publicComment[\s\S]*?function commentsCursor/u
    )?.[0] ?? "";
    expect(metadata).not.toContain("allowedEmailHashes");
    expect(metadata).not.toContain("ownerWrappedShareKey");
    expect(content).not.toContain("blobPath");
    expect(content).not.toContain("storagePath");
    expect(content).not.toContain("contentKey");
    expect(publicComment).not.toContain("deletedAt:");
    expect(commonSource).not.toContain("console.error(\"secure share request failed\", error)");
  });

  it("prepares and validates private Blob data before committing a 200 response", () => {
    const stream = backendSource.match(
      /async function streamAttachment[\s\S]*?async function dispatch/u
    )?.[0] ?? "";
    const headersIndex = stream.indexOf("response.statusCode = 200");
    const metadataIndex = stream.indexOf(
      "const blobMetadata = await headPrivateBlobIfPresent(attachment.blobPath)"
    );
    const streamIndex = stream.indexOf("const blob = await get(attachment.blobPath");
    expect(backendSource).not.toContain('import { get } from "@vercel/blob"');
    expect(backendSource).toContain("async function headPrivateBlobIfPresent(blobPath)");
    expect(stream.indexOf("Inline attachment size mismatch")).toBeLessThan(headersIndex);
    expect(stream.indexOf("Private Blob metadata mismatch")).toBeLessThan(headersIndex);
    expect(stream).toContain(
      "storedBlobMetadataMatchesAttachment(blobMetadata, attachment.blobPath, encryptedSize)"
    );
    expect(metadataIndex).toBeGreaterThanOrEqual(0);
    expect(metadataIndex).toBeLessThan(streamIndex);
    expect(stream).toContain('const { get } = await import("@vercel/blob")');
    expect(stream.indexOf("const blob = await get(")).toBeLessThan(headersIndex);
    expect(stream).toContain(
      "streamedBlobMetadataMatchesAttachment(blob.blob, attachment.blobPath, encryptedSize)"
    );
    expect(stream).toContain("await blob.stream.cancel()");
    expect(stream).not.toContain("blob.blob.size");
    expect(stream).toContain("await pipeline(Readable.fromWeb(privateBlobStream), response)");
    expect(stream).toContain("upstream_stream_failed");
    expect(commonSource).toContain("if (response.headersSent)");
    expect(commonSource).toContain("response.destroy()");
  });

  it("accepts legacy RSA-2048 and new RSA-3072 owner-wrapped keys only", () => {
    const wrappedKeyParser = backendSource.match(
      /function wrappedShareKey[\s\S]*?function safeDisplayName/u
    )?.[0] ?? "";

    expect(backendSource).toContain(
      "const supportedOwnerWrappedKeyByteLengths = new Set([256, 384])"
    );
    expect(wrappedKeyParser).toContain(
      "!supportedOwnerWrappedKeyByteLengths.has(wrappedKeyBytes)"
    );
  });

  it("filters owner pagination by schema and uses a document-name tie breaker", () => {
    const ownerList = backendSource.match(
      /async function handleOwnerList[\s\S]*?async function handleOwnerDetails/u
    )?.[0] ?? "";
    expect(ownerList).toContain('field: { fieldPath: "schemaVersion" }');
    expect(ownerList).toContain("firestoreIntegerValue(2)");
    expect(ownerList).toContain('field: { fieldPath: "__name__" }');
    expect(ownerList).toContain("firestoreReferenceValue(cursor.documentName)");
    expect(ownerList).not.toContain("documents.filter((share) => share.schemaVersion === 2)");
  });

  it("uses a bounded complete source-note query and transactional uniqueness guard", () => {
    const sourceQuery = backendSource.match(
      /function sourceShareHistoryQuery[\s\S]*?function sourceNoteMatchesCreate/u
    )?.[0] ?? "";
    const ownerCreate = backendSource.match(
      /async function handleOwnerCreate[\s\S]*?function ownerListCursor/u
    )?.[0] ?? "";
    const ownerList = backendSource.match(
      /async function handleOwnerList[\s\S]*?async function handleOwnerDetails/u
    )?.[0] ?? "";

    expect(sourceQuery).toContain('field: { fieldPath: "ownerUid" }');
    expect(sourceQuery).toContain('field: { fieldPath: "sourceNoteId" }');
    expect(sourceQuery).toContain("limit: maximumSourceShareHistory + 1");
    expect(sourceQuery).toContain("compositeFilter");
    expect(sourceQuery).not.toContain("orderBy");
    expect(sourceQuery).toContain("documents.length > maximumSourceShareHistory");
    expect(ownerCreate).toContain("firestoreBatchGetNewTransaction(context");
    expect(ownerCreate).toContain("user.uid,\n          input.sourceNoteId,\n          transaction");
    expect(ownerCreate).toContain("firestoreCommit(context, [...writes, guardWrite], transaction)");
    expect(ownerCreate).toContain("sourceCreateTransactionMaximumAttempts");
    expect(ownerCreate).toContain("blockingSourceShareFromGuard(");
    expect(ownerCreate).toContain("await waitBeforeOptimisticRetry(attempt)");
    expect(ownerCreate).toContain("if (error instanceof HttpError)");
    expect(ownerCreate).toContain("const createRateLimitReservations = await consumeRateLimits");
    expect(ownerCreate).toContain("catch (recoveryError)");
    expect(ownerCreate).toContain("Source share conflict recovery did not converge");
    expect(
      ownerCreate.match(
        /releaseRateLimitReservations\(\s*context,\s*createRateLimitReservations\s*\)/gu
      )
    ).toHaveLength(2);
    expect(ownerCreate).toContain('"active_share_exists"');
    expect(ownerList).toContain("ownedSourceShareHistory(");
    expect(ownerList).toContain("nextCursor: null");
    expect(ownerList).toContain("Source-specific share history does not accept a cursor");
  });

  it("keeps only failed password attempts and applies the documented create and copy limits", () => {
    const access = backendSource.match(
      /async function handleAccess[\s\S]*?async function validatedSession/u
    )?.[0] ?? "";
    const release = backendSource.match(
      /async function releaseRateLimitReservations[\s\S]*?function policyInputKeys/u
    )?.[0] ?? "";
    const consume = backendSource.match(
      /async function consumeRateLimits[\s\S]*?async function releaseRateLimitReservations/u
    )?.[0] ?? "";
    const ownerCreate = backendSource.match(
      /async function handleOwnerCreate[\s\S]*?async function handleOwnerList/u
    )?.[0] ?? "";
    const copyGrant = backendSource.match(
      /async function handleCopyGrant[\s\S]*?function evaluateCopyAttachmentQuota/u
    )?.[0] ?? "";

    expect(access).toContain("const passwordReservations = await consumeRateLimits");
    expect(access.indexOf("verifySharePassword(")).toBeLessThan(
      access.indexOf("releaseRateLimitReservations(context, passwordReservations)")
    );
    expect(release).toContain("count: count - 1");
    expect(release).toContain("deleteDocumentWrite(");
    expect(release).toContain("rateLimitTransactionMaximumAttempts");
    expect(release).toContain("await waitBeforeOptimisticRetry(attempt)");
    expect(release).toContain("Rate limit release did not converge");
    expect(consume).toContain("rateLimitTransactionMaximumAttempts");
    expect(consume).toContain("await waitBeforeOptimisticRetry(attempt)");
    expect(consume).toContain("Rate limit update did not converge");
    expect(consume).toContain("previousWindowLock");
    expect(consume).toContain("definition.rollingWindowHours + 2");
    expect(consume).toContain("states.map(({ current }) => current.path)");
    expect(backendSource).toContain('"otp_share_email_rolling_24h"');
    expect(backendSource).not.toContain('"otp_share_email_day"');
    expect(ownerCreate).toContain('"share_create_owner_hour"');
    expect(ownerCreate).toContain('"share_create_owner_day"');
    expect(ownerCreate).toContain("limit: 20");
    expect(ownerCreate).toContain("limit: 100");
    expect(copyGrant).toContain("copyGrantRateBucket(");
    expect(copyGrant).toContain("beginCopyGrantRequestTransaction(");
    expect(copyGrant).toContain("[requestWrite, rateWrite, auditWrite]");
    expect(copyGrant).not.toContain("consumeRateLimits(context");
  });

  it("keeps the production provider server-only and the Resend retry gate test-only", () => {
    const emailChallenge = backendSource.match(
      /async function handleEmailChallenge[\s\S]*?async function incrementChallengeFailure/u
    )?.[0] ?? "";

    expect(backendSource).toContain("const emailProviderRequestRateWindowSeconds = 1");
    expect(backendSource).toContain("const emailProviderRequestRateLimit = 2");
    expect(backendSource).toContain('provider === "gmail_smtp"');
    expect(backendSource).toContain("createGmailSmtpEmailAdapter({");
    expect(backendSource).toContain("runtimeSnapshot?.environment ?? environment");
    expect(backendSource).toContain('provider === "resend" && environment.NODE_ENV === "test"');
    expect(backendSource).toContain('"email_provider_request_global_second"');
    expect(backendSource).toContain('keyParts: ["resend_test_only"]');
    expect(emailChallenge).toContain("createConfiguredEmailAdapter(");
    expect(emailChallenge).toContain("currentEmailRuntime");
    expect(emailChallenge).toContain("providerAdapter,");
  });

  it("replays persistent copy grants before quota work and recovers ambiguous commits", () => {
    const copyGrant = backendSource.match(
      /function copyGrantRequestId[\s\S]*?function evaluateCopyAttachmentQuota/u
    )?.[0] ?? "";
    const handlerSource = backendSource.match(
      /async function handleCopyGrant[\s\S]*?function evaluateCopyAttachmentQuota/u
    )?.[0] ?? "";

    expect(copyGrant).toContain("publicShareCopyGrantRequests/${requestDocumentId}");
    expect(copyGrant).toContain("firestoreBatchGetNewTransaction(context");
    expect(copyGrant).toContain("requestDocument.issuanceGeneration + 1");
    expect(copyGrant).toContain("expiresAtSeconds <= nowSeconds + copyGrantReplayMinimumSeconds");
    expect(copyGrant).toContain("copyGrantAuditEventId(");
    expect(copyGrant).toContain("grant.exp !== expiresAtSeconds");
    expect(handlerSource.indexOf("fastReplay.status === \"replay\"")).toBeLessThan(
      handlerSource.indexOf("preflightCopyAttachmentQuota(")
    );
    expect(handlerSource).toContain("[requestWrite, rateWrite, auditWrite]");
    expect(handlerSource).toContain("commitAttempted = true");
    expect(handlerSource).toContain("await firestoreGet(context, requestPath)");
    expect(handlerSource).toContain("recovered.status === \"replay\"");
  });

  it("uses a structured comment cursor query instead of a bounded collection scan", () => {
    const comments = backendSource.match(
      /async function handleComments[\s\S]*?async function handleCommentDelete/u
    )?.[0] ?? "";
    expect(comments).toContain("firestoreRunQuery(");
    expect(comments).toContain("`publicShareComments/${shareId}`");
    expect(comments).toContain('field: { fieldPath: "createdAt" }');
    expect(comments).toContain('field: { fieldPath: "__name__" }');
    expect(comments).toContain("pageSize + 1");
    expect(comments).not.toContain("firestoreListCollection(");
  });

  it("accepts proxy IP headers only in the Vercel runtime and prefers Vercel's stable header", () => {
    const trustedInputs = commonSource.match(
      /function trustedClientNetworkValues[\s\S]*?export function clientNetworkIdentity/u
    )?.[0] ?? "";
    const networkIdentity = commonSource.match(
      /export function clientNetworkIdentity[\s\S]*?export function clientIpPrefix/u
    )?.[0] ?? "";
    const consumers = commonSource.match(
      /export function clientIpPrefix[\s\S]*?export function userAgentDigest/u
    )?.[0] ?? "";
    expect(trustedInputs).toContain('process.env.VERCEL === "1"');
    expect(trustedInputs).toContain('"x-vercel-forwarded-for"');
    expect(trustedInputs).toContain("request?.socket?.remoteAddress");
    expect(trustedInputs).not.toContain('headerValue(request, "x-real-ip")');
    expect(trustedInputs.match(/headerValue\(request, "x-vercel-forwarded-for"\)/gu))
      .toHaveLength(1);
    expect(networkIdentity).toContain("digest:");
    expect(networkIdentity).toContain("prefix:");
    expect(consumers).toContain(
      "return publicIpPrefix(trustedClientNetworkValues(request).prefixCandidate)"
    );
    expect(consumers).toContain("return clientNetworkIdentity(request).digest");
  });

  it("records an authorized administrator distinctly when deleting a comment", () => {
    const deletion = backendSource.match(
      /async function handleCommentDelete[\s\S]*?async function handleCopyGrant/u
    )?.[0] ?? "";
    expect(deletion).toContain('const managerRole = access.owner?.isAdmin === true ? "admin" : "owner"');
    expect(deletion).toContain('? "admin_preview"');
  });
});

describe("Secure Share v2 participant identity and coarse network contracts", () => {
  it("fails participant identity closed for missing, short, or reused HMAC keys", async () => {
    const { secureShareParticipantIdentityEnabled } = await vi.importActual<{
      secureShareParticipantIdentityEnabled(): boolean;
    }>("../../api/_secure-share-common.js");
    const secretNames = [
      "SHARE_PASSWORD_PEPPER",
      "SHARE_SESSION_HMAC_KEY",
      "SHARE_COOKIE_NAME_HMAC_KEY",
      "SHARE_CSRF_HMAC_KEY",
      "SHARE_OTP_HMAC_KEY",
      "SHARE_EMAIL_HMAC_KEY",
      "SHARE_RATE_LIMIT_HMAC_KEY"
    ];
    vi.stubEnv("SECURE_SHARE_V2_ENABLED", "true");
    vi.stubEnv("SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED", "false");
    vi.stubEnv("SHARE_PARTICIPANT_HMAC_KEY", "");
    expect(secureShareParticipantIdentityEnabled()).toBe(false);

    vi.stubEnv("SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED", "true");
    for (const invalid of ["", "short-participant-key"]) {
      vi.stubEnv("SHARE_PARTICIPANT_HMAC_KEY", invalid);
      expect(() => secureShareParticipantIdentityEnabled()).toThrowError(
        expect.objectContaining({
          code: "service_unavailable",
          expose: false,
          statusCode: 503
        })
      );
    }

    const participantKey = "participant-key-distinct-000000000000000001";
    secretNames.forEach((name, index) => {
      vi.stubEnv(name, `other-secret-${index}-0000000000000000000000000001`);
    });
    vi.stubEnv("SHARE_PARTICIPANT_HMAC_KEY", participantKey);
    expect(secureShareParticipantIdentityEnabled()).toBe(true);

    const logSpies = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined)
    ];
    for (const name of secretNames) {
      secretNames.forEach((candidate, index) => {
        vi.stubEnv(
          candidate,
          `other-secret-${index}-0000000000000000000000000001`
        );
      });
      vi.stubEnv(name, participantKey);
      expect(() => secureShareParticipantIdentityEnabled(), name).toThrowError(
        expect.objectContaining({
          code: "service_unavailable",
          expose: false,
          statusCode: 503
        })
      );
    }
    expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it("fails IP-prefix display closed when its network HMAC is short or reused", async () => {
    const { secureShareCommentIpPrefixEnabled } = await vi.importActual<{
      secureShareCommentIpPrefixEnabled(): boolean;
    }>("../../api/_secure-share-common.js");
    vi.stubEnv("SECURE_SHARE_V2_ENABLED", "true");
    vi.stubEnv("SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED", "true");
    vi.stubEnv("SECURE_SHARE_COMMENT_IP_PREFIX_ENABLED", "true");
    vi.stubEnv("SHARE_PARTICIPANT_HMAC_KEY", "p".repeat(48));
    vi.stubEnv("SHARE_PASSWORD_PEPPER", "w".repeat(48));
    vi.stubEnv("SHARE_SESSION_HMAC_KEY", "s".repeat(48));
    vi.stubEnv("SHARE_COOKIE_NAME_HMAC_KEY", "k".repeat(48));
    vi.stubEnv("SHARE_CSRF_HMAC_KEY", "c".repeat(48));
    vi.stubEnv("SHARE_OTP_HMAC_KEY", "o".repeat(48));
    vi.stubEnv("SHARE_EMAIL_HMAC_KEY", "e".repeat(48));
    vi.stubEnv("SHARE_RATE_LIMIT_HMAC_KEY", "r".repeat(48));
    expect(secureShareCommentIpPrefixEnabled()).toBe(true);

    for (const invalid of [
      "short-network-key",
      "w".repeat(48),
      "s".repeat(48)
    ]) {
      vi.stubEnv("SHARE_RATE_LIMIT_HMAC_KEY", invalid);
      expect(() => secureShareCommentIpPrefixEnabled()).toThrowError(
        expect.objectContaining({
          code: "service_unavailable",
          expose: false,
          statusCode: 503
        })
      );
    }
  });

  it("normalizes only coarse public IPv4 and IPv6 prefixes", async () => {
    const { publicIpPrefix } = await vi.importActual<{
      publicIpPrefix(value: string): string | null;
    }>("../../api/_secure-share-common.js");

    expect(publicIpPrefix("203.226.244.27")).toBe("203.226");
    expect(publicIpPrefix("2001:2D8:1234::99")).toBe("2001:2d8");
    expect(publicIpPrefix("::ffff:203.226.244.27")).toBe("203.226");

    for (const rejected of [
      "10.1.2.3",
      "100.64.1.2",
      "127.0.0.1",
      "169.254.1.2",
      "172.16.1.2",
      "192.0.3.1",
      "192.168.1.2",
      "192.88.99.7",
      "192.88.100.1",
      "198.51.100.7",
      "198.51.101.1",
      "203.0.113.7",
      "203.0.114.1",
      "::1",
      "::2",
      "fc00::1",
      "fe80::1",
      "2001:2::1",
      "2001:db8::1",
      "3fff:0::1",
      "3fff:fff::1",
      "::ffff:192.168.1.2",
      "not-an-ip"
    ]) {
      expect(publicIpPrefix(rejected), rejected).toBeNull();
    }
  });

  it("rejects private, benchmark, and documentation prefixes from stored snapshots", async () => {
    const { safeIpPrefixSnapshot } = await vi.importActual<{
      safeIpPrefixSnapshot(value: unknown): string | null;
    }>("../../api/public-shares-v2.js");

    expect(safeIpPrefixSnapshot("203.226")).toBe("203.226");
    expect(safeIpPrefixSnapshot("2001:2d8")).toBe("2001:2d8");
    for (const rejected of [
      "10.1",
      "192.168",
      "198.51",
      "203.0",
      "2001:db8",
      "2001:2",
      "3fff:0"
    ]) {
      expect(safeIpPrefixSnapshot(rejected), rejected).toBeNull();
    }
  });

  it("uses production-disabled IP injection and rejects forwarded chains", async () => {
    const { clientIpPrefix } = await vi.importActual<{
      clientIpPrefix(request: unknown): string | null;
    }>("../../api/_secure-share-common.js");

    vi.stubEnv("SHARE_RATE_LIMIT_HMAC_KEY", "r".repeat(48));
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "1");
    expect(clientIpPrefix({
      headers: { "x-vercel-forwarded-for": "8.8.8.8" },
      secureShareTestClientIp: "203.226.244.27"
    })).toBe("203.226");
    expect(clientIpPrefix({
      headers: { "x-vercel-forwarded-for": "8.8.8.8, 1.1.1.1" }
    })).toBeNull();

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "0");
    expect(clientIpPrefix({
      headers: {
        "x-forwarded-for": "203.226.244.27",
        "x-real-ip": "203.226.244.27",
        "x-vercel-forwarded-for": "203.226.244.27"
      },
      secureShareTestClientIp: "203.226.244.27"
    })).toBeNull();
  });

  it("allocates an idempotent participant from CSPRNG-signed cookies in the access transaction", () => {
    const identity = backendSource.match(
      /async function resolveAccessIdentity[\s\S]*?async function beginParticipantAllocation/u
    )?.[0] ?? "";
    const tokenIssuance = backendSource.match(
      /function participantIssuanceIdentity[\s\S]*?function participantIdFromIdentityHash/u
    )?.[0] ?? "";
    const allocation = backendSource.match(
      /async function beginParticipantAllocation[\s\S]*?function sessionCapabilities/u
    )?.[0] ?? "";
    const lastSeen = backendSource.match(
      /function participantLastSeenWrites[\s\S]*?async function beginParticipantAllocation/u
    )?.[0] ?? "";
    const issue = backendSource.match(
      /async function issueAccessSession[\s\S]*?async function handleAccess/u
    )?.[0] ?? "";
    const access = backendSource.match(
      /async function handleAccess[\s\S]*?async function validatedSession/u
    )?.[0] ?? "";
    const metadata = backendSource.match(
      /async function handleMetadata[\s\S]*?async function emailChallengeEligibility/u
    )?.[0] ?? "";

    expect(identity).toContain("issueAnonymousParticipantToken(");
    expect(identity).toContain("safeUnlockAttemptId(body.unlockAttemptId)");
    expect(identity).toContain("verifiedAnonymousParticipantToken(");
    expect(identity).toContain("participantIdentityValue");
    expect(tokenIssuance).toContain("const nonce = randomToken(32)");
    expect(tokenIssuance).toContain('"quickmemo/secure-share/participant-issuance/v2"');
    expect(tokenIssuance).toContain(
      '"quickmemo/secure-share/participant-token-signature/v2"'
    );
    expect(tokenIssuance).not.toContain(
      '"quickmemo/secure-share/participant-token-issuance/v1"'
    );
    expect(allocation).toContain("firestoreBatchGetNewTransaction(context");
    expect(allocation).toContain("participantDocumentPath(shareId, participantId)");
    expect(allocation).toContain("participantCounterPath(shareId)");
    expect(allocation).toContain("participantCount >= maximumParticipantsPerShare");
    expect(allocation).toContain("participant: null");
    expect(lastSeen).toContain(
      "lastSeenAt > Date.now() - sessionLastSeenWriteIntervalMilliseconds"
    );
    expect(lastSeen).toContain('{ lastSeenAt: now, updatedAt: now }');
    expect(lastSeen).toContain('["lastSeenAt", "updatedAt"]');
    expect(lastSeen).toContain("participant.__updateTime");
    expect(allocation).toContain("transaction: \"\"");
    expect(issue).toContain("firestoreCommit(context, writes, participantAllocation.transaction)");
    expect(issue).toContain("session.participantId = participantAllocation.participant.participantId");
    expect(issue).toContain(
      "session.participantIdentityEnabled = participantAllocation.enabled"
    );
    expect(issue).toContain(
      "session.participantLimitReached = participantAllocation.limitReached"
    );
    expect(issue).toContain(
      "participantIdentityEnabled: participantAllocation.enabled"
    );
    expect(access).toContain("participantCookie(request, shareId, identity.participantToken)");
    expect(access).toContain("grant.participantIdentityEnabled");
    expect(access).toContain('"owner_preview_share_network_15m"');
    expect(access).toContain('"owner_preview_network_hour"');
    expect(metadata).not.toContain("beginParticipantAllocation(");
    expect(backendSource).toContain('"SECURE_SHARE_MAX_PARTICIPANTS_PER_SHARE",\n  1000,\n  1,\n  1000');
  });

  it("keeps legacy sessions legacy across rollout while exposing capped sessions explicitly", () => {
    const capabilities = backendSource.match(
      /function sessionCapabilities[\s\S]*?function sessionFields/u
    )?.[0] ?? "";
    const sessionHandler = backendSource.match(
      /async function handleSession[\s\S]*?function safeAttachmentMetadata/u
    )?.[0] ?? "";
    const comments = backendSource.match(
      /async function handleComments[\s\S]*?async function handleCommentDelete/u
    )?.[0] ?? "";

    expect(capabilities).toContain(
      "participantIdentitySessionEnabled = secureShareParticipantIdentityEnabled()"
    );
    expect(capabilities).toContain("&& participantIdentitySessionEnabled");
    expect(capabilities).toContain("participantLimitReached:");
    expect(capabilities).toContain("participantIdentityEnabled && participantLimitReached");
    expect(capabilities).toContain("!participantIdentityEnabled");
    expect(capabilities).toContain("|| participantAvailable");
    expect(sessionHandler).toContain("session.participantIdentityEnabled === true");
    expect(sessionHandler).toContain("session.participantLimitReached === true");
    expect(comments).toContain("session.participantIdentityEnabled === true");
  });

  it("keeps participant APIs session-bound, CSRF protected, and idempotent", () => {
    const rename = backendSource.match(
      /async function renameParticipant[\s\S]*?async function handleParticipantMe/u
    )?.[0] ?? "";
    const participantMe = backendSource.match(
      /async function handleParticipantMe[\s\S]*?function validateCommentBody/u
    )?.[0] ?? "";
    const dispatch = backendSource.match(
      /async function dispatch[\s\S]*?export \{/u
    )?.[0] ?? "";

    expect(participantMe).toContain('requireMethod(request, ["GET", "PATCH"])');
    expect(participantMe).toContain("commentAccess(request, context, shareId, request.method === \"PATCH\")");
    expect(participantMe).toContain('assertOnlyKeys(body, ["displayName", "clientRequestId"])');
    expect(participantMe).not.toContain('"participantId",');
    expect(participantMe).toContain('"participant_rename_identity_hour"');
    expect(participantMe).toContain('"participant_rename_share_network_hour"');
    expect(backendSource).toContain(
      "publicShareParticipantRenameRequests/${shareId}/items/${participantId}"
    );
    expect(rename).toContain("renameRequestPath");
    expect(rename).toContain("renameRequestHistory(renameRequest)");
    expect(rename).toContain("recentRenameRequests.find((entry)");
    expect(rename).toContain("].slice(-10)");
    expect(rename).toContain("firestoreBatchGetNewTransaction(context, readPaths)");
    expect(rename).toContain("window.hourCount >= 3");
    expect(rename).toContain("window.dayCount >= 10");
    expect(rename).toContain("lastRenamedAt + 60_000");
    expect(rename).toContain("participant.normalizedDisplayName === name.normalizedDisplayName");
    expect(rename).toContain("renameHourCount: window.hourCount + 1");
    expect(rename).toContain("renameDayCount: window.dayCount + 1");
    expect(rename).toContain('"participant_rename_noop"');
    expect(rename).toContain('"display_name_unavailable"');
    expect(dispatch).toContain('action === "participant-me"');
    expect(dispatch).toContain("handleParticipantMe(request, response, id, shareId)");
  });

  it("hydrates at most twenty comment authors in one bounded batch and preserves legacy fallback", () => {
    const comments = backendSource.match(
      /async function handleComments[\s\S]*?async function handleCommentDelete/u
    )?.[0] ?? "";
    const publicComment = backendSource.match(
      /function publicComment[\s\S]*?function commentsCursor/u
    )?.[0] ?? "";
    const deletion = backendSource.match(
      /async function handleCommentDelete[\s\S]*?async function handleCopyGrant/u
    )?.[0] ?? "";

    expect(backendSource).toContain("const maximumCommentPageSize = 20");
    expect(comments).toContain("boundedInteger(Number.parseInt(pageSizeText, 10), \"limit\", 1, maximumCommentPageSize)");
    expect(comments).toContain("const participantIds = [...new Set(");
    expect(comments).toContain("await firestoreBatchGet(");
    expect(comments.match(/await firestoreBatchGet\(/gu)).toHaveLength(1);
    expect(comments).not.toContain("firestoreListCollection(");
    expect(publicComment).toContain("comment.authorDisplayNameSnapshot");
    expect(publicComment).toContain("comment.authorDisplayName");
    expect(publicComment).toContain("safeIpPrefixSnapshot(comment.ipPrefixSnapshot)");
    expect(publicComment).not.toContain("identityHash:");
    expect(comments).toContain("authorUid: participant ? undefined");
    expect(comments).toContain("authorIdentityHash: participant ? undefined");
    expect(comments).toContain("authorParticipantId: participant?.participantId");
    expect(deletion).toContain("comment.authorParticipantId === access.session.participantId");
    expect(deletion).toContain("!comment.authorParticipantId");
  });

  it("keeps legacy feature status exact and exposes live sync separately", () => {
    const featureStatus = backendSource.match(
      /if \(action === "feature-status"\)[\s\S]*?return;/u
    )?.[0] ?? "";
    const liveSyncStatus = backendSource.match(
      /if \(action === "live-sync-status"\)[\s\S]*?return;/u
    )?.[0] ?? "";

    expect(featureStatus).toContain("v2Enabled: secureShareV2Enabled()");
    expect(featureStatus).toContain("emailEnabled");
    expect(featureStatus).toContain("safeSecureShareEmailRuntimeSnapshot");
    expect(featureStatus).not.toContain("secureShareEmailEnabled()");
    expect(featureStatus).not.toContain("liveContentSyncEnabled");
    expect(liveSyncStatus).toContain("secureShareLiveContentSyncEnabled()");
    expect(liveSyncStatus).toContain("secureShareV2Enabled()");
    expect(featureStatus).not.toContain("participantIdentityEnabled");
    expect(featureStatus).not.toContain("commentIpPrefixEnabled");
  });
});
