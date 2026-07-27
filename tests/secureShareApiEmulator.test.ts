import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  emailDigest,
  hashSharePassword,
  otpCodeDigest,
  sessionTokenDigest
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
  type SecureShareApiHarness
} from "./helpers/secureShareApiEmulator.js";

const describeEmulator =
  process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
    ? describe
    : describe.skip;

const failureOnlyKeys = ["error", "ok", "requestId"];

function accessUrl(origin: string, shareId: string) {
  return `${origin}/api/public-shares-v2?action=access&shareId=${encodeURIComponent(shareId)}`;
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

  it("atomically grants exactly one of 20 parallel identities and preserves same-attempt grace", async () => {
    const shareId = "parallel_one_time_share";
    const seed = await seedSecureShare({ shareId });
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
