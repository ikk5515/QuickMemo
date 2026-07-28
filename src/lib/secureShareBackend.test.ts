import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import handler, {
  HttpError,
  assertOnlyKeys,
  assertEmailPolicyAvailable,
  buildPolicySettings,
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
  ensureSameOrigin,
  evaluateCopyAttachmentQuota,
  handleApiError,
  hashSharePassword,
  issueAccessSession,
  normalizeAllowedEmails,
  normalizeEmail,
  otpCodeDigest,
  otpVerificationFailureMinimumResponseMilliseconds,
  padEmailChallengeResponse,
  padOtpVerificationFailureResponse,
  readJsonBody,
  resolveAccessIdentity,
  resolveEmailQuotaPolicy,
  safeDisplayName,
  secureShareAttachmentBlobPath,
  secureShareEmailReadiness,
  shareManagedBy,
  shareOwnedBy,
  signedOpaqueToken,
  sourceShareGuardId,
  sourceSnapshotAvailable,
  validateCommentBody,
  verificationEmailText,
  verifySharePassword,
  verifySignedOpaqueToken
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

    expect(fetchMock).toHaveBeenCalledTimes(4);
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

describe("Secure Share v2 request boundary", () => {
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
      { now: () => 0, random: () => 3_000, wait: pendingWait }
    )).rejects.toMatchObject({ statusCode: 403, code: "access_denied" });
    await expect(resolveAccessIdentity(
      request,
      context,
      "share-a",
      policy,
      { challengeId: suppressedChallengeId, otp: "000000" },
      { now: () => 0, random: () => 3_000, wait: suppressedWait }
    )).rejects.toMatchObject({ statusCode: 403, code: "access_denied" });

    expect(pendingWait).toHaveBeenCalledExactlyOnceWith(3_000);
    expect(suppressedWait).toHaveBeenCalledExactlyOnceWith(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
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
      senderVerified: true
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
      dailyHardLimit: 80,
      dailySoftLimit: 64,
      monthlyHardLimit: 2_400,
      monthlySoftLimit: 1_920
    });
    expect(resolveEmailQuotaPolicy({
      SHARE_EMAIL_DAILY_HARD_LIMIT: "999",
      SHARE_EMAIL_DAILY_SOFT_LIMIT: "999",
      SHARE_EMAIL_MONTHLY_HARD_LIMIT: "9999",
      SHARE_EMAIL_MONTHLY_SOFT_LIMIT: "9999"
    })).toEqual({
      dailyHardLimit: 80,
      dailySoftLimit: 80,
      monthlyHardLimit: 2_400,
      monthlySoftLimit: 2_400
    });

    const [daily, monthly] = emailQuotaPeriods(
      Date.parse("2026-07-29T12:34:56.000Z")
    );
    expect(daily).toMatchObject({
      bucketId: "day_2026-07-29",
      periodKey: "2026-07-29",
      scope: "daily",
      softLimit: 64,
      hardLimit: 80
    });
    expect(monthly).toMatchObject({
      bucketId: "month_2026-07",
      periodKey: "2026-07",
      scope: "monthly",
      softLimit: 1_920,
      hardLimit: 2_400
    });
    expect(emailQuotaExceeded(
      { reservedCount: 1, sentCount: 79 },
      daily
    )).toMatchObject({
      exceeded: true,
      softLimitReached: true,
      total: 80
    });
    expect(emailQuotaExceeded(
      { reservedCount: 0, sentCount: 2_399 },
      monthly
    )).toMatchObject({
      exceeded: false,
      softLimitReached: true,
      total: 2_399
    });
    expect(emailQuotaExceeded(
      { reservedCount: 1, sentCount: 2_399 },
      monthly
    )).toMatchObject({
      exceeded: true,
      total: 2_400
    });
    expect(emailQuotaPeriods(
      Date.parse("2026-08-01T00:00:00.000Z")
    ).map((period) => period.bucketId)).toEqual([
      "day_2026-08-01",
      "month_2026-08"
    ]);
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

  it("binds every read to the active owner and exact source revisions", () => {
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
    expect(sourceSnapshotAvailable(share, { ...note, revision: 10 }, profile)).toBe(false);
    expect(sourceSnapshotAvailable(share, note, { ...profile, isActive: false })).toBe(false);
    expect(sourceSnapshotAvailable(share, note, {
      ...profile,
      featureAccess: { notes: false }
    })).toBe(false);
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
      identityType: "browser"
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
    expect(issue).toContain("for (let attempt = 0; attempt < 4; attempt += 1)");
    expect(issue).toContain("state.share.__updateTime");
    expect(issue).toContain("state.policy.__updateTime");
    expect(issue).toContain("`publicShareUnlockGrants/${attemptHash}`");
    expect(issue).toContain("createDocumentWrite(context.projectId, `publicShareAccessSessions/${digest}`");
    expect(issue).toContain("await firestoreCommit(context, writes)");
    expect(issue).toContain("isOptimisticConflict(error)");
    expect(issue.indexOf("createAuditWrite(")).toBeLessThan(issue.indexOf("await firestoreCommit(context, writes)"));
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
      /async function issueOwnerPreviewSession[\s\S]*?async function issueAccessSession/u
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
    expect(stream.indexOf("Inline attachment size mismatch")).toBeLessThan(headersIndex);
    expect(stream.indexOf("Private Blob metadata mismatch")).toBeLessThan(headersIndex);
    expect(stream.indexOf("const blob = await get(")).toBeLessThan(headersIndex);
    expect(stream).toContain("await pipeline(Readable.fromWeb(privateBlobStream), response)");
    expect(stream).toContain("upstream_stream_failed");
    expect(commonSource).toContain("if (response.headersSent)");
    expect(commonSource).toContain("response.destroy()");
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
    expect(ownerCreate).toContain('"share_create_owner_hour"');
    expect(ownerCreate).toContain('"share_create_owner_day"');
    expect(ownerCreate).toContain("limit: 20");
    expect(ownerCreate).toContain("limit: 100");
    expect(copyGrant).toContain("copyGrantRateBucket(");
    expect(copyGrant).toContain("beginCopyGrantRequestTransaction(");
    expect(copyGrant).toContain("[requestWrite, rateWrite, auditWrite]");
    expect(copyGrant).not.toContain("consumeRateLimits(context");
  });

  it("consumes a conservative distributed token before every provider attempt", () => {
    const emailChallenge = backendSource.match(
      /async function handleEmailChallenge[\s\S]*?async function incrementChallengeFailure/u
    )?.[0] ?? "";

    expect(backendSource).toContain("const emailProviderRequestRateWindowSeconds = 1");
    expect(backendSource).toContain("const emailProviderRequestRateLimit = 2");
    expect(emailChallenge).toContain("createResendEmailAdapter(");
    expect(emailChallenge).toContain('"email_provider_request_global_second"');
    expect(emailChallenge).toContain('keyParts: ["resend"]');
    expect(emailChallenge).toContain("including the adapter's idempotent retry");
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
    const networkIdentity = commonSource.match(
      /export function clientNetworkDigest[\s\S]*?export function userAgentDigest/u
    )?.[0] ?? "";
    expect(networkIdentity).toContain('process.env.VERCEL === "1"');
    expect(networkIdentity).toContain('"x-vercel-forwarded-for"');
    expect(networkIdentity).toContain("request?.socket?.remoteAddress");
    expect(networkIdentity).not.toContain('headerValue(request, "x-real-ip")');
  });

  it("records an authorized administrator distinctly when deleting a comment", () => {
    const deletion = backendSource.match(
      /async function handleCommentDelete[\s\S]*?async function handleCopyGrant/u
    )?.[0] ?? "";
    expect(deletion).toContain('const managerRole = access.owner?.isAdmin === true ? "admin" : "owner"');
    expect(deletion).toContain('? "admin_preview"');
  });
});
