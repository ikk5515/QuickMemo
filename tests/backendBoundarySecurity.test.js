/* global Response */

import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lookupCallerUid as lookupBlobCallerUid,
  safeErrorSummary as blobErrorSummary
} from "../api/blob-attachments.js";
import { safeErrorSummary as cleanupErrorSummary } from "../api/cleanup-public-shares.js";
import {
  idTokenHasRecentAuthentication,
  lookupCallerUid as lookupDeleteCallerUid,
  safeErrorSummary as deleteErrorSummary
} from "../api/delete-managed-user.js";
import { safeErrorSummary as googleErrorSummary } from "../api/_google-calendar-common.js";
import { safeErrorSummary as secureShareErrorSummary } from "../api/_secure-share-common.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("backend security boundaries", () => {
  it("never serializes exception messages, names, bodies, stacks, causes, or invalid statuses", () => {
    const canary = "PRIVATE_CANARY_7d6b";
    const error = new Error(canary, { cause: canary });
    Object.defineProperty(error, "name", { configurable: true, get: () => canary });
    Object.defineProperty(error, "stack", { configurable: true, get: () => canary });
    Object.defineProperty(error, "body", { configurable: true, get: () => canary });
    Object.defineProperty(error, "statusCode", {
      configurable: true,
      get: () => 123_456
    });
    Object.defineProperty(error, "status", {
      configurable: true,
      get: () => {
        throw new Error(canary);
      }
    });

    for (const summarize of [
      blobErrorSummary,
      cleanupErrorSummary,
      deleteErrorSummary,
      googleErrorSummary,
      secureShareErrorSummary
    ]) {
      const serialized = JSON.stringify(summarize(error));
      expect(serialized).toContain('"kind":"error"');
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain("123456");
    }
  });

  it("keeps only bounded HTTP status metadata", () => {
    const error = Object.assign(new Error("not logged"), {
      status: 418,
      statusCode: 503,
      upstreamStatus: 429
    });

    expect(blobErrorSummary(error)).toEqual({
      kind: "error",
      status: 418,
      statusCode: 503
    });
    expect(secureShareErrorSummary(error)).toEqual({
      kind: "error",
      statusCode: 503,
      upstreamStatus: 429
    });
  });

  it("rejects disabled Firebase callers in Blob and managed-delete lookups", async () => {
    vi.stubEnv("VITE_FIREBASE_API_KEY", "test-api-key");
    const disabledResponse = () => new Response(JSON.stringify({
      users: [{ disabled: true, localId: "disabled-user" }]
    }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
    vi.stubGlobal("fetch", vi.fn(disabledResponse));

    await expect(lookupBlobCallerUid("test-token")).resolves.toBe("");
    await expect(lookupDeleteCallerUid("test-token")).resolves.toBe("");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      users: [{ disabled: false, localId: "active-user" }]
    }), {
      headers: { "content-type": "application/json" },
      status: 200
    })));
    await expect(lookupBlobCallerUid("test-token")).resolves.toBe("active-user");
    await expect(lookupDeleteCallerUid("test-token")).resolves.toBe("active-user");
  });

  it("binds recent authentication to the validated user, Firebase project, and token lifetime", () => {
    const now = Date.UTC(2026, 6, 29, 12, 0, 0);
    const nowSeconds = Math.floor(now / 1000);
    const uid = "admin-user";
    const projectId = "quickmemo-test";
    const token = (overrides = {}) => {
      const payload = {
        aud: projectId,
        auth_time: nowSeconds - 14 * 60,
        exp: nowSeconds + 60 * 60,
        iat: nowSeconds - 30,
        iss: `https://securetoken.google.com/${projectId}`,
        sub: uid,
        ...overrides
      };
      return [
        "eyJhbGciOiJSUzI1NiJ9",
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "signature"
      ].join(".");
    };

    expect(idTokenHasRecentAuthentication(token(), uid, projectId, now)).toBe(true);
    expect(idTokenHasRecentAuthentication(
      token({ auth_time: nowSeconds - 15 * 60 - 1 }),
      uid,
      projectId,
      now
    )).toBe(false);
    expect(idTokenHasRecentAuthentication(token({ sub: "other-user" }), uid, projectId, now)).toBe(false);
    expect(idTokenHasRecentAuthentication(token({ aud: "other-project" }), uid, projectId, now)).toBe(false);
    expect(idTokenHasRecentAuthentication(token({ exp: nowSeconds }), uid, projectId, now)).toBe(false);
    expect(idTokenHasRecentAuthentication(
      token({ auth_time: nowSeconds + 61 }),
      uid,
      projectId,
      now
    )).toBe(false);
    expect(idTokenHasRecentAuthentication("malformed", uid, projectId, now)).toBe(false);
  });
});
