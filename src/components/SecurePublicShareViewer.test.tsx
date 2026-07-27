import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  getPreview: vi.fn(),
  extractHwpPreviewHtml: vi.fn(),
  extractHwpxPreviewHtml: vi.fn(),
  extractXlsxPreviewHtml: vi.fn(),
  importKey: vi.fn(),
  listComments: vi.fn(),
  refreshSession: vi.fn(),
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
    listSecureShareComments: mocks.listComments,
    refreshSecureShareSession: mocks.refreshSession,
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
  mocks.listComments.mockResolvedValue({
    ok: true,
    items: [],
    nextCursor: null,
    requestId: "request_123456"
  });
  mocks.unlock.mockResolvedValue({ granted: true });
  mocks.createComment.mockResolvedValue({ commentId: "comment_123456" });
  mocks.deleteComment.mockResolvedValue({ deleted: true });
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
    expect(mocks.unlock.mock.calls[0][2]).toEqual({ idToken });
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
      { idToken }
    );
    expect(mocks.unlock.mock.calls[0][1]).not.toHaveProperty("otp");
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
          permissionLevel: "view",
          canComment: true,
          canSaveCopy: false,
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
    expect(mocks.listComments).toHaveBeenCalledWith(
      shareId,
      expect.objectContaining({ idToken, limit: 20 })
    );

    await user.type(screen.getByLabelText("새 댓글"), "소유자 새 댓글");
    await user.click(screen.getByRole("button", { name: "댓글 작성" }));
    await waitFor(() => expect(mocks.createComment).toHaveBeenCalledWith(
      shareId,
      { body: "소유자 새 댓글" },
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
      { body: "안전한 댓글" },
      { idToken: undefined }
    ));
    expect(document.querySelector(".secure-public-share-comment-list script")).toBeNull();

    await user.type(screen.getByLabelText("새 댓글"), "<script>alert(1)</script>");
    await user.click(screen.getByRole("button", { name: "댓글 작성" }));
    expect(mocks.createComment).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("댓글에는 HTML 태그를 입력할 수 없습니다."))
      .toBeInTheDocument();
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
      { idToken: undefined }
    );

    await user.click(screen.getByRole("button", { name: "미리보기 닫기" }));
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:secure-preview");

    await user.click(screen.getByRole("button", { name: "다운로드" }));
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    expect(mocks.getDownload).toHaveBeenCalledWith(
      shareId,
      "attachment_123456",
      { idToken: undefined }
    );

    unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:secure-download");
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
      expect.any(String)
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
      signal
    );
    expect(JSON.stringify(copyPayload)).not.toContain(contentKey);
    expect(JSON.stringify(copyPayload)).not.toContain(`${"G".repeat(40)}.${"S".repeat(43)}`);
    expect(copyPayload.body).not.toMatch(/script|onclick|javascript:/iu);
    expect(copyPayload).not.toHaveProperty("contentKey");
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
