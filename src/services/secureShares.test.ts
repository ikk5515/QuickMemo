import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSecureShareSessionMemory,
  createSecureShareComment,
  getSecureShareAttachmentForCopy,
  getSecureShareFeatureStatus,
  getSecureShareMetadata,
  listOwnedSecureShares,
  secureShareApiActionContract,
  secureShareApiActions,
  secureShareApiRequest,
  unlockSecureShare
} from "./secureShares";

const appCheckMocks = vi.hoisted(() => ({
  appCheck: null as object | null,
  getToken: vi.fn()
}));

vi.mock("../lib/firebase", () => ({
  get appCheck() {
    return appCheckMocks.appCheck;
  }
}));

vi.mock("firebase/app-check", () => ({
  getToken: appCheckMocks.getToken
}));

const shareId = "secure_share_123456";
const csrfToken = "C".repeat(43);
const idToken = "header.payload.signature-for-tests";

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}

describe("secure share API client", () => {
  beforeEach(() => {
    appCheckMocks.appCheck = null;
    appCheckMocks.getToken.mockReset();
    clearSecureShareSessionMemory();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    clearSecureShareSessionMemory();
    vi.unstubAllGlobals();
  });

  it("exports the complete flat-router action contract", () => {
    expect(secureShareApiActions).toEqual(expect.arrayContaining([
      "feature-status",
      "owner-list",
      "owner-details",
      "owner-create",
      "owner-update",
      "owner-activate",
      "owner-revoke",
      "metadata",
      "email-challenge",
      "access",
      "session",
      "content",
      "comments",
      "comment-delete",
      "copy-grant",
      "attachment-preview",
      "attachment-download"
    ]));
    expect(secureShareApiActionContract["owner-update"].methods).toEqual(["PATCH"]);
    expect(secureShareApiActionContract.comments.methods).toEqual(["GET", "POST"]);
    expect(secureShareApiActionContract["feature-status"]).toMatchObject({
      auth: "optional",
      csrf: "none",
      methods: ["GET"]
    });
  });

  it("uses the flat action router, includes credentials, and sends owner auth", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ items: [] }));

    await listOwnedSecureShares(idToken, { limit: 20, status: "active" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const parsedUrl = new URL(String(url), "https://quickmemo.example");
    const headers = new Headers(init?.headers);

    expect(parsedUrl.pathname).toBe("/api/public-shares-v2");
    expect(parsedUrl.searchParams.get("action")).toBe("owner-list");
    expect(parsedUrl.searchParams.get("status")).toBe("active");
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "include",
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    expect(headers.get("authorization")).toBe(`Bearer ${idToken}`);
  });

  it("sends optional owner authentication on metadata without any fragment material", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      ok: true,
      metadata: { ownerPreview: true },
      requestId: "request_123456"
    }));

    await getSecureShareMetadata(shareId, { idToken });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const headers = new Headers(init?.headers);

    expect(headers.get("authorization")).toBe(`Bearer ${idToken}`);
    expect(String(url)).toContain("action=metadata");
    expect(String(url)).not.toContain("#");
    expect(init?.body).toBeUndefined();
  });

  it("keeps a save-copy grant in an authenticated attachment request header", async () => {
    const copyGrant = `${"G".repeat(40)}.${"S".repeat(43)}`;
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" }
    }));

    await getSecureShareAttachmentForCopy(
      shareId,
      "attachment_123456",
      idToken,
      copyGrant
    );

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const parsedUrl = new URL(String(url), "https://quickmemo.example");
    const headers = new Headers(init?.headers);

    expect(parsedUrl.searchParams.get("action")).toBe("attachment-download");
    expect(parsedUrl.searchParams.get("attachmentId")).toBe("attachment_123456");
    expect(String(url)).not.toContain(copyGrant);
    expect(init?.body).toBeUndefined();
    expect(headers.get("authorization")).toBe(`Bearer ${idToken}`);
    expect(headers.get("x-secure-share-copy-grant")).toBe(copyGrant);
  });

  it("adds App Check when configured and continues best-effort when token lookup fails", async () => {
    appCheckMocks.appCheck = {};
    appCheckMocks.getToken
      .mockResolvedValueOnce({ token: "A".repeat(43) })
      .mockRejectedValueOnce(new Error("App Check unavailable"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ ready: true }))
      .mockResolvedValueOnce(jsonResponse({ ready: true }));

    await secureShareApiRequest({
      action: "metadata",
      method: "GET",
      shareId
    });
    let headers = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
    expect(headers.get("x-firebase-appcheck")).toBe("A".repeat(43));

    await secureShareApiRequest({
      action: "metadata",
      method: "GET",
      shareId
    });
    headers = new Headers(vi.mocked(fetch).mock.calls[1][1]?.headers);
    expect(headers.has("x-firebase-appcheck")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("captures CSRF only in module memory, redacts it from results, and reuses it for mutations", async () => {
    const localStorageSpy = vi.spyOn(Storage.prototype, "setItem");
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        shareId,
        csrfToken,
        permissionLevel: "comment"
      }))
      .mockResolvedValueOnce(jsonResponse({ commentId: "comment_123456" }));

    const accessResult = await unlockSecureShare(shareId, {
      password: " 123456 ",
      unlockAttemptId: "attempt_1234567890"
    });

    expect(accessResult).toEqual({
      shareId,
      permissionLevel: "comment"
    });
    expect(localStorageSpy).not.toHaveBeenCalled();

    const firstRequest = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(firstRequest[1]?.body))).toMatchObject({
      password: " 123456 "
    });

    await createSecureShareComment(shareId, { body: "안전한 댓글" });
    const secondRequest = vi.mocked(fetch).mock.calls[1];
    const headers = new Headers(secondRequest[1]?.headers);

    expect(headers.get("x-csrf-token")).toBe(csrfToken);
    expect(String(secondRequest[0])).not.toContain(csrfToken);
  });

  it("sends owner authentication for owner-preview comment creation", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        shareId,
        csrfToken,
        ownerPreview: true
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        comment: { id: "comment_owner_123456" }
      }));

    await unlockSecureShare(
      shareId,
      {
        ownerPreview: true,
        unlockAttemptId: "attempt_owner_123456"
      },
      { idToken }
    );
    await createSecureShareComment(
      shareId,
      { body: "소유자 댓글" },
      { idToken }
    );

    const headers = new Headers(vi.mocked(fetch).mock.calls[1][1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${idToken}`);
    expect(headers.get("x-csrf-token")).toBe(csrfToken);
  });

  it("blocks content keys and fragment-bearing URLs before fetch", async () => {
    await expect(secureShareApiRequest({
      action: "access",
      method: "POST",
      shareId,
      body: {
        shareKey: "A".repeat(43),
        unlockAttemptId: "attempt_1234567890"
      }
    })).rejects.toMatchObject({ code: "content_key_blocked" });

    await expect(secureShareApiRequest({
      action: "access",
      method: "POST",
      shareId,
      body: {
        returnUrl: `https://quickmemo.example/share/${shareId}#key=${"A".repeat(43)}`,
        unlockAttemptId: "attempt_1234567890"
      }
    })).rejects.toMatchObject({ code: "content_key_blocked" });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when a post-session mutation has no in-memory CSRF token", async () => {
    await expect(createSecureShareComment(shareId, { body: "댓글" }))
      .rejects.toMatchObject({ code: "session_required", status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("strictly accepts only the two public feature-status booleans", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ v2Enabled: true, emailEnabled: false }))
      .mockResolvedValueOnce(jsonResponse({
        v2Enabled: true,
        emailEnabled: true,
        secretConfigured: true
      }));

    await expect(getSecureShareFeatureStatus()).resolves.toEqual({
      v2Enabled: true,
      emailEnabled: false
    });
    await expect(getSecureShareFeatureStatus()).rejects.toMatchObject({
      code: "invalid_response"
    });
  });

  it("returns safe retry information without exposing request data", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(
      { error: "rate_limited", message: "잠시 후 다시 시도해주세요." },
      429,
      { "retry-after": "60" }
    ));

    await expect(secureShareApiRequest({
      action: "metadata",
      method: "GET",
      shareId
    })).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 60,
      status: 429
    });
  });
});
