/* global Buffer, console */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), batchGet: vi.fn(), commit: vi.fn(), verify: vi.fn(), send: vi.fn()
}));
vi.mock("../api/_secure-share-common.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual,
    createFirestoreContext: async () => ({ projectId: "quickmemo-recovery-test", accessToken: "unit-test" }),
    activeUserFromRequest: async (_request, context) => ({ uid: "unit-admin", isAdmin: true, context }),
    verifySecureShareAppCheck: async () => ({ enforced: true, valid: true }),
    readJsonBody: async (request) => request.body,
    firestoreGet: mocks.get, firestoreBatchGet: mocks.batchGet, firestoreCommit: mocks.commit
  };
});
vi.mock("../api/_secure-share-email-settings.js", async (importOriginal) => ({
  ...await importOriginal(),
  idTokenHasRecentAdminAuthentication: () => true,
  consumeEmailSettingsAdminRateLimit: async () => {},
  priorAdminIdempotency: async () => null,
  safeSecureShareEmailRuntimeSnapshot: async () => ({ ready: false })
}));
vi.mock("../api/_secure-share-gmail-smtp.js", () => ({
  createGmailSmtpEmailAdapter: () => ({ verifyConfiguration: mocks.verify, send: mocks.send })
}));

import handler from "../api/admin-email-settings.js";
import { fromFirestoreFields, HttpError } from "../api/_secure-share-common.js";

const version = (counter) => `2026-09-06T00:00:00.${String(counter).padStart(6, "0")}Z`;
const settingsPath = "secureShareEmailSettings/current";
const bucketIds = ["minute_2026-09-06T00:00", "hour_2026-09-06T00", "month_2026-09"];
let current;
let quota;

function finalizerWins() {
  current = { ...current, __updateTime: version(2), pending: {
    ...current.pending, testState: "sent", testQuotaState: "finalized", testQuotaBucketIds: undefined
  } };
  quota = quota.map((bucket) => ({ ...bucket, reservedCount: 0, sentCount: 1 }));
}

async function stage() {
  const headers = new Map();
  const response = { setHeader: (key, value) => headers.set(key, value), end(value) { this.body = JSON.parse(value); } };
  await handler({ method: "POST", url: "/api/admin-email-settings",
    headers: { host: "quickmemo.example", origin: "https://quickmemo.example", authorization: "Bearer unit-recovery-token-0001", "x-quickmemo-admin-email-settings": "1" },
    body: { action: "stage", username: "unit-recovery@gmail.com", appPassword: "abcdefghijklmnop", idempotencyKey: "unit_recovery_stage_0001" }
  }, response);
  expect(headers.get("cache-control")).toContain("no-store");
  return response;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-06T00:00:10Z"));
  vi.stubEnv("SHARE_EMAIL_SETTINGS_ENCRYPTION_KEY_V1", Buffer.alloc(32, 0x5a).toString("base64url"));
  vi.stubEnv("SHARE_RATE_LIMIT_HMAC_KEY", "r".repeat(48));
  vi.stubEnv("SECURE_SHARE_ALLOWED_ORIGINS", "https://quickmemo.example");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unit test must not access the network"); }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.verify.mockResolvedValue(undefined);
  mocks.send.mockImplementation(() => { throw new Error("No SMTP send is allowed"); });
  current = { schemaVersion: 1, enabled: false, __updateTime: version(1), pending: {
    generation: "generation_recovery_unit_0001", testState: "sending", testExpiresAt: "2026-09-06T00:00:00Z",
    testQuotaState: "reserved", testQuotaBucketIds: bucketIds, expiresAt: "2026-09-07T00:00:00Z"
  } };
  quota = bucketIds.map((bucketId, index) => ({ reservedCount: 1, sentCount: 0, failedCount: 0, ambiguousCount: 0,
    __updateTime: version(1), scope: ["minute", "hourly", "monthly"][index], periodKey: bucketId.split("_")[1],
    expiresAt: "2026-12-01T00:00:00Z", hardLimit: 100, softLimit: 100 }));
  mocks.get.mockImplementation(async (_context, path) => {
    expect(path).toBe(settingsPath);
    return current ? JSON.parse(JSON.stringify(current)) : null;
  });
  mocks.batchGet.mockImplementation(async (_context, paths) => {
    expect(paths).toEqual(bucketIds.map((id) => `publicShareEmailQuotaBuckets/${id}`));
    return quota.map((bucket) => ({ ...bucket }));
  });
  mocks.commit.mockImplementation(async (_context, writes) => {
    const write = writes.find((item) => item.update.name.endsWith(`/${settingsPath}`));
    expect(write.currentDocument).toEqual({ updateTime: current.__updateTime });
    for (const quotaWrite of writes.filter((item) => item.update.name.includes("/publicShareEmailQuotaBuckets/"))) {
      const index = bucketIds.indexOf(quotaWrite.update.name.split("/").at(-1));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(quotaWrite.currentDocument).toEqual({ updateTime: quota[index].__updateTime });
      quota[index] = { ...fromFirestoreFields(quotaWrite.update.fields), __updateTime: version(10) };
    }
    current = { ...fromFirestoreFields(write.update.fields), __updateTime: version(10) };
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("expired SMTP-test recovery snapshot races", () => {
  it("reloads a concurrently finalized reservation without charging its quota twice", async () => {
    mocks.batchGet.mockImplementationOnce(async () => {
      finalizerWins();
      return quota.map((bucket) => ({ ...bucket }));
    });
    const response = await stage();
    expect(mocks.batchGet).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    const writes = mocks.commit.mock.calls[0][1];
    expect(writes.every((write) => !write.update.name.includes("/publicShareEmailQuotaBuckets/"))).toBe(true);
    expect(writes[0].currentDocument).toEqual({ updateTime: version(2) });
    expect(quota.map(({ reservedCount, sentCount, ambiguousCount }) => ({ reservedCount, sentCount, ambiguousCount })))
      .toEqual(Array.from({ length: 3 }, () => ({ reservedCount: 0, sentCount: 1, ambiguousCount: 0 })));
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("accounts an uncontended expired reservation once as ambiguous before staging", async () => {
    expect((await stage()).statusCode).toBe(200);
    expect(mocks.commit).toHaveBeenCalledTimes(2);
    expect(mocks.commit.mock.calls.flatMap(([, writes]) => writes)
      .filter((write) => write.update.name.includes("/publicShareEmailQuotaBuckets/"))).toHaveLength(3);
    expect(quota.map(({ reservedCount, sentCount, ambiguousCount }) => ({ reservedCount, sentCount, ambiguousCount })))
      .toEqual(Array.from({ length: 3 }, () => ({ reservedCount: 0, sentCount: 0, ambiguousCount: 1 })));
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("retains optimistic write preconditions when the finalizer wins at commit", async () => {
    mocks.commit.mockImplementationOnce(async () => {
      finalizerWins();
      const error = new Error("Synthetic version conflict"); error.upstreamStatus = 412; throw error;
    });
    expect((await stage()).statusCode).toBe(200);
    expect(mocks.commit).toHaveBeenCalledTimes(2);
    expect(mocks.commit.mock.calls[1][1].every((write) => !write.update.name.includes("/publicShareEmailQuotaBuckets/"))).toBe(true);
    expect(quota.map(({ reservedCount, sentCount, ambiguousCount }) => ({ reservedCount, sentCount, ambiguousCount })))
      .toEqual(Array.from({ length: 3 }, () => ({ reservedCount: 0, sentCount: 1, ambiguousCount: 0 })));
  });

  it.each(["unchanged", "missing-version", "latest-missing-version", "latest-missing-document"])("rejects a real quota underflow with %s settings", async (mode) => {
    if (mode === "missing-version") delete current.__updateTime;
    quota = quota.map((bucket) => ({ ...bucket, reservedCount: 0 }));
    if (mode.startsWith("latest-")) mocks.batchGet.mockImplementationOnce(async () => {
      if (mode === "latest-missing-version") delete current.__updateTime;
      else current = null;
      return quota.map((bucket) => ({ ...bucket }));
    });
    const response = await stage();
    expect(response.statusCode).toBe(503);
    expect(response.body.error).toBe("email_settings_unavailable");
    expect(mocks.batchGet).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("ends repeated changing snapshots with conflict after five bounded attempts", async () => {
    let revision = 1;
    mocks.batchGet.mockImplementation(async () => {
      current = { ...current, __updateTime: version(++revision) };
      return quota.map((bucket) => ({ ...bucket, reservedCount: 0 }));
    });
    const response = await stage();
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toBe("conflict");
    expect(mocks.batchGet).toHaveBeenCalledTimes(5);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("preserves unrelated storage failures without retrying or writing", async () => {
    mocks.batchGet.mockRejectedValueOnce(new HttpError(503, "service_unavailable", "Synthetic storage failure"));
    const response = await stage();
    expect(response.statusCode).toBe(503);
    expect(response.body.error).toBe("service_unavailable");
    expect(mocks.batchGet).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
  });
});
