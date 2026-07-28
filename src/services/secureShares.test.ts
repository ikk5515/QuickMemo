import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSecureShareSessionMemory,
  createSecureShareComment,
  getSecureShareAttachmentForCopy,
  getSecureShareFeatureStatus,
  getSecureShareMetadata,
  getSecureShareParticipant,
  listSecureShareComments,
  listOwnedSecureShares,
  normalizeSecureShareParticipantDisplayName,
  parseSecureShareIpPrefix,
  renameSecureShareParticipant,
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
      "participant-me",
      "comments",
      "comment-delete",
      "copy-grant",
      "attachment-preview",
      "attachment-download"
    ]));
    expect(secureShareApiActionContract["owner-update"].methods).toEqual(["PATCH"]);
    expect(secureShareApiActionContract.comments.methods).toEqual(["GET", "POST"]);
    expect(secureShareApiActionContract["participant-me"]).toMatchObject({
      auth: "session",
      csrf: "after_session",
      methods: ["GET", "PATCH"]
    });
    expect(secureShareApiActionContract["feature-status"]).toMatchObject({
      auth: "optional",
      csrf: "none",
      methods: ["GET"]
    });
  });

  it("uses the flat action router, includes credentials, and sends owner auth", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ items: [] }));

    await listOwnedSecureShares(idToken, {
      limit: 20,
      sourceNoteId: "note_source_123456",
      status: "active"
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const parsedUrl = new URL(String(url), "https://quickmemo.example");
    const headers = new Headers(init?.headers);

    expect(parsedUrl.pathname).toBe("/api/public-shares-v2");
    expect(parsedUrl.searchParams.get("action")).toBe("owner-list");
    expect(parsedUrl.searchParams.get("sourceNoteId")).toBe("note_source_123456");
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

  it("rejects an invalid owner-list source note identifier before making a request", () => {
    expect(() => listOwnedSecureShares(idToken, {
      sourceNoteId: "invalid source note"
    })).toThrow("sourceNoteId 값이 올바르지 않습니다.");

    expect(fetch).not.toHaveBeenCalled();
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

    await createSecureShareComment(shareId, {
      body: "안전한 댓글",
      clientRequestId: "comment-request-123456"
    });
    const secondRequest = vi.mocked(fetch).mock.calls[1];
    const headers = new Headers(secondRequest[1]?.headers);

    expect(headers.get("x-csrf-token")).toBe(csrfToken);
    expect(JSON.parse(String(secondRequest[1]?.body))).toEqual({
      body: "안전한 댓글",
      clientRequestId: "comment-request-123456"
    });
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
      {
        body: "소유자 댓글",
        clientRequestId: "comment-request-owner-123456"
      },
      { idToken }
    );

    const headers = new Headers(vi.mocked(fetch).mock.calls[1][1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${idToken}`);
    expect(headers.get("x-csrf-token")).toBe(csrfToken);
  });

  it("gets and renames only the current session participant through the flat router", async () => {
    const participant = {
      participantId: "participant_123456",
      guestNumber: 1,
      displayName: "guest1",
      isSystemDefaultName: true,
      canRename: true,
      renameCooldownEndsAt: null,
      capabilities: {
        canRename: true,
        showsCommenterIpPrefix: true
      },
      currentIpPrefix: "203.226"
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        shareId,
        csrfToken,
        permissionLevel: "comment"
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        participant,
        requestId: "request_participant_get"
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        participant: {
          ...participant,
          displayName: "인기",
          isSystemDefaultName: false,
          renameCooldownEndsAt: "2026-07-29T01:01:00.000Z"
        },
        requestId: "request_participant_patch"
      }));

    await unlockSecureShare(shareId, {
      unlockAttemptId: "attempt_participant_123456"
    });
    await expect(getSecureShareParticipant(shareId)).resolves.toEqual(participant);
    await expect(renameSecureShareParticipant(shareId, {
      displayName: "  인기  ",
      clientRequestId: "rename-request-123456"
    })).resolves.toMatchObject({
      displayName: "인기",
      currentIpPrefix: "203.226"
    });

    const getRequest = vi.mocked(fetch).mock.calls[1];
    const patchRequest = vi.mocked(fetch).mock.calls[2];
    expect(new URL(String(getRequest[0]), "https://quickmemo.example").searchParams.get("action"))
      .toBe("participant-me");
    expect(getRequest[1]?.method).toBe("GET");
    expect(new URL(String(patchRequest[0]), "https://quickmemo.example").searchParams.get("action"))
      .toBe("participant-me");
    expect(patchRequest[1]?.method).toBe("PATCH");
    expect(new Headers(patchRequest[1]?.headers).get("x-csrf-token")).toBe(csrfToken);
    expect(JSON.parse(String(patchRequest[1]?.body))).toEqual({
      displayName: "인기",
      clientRequestId: "rename-request-123456"
    });
  });

  it("never requests more comments than the server page-size contract", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        shareId,
        csrfToken,
        permissionLevel: "comment"
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        items: [],
        nextCursor: null,
        requestId: "request_comments_bounded"
      }));

    await unlockSecureShare(shareId, {
      unlockAttemptId: "attempt_comments_bounded_123456"
    });
    await listSecureShareComments(shareId, { limit: 100 });

    const commentsUrl = new URL(
      String(vi.mocked(fetch).mock.calls[1][0]),
      "https://quickmemo.example"
    );
    expect(commentsUrl.searchParams.get("action")).toBe("comments");
    expect(commentsUrl.searchParams.get("limit")).toBe("20");
  });

  it("fails closed on unsafe participant fields and accepts only canonical partial prefixes", async () => {
    const unsafeParticipant = {
      participantId: "participant_123456",
      guestNumber: 1,
      displayName: "guest1",
      isSystemDefaultName: true,
      canRename: true,
      renameCooldownEndsAt: null,
      capabilities: {
        canRename: true,
        showsCommenterIpPrefix: true
      },
      currentIpPrefix: "203.226.244.27",
      identityHash: "must-not-cross-the-client-boundary"
    };
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      ok: true,
      participant: unsafeParticipant,
      requestId: "request_participant_unsafe"
    }));

    await expect(getSecureShareParticipant(shareId)).rejects.toMatchObject({
      code: "invalid_response"
    });
    expect(parseSecureShareIpPrefix("203.226")).toBe("203.226");
    expect(parseSecureShareIpPrefix("2001:2d8")).toBe("2001:2d8");
    expect(parseSecureShareIpPrefix("203.226.244.27")).toBeNull();
    expect(parseSecureShareIpPrefix("2001:2d8:1:2")).toBeNull();
    expect(parseSecureShareIpPrefix("0203.226")).toBeNull();
    expect(parseSecureShareIpPrefix("999.226")).toBeNull();
    expect(parseSecureShareIpPrefix("2001:2D8")).toBeNull();
  });

  it("keeps participant display-name validation aligned with the server policy", () => {
    expect(normalizeSecureShareParticipantDisplayName("Alice 42")).toBe("Alice 42");
    expect(normalizeSecureShareParticipantDisplayName("  Alice   Bob  ")).toBe("Alice Bob");
    expect(normalizeSecureShareParticipantDisplayName("  山田 太郎  ")).toBe("山田 太郎");
    expect(normalizeSecureShareParticipantDisplayName("김인기")).toBe("김인기");
    expect(normalizeSecureShareParticipantDisplayName("테스터A")).toBe("테스터A");
    expect(normalizeSecureShareParticipantDisplayName("やまだ太郎")).toBe("やまだ太郎");
    expect(normalizeSecureShareParticipantDisplayName("テスターB")).toBe("テスターB");
    expect(normalizeSecureShareParticipantDisplayName("ユーザー")).toBe("ユーザー");
    expect(normalizeSecureShareParticipantDisplayName("비공식 연구자")).toBe("비공식 연구자");
    expect(normalizeSecureShareParticipantDisplayName("非公式研究者")).toBe("非公式研究者");
    expect(normalizeSecureShareParticipantDisplayName("王小明")).toBe("王小明");
    expect(normalizeSecureShareParticipantDisplayName("李系统")).toBe("李系统");

    for (const displayName of [
      ". _ -",
      "ーー",
      "\u115f",
      "\u1160",
      "\u3164",
      "\uffa0",
      "A\ufe0f",
      `A${String.fromCodePoint(0xe0100)}`,
      "Alice\u034f",
      "Alice\u180b",
      "Alice\u17b4",
      "Alice\nBob",
      "Alice\tBob",
      "Alice\u2028Bob",
      "Alice\u2029Bob",
      "A\u0338",
      "admın",
      "admɪn",
      "ᴀdmin",
      "adᴍin",
      "ᴏwner",
      "quıckmemo",
      "quickmem〇",
      "guest1",
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
      "Owner",
      "QuickMemo-Official",
      "QuickMemo Support",
      "Admin Team",
      "official account",
      "Support Crew",
      "System Admin",
      "System Owner",
      "System X",
      "운영자",
      "퀵메모",
      "친절한운영자팀",
      "管理者",
      "クイックメモ",
      "クイックメモ案内",
      "evil.dev",
      "123.com",
      "1.co",
      "2026.kr",
      "8.8.8.8"
    ]) {
      expect(
        () => normalizeSecureShareParticipantDisplayName(displayName),
        displayName
      ).toThrow("한글·영문·일본어·숫자");
    }
  });

  it("rejects private, loopback, link-local, test, and documentation prefixes", () => {
    for (const prefix of [
      "0.1",
      "10.1",
      "100.64",
      "127.0",
      "169.254",
      "172.16",
      "192.0",
      "192.88",
      "192.168",
      "198.18",
      "198.51",
      "203.0",
      "224.0",
      "0:0",
      "fc00:1",
      "fe80:1",
      "ff00:1",
      "2001:2",
      "2001:db8",
      "3fff:0"
    ]) {
      expect(parseSecureShareIpPrefix(prefix), prefix).toBeNull();
    }

    expect(parseSecureShareIpPrefix("115.161")).toBe("115.161");
    expect(parseSecureShareIpPrefix("203.226")).toBe("203.226");
    expect(parseSecureShareIpPrefix("2001:2d8")).toBe("2001:2d8");
    expect(parseSecureShareIpPrefix("2406:da1c")).toBe("2406:da1c");
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
    await expect(createSecureShareComment(shareId, {
      body: "댓글",
      clientRequestId: "comment-request-failure-123456"
    }))
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
