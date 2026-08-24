import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecureShareOwnerSummary, UserProfile } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import {
  VaultShareManagerDialog,
  type VaultShareManagerDependencies
} from "./VaultShareManagerDialog";

const fixedNow = Date.parse("2026-08-24T00:00:00.000Z");
const contentKey = "A".repeat(43);
const shareOrigin = "https://quickmemo.test";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    allowedShareTargetUids: ["user-b"],
    avatarText: "A",
    color: "#334155",
    displayName: "사용자 A",
    featureAccess: { library: true, notes: true, schedule: true },
    isActive: true,
    isAdmin: false,
    loginEmail: "user-a@example.com",
    order: 0,
    publicKeyJwk: { e: "AQAB", kty: "RSA", n: "public-key" },
    quickKey: 1,
    role: "user",
    uid: "user-a",
    ...overrides
  };
}

function note(overrides: Partial<DecryptedVaultNote> = {}): DecryptedVaultNote {
  return {
    body: "# 본문",
    contentFormat: "markdown-v1",
    encryptedBody: { algorithm: "AES-GCM", cipherText: "body", iv: "iv", version: 1 },
    encryptedTitle: { algorithm: "AES-GCM", cipherText: "title", iv: "iv", version: 1 },
    entryKind: "markdown",
    folderId: null,
    id: "note-a1",
    isDeleted: false,
    ownerUid: "user-a",
    participantUids: ["user-a"],
    revision: 4,
    title: "공유할 노트",
    type: "personal",
    updatedBy: "user-a",
    wrappedKeys: {
      "user-a": { algorithm: "RSA-OAEP", version: 1, wrappedKey: "owner-key" }
    },
    ...overrides
  };
}

function share(overrides: Partial<SecureShareOwnerSummary> = {}): SecureShareOwnerSummary {
  return {
    accessMode: "anyone_with_link",
    attachmentCount: 0,
    consumedAt: null,
    contentRevision: 1,
    createdAt: "2026-08-24T01:00:00.000Z",
    currentGeneration: "",
    downloadAllowed: true,
    expiresAt: "2026-08-31T00:00:00.000Z",
    hasPassword: false,
    lastAccessAt: null,
    oneTimeEnabled: false,
    ownerWrappedShareKey: {
      algorithm: "RSA-OAEP",
      version: 1,
      wrappedKey: "wrapped-owner-share-key"
    },
    permissionLevel: "view",
    policyVersion: 1,
    quickCopyButtonVisible: true,
    ready: true,
    requiresEmailVerification: false,
    revokedAt: null,
    schemaVersion: 2,
    shareId: "share-a1",
    showCommenterIpPrefix: false,
    sourceAttachmentRevision: 0,
    sourceNoteId: "note-a1",
    sourceRevision: 4,
    sourceSyncMode: "revision_bound",
    status: "active",
    successfulAccessCount: 0,
    updatedAt: "2026-08-24T01:00:00.000Z",
    ...overrides
  };
}

function listResponse(shares: SecureShareOwnerSummary[], nextCursor: string | null = null) {
  return { nextCursor, ok: true, shares };
}

function commentsResponse(
  items: Array<{
    badge?: "admin" | "email_verified" | "guest" | "owner" | "quickmemo_user";
    body: string;
    id: string;
    ipPrefix?: string;
  }>,
  nextCursor: string | null = null
) {
  return {
    items: items.map((item, index) => ({
      badge: item.badge ?? "guest",
      body: item.body,
      canDelete: false,
      createdAt: `2026-08-24T0${index + 1}:30:00.000Z`,
      displayName: `댓글 작성자 ${index + 1}`,
      id: item.id,
      ...(item.ipPrefix ? { ipPrefix: item.ipPrefix } : {})
    })),
    nextCursor,
    ok: true,
    requestId: "request_comments_1"
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function dependencies(
  overrides: Partial<VaultShareManagerDependencies> = {}
): VaultShareManagerDependencies {
  return {
    createShare: vi.fn().mockRejectedValue(new Error("unexpected create")),
    getFeatureStatus: vi.fn().mockResolvedValue({ emailEnabled: true, v2Enabled: true }),
    getShareDetails: vi.fn().mockRejectedValue(new Error("unexpected details")),
    listComments: vi.fn().mockRejectedValue(new Error("unexpected comments")),
    listShares: vi.fn().mockResolvedValue(listResponse([])),
    recoverShareUrl: vi.fn().mockRejectedValue(new Error("unexpected recover")),
    revokeShare: vi.fn().mockRejectedValue(new Error("unexpected revoke")),
    updateShare: vi.fn().mockRejectedValue(new Error("unexpected update")),
    ...overrides
  };
}

type ManagerProps = ComponentProps<typeof VaultShareManagerDialog>;

function renderManager(overrides: Partial<ManagerProps> = {}) {
  const appRoot = document.createElement("div");
  const renderHost = document.createElement("div");
  appRoot.id = "root";
  appRoot.append(renderHost);
  document.body.append(appRoot);
  const props: ManagerProps = {
    dependencies: dependencies(),
    getIdToken: vi.fn().mockResolvedValue("firebase-token"),
    hasUnsharedAssetEmbeds: false,
    note: note(),
    now: fixedNow,
    onClose: vi.fn(),
    onRequestParticipantSharing: vi.fn(),
    origin: shareOrigin,
    privateKey: {} as CryptoKey,
    profile: profile(),
    ...overrides
  };
  return {
    ...render(<VaultShareManagerDialog {...props} />, { container: renderHost }),
    appRoot,
    props
  };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("VaultShareManagerDialog", () => {
  it("explains that source edits immediately make a Vault snapshot link unavailable", async () => {
    renderManager();

    expect(await screen.findByText(/원본 노트의 내용이나 첨부가 변경되면/))
      .toHaveTextContent("기존 링크는 즉시 접근할 수 없게");
  });

  it("marks a revision-bound stale link and permits only revocation", async () => {
    renderManager({
      dependencies: dependencies({
        listShares: vi.fn().mockResolvedValue(listResponse([
          share({ sourceRevision: 3 })
        ]))
      })
    });

    expect(await screen.findByText("원본 변경됨")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "주소 복사" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "설정 변경" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /링크 중단/ })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("원본이 변경된 링크를 중단");
    expect(screen.getByRole("button", { name: "새 보안 링크 만들기" })).toBeDisabled();
  });

  it("fails closed before network access when the user cannot manage the note", async () => {
    const service = dependencies();
    renderManager({
      dependencies: service,
      profile: profile({ featureAccess: { library: true, notes: false, schedule: true } })
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("활성화된 노트 권한");
    expect(service.getFeatureStatus).not.toHaveBeenCalled();
    expect(service.listShares).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("tab", { name: /QuickMemo 사용자/ }));
    expect(screen.getByRole("button", { name: "사용자 공유 설정 열기" })).toBeDisabled();
  });

  it("blocks both new link and participant sharing when embedded assets cannot be re-shared", async () => {
    const user = userEvent.setup();
    const onRequestParticipantSharing = vi.fn();
    renderManager({
      hasUnsharedAssetEmbeds: true,
      onRequestParticipantSharing
    });

    expect(await screen.findByText(/ACL과 재암호화를 안전하게 전달할 수 없는 첨부 자산/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 보안 링크 만들기" })).toBeDisabled();

    const linkTab = screen.getByRole("tab", { name: /보안 링크/ });
    linkTab.focus();
    await user.keyboard("{ArrowRight}");
    const participantTab = screen.getByRole("tab", { name: /QuickMemo 사용자/ });
    expect(participantTab).toHaveFocus();
    expect(participantTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/공유되지 않은 첨부 자산이 있어 새 사용자를 추가할 수 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "사용자 공유 설정 열기" })).toBeDisabled();
    expect(onRequestParticipantSharing).not.toHaveBeenCalled();
  });

  it("fails closed on disabled or malformed server feature status", async () => {
    const getIdToken = vi.fn().mockResolvedValue("firebase-token");
    const service = dependencies({
      getFeatureStatus: vi.fn().mockResolvedValue({ emailEnabled: true, v2Enabled: false })
    });
    const { unmount } = renderManager({ dependencies: service, getIdToken });

    expect(await screen.findByRole("alert")).toHaveTextContent("현재 서버에서 보안 공유 기능을 사용할 수 없습니다");
    expect(getIdToken).not.toHaveBeenCalled();
    expect(service.listShares).not.toHaveBeenCalled();
    unmount();
    document.body.replaceChildren();

    const malformed = dependencies({
      getFeatureStatus: vi.fn().mockResolvedValue({ emailEnabled: true, v2Enabled: "true" })
    });
    renderManager({ dependencies: malformed });
    expect(await screen.findByRole("alert")).toHaveTextContent("기능 상태를 안전하게 확인하지 못했습니다");
    expect(malformed.listShares).not.toHaveBeenCalled();
  });

  it("strictly scopes history to sourceNoteId and rechecks for a concurrent active link before creation", async () => {
    const user = userEvent.setup();
    const activeShare = share();
    const service = dependencies({
      listShares: vi.fn()
        .mockResolvedValueOnce(listResponse([]))
        .mockResolvedValueOnce(listResponse([activeShare]))
    });
    renderManager({ dependencies: service });

    const createButton = await screen.findByRole("button", { name: "새 보안 링크 만들기" });
    expect(createButton).toBeEnabled();
    expect(service.listShares).toHaveBeenNthCalledWith(1, "firebase-token", {
      limit: 100,
      sourceNoteId: "note-a1"
    });

    await user.click(createButton);
    const settings = await screen.findByRole("dialog", { name: "보안 공유 만들기" });
    await user.click(within(settings).getByRole("button", { name: "보안 공유 만들기" }));
    expect(await within(settings).findByRole("alert")).toHaveTextContent(/이미 활성 또는 준비 중인 보안 링크/);
    expect(createButton).toBeDisabled();
    expect(service.createShare).not.toHaveBeenCalled();
  });

  it("rejects a cross-note history response instead of exposing management controls", async () => {
    const service = dependencies({
      listShares: vi.fn().mockResolvedValue(listResponse([
        share({ sourceNoteId: "note-b1" })
      ]))
    });
    renderManager({ dependencies: service });

    expect(await screen.findByRole("alert")).toHaveTextContent("이력을 안전하게 확인하지 못했습니다");
    expect(screen.queryByRole("button", { name: "새 보안 링크 만들기" })).not.toBeInTheDocument();
    expect(service.listShares).toHaveBeenCalledWith("firebase-token", {
      limit: 100,
      sourceNoteId: "note-a1"
    });
  });

  it("creates a Markdown save-copy link and keeps the URL out of storage", async () => {
    const user = userEvent.setup();
    const localStorageWrite = vi.spyOn(Storage.prototype, "setItem");
    const activeShare = share({ permissionLevel: "save_copy" });
    const service = dependencies({
      createShare: vi.fn().mockResolvedValue({
        contentKey,
        share: activeShare,
        url: `${shareOrigin}/share/${activeShare.shareId}#key=${contentKey}`
      })
    });
    renderManager({ dependencies: service });

    await user.click(await screen.findByRole("button", { name: "새 보안 링크 만들기" }));
    const settings = await screen.findByRole("dialog", { name: "보안 공유 만들기" });
    expect(within(settings).getByRole("radio", { name: /지정한 이메일만/ })).toBeEnabled();
    expect(screen.queryByText(/복사본 저장 권한은 제공하지 않습니다/)).not.toBeInTheDocument();

    await user.click(within(settings).getByRole("radio", { name: /QuickMemo에 복사본 저장 가능/ }));
    await user.click(within(settings).getByRole("button", { name: "보안 공유 만들기" }));
    await waitFor(() => expect(service.createShare).toHaveBeenCalledTimes(1));
    expect(service.createShare).toHaveBeenCalledWith(expect.objectContaining({
      emailFeatureEnabled: true,
      idToken: "firebase-token",
      note: expect.objectContaining({ id: "note-a1" }),
      origin: shareOrigin,
      policy: expect.objectContaining({ permissionLevel: "save_copy" })
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "보안 공유 만들기" })).not.toBeInTheDocument());
    expect(screen.getByText(/링크 키는 이 화면의 메모리에만 유지/)).toBeInTheDocument();
    expect(localStorageWrite).not.toHaveBeenCalled();
  });

  it("loads and updates an active link policy through the existing settings surface", async () => {
    const user = userEvent.setup();
    const activeShare = share();
    const updatedShare = share({
      contentRevision: 1,
      permissionLevel: "save_copy",
      policyVersion: 2,
      showCommenterIpPrefix: false
    });
    const service = dependencies({
      getShareDetails: vi.fn().mockResolvedValue({
        ok: true,
        policy: {
          allowedEmails: [],
          downloadAllowed: true,
          emailVerificationRequired: false,
          oneTimeEnabled: false,
          passwordEnabled: false,
          quickCopyButtonVisible: true,
          showCommenterIpPrefix: false
        },
        share: activeShare
      }),
      listShares: vi.fn().mockResolvedValue(listResponse([activeShare])),
      updateShare: vi.fn().mockResolvedValue({ ok: true, share: updatedShare })
    });
    renderManager({ dependencies: service });

    await user.click(await screen.findByRole("button", { name: "설정 변경" }));
    const settings = await screen.findByRole("dialog", { name: "보안 공유 설정 변경" });
    await user.click(within(settings).getByRole("radio", { name: /QuickMemo에 복사본 저장 가능/ }));
    await user.click(within(settings).getByRole("button", { name: "설정 저장" }));

    await waitFor(() => expect(service.updateShare).toHaveBeenCalledTimes(1));
    expect(service.updateShare).toHaveBeenCalledWith(
      activeShare.shareId,
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^vault_update_/u),
        policy: expect.objectContaining({ permissionLevel: "save_copy" })
      }),
      "firebase-token",
      expect.objectContaining({ emailFeatureEnabled: true })
    );
    expect(await screen.findByText("보안 공유 설정을 저장했습니다.")).toBeInTheDocument();
    expect(screen.getByText(/복사본 저장 가능/)).toBeInTheDocument();
  });

  it("loads owner-authorized comments for an active comment share and paginates with policy-approved IP prefixes", async () => {
    const user = userEvent.setup();
    const commentShare = share({
      permissionLevel: "comment",
      showCommenterIpPrefix: true
    });
    const listComments = vi.fn()
      .mockResolvedValueOnce(commentsResponse([
        { body: "첫 번째 댓글", id: "comment_a1", ipPrefix: "8.8" }
      ], "cursor_page_2"))
      .mockResolvedValueOnce(commentsResponse([
        { badge: "quickmemo_user", body: "두 번째 댓글", id: "comment_a2", ipPrefix: "1.1" }
      ]));
    const service = dependencies({
      listComments,
      listShares: vi.fn().mockResolvedValue(listResponse([commentShare]))
    });
    renderManager({ dependencies: service });

    expect(await screen.findByText("첫 번째 댓글")).toBeInTheDocument();
    expect(screen.getByText("(8.8)")).toBeInTheDocument();
    expect(listComments).toHaveBeenNthCalledWith(1, commentShare.shareId, {
      idToken: "firebase-token",
      limit: 20,
      signal: expect.any(AbortSignal)
    });

    await user.click(screen.getByRole("button", { name: "댓글 더 보기" }));
    expect(await screen.findByText("두 번째 댓글")).toBeInTheDocument();
    expect(screen.getByText("(1.1)")).toBeInTheDocument();
    expect(listComments).toHaveBeenNthCalledWith(2, commentShare.shareId, {
      cursor: "cursor_page_2",
      idToken: "firebase-token",
      limit: 20,
      signal: expect.any(AbortSignal)
    });
  });

  it("rejects comment IP data when the current share policy does not allow owner IP-prefix display", async () => {
    const commentShare = share({
      permissionLevel: "comment",
      showCommenterIpPrefix: false
    });
    const service = dependencies({
      listComments: vi.fn().mockResolvedValue(commentsResponse([
        { body: "정책 밖 IP 댓글", id: "comment_a3", ipPrefix: "8.8" }
      ])),
      listShares: vi.fn().mockResolvedValue(listResponse([commentShare]))
    });
    renderManager({ dependencies: service });

    expect(await screen.findByRole("alert")).toHaveTextContent("댓글을 불러오지 못했습니다");
    expect(screen.queryByText("정책 밖 IP 댓글")).not.toBeInTheDocument();
    expect(screen.queryByText("(8.8)")).not.toBeInTheDocument();
  });

  it("does not request comments for view-only, stale, expired, or revoked share history", async () => {
    const listComments = vi.fn();
    const service = dependencies({
      listComments,
      listShares: vi.fn().mockResolvedValue(listResponse([
        share({ permissionLevel: "view", shareId: "share_view" }),
        share({ permissionLevel: "comment", shareId: "share_stale", sourceRevision: 3 }),
        share({
          expiresAt: "2026-08-23T23:59:59.000Z",
          permissionLevel: "comment",
          shareId: "share_expired",
          status: "expired"
        }),
        share({
          permissionLevel: "comment",
          ready: false,
          revokedAt: "2026-08-23T23:00:00.000Z",
          shareId: "share_revoked",
          status: "revoked"
        })
      ]))
    });
    renderManager({ dependencies: service });

    expect(await screen.findByText("보기만 가능 · 0회 접근")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "댓글" })).not.toBeInTheDocument();
    expect(listComments).not.toHaveBeenCalled();
  });

  it("aborts and discards an in-flight comment page when refreshed policy state no longer permits comments", async () => {
    const user = userEvent.setup();
    const pendingComments = deferred<ReturnType<typeof commentsResponse>>();
    const commentShare = share({ permissionLevel: "comment", policyVersion: 1 });
    const changedShare = share({ permissionLevel: "view", policyVersion: 2 });
    const listComments = vi.fn().mockReturnValue(pendingComments.promise);
    const service = dependencies({
      listComments,
      listShares: vi.fn()
        .mockResolvedValueOnce(listResponse([commentShare]))
        .mockResolvedValueOnce(listResponse([changedShare]))
    });
    renderManager({ dependencies: service });

    await waitFor(() => expect(listComments).toHaveBeenCalledTimes(1));
    const firstSignal = listComments.mock.calls[0][1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    await user.click(screen.getByRole("button", { name: "보안 공유 이력 새로고침" }));
    await waitFor(() => expect(firstSignal.aborted).toBe(true));
    expect(screen.queryByRole("heading", { name: "댓글" })).not.toBeInTheDocument();

    pendingComments.resolve(commentsResponse([
      { body: "폐기되어야 하는 이전 정책 댓글", id: "comment_old" }
    ]));
    await waitFor(() => {
      expect(screen.queryByText("폐기되어야 하는 이전 정책 댓글")).not.toBeInTheDocument();
    });
    expect(listComments).toHaveBeenCalledTimes(1);
  });

  it("recovers an existing owner-wrapped key and shows a read-only URL when clipboard copy fails", async () => {
    const user = userEvent.setup();
    const localStorageWrite = vi.spyOn(Storage.prototype, "setItem");
    const clipboardWrite = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite }
    });
    const activeShare = share();
    const service = dependencies({
      listShares: vi.fn().mockResolvedValue(listResponse([activeShare])),
      recoverShareUrl: vi.fn().mockResolvedValue({
        contentKey,
        share: activeShare,
        url: `${shareOrigin}/share/${activeShare.shareId}#key=${contentKey}`
      })
    });
    const privateKey = {} as CryptoKey;
    renderManager({ dependencies: service, privateKey });

    await user.click(await screen.findByRole("button", { name: "주소 복사" }));
    const fallback = await screen.findByLabelText("복사할 보안 공유 주소");
    expect(fallback).toHaveAttribute("readonly");
    expect(fallback).toHaveValue(`${shareOrigin}/share/${activeShare.shareId}#key=${contentKey}`);
    expect(clipboardWrite).toHaveBeenCalledWith(`${shareOrigin}/share/${activeShare.shareId}#key=${contentKey}`);
    expect(service.recoverShareUrl).toHaveBeenCalledWith({
      idToken: "firebase-token",
      origin: shareOrigin,
      privateKey,
      share: expect.objectContaining({
        ownerWrappedShareKey: activeShare.ownerWrappedShareKey,
        shareId: activeShare.shareId
      })
    });
    expect(localStorageWrite).not.toHaveBeenCalled();
  });

  it("strictly verifies revoke results and opens the separate participant-sharing surface", async () => {
    const user = userEvent.setup();
    const activeShare = share({
      consumedAt: "2026-08-24T01:30:00.000Z",
      status: "consumed"
    });
    const revokedShare = share({
      ready: false,
      revokedAt: "2026-08-24T02:00:00.000Z",
      status: "revoked",
      updatedAt: "2026-08-24T02:00:00.000Z"
    });
    const service = dependencies({
      listShares: vi.fn().mockResolvedValue(listResponse([activeShare])),
      revokeShare: vi.fn().mockResolvedValue({ ok: true, share: revokedShare })
    });
    const onClose = vi.fn();
    const onRequestParticipantSharing = vi.fn();
    renderManager({ dependencies: service, onClose, onRequestParticipantSharing });

    await user.click(await screen.findByRole("button", { name: "링크 중단" }));
    const confirmation = screen.getByRole("group", { name: "링크 중단 확인" });
    await user.click(within(confirmation).getByRole("button", { name: "중단" }));
    expect(await screen.findByText("보안 링크를 중단했습니다.")).toBeInTheDocument();
    expect(screen.getByText("중단됨")).toBeInTheDocument();
    expect(service.revokeShare).toHaveBeenCalledWith(
      activeShare.shareId,
      "firebase-token",
      expect.stringMatching(/^vault_revoke_[A-Za-z0-9]+$/u)
    );
    expect(screen.getByRole("button", { name: "새 보안 링크 만들기" })).toBeEnabled();

    await user.click(screen.getByRole("tab", { name: /QuickMemo 사용자/ }));
    await user.click(screen.getByRole("button", { name: "사용자 공유 설정 열기" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRequestParticipantSharing).toHaveBeenCalledTimes(1);
  });
});
