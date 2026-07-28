import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecureShareApiError } from "../services/secureShares";
import { SecurePublicShareViewer } from "./SecurePublicShareViewer";

const mocks = vi.hoisted(() => ({
  createComment: vi.fn(),
  decryptAttachmentToBlob: vi.fn(),
  decryptAttachmentToBytes: vi.fn(),
  decryptText: vi.fn(),
  deleteComment: vi.fn(),
  getContent: vi.fn(),
  getCopyAttachment: vi.fn(),
  getDownload: vi.fn(),
  getMetadata: vi.fn(),
  getParticipant: vi.fn(),
  getPreview: vi.fn(),
  extractHwpPreviewHtml: vi.fn(),
  extractHwpxPreviewHtml: vi.fn(),
  extractXlsxPreviewHtml: vi.fn(),
  importKey: vi.fn(),
  listComments: vi.fn(),
  refreshSession: vi.fn(),
  renameParticipant: vi.fn(),
  requestChallenge: vi.fn(),
  requestCopyGrant: vi.fn(),
  renderSafeDocxPreviewSrcDoc: vi.fn(),
  safeRasterImageBytes: vi.fn(),
  unlock: vi.fn()
}));

vi.mock("../services/secureShares", () => {
  class MockSecureShareApiError extends Error {
    code: string;
    retryAfterSeconds: number | null;
    status: number;

    constructor(code: string, message: string, status = 0, retryAfterSeconds: number | null = null) {
      super(message);
      this.name = "SecureShareApiError";
      this.code = code;
      this.status = status;
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }

  return {
    SecureShareApiError: MockSecureShareApiError,
    createSecureShareComment: mocks.createComment,
    deleteSecureShareComment: mocks.deleteComment,
    getSecureShareAttachmentDownload: mocks.getDownload,
    getSecureShareAttachmentForCopy: mocks.getCopyAttachment,
    getSecureShareAttachmentPreview: mocks.getPreview,
    getSecureShareContent: mocks.getContent,
    getSecureShareMetadata: mocks.getMetadata,
    getSecureShareParticipant: mocks.getParticipant,
    listSecureShareComments: mocks.listComments,
    normalizeSecureShareParticipantDisplayName: (value: string) =>
      value.normalize("NFKC").trim().replace(/\s+/gu, " "),
    parseSecureShareIpPrefix: (value: unknown) =>
      typeof value === "string"
      && (
        /^(?:\d{1,3})\.(?:\d{1,3})$/u.test(value)
        || /^(?:[0-9a-f]{1,4}):(?:[0-9a-f]{1,4})$/u.test(value)
      )
        ? value
        : null,
    refreshSecureShareSession: mocks.refreshSession,
    renameSecureShareParticipant: mocks.renameParticipant,
    requestSecureShareCopyGrant: mocks.requestCopyGrant,
    requestSecureShareEmailChallenge: mocks.requestChallenge,
    unlockSecureShare: mocks.unlock
  };
});

vi.mock("../lib/crypto", () => ({
  decryptText: mocks.decryptText,
  importAesKeyBase64Url: mocks.importKey
}));

vi.mock("../lib/attachmentCrypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/attachmentCrypto")>();
  return {
    ...original,
    decryptAttachmentToBlob: mocks.decryptAttachmentToBlob,
    decryptAttachmentToBytes: mocks.decryptAttachmentToBytes
  };
});

vi.mock("../lib/safeRasterImage", () => ({
  safeRasterImageBytes: mocks.safeRasterImageBytes
}));

vi.mock("../lib/documentPreview", () => ({
  extractHwpPreviewHtml: mocks.extractHwpPreviewHtml,
  extractHwpxPreviewHtml: mocks.extractHwpxPreviewHtml,
  extractXlsxPreviewHtml: mocks.extractXlsxPreviewHtml,
  renderSafeDocxPreviewSrcDoc: mocks.renderSafeDocxPreviewSrcDoc
}));

vi.mock("./PublicAttachmentPreviewModal", () => ({
  default: ({
    onClose,
    preview
  }: {
    onClose: () => void;
    preview: { downloadAllowed?: boolean; fileName: string; kind: string };
  }) => (
    <section aria-label={preview.fileName} role="dialog">
      <span>{preview.kind}</span>
      {preview.downloadAllowed && <button type="button">모달 다운로드</button>}
      <button onClick={onClose} type="button">미리보기 닫기</button>
    </section>
  )
}));

const shareId = "secure_share_123456";
const contentKey = "K".repeat(43);
const iv = "AAAAAAAAAAAAAAAA";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function encrypted(cipherText: string) {
  return {
    version: 1,
    algorithm: "AES-GCM",
    cipherText,
    iv
  };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    metadata: {
      schemaVersion: 2,
      accessMode: "anyone_with_link",
      hasPassword: false,
      requiresPassword: false,
      requiresEmailVerification: false,
      emailChallengeRequired: false,
      requiresAuthentication: false,
      oneTimeEnabled: false,
      oneTimeScope: "global",
      ownerPreview: false,
      ...overrides
    },
    requestId: "request_123456"
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    ownerPreview: false,
    sessionExpiresAt: "2026-07-28T01:00:00.000Z",
    capabilities: {
      permissionLevel: "view",
      canComment: false,
      canSaveCopy: false,
      downloadAllowed: true,
      quickCopyButtonVisible: true
    },
    ...overrides,
    requestId: "request_123456"
  };
}

function participant(overrides: Record<string, unknown> = {}) {
  return {
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
    currentIpPrefix: "203.226",
    ...overrides
  };
}

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    id: "attachment_123456",
    encryptedFileName: encrypted("ZmlsZQ=="),
    extension: "png",
    mimeType: "image/png",
    originalSize: 100,
    previewAllowed: true,
    version: 1,
    algorithm: "AES-GCM",
    encryptedSize: 116,
    iv,
    ...overrides
  };
}

function content(attachments: unknown[] = []) {
  return {
    ok: true,
    schemaVersion: 2,
    encryptedTitle: encrypted("dGl0bGU="),
    encryptedBody: encrypted("Ym9keQ=="),
    attachments,
    requestId: "request_123456"
  };
}

function commentMutation(id: string, body: string) {
  return {
    ok: true,
    comment: {
      id,
      body,
      displayName: "검증 사용자",
      badge: "guest",
      createdAt: "2026-07-28T00:00:00.000Z",
      canDelete: true
    },
    requestId: "request_comment_123456"
  };
}

function renderViewer(overrides: Partial<Parameters<typeof SecurePublicShareViewer>[0]> = {}) {
  const props = {
    shareId,
    contentKey,
    idToken: undefined,
    isAuthenticated: false,
    onRequireLogin: vi.fn(),
    ...overrides
  };
  const result = render(<SecurePublicShareViewer {...props} />);
  return { ...result, props };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }

  mocks.importKey.mockResolvedValue({ algorithm: { name: "AES-GCM" } });
  mocks.decryptText.mockImplementation(async (payload: { cipherText: string }) => {
    if (payload.cipherText === "dGl0bGU=") {
      return "보안 제목";
    }
    if (payload.cipherText === "ZmlsZQ==") {
      return "안전한 이미지";
    }
    return "<p onclick=\"alert(1)\">안전한 본문 <a href=\"javascript:alert(1)\">위험 링크</a></p><script>window.evil=true</script>";
  });
  mocks.getMetadata.mockResolvedValue(metadata());
  mocks.getContent.mockResolvedValue(content());
  mocks.getParticipant.mockResolvedValue(participant());
  mocks.listComments.mockResolvedValue({
    ok: true,
    items: [],
    nextCursor: null,
    requestId: "request_123456"
  });
  mocks.unlock.mockResolvedValue({ granted: true });
  mocks.createComment.mockImplementation(async (
    _shareId: string,
    input: { body: string }
  ) => ({
    ok: true,
    comment: {
      id: "comment_123456",
      body: input.body,
      displayName: "검증 사용자",
      badge: "guest",
      createdAt: "2026-07-28T00:00:00.000Z",
      canDelete: true
    },
    requestId: "request_123456"
  }));
  mocks.deleteComment.mockResolvedValue({ deleted: true });
  mocks.renameParticipant.mockResolvedValue(participant({
    displayName: "인기",
    isSystemDefaultName: false,
    renameCooldownEndsAt: "2026-07-29T01:01:00.000Z"
  }));
  mocks.requestCopyGrant.mockResolvedValue({
    ok: true,
    copyGrant: `${"G".repeat(40)}.${"S".repeat(43)}`,
    expiresAt: "2026-07-28T00:05:00.000Z",
    requestId: "request_123456"
  });
  mocks.requestChallenge.mockResolvedValue({
    ok: true,
    challengeId: "challenge_123456",
    resendAfterSeconds: 60,
    requestId: "request_123456"
  });
  mocks.getPreview.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "application/octet-stream" }
  }));
  mocks.getDownload.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "application/octet-stream" }
  }));
  mocks.getCopyAttachment.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "application/octet-stream" }
  }));
  mocks.decryptAttachmentToBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.decryptAttachmentToBlob.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])]));
  mocks.safeRasterImageBytes.mockReturnValue(true);
  mocks.renderSafeDocxPreviewSrcDoc.mockResolvedValue("<!doctype html><p>safe docx</p>");
  mocks.extractHwpPreviewHtml.mockResolvedValue({ html: "<p>safe hwp</p>" });
  mocks.extractHwpxPreviewHtml.mockReturnValue("<p>safe hwpx</p>");
  mocks.extractXlsxPreviewHtml.mockReturnValue("<table><tr><td>safe xlsx</td></tr></table>");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SecurePublicShareViewer", () => {
  it("opens through the server session, decrypts locally, and sanitizes rich-content XSS", async () => {
    const user = userEvent.setup();
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    mocks.refreshSession
      .mockRejectedValueOnce(new SecureShareApiError("session_required", "missing", 401))
      .mockResolvedValueOnce(session());

    renderViewer();

    await user.click(await screen.findByRole("button", { name: "보안 공유 열기" }));
    expect(await screen.findByRole("heading", { name: "보안 제목" })).toBeInTheDocument();
    expect(screen.getByText(/안전한 본문/)).toBeInTheDocument();

    const body = document.querySelector(".secure-public-share-body");
    expect(body?.querySelector("script")).toBeNull();
    expect(body?.querySelector("[onclick]")).toBeNull();
    const sanitizedHref = body?.querySelector("a")?.getAttribute("href") ?? "";
    expect(sanitizedHref).not.toMatch(/^javascript:/iu);
    expect(storageSpy).not.toHaveBeenCalled();

    const allServiceArguments = [
      ...mocks.getMetadata.mock.calls,
      ...mocks.refreshSession.mock.calls,
      ...mocks.unlock.mock.calls,
      ...mocks.getContent.mock.calls
    ];
    expect(JSON.stringify(allServiceArguments)).not.toContain(contentKey);
    expect(mocks.importKey).toHaveBeenCalledWith(contentKey);
  });

  it("combines password, email OTP, and explicit one-time confirmation", async () => {
    const user = userEvent.setup();
    const idToken = "header.payload.signature-for-viewer";
    mocks.getMetadata.mockResolvedValue(metadata({
      hasPassword: true,
      requiresPassword: true,
      requiresEmailVerification: true,
      emailChallengeRequired: true,
      oneTimeEnabled: true
    }));
    mocks.refreshSession
      .mockRejectedValueOnce(new SecureShareApiError("session_required", "missing", 401))
      .mockResolvedValueOnce(session());

    renderViewer({ idToken, isAuthenticated: true });

    await user.type(await screen.findByLabelText(/^공유 비밀번호/u), " 123456 ");
    expect(mocks.getMetadata).toHaveBeenCalledWith(
      shareId,
      expect.objectContaining({ idToken, signal: expect.any(AbortSignal) })
    );
    await user.type(screen.getByLabelText("인증 이메일"), "User@Example.com");
    await user.click(screen.getByRole("button", { name: "인증 코드 보내기" }));
    expect(await screen.findByText("인증 가능한 이메일인 경우 코드를 전송했습니다."))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: /60초 후 재전송/ })).toBeDisabled();

    await user.type(screen.getByLabelText("6자리 인증 코드"), "123456");
    await user.click(screen.getByRole("checkbox", { name: /이 링크를 지금 한 번 열겠습니다/ }));
    await user.click(screen.getByRole("button", { name: "보안 공유 열기" }));

    await screen.findByRole("heading", { name: "보안 제목" });
    expect(mocks.unlock).toHaveBeenCalledTimes(1);
    expect(mocks.unlock.mock.calls[0][1]).toEqual(expect.objectContaining({
      challengeId: "challenge_123456",
      oneTimeOpenConfirmed: true,
      otp: "123456",
      password: " 123456 "
    }));
    expect(mocks.unlock.mock.calls[0][2]).toEqual({
      idToken,
      signal: expect.any(AbortSignal)
    });
  });

  it("uses Firebase authentication without a redundant OTP challenge", async () => {
    const user = userEvent.setup();
    const idToken = "header.payload.signature-for-authenticated-user";
    mocks.getMetadata.mockResolvedValue(metadata({
      accessMode: "authenticated_users",
      hasPassword: true,
      requiresPassword: true,
      requiresAuthentication: true,
      requiresEmailVerification: true
    }));
    mocks.refreshSession
      .mockRejectedValueOnce(new SecureShareApiError("session_required", "missing", 401))
      .mockResolvedValueOnce(session());

    renderViewer({ idToken, isAuthenticated: true });

    await user.type(await screen.findByLabelText(/^공유 비밀번호/u), "12345678");
    expect(screen.queryByLabelText("인증 이메일")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("6자리 인증 코드")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "보안 공유 열기" }));
    await screen.findByRole("heading", { name: "보안 제목" });

    expect(mocks.unlock).toHaveBeenCalledWith(
      shareId,
      expect.objectContaining({ password: "12345678" }),
      { idToken, signal: expect.any(AbortSignal) }
    );
    expect(mocks.unlock.mock.calls[0][1]).not.toHaveProperty("otp");
  });

  it("does not let a stale access response restore plaintext after authentication changes", async () => {
    const user = userEvent.setup();
    const unlockGate = deferred<unknown>();
    const firstIdToken = "header.payload.signature-before-auth-change";
    const nextIdToken = "header.payload.signature-after-auth-change";
    mocks.getMetadata.mockResolvedValue(metadata({
      hasPassword: true,
      requiresPassword: true
    }));
    mocks.refreshSession
      .mockRejectedValueOnce(new SecureShareApiError("session_required", "missing", 401))
      .mockRejectedValueOnce(new SecureShareApiError("session_required", "missing", 401))
      .mockResolvedValueOnce(session());
    mocks.unlock.mockImplementationOnce(() => unlockGate.promise);

    const { props, rerender } = renderViewer({
      idToken: firstIdToken,
      isAuthenticated: true
    });

    await user.type(await screen.findByLabelText(/^공유 비밀번호/u), "12345678");
    await user.click(screen.getByRole("button", { name: "보안 공유 열기" }));
    await waitFor(() => expect(mocks.unlock).toHaveBeenCalledTimes(1));
    const staleSignal = mocks.unlock.mock.calls[0]?.[2]?.signal as AbortSignal;

    rerender(
      <SecurePublicShareViewer
        {...props}
        idToken={nextIdToken}
        isAuthenticated
      />
    );
    await waitFor(() => expect(mocks.getMetadata).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(staleSignal.aborted).toBe(true));

    await act(async () => {
      unlockGate.resolve({ granted: true });
      await unlockGate.promise;
    });

    await waitFor(() => expect(mocks.refreshSession).toHaveBeenCalledTimes(2));
    expect(mocks.getContent).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "보안 제목" })).not.toBeInTheDocument();
  });

  it("requires login without putting the fragment key in the callback", async () => {
    const user = userEvent.setup();
    const onRequireLogin = vi.fn();
    mocks.getMetadata.mockResolvedValue(metadata({
      accessMode: "authenticated_users",
      requiresAuthentication: true
    }));

    renderViewer({ onRequireLogin });

    await user.click(await screen.findByRole("button", { name: "QuickMemo 로그인" }));
    expect(onRequireLogin).toHaveBeenCalledWith();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expect(mocks.unlock).not.toHaveBeenCalled();
    expect(JSON.stringify(onRequireLogin.mock.calls)).not.toContain(contentKey);
  });

  it("uses only server-reported owner preview and hides disabled capabilities", async () => {
    const user = userEvent.setup();
    const idToken = "header.payload.signature-for-owner";
    mocks.getMetadata.mockResolvedValue(metadata({
      hasPassword: true,
      requiresPassword: true,
      requiresEmailVerification: true,
      emailChallengeRequired: true,
      oneTimeEnabled: true,
      ownerPreview: true
    }));
    mocks.refreshSession
      .mockRejectedValueOnce(new SecureShareApiError("session_required", "missing", 401))
      .mockResolvedValueOnce(session({
        ownerPreview: true,
        capabilities: {
          permissionLevel: "comment",
          canComment: true,
          canSaveCopy: false,
          commentIpPrefixEnabled: true,
          downloadAllowed: false,
          quickCopyButtonVisible: false
        }
      }));
    mocks.listComments.mockResolvedValue({
      ok: true,
      items: [{
        id: "comment_owner_123456",
        body: "소유자 안내 댓글",
        displayName: "공유 소유자",
        badge: "owner",
        createdAt: "2026-07-28T00:00:00.000Z",
        canDelete: true
      }, {
        id: "comment_guest_123456",
        body: "게스트 Prefix 댓글",
        displayName: "guest1",
        badge: "guest",
        createdAt: "2026-07-28T00:01:00.000Z",
        canDelete: true,
        authorParticipantId: "participant_guest_123456",
        ipPrefix: "203.226"
      }],
      nextCursor: null,
      requestId: "request_123456"
    });

    renderViewer({ idToken, isAuthenticated: true });

    expect(await screen.findByText(/소유자\/관리자 미리보기 · 일회성 링크 미소비/)).toBeInTheDocument();
    expect(screen.queryByLabelText("공유 비밀번호")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("인증 이메일")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /한 번 열겠습니다/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "소유자/관리자 미리보기 열기" }));
    await screen.findByRole("heading", { name: "보안 제목" });

    expect(mocks.unlock.mock.calls[0][1]).toEqual(expect.objectContaining({
      ownerPreview: true
    }));
    expect(mocks.unlock.mock.calls[0][1]).not.toHaveProperty("oneTimeOpenConfirmed");
    expect(mocks.refreshSession).toHaveBeenCalledWith(
      shareId,
      expect.objectContaining({ idToken })
    );
    expect(mocks.getContent).toHaveBeenCalledWith(
      shareId,
      expect.objectContaining({ idToken })
    );
    expect(screen.queryByRole("button", { name: "본문 빠른 복사" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /다운로드/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "댓글" })).toBeInTheDocument();
    expect(screen.getByText("소유자 안내 댓글")).toBeInTheDocument();
    expect(screen.getByText("소유자")).toBeInTheDocument();
    expect(screen.getByText("guest1, 네트워크 대역 203.226"))
      .toBeInTheDocument();
    expect(mocks.listComments).toHaveBeenCalledWith(
      shareId,
      expect.objectContaining({ idToken, limit: 20 })
    );

    await user.type(screen.getByLabelText("새 댓글"), "소유자 새 댓글");
    await user.click(screen.getByRole("button", { name: "댓글 작성" }));
    await waitFor(() => expect(mocks.createComment).toHaveBeenCalledWith(
      shareId,
      {
        body: "소유자 새 댓글",
        clientRequestId: expect.any(String)
      },
      { idToken }
    ));
  });

  it("renders comments as plain text and sends only trimmed plain text", async () => {
    const user = userEvent.setup();
    const commentSession = session({
      capabilities: {
        permissionLevel: "comment",
        canComment: true,
        canSaveCopy: false,
        downloadAllowed: false,
        quickCopyButtonVisible: false
      }
    });
    mocks.refreshSession.mockResolvedValue(commentSession);
    mocks.listComments
      .mockResolvedValueOnce({
        ok: true,
        items: [{
          id: "comment_123456",
          body: "<img src=x onerror=alert(1)>",
          displayName: "검증 사용자",
          badge: "email_verified",
          createdAt: "2026-07-28T00:00:00.000Z",
          canDelete: true
        }],
        nextCursor: null,
        requestId: "request_123456"
      })
      .mockResolvedValueOnce({
        ok: true,
        items: [],
        nextCursor: null,
        requestId: "request_123456"
      });

    renderViewer();

    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector(".secure-public-share-comment-list img")).toBeNull();

    await user.type(screen.getByLabelText("새 댓글"), "  안전한 댓글  ");
    await user.click(screen.getByRole("button", { name: "댓글 작성" }));

    await waitFor(() => expect(mocks.createComment).toHaveBeenCalledWith(
      shareId,
      {
        body: "안전한 댓글",
        clientRequestId: expect.any(String)
      },
      { idToken: undefined }
    ));
    expect(document.querySelector(".secure-public-share-comment-list script")).toBeNull();

    await user.type(screen.getByLabelText("새 댓글"), "<script>alert(1)</script>");
    await user.click(screen.getByRole("button", { name: "댓글 작성" }));
    expect(mocks.createComment).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("댓글에는 HTML 태그를 입력할 수 없습니다."))
      .toBeInTheDocument();
  });

  it("shows the share participant, safely renders a partial prefix, and retries rename idempotently", async () => {
    const user = userEvent.setup();
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "comment",
        canComment: true,
        canSaveCopy: false,
        downloadAllowed: false,
        quickCopyButtonVisible: false,
        participantIdentityEnabled: true,
        commentIpPrefixEnabled: true
      }
    }));
    mocks.listComments.mockResolvedValue({
      ok: true,
      items: [{
        id: "comment_participant_123456",
        body: "기존 댓글",
        displayName: "guest1",
        badge: "guest",
        createdAt: "2026-07-28T00:00:00.000Z",
        canDelete: true,
        authorParticipantId: "participant_123456",
        ipPrefix: "203.226"
      }],
      nextCursor: null,
      requestId: "request_participant_comments"
    });
    mocks.renameParticipant
      .mockRejectedValueOnce(new Error("ambiguous response"))
      .mockResolvedValueOnce(participant({
        displayName: "인기",
        isSystemDefaultName: false,
        renameCooldownEndsAt: "2026-07-29T01:01:00.000Z"
      }));

    renderViewer();

    expect(await screen.findByText("내 댓글 이름")).toBeInTheDocument();
    await waitFor(() => expect(mocks.getParticipant).toHaveBeenCalledWith(
      shareId,
      { signal: expect.any(AbortSignal) }
    ));
    expect(screen.getAllByText("(203.226)").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("guest1, 네트워크 대역 203.226").length)
      .toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).not.toContain("203.226.244.27");
    expect(screen.getByText("전체 IP 주소가 아닌 일부 네트워크 대역만 표시됩니다."))
      .toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "이름 변경" }));
    let input = screen.getByLabelText("표시 이름");
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("표시 이름")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이름 변경" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "이름 변경" }));
    input = screen.getByLabelText("표시 이름");
    await user.clear(input);
    await user.type(input, "인기");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("표시 이름을 변경하지 못했습니다. 다시 시도해주세요."))
      .toBeInTheDocument();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(mocks.renameParticipant).toHaveBeenCalledTimes(2));
    const firstRequest = mocks.renameParticipant.mock.calls[0]?.[1] as {
      clientRequestId: string;
    };
    const retryRequest = mocks.renameParticipant.mock.calls[1]?.[1] as {
      clientRequestId: string;
    };
    expect(retryRequest.clientRequestId).toBe(firstRequest.clientRequestId);
    expect(mocks.renameParticipant).toHaveBeenLastCalledWith(
      shareId,
      {
        displayName: "인기",
        clientRequestId: firstRequest.clientRequestId
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(await screen.findByText("댓글 표시 이름을 변경했습니다.")).toBeInTheDocument();
    expect(screen.getAllByText("인기").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: "이름 변경" })).toHaveFocus();
  });

  it("keeps existing comments readable when the participant limit blocks new comments", async () => {
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "comment",
        canComment: false,
        canSaveCopy: false,
        downloadAllowed: false,
        quickCopyButtonVisible: false,
        participantIdentityEnabled: true,
        participantLimitReached: true,
        commentIpPrefixEnabled: false
      }
    }));
    mocks.listComments.mockResolvedValue({
      ok: true,
      items: [{
        id: "comment_limit_123456",
        body: "기존 댓글은 계속 읽을 수 있습니다.",
        displayName: "기존 참여자",
        badge: "guest",
        createdAt: "2026-07-28T00:00:00.000Z",
        canDelete: true
      }],
      nextCursor: null,
      requestId: "request_limit_comments"
    });

    renderViewer();

    expect(await screen.findByText(
      "이 공유의 댓글 참여 인원이 많아 새 댓글 작성이 제한되었습니다."
    )).toBeInTheDocument();
    expect(screen.getByText("기존 댓글은 계속 읽을 수 있습니다.")).toBeInTheDocument();
    expect(screen.queryByLabelText("새 댓글")).not.toBeInTheDocument();
    expect(screen.queryByText("내 댓글 이름")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "기존 참여자 댓글 삭제" }))
      .not.toBeInTheDocument();
    expect(mocks.getParticipant).not.toHaveBeenCalled();
    expect(mocks.listComments).toHaveBeenCalledWith(
      shareId,
      {
        idToken: undefined,
        limit: 20,
        signal: expect.any(AbortSignal)
      }
    );
  });

  it.each([
    ["comment capability is still enabled", true, true],
    ["participant identity is disabled", false, false]
  ])("fails closed when a participant-limit session says %s", async (
    _case,
    canComment,
    participantIdentityEnabled
  ) => {
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "comment",
        canComment,
        canSaveCopy: false,
        downloadAllowed: false,
        quickCopyButtonVisible: false,
        participantIdentityEnabled,
        participantLimitReached: true,
        commentIpPrefixEnabled: false
      }
    }));

    renderViewer();

    expect(await screen.findByRole("heading", {
      name: "이 공유 링크를 사용할 수 없습니다."
    })).toBeInTheDocument();
    expect(mocks.getContent).not.toHaveBeenCalled();
    expect(mocks.listComments).not.toHaveBeenCalled();
  });

  it("keeps legacy comments working and fails closed on a prefix when the capability is off", async () => {
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "comment",
        canComment: true,
        canSaveCopy: false,
        downloadAllowed: false,
        quickCopyButtonVisible: false
      }
    }));
    mocks.listComments.mockResolvedValue({
      ok: true,
      items: [{
        id: "comment_legacy_123456",
        body: "레거시 댓글",
        displayName: "기존 사용자",
        badge: "guest",
        createdAt: "2026-07-28T00:00:00.000Z",
        canDelete: false,
        ipPrefix: "203.226"
      }],
      nextCursor: null,
      requestId: "request_legacy_comments"
    });

    renderViewer();

    expect(await screen.findByText("댓글 응답을 확인하지 못했습니다.")).toBeInTheDocument();
    expect(screen.queryByText("(203.226)")).not.toBeInTheDocument();
    expect(screen.queryByText("내 댓글 이름")).not.toBeInTheDocument();
    expect(mocks.getParticipant).not.toHaveBeenCalled();
  });

  it("reuses the same comment request id after an ambiguous client retry", async () => {
    const user = userEvent.setup();
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "comment",
        canComment: true,
        canSaveCopy: false,
        downloadAllowed: false,
        quickCopyButtonVisible: false
      }
    }));
    mocks.createComment
      .mockRejectedValueOnce(new Error("ambiguous network failure"))
      .mockResolvedValueOnce({
        ok: true,
        comment: {
          id: "comment_retry_123456",
          body: "재시도 댓글",
          displayName: "검증 사용자",
          badge: "guest",
          createdAt: "2026-07-28T00:00:00.000Z",
          canDelete: true
        },
        requestId: "request_retry_123456"
      });

    renderViewer();
    await screen.findByRole("heading", { name: "댓글" });
    await user.type(screen.getByLabelText("새 댓글"), "재시도 댓글");
    await user.click(screen.getByRole("button", { name: "댓글 작성" }));
    expect(await screen.findByText("댓글을 저장하지 못했습니다.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "댓글 작성" }));

    await waitFor(() => expect(mocks.createComment).toHaveBeenCalledTimes(2));
    const firstRequest = mocks.createComment.mock.calls[0]?.[1] as {
      clientRequestId: string;
    };
    const retryRequest = mocks.createComment.mock.calls[1]?.[1] as {
      clientRequestId: string;
    };
    expect(retryRequest.clientRequestId).toBe(firstRequest.clientRequestId);
    expect(await screen.findByText("재시도 댓글")).toBeInTheDocument();
  });

  it("keeps an optimistic comment when the initial comment page resolves later", async () => {
    const user = userEvent.setup();
    const initialComments = deferred<unknown>();
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "comment",
        canComment: true,
        canSaveCopy: false,
        downloadAllowed: false,
        quickCopyButtonVisible: false
      }
    }));
    mocks.listComments.mockImplementationOnce(() => initialComments.promise);

    renderViewer();
    await screen.findByRole("heading", { name: "댓글" });
    await user.type(screen.getByLabelText("새 댓글"), "방금 작성한 댓글");
    await user.click(screen.getByRole("button", { name: "댓글 작성" }));
    expect(await screen.findByText("방금 작성한 댓글")).toBeInTheDocument();

    await act(async () => {
      initialComments.resolve({
        ok: true,
        items: [{
          id: "comment_existing_123456",
          body: "기존 댓글",
          displayName: "기존 사용자",
          badge: "guest",
          createdAt: "2026-07-27T23:59:00.000Z",
          canDelete: false
        }],
        nextCursor: null,
        requestId: "request_existing_123456"
      });
      await initialComments.promise;
    });

    expect(screen.getByText("방금 작성한 댓글")).toBeInTheDocument();
    expect(screen.getByText("기존 댓글")).toBeInTheDocument();
  });

  it("ignores a stale comment mutation without clearing the next share's busy state", async () => {
    const user = userEvent.setup();
    const firstMutation = deferred<unknown>();
    const secondMutation = deferred<unknown>();
    const nextShareId = "secure_share_654321";
    const nextContentKey = "L".repeat(43);
    const commentSession = session({
      capabilities: {
        permissionLevel: "comment",
        canComment: true,
        canSaveCopy: false,
        downloadAllowed: false,
        quickCopyButtonVisible: false
      }
    });
    mocks.refreshSession.mockResolvedValue(commentSession);
    mocks.createComment
      .mockImplementationOnce(() => firstMutation.promise)
      .mockImplementationOnce(() => secondMutation.promise);

    const { props, rerender } = renderViewer();
    await screen.findByRole("heading", { name: "댓글" });
    await user.type(screen.getByLabelText("새 댓글"), "이전 공유 댓글");
    await user.click(screen.getByRole("button", { name: "댓글 작성" }));
    await waitFor(() => expect(mocks.createComment).toHaveBeenCalledTimes(1));

    rerender(
      <SecurePublicShareViewer
        {...props}
        contentKey={nextContentKey}
        shareId={nextShareId}
      />
    );
    await waitFor(() => expect(mocks.listComments).toHaveBeenCalledWith(
      nextShareId,
      expect.objectContaining({ limit: 20 })
    ));
    await waitFor(() => expect(screen.getByLabelText("새 댓글")).toHaveValue(""));

    await user.type(screen.getByLabelText("새 댓글"), "현재 공유 댓글");
    await user.click(screen.getByRole("button", { name: "댓글 작성" }));
    await waitFor(() => expect(mocks.createComment).toHaveBeenCalledTimes(2));
    expect(mocks.createComment).toHaveBeenLastCalledWith(
      nextShareId,
      expect.objectContaining({ body: "현재 공유 댓글" }),
      expect.any(Object)
    );

    await act(async () => {
      firstMutation.resolve(commentMutation(
        "comment_previous_123456",
        "이전 공유 댓글"
      ));
      await firstMutation.promise;
    });

    expect(screen.queryByText("이전 공유 댓글")).not.toBeInTheDocument();
    expect(screen.getByLabelText("새 댓글")).toHaveValue("현재 공유 댓글");
    expect(screen.getByLabelText("새 댓글")).toBeDisabled();
    expect(screen.getByRole("button", { name: "댓글 작성" })).toBeDisabled();

    await act(async () => {
      secondMutation.resolve(commentMutation(
        "comment_current_123456",
        "현재 공유 댓글"
      ));
      await secondMutation.promise;
    });

    expect(await screen.findByText("현재 공유 댓글")).toBeInTheDocument();
    expect(screen.getByLabelText("새 댓글")).toHaveValue("");
  });

  it("previews and downloads only through authenticated API responses and revokes object URLs", async () => {
    const user = userEvent.setup();
    const createObjectUrl = vi.fn()
      .mockReturnValueOnce("blob:secure-preview")
      .mockReturnValueOnce("blob:secure-download");
    const revokeObjectUrl = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const TestUrl = class extends URL {};
    Object.assign(TestUrl, {
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl
    });
    vi.stubGlobal("URL", TestUrl);
    mocks.refreshSession.mockResolvedValue(session());
    mocks.getContent.mockResolvedValue(content([attachment()]));

    const { unmount } = renderViewer();
    expect(await screen.findByText("안전한 이미지.png")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "미리보기" }));
    expect(await screen.findByRole("dialog", { name: "안전한 이미지.png" })).toBeInTheDocument();
    expect(mocks.getPreview).toHaveBeenCalledWith(
      shareId,
      "attachment_123456",
      { idToken: undefined, signal: expect.any(AbortSignal) }
    );

    await user.click(screen.getByRole("button", { name: "미리보기 닫기" }));
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:secure-preview");

    await user.click(screen.getByRole("button", { name: "다운로드" }));
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    expect(mocks.getDownload).toHaveBeenCalledWith(
      shareId,
      "attachment_123456",
      { idToken: undefined, signal: expect.any(AbortSignal) }
    );

    unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:secure-download");
  });

  it("aborts and discards an in-flight attachment preview when the content key changes", async () => {
    const user = userEvent.setup();
    const previewGate = deferred<Response>();
    mocks.refreshSession.mockResolvedValue(session());
    mocks.getContent.mockResolvedValue(content([attachment()]));
    mocks.getPreview.mockImplementationOnce(() => previewGate.promise);

    const { props, rerender } = renderViewer();
    expect(await screen.findByText("안전한 이미지.png")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "미리보기" }));
    await waitFor(() => expect(mocks.getPreview).toHaveBeenCalledTimes(1));
    const staleSignal = mocks.getPreview.mock.calls[0]?.[2]?.signal as AbortSignal;

    rerender(
      <SecurePublicShareViewer
        {...props}
        contentKey={"L".repeat(43)}
      />
    );
    await waitFor(() => expect(staleSignal.aborted).toBe(true));

    await act(async () => {
      previewGate.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      await previewGate.promise;
    });

    expect(mocks.decryptAttachmentToBytes).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "안전한 이미지.png" })).not.toBeInTheDocument();
  });

  it("aborts and discards an in-flight attachment download when authentication changes", async () => {
    const user = userEvent.setup();
    const downloadGate = deferred<Response>();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const firstIdToken = "header.payload.signature-before-download-auth-change";
    const nextIdToken = "header.payload.signature-after-download-auth-change";
    mocks.refreshSession.mockResolvedValue(session());
    mocks.getContent.mockResolvedValue(content([attachment()]));
    mocks.getDownload.mockImplementationOnce(() => downloadGate.promise);

    const { props, rerender } = renderViewer({
      idToken: firstIdToken,
      isAuthenticated: true
    });
    expect(await screen.findByText("안전한 이미지.png")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "다운로드" }));
    await waitFor(() => expect(mocks.getDownload).toHaveBeenCalledTimes(1));
    const staleSignal = mocks.getDownload.mock.calls[0]?.[2]?.signal as AbortSignal;

    rerender(
      <SecurePublicShareViewer
        {...props}
        idToken={nextIdToken}
        isAuthenticated
      />
    );
    await waitFor(() => expect(staleSignal.aborted).toBe(true));

    await act(async () => {
      downloadGate.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      await downloadGate.promise;
    });

    expect(mocks.decryptAttachmentToBlob).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it.each([
    ["doc", "application/msword", "unsupported"],
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ["hwp", "application/x-hwp", "html"],
    ["hwpx", "application/vnd.hancom.hwpx", "html"],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "html"]
  ])("preserves the existing safe %s preview without exposing a modal download", async (
    extension,
    mimeType,
    expectedKind
  ) => {
    const user = userEvent.setup();
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "view",
        canComment: false,
        canSaveCopy: false,
        downloadAllowed: false,
        quickCopyButtonVisible: true
      }
    }));
    mocks.getContent.mockResolvedValue(content([attachment({ extension, mimeType })]));

    renderViewer();
    expect(await screen.findByText(`안전한 이미지.${extension}`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "미리보기" }));

    const dialog = await screen.findByRole("dialog", { name: `안전한 이미지.${extension}` });
    expect(dialog).toHaveTextContent(expectedKind);
    expect(screen.queryByRole("button", { name: "모달 다운로드" })).not.toBeInTheDocument();
  });

  it("requests a copy grant before handing off decrypted content without the content key", async () => {
    const user = userEvent.setup();
    const onSaveCopy = vi.fn().mockResolvedValue(undefined);
    const idToken = "header.payload.signature-for-copy";
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "save_copy",
        canComment: false,
        canSaveCopy: true,
        downloadAllowed: false,
        quickCopyButtonVisible: false
      }
    }));
    mocks.getContent.mockResolvedValue(content([attachment()]));

    renderViewer({
      idToken,
      isAuthenticated: true,
      onSaveCopy
    });

    await user.click(await screen.findByRole("button", { name: "QuickMemo에 복사본 저장" }));
    await waitFor(() => expect(onSaveCopy).toHaveBeenCalledTimes(1));

    expect(mocks.requestCopyGrant).toHaveBeenCalledWith(
      shareId,
      idToken,
      expect.any(String),
      expect.any(AbortSignal)
    );
    const copyPayload = onSaveCopy.mock.calls[0][0];
    expect(copyPayload).toEqual(expect.objectContaining({
      title: "보안 제목",
      copyAttachment: expect.any(Function),
      capabilities: expect.objectContaining({ canSaveCopy: true })
    }));
    const signal = new AbortController().signal;
    const copiedBlob = await copyPayload.copyAttachment(copyPayload.attachments[0], signal);
    expect(copiedBlob).toBeInstanceOf(Blob);
    expect(mocks.getCopyAttachment).toHaveBeenCalledWith(
      shareId,
      "attachment_123456",
      idToken,
      `${"G".repeat(40)}.${"S".repeat(43)}`,
      expect.any(AbortSignal)
    );
    expect(JSON.stringify(copyPayload)).not.toContain(contentKey);
    expect(JSON.stringify(copyPayload)).not.toContain(`${"G".repeat(40)}.${"S".repeat(43)}`);
    expect(copyPayload.body).not.toMatch(/script|onclick|javascript:/iu);
    expect(copyPayload).not.toHaveProperty("contentKey");
  });

  it("aborts a pending copy grant and blocks its stale handoff after authentication changes", async () => {
    const user = userEvent.setup();
    const grantGate = deferred<unknown>();
    const onSaveCopy = vi.fn().mockResolvedValue(undefined);
    const firstIdToken = "header.payload.signature-before-copy-auth-change";
    const nextIdToken = "header.payload.signature-after-copy-auth-change";
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "save_copy",
        canComment: false,
        canSaveCopy: true,
        downloadAllowed: false,
        quickCopyButtonVisible: false
      }
    }));
    mocks.requestCopyGrant.mockImplementationOnce(() => grantGate.promise);

    const { props, rerender } = renderViewer({
      idToken: firstIdToken,
      isAuthenticated: true,
      onSaveCopy
    });
    await user.click(await screen.findByRole("button", {
      name: "QuickMemo에 복사본 저장"
    }));
    await waitFor(() => expect(mocks.requestCopyGrant).toHaveBeenCalledTimes(1));
    const staleSignal = mocks.requestCopyGrant.mock.calls[0]?.[3] as AbortSignal;

    rerender(
      <SecurePublicShareViewer
        {...props}
        idToken={nextIdToken}
        isAuthenticated
      />
    );
    await waitFor(() => expect(staleSignal.aborted).toBe(true));

    await act(async () => {
      grantGate.resolve({
        ok: true,
        copyGrant: `${"G".repeat(40)}.${"S".repeat(43)}`,
        expiresAt: "2026-07-28T00:05:00.000Z",
        requestId: "request_stale_copy_123456"
      });
      await grantGate.promise;
    });

    expect(onSaveCopy).not.toHaveBeenCalled();
    expect(screen.queryByText("QuickMemo 복사본 저장 작업을 시작했습니다."))
      .not.toBeInTheDocument();
  });

  it("reuses the Save Copy request ID after a lost grant response and a failed copy handoff", async () => {
    const user = userEvent.setup();
    const onSaveCopy = vi.fn()
      .mockRejectedValueOnce(new Error("copy failed"))
      .mockResolvedValue(undefined);
    const idToken = "header.payload.signature-for-copy-retry";
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "save_copy",
        canComment: false,
        canSaveCopy: true,
        downloadAllowed: false,
        quickCopyButtonVisible: false
      }
    }));
    mocks.requestCopyGrant.mockRejectedValueOnce(new Error("grant response lost"));

    renderViewer({
      idToken,
      isAuthenticated: true,
      onSaveCopy
    });

    const copyButton = await screen.findByRole("button", {
      name: "QuickMemo에 복사본 저장"
    });
    await user.click(copyButton);
    await waitFor(() => expect(mocks.requestCopyGrant).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(copyButton).toBeEnabled());

    await user.click(copyButton);
    await waitFor(() => expect(mocks.requestCopyGrant).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onSaveCopy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(copyButton).toBeEnabled());

    await user.click(copyButton);
    await waitFor(() => expect(mocks.requestCopyGrant).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(onSaveCopy).toHaveBeenCalledTimes(2));

    const requestIds = mocks.requestCopyGrant.mock.calls.map((call) => call[2]);
    expect(new Set(requestIds).size).toBe(1);
    expect(await screen.findByText("QuickMemo 복사본 저장 작업을 시작했습니다."))
      .toBeInTheDocument();
  });

  it("allocates a new Save Copy request ID only after the prior copy succeeds", async () => {
    const user = userEvent.setup();
    const onSaveCopy = vi.fn().mockResolvedValue(undefined);
    const idToken = "header.payload.signature-for-copy-success";
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "save_copy",
        canComment: false,
        canSaveCopy: true,
        downloadAllowed: false,
        quickCopyButtonVisible: false
      }
    }));

    renderViewer({
      idToken,
      isAuthenticated: true,
      onSaveCopy
    });

    const copyButton = await screen.findByRole("button", {
      name: "QuickMemo에 복사본 저장"
    });
    await user.click(copyButton);
    await waitFor(() => expect(onSaveCopy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(copyButton).toBeEnabled());

    await user.click(copyButton);
    await waitFor(() => expect(onSaveCopy).toHaveBeenCalledTimes(2));

    expect(mocks.requestCopyGrant).toHaveBeenCalledTimes(2);
    expect(mocks.requestCopyGrant.mock.calls[0][2])
      .not.toBe(mocks.requestCopyGrant.mock.calls[1][2]);
  });

  it("resets a pending Save Copy request ID when the share changes", async () => {
    const user = userEvent.setup();
    const onSaveCopy = vi.fn().mockResolvedValue(undefined);
    const idToken = "header.payload.signature-for-copy-share-change";
    const nextShareId = "secure_share_654321";
    mocks.refreshSession.mockResolvedValue(session({
      capabilities: {
        permissionLevel: "save_copy",
        canComment: false,
        canSaveCopy: true,
        downloadAllowed: false,
        quickCopyButtonVisible: false
      }
    }));
    mocks.requestCopyGrant.mockRejectedValueOnce(new Error("grant response lost"));

    const { rerender } = renderViewer({
      idToken,
      isAuthenticated: true,
      onSaveCopy
    });

    const firstCopyButton = await screen.findByRole("button", {
      name: "QuickMemo에 복사본 저장"
    });
    await user.click(firstCopyButton);
    await waitFor(() => expect(mocks.requestCopyGrant).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(firstCopyButton).toBeEnabled());

    rerender(
      <SecurePublicShareViewer
        contentKey={contentKey}
        idToken={idToken}
        isAuthenticated
        onRequireLogin={vi.fn()}
        onSaveCopy={onSaveCopy}
        shareId={nextShareId}
      />
    );
    await waitFor(() => expect(mocks.getContent.mock.calls.some(
      ([requestedShareId]) => requestedShareId === nextShareId
    )).toBe(true));

    const nextCopyButton = await screen.findByRole("button", {
      name: "QuickMemo에 복사본 저장"
    });
    await user.click(nextCopyButton);
    await waitFor(() => expect(mocks.requestCopyGrant).toHaveBeenCalledTimes(2));

    expect(mocks.requestCopyGrant.mock.calls[0][0]).toBe(shareId);
    expect(mocks.requestCopyGrant.mock.calls[1][0]).toBe(nextShareId);
    expect(mocks.requestCopyGrant.mock.calls[0][2])
      .not.toBe(mocks.requestCopyGrant.mock.calls[1][2]);
  });

  it("fails closed on an invalid metadata DTO", async () => {
    mocks.getMetadata.mockResolvedValue({
      ok: true,
      metadata: {
        schemaVersion: 2,
        accessMode: "owner_only",
        hasPassword: false
      },
      requestId: "request_123456"
    });

    renderViewer();

    expect(await screen.findByRole("heading", {
      name: "이 공유 링크를 사용할 수 없습니다."
    })).toBeInTheDocument();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });
});
