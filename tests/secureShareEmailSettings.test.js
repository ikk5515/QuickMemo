/* global Buffer, process */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adminEmailSettingsRequestHash,
  adminIdempotencyRequestMatches,
  assertEmailSettingsTestSendAvailable,
  createPendingEmailSettingsSlot,
  decryptEmailSettingsSlot,
  emailSettingsTestFailureDisposition,
  encryptEmailSettingsSlot,
  gmailRuntimeEnvironment,
  idTokenHasRecentAdminAuthentication,
  loadSecureShareEmailRuntimeSnapshot,
  normalizeGmailSettingsInput,
  publicEmailSettingsStatus
} from "../api/_secure-share-email-settings.js";
import {
  emailSettingsSendingRecoveryState
} from "../api/admin-email-settings.js";

const projectId = "quickmemo-settings-test";
const generation = "generation_20260730_abcd";
const encryptionKey = Buffer.alloc(32, 0x5a).toString("base64url");
const baseEnvironment = {
  SECURE_SHARE_V2_ENABLED: "true",
  SECURE_SHARE_EMAIL_ENABLED: "true",
  SHARE_EMAIL_SETTINGS_ENCRYPTION_KEY_V1: encryptionKey,
  SHARE_OTP_HMAC_KEY: "o".repeat(48),
  SHARE_EMAIL_HMAC_KEY: "e".repeat(48),
  SHARE_RATE_LIMIT_HMAC_KEY: "r".repeat(48),
  SHARE_PASSWORD_PEPPER: "p".repeat(48),
  SHARE_SESSION_HMAC_KEY: "s".repeat(48),
  SHARE_COOKIE_NAME_HMAC_KEY: "c".repeat(48),
  SHARE_CSRF_HMAC_KEY: "f".repeat(48),
  SHARE_PARTICIPANT_HMAC_KEY: "i".repeat(48)
};
const gmailSettings = {
  username: "quickmemo.settings.test@gmail.com",
  appPassword: "abcdefghijklmnop",
  replyTo: "reply@example.com"
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Secure Share administrator email settings", () => {
  it("normalizes only ASCII display spaces in an app password and rejects hyphens", () => {
    expect(normalizeGmailSettingsInput({
      ...gmailSettings,
      appPassword: "abcd efgh ijkl mnop"
    }).appPassword).toBe("abcdefghijklmnop");
    expect(() => normalizeGmailSettingsInput({
      ...gmailSettings,
      appPassword: "abcd-efgh-ijkl-mnop"
    })).toThrowError(expect.objectContaining({
      code: "invalid_request",
      statusCode: 400
    }));
    expect(() => normalizeGmailSettingsInput({
      ...gmailSettings,
      appPassword: "abcd\tefghijklmnop"
    })).toThrowError(expect.objectContaining({
      code: "invalid_request",
      statusCode: 400
    }));
    expect(() => normalizeGmailSettingsInput({
      ...gmailSettings,
      username: "사용자@gmail.com"
    })).toThrowError(expect.objectContaining({
      code: "invalid_request",
      statusCode: 400
    }));
  });

  it("binds every admin idempotency action to its canonical normalized payload", () => {
    vi.stubEnv(
      "SHARE_RATE_LIMIT_HMAC_KEY",
      baseEnvironment.SHARE_RATE_LIMIT_HMAC_KEY
    );
    const actorUid = "admin-user";
    const now = Date.parse("2026-07-30T00:00:00.000Z");
    const cases = [
      {
        action: "stage",
        first: {
          action: "stage",
          username: " QuickMemo.Settings.Test@Gmail.com ",
          appPassword: "abcd efgh ijkl mnop",
          replyTo: " reply@example.com "
        },
        same: {
          action: "stage",
          username: gmailSettings.username,
          appPassword: gmailSettings.appPassword,
          replyTo: gmailSettings.replyTo
        },
        different: {
          action: "stage",
          username: gmailSettings.username,
          appPassword: "ponmlkjihgfedcba",
          replyTo: gmailSettings.replyTo
        }
      },
      {
        action: "send-test",
        first: { action: "send-test", generation },
        same: { action: "send-test", generation },
        different: {
          action: "send-test",
          generation: "generation_20260730_other"
        }
      },
      {
        action: "confirm-test",
        first: { action: "confirm-test", generation, code: "123456" },
        same: { action: "confirm-test", generation, code: "123456" },
        different: { action: "confirm-test", generation, code: "654321" }
      },
      {
        action: "disable",
        first: { action: "disable" },
        same: { action: "disable" },
        different: null
      },
      {
        action: "discard-pending",
        first: { action: "discard-pending", generation },
        same: { action: "discard-pending", generation },
        different: {
          action: "discard-pending",
          generation: "generation_20260730_other"
        }
      },
      {
        action: "remove",
        first: { action: "remove", target: "pending", generation },
        same: { action: "remove", target: "pending", generation },
        different: { action: "remove", target: "all", generation }
      }
    ];
    const hashes = [];
    for (const testCase of cases) {
      const first = adminEmailSettingsRequestHash(
        actorUid,
        testCase.first
      );
      const same = adminEmailSettingsRequestHash(
        actorUid,
        testCase.same
      );
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(same).toBe(first);
      expect(adminIdempotencyRequestMatches(
        {
          schemaVersion: 1,
          actorUid,
          action: testCase.action,
          expiresAt: new Date(now + 60_000).toISOString(),
          requestHash: first
        },
        {
          actorUid,
          action: testCase.action,
          nowMilliseconds: now,
          requestHash: same
        }
      )).toBe(true);
      if (testCase.different) {
        expect(adminEmailSettingsRequestHash(
          actorUid,
          testCase.different
        )).not.toBe(first);
      }
      hashes.push(first);
    }
    expect(new Set(hashes).size).toBe(cases.length);
    expect(adminEmailSettingsRequestHash(
      "different-admin",
      cases[3].first
    )).not.toBe(hashes[3]);
    const serialized = JSON.stringify(hashes);
    expect(serialized).not.toContain(gmailSettings.username);
    expect(serialized).not.toContain(gmailSettings.appPassword);
    expect(serialized).not.toContain("123456");
    expect(serialized).not.toContain("pending");
    const validDisableDocument = {
      schemaVersion: 1,
      actorUid,
      action: "disable",
      expiresAt: new Date(now + 60_000).toISOString(),
      requestHash: hashes[3]
    };
    for (const malformed of [
      { ...validDisableDocument, schemaVersion: 2 },
      { ...validDisableDocument, actorUid: "different-admin" },
      { ...validDisableDocument, action: "stage" },
      {
        ...validDisableDocument,
        expiresAt: new Date(now).toISOString()
      }
    ]) {
      expect(adminIdempotencyRequestMatches(malformed, {
        actorUid,
        action: "disable",
        nowMilliseconds: now,
        requestHash: hashes[3]
      })).toBe(false);
    }
  });

  it("recovers only a structurally valid sending reservation after its deadline", () => {
    const now = Date.parse("2026-07-30T00:10:00.000Z");
    const pending = {
      testState: "sending",
      testQuotaState: "reserved",
      testQuotaBucketIds: [
        "minute_2026-07-30T00:00",
        "hour_2026-07-30T00",
        "month_2026-07"
      ]
    };
    expect(emailSettingsSendingRecoveryState({
      ...pending,
      testExpiresAt: new Date(now + 1).toISOString()
    }, now)).toBe("in_flight");
    expect(emailSettingsSendingRecoveryState({
      ...pending,
      testExpiresAt: new Date(now).toISOString()
    }, now)).toBe("expired");
    expect(emailSettingsSendingRecoveryState({
      testState: "ambiguous"
    }, now)).toBe("not_sending");
    expect(() => emailSettingsSendingRecoveryState({
      ...pending,
      testQuotaBucketIds: ["minute_invalid"],
      testExpiresAt: new Date(now).toISOString()
    }, now)).toThrowError(expect.objectContaining({
      code: "email_settings_unavailable",
      statusCode: 503
    }));
  });

  it("round-trips one authenticated ciphertext and rejects AAD relocation", () => {
    const encrypted = encryptEmailSettingsSlot(gmailSettings, {
      environment: baseEnvironment,
      generation,
      projectId,
      slot: "pending"
    });
    const decrypted = decryptEmailSettingsSlot(encrypted, {
      environment: baseEnvironment,
      generation,
      projectId,
      slot: "pending"
    });
    expect(decrypted.settings).toEqual(gmailSettings);
    expect(decrypted.configuration).toMatchObject({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      username: gmailSettings.username
    });
    for (const changedBinding of [
      { generation: "generation_20260730_efgh", projectId, slot: "pending" },
      { generation, projectId: "quickmemo-settings-other", slot: "pending" },
      { generation, projectId, slot: "active" }
    ]) {
      expect(() => decryptEmailSettingsSlot(encrypted, {
        environment: baseEnvironment,
        ...changedBinding
      })).toThrowError(expect.objectContaining({
        code: "email_settings_unavailable",
        statusCode: 503
      }));
    }
  });

  it("requires a canonical base64url key encoding exactly 32 bytes", () => {
    for (const invalidKey of [
      "",
      Buffer.alloc(31, 0x5a).toString("base64url"),
      `${encryptionKey}=`
    ]) {
      expect(() => encryptEmailSettingsSlot(gmailSettings, {
        environment: {
          ...baseEnvironment,
          SHARE_EMAIL_SETTINGS_ENCRYPTION_KEY_V1: invalidKey
        },
        generation,
        projectId,
        slot: "pending"
      })).toThrowError(expect.objectContaining({
        code: "email_settings_unavailable",
        statusCode: 503
      }));
    }
  });

  it("never returns encrypted values or credential text in client status", () => {
    const pending = createPendingEmailSettingsSlot(gmailSettings, {
      environment: baseEnvironment,
      generation,
      projectId
    });
    const status = publicEmailSettingsStatus({
      schemaVersion: 1,
      enabled: false,
      pending
    });
    expect(status).toMatchObject({
      enabled: false,
      active: { present: false },
      pending: {
        present: true,
        generation,
        usernameMasked: "q***t@gmail.com",
        replyToMasked: "r***y@example.com"
      }
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(gmailSettings.username);
    expect(serialized).not.toContain(gmailSettings.appPassword);
    expect(serialized).not.toContain(pending.encrypted.ciphertext);
    expect(serialized).not.toContain("encrypted");
    expect(Date.parse(pending.expiresAt) - Date.parse(pending.stagedAt)).toBe(
      24 * 60 * 60 * 1000
    );
  });

  it("routes admin retention and expired pending slots through bounded cleanup", () => {
    const source = readFileSync(
      join(process.cwd(), "api/cleanup-public-shares.js"),
      "utf8"
    );
    const handlerSource = readFileSync(
      join(process.cwd(), "api/admin-email-settings.js"),
      "utf8"
    );
    const shareSource = readFileSync(
      join(process.cwd(), "api/public-shares-v2.js"),
      "utf8"
    );
    const cleanupSource = source.match(
      /async function discardExpiredPendingEmailSettings[\s\S]*?function secureShareRetentionQueues/u
    )?.[0] ?? "";
    const responseSource = handlerSource.match(
      /async function settingsResponse[\s\S]*?async function currentSettings/u
    )?.[0] ?? "";
    const stageSource = handlerSource.match(
      /async function handleStage[\s\S]*?function pendingForGeneration/u
    )?.[0] ?? "";
    const finalizationSource = handlerSource.match(
      /async function finalizeTestState[\s\S]*?async function handleSendTest/u
    )?.[0] ?? "";
    const sendTestSource = handlerSource.match(
      /async function handleSendTest[\s\S]*?async function recordInvalidTestCode/u
    )?.[0] ?? "";
    const disableSource = handlerSource.match(
      /async function handleDisable[\s\S]*?async function handleDiscardPending/u
    )?.[0] ?? "";
    const discardSource = handlerSource.match(
      /async function handleDiscardPending[\s\S]*?function generationMatchesRemoval/u
    )?.[0] ?? "";
    const removeSource = handlerSource.match(
      /async function handleRemove[\s\S]*?async function dispatch/u
    )?.[0] ?? "";
    expect(source).toContain('"secureShareEmailAdminIdempotency"');
    expect(source).toContain('"secureShareEmailAdminRateLimits"');
    expect(source).toContain('"secureShareEmailAdminAudit"');
    expect(source).toContain('fieldPath: "pending.expiresAt"');
    expect(source).toContain('updateMask: { fieldPaths: ["pending"] }');
    expect(source).toContain("emailQuotaReconciliationWrite(");
    expect(source).toContain(
      '"Invalid pending Gmail test quota reservation"'
    );
    expect(cleanupSource).toContain(
      'updateMask: { fieldPaths: ["pending"] }'
    );
    expect(cleanupSource).not.toContain("active");
    expect(responseSource).toContain(
      "status.enabled = runtime.ready === true"
    );
    expect(responseSource).toContain("settings: status");
    expect(handlerSource).toContain('"SHARE_EMAIL_GLOBAL_MINUTE_LIMIT"');
    expect(handlerSource).toContain('"SHARE_EMAIL_GLOBAL_HOURLY_LIMIT"');
    expect(handlerSource).toContain('"SHARE_EMAIL_ROLLING_24H_HARD_LIMIT"');
    expect(handlerSource).toContain('"SHARE_EMAIL_MONTHLY_HARD_LIMIT"');
    expect(handlerSource).toContain('testQuotaState: "reserved"');
    expect(handlerSource).toContain('testQuotaState: "finalized"');
    expect(sendTestSource).toContain(
      "reservation.push(...quotaReservation.writes)"
    );
    expect(sendTestSource).toContain(
      "await commitMutation(user, current, reservation)"
    );
    expect(finalizationSource).toContain(
      "pending.testQuotaState === \"finalized\""
    );
    expect(finalizationSource).toContain(
      "adminIdempotencyOutcomeWrite("
    );
    expect(finalizationSource).toContain("...quotaWrites");
    expect(stageSource).toContain(
      'current?.pending?.testState === "sending"'
    );
    expect(discardSource).toContain(
      'pending.testState === "sending"'
    );
    expect(removeSource).toContain(
      'current?.pending?.testState === "sending"'
    );
    expect(disableSource).not.toContain('testState === "sending"');
    expect(disableSource).toContain("pending: current?.pending");
    expect(handlerSource).toContain(
      "appCheck.enforced === true && appCheck.valid !== true"
    );
    expect(handlerSource).not.toContain(
      'FIREBASE_APP_CHECK_ENFORCEMENT").toLowerCase() !== "enforce"'
    );
    expect(shareSource.match(/allowCache: false/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("keeps the Vercel master flag as a no-read fail-closed kill switch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const snapshot = await loadSecureShareEmailRuntimeSnapshot(
      { projectId, accessToken: "owner" },
      {
        allowCache: false,
        environment: {
          ...baseEnvironment,
          SECURE_SHARE_EMAIL_ENABLED: "false"
        }
      }
    );
    expect(snapshot).toMatchObject({
      ready: false,
      enabled: false,
      reason: "master_switch_disabled"
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not let the staged Gmail environment override the master flag", () => {
    const runtimeEnvironment = gmailRuntimeEnvironment(gmailSettings, {
      ...baseEnvironment,
      SECURE_SHARE_EMAIL_ENABLED: "false"
    });
    expect(runtimeEnvironment.SECURE_SHARE_EMAIL_ENABLED).toBe("false");
    expect(runtimeEnvironment.SHARE_SMTP_USERNAME).toBe(gmailSettings.username);
    expect(runtimeEnvironment.SHARE_SMTP_APP_PASSWORD).toBe(
      gmailSettings.appPassword
    );
  });

  it("blocks concurrent, ambiguous, cooldown, and exhausted test sends", () => {
    const now = Date.parse("2026-07-30T00:00:00.000Z");
    for (const testState of ["sending", "ambiguous"]) {
      expect(() => assertEmailSettingsTestSendAvailable({
        testState,
        testSendCount: 1
      }, now)).toThrowError(expect.objectContaining({
        code: "conflict",
        statusCode: 409
      }));
    }
    expect(() => assertEmailSettingsTestSendAvailable({
      testState: "sent",
      testSendCount: 1,
      testSentAt: new Date(now - 30_000).toISOString()
    }, now)).toThrowError(expect.objectContaining({
      code: "rate_limited",
      retryAfter: 30,
      statusCode: 429
    }));
    expect(() => assertEmailSettingsTestSendAvailable({
      testState: "failed",
      testSendCount: 5,
      testSentAt: new Date(now - 60_001).toISOString()
    }, now)).toThrowError(expect.objectContaining({
      code: "rate_limited",
      statusCode: 429
    }));
    expect(assertEmailSettingsTestSendAvailable({
      testState: "failed",
      testSendCount: 2,
      testSentAt: new Date(now - 60_001).toISOString()
    }, now)).toBe(2);
  });

  it("classifies uncertain SMTP delivery without exposing provider detail", () => {
    const now = Date.parse("2026-07-30T00:00:00.000Z");
    const ambiguous = emailSettingsTestFailureDisposition({
      deliveryAmbiguous: true,
      providerReasonCode: "private-provider-detail"
    }, now);
    expect(ambiguous).toEqual({
      state: "ambiguous",
      quotaOutcome: "ambiguous",
      testNotBefore: new Date(now + 60_000)
    });
    expect(JSON.stringify(ambiguous)).not.toContain("private-provider-detail");
    expect(emailSettingsTestFailureDisposition(
      new Error("private SMTP response"),
      now
    )).toEqual({
      state: "failed",
      quotaOutcome: "failed",
      testNotBefore: new Date(now + 60_000)
    });
  });

  it("binds five-minute recent authentication to the validated Firebase identity", () => {
    const now = Date.UTC(2026, 6, 30, 0, 0, 0);
    const nowSeconds = Math.floor(now / 1000);
    const token = (overrides = {}) => [
      "eyJhbGciOiJSUzI1NiJ9",
      Buffer.from(JSON.stringify({
        aud: projectId,
        auth_time: nowSeconds - 5 * 60,
        exp: nowSeconds + 60 * 60,
        iat: nowSeconds - 30,
        iss: `https://securetoken.google.com/${projectId}`,
        sub: "admin-user",
        ...overrides
      })).toString("base64url"),
      "signature"
    ].join(".");
    expect(idTokenHasRecentAdminAuthentication(
      token(),
      "admin-user",
      projectId,
      now
    )).toBe(true);
    expect(idTokenHasRecentAdminAuthentication(
      token({ auth_time: nowSeconds - 5 * 60 - 1 }),
      "admin-user",
      projectId,
      now
    )).toBe(false);
    expect(idTokenHasRecentAdminAuthentication(
      token({ sub: "other-user" }),
      "admin-user",
      projectId,
      now
    )).toBe(false);
  });
});
