// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Profiler,
  type ProfilerOnRenderCallback
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecurePublicShareViewer } from "../src/components/SecurePublicShareViewer";

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
  importKey: vi.fn(),
  listComments: vi.fn(),
  refreshSession: vi.fn(),
  renameParticipant: vi.fn(),
  requestChallenge: vi.fn(),
  requestCopyGrant: vi.fn(),
  safeRasterImageBytes: vi.fn(),
  unlock: vi.fn()
}));

vi.mock("../src/services/secureShares", () => ({
  SecureShareApiError: class MockSecureShareApiError extends Error {
    code: string;
    retryAfterSeconds: number | null;
    status: number;

    constructor(code: string, message: string, status = 0) {
      super(message);
      this.code = code;
      this.retryAfterSeconds = null;
      this.status = status;
    }
  },
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
}));

vi.mock("../src/lib/crypto", () => ({
  decryptText: mocks.decryptText,
  importAesKeyBase64Url: mocks.importKey
}));

vi.mock("../src/lib/attachmentCrypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/attachmentCrypto")>();
  return {
    ...original,
    decryptAttachmentToBlob: mocks.decryptAttachmentToBlob,
    decryptAttachmentToBytes: mocks.decryptAttachmentToBytes
  };
});

vi.mock("../src/lib/safeRasterImage", () => ({
  safeRasterImageBytes: mocks.safeRasterImageBytes
}));

vi.mock("../src/lib/documentPreview", () => ({
  extractHwpPreviewHtml: vi.fn(),
  extractHwpxPreviewHtml: vi.fn(),
  extractXlsxPreviewHtml: vi.fn(),
  renderSafeDocxPreviewSrcDoc: vi.fn()
}));

vi.mock("../src/components/PublicAttachmentPreviewModal", () => ({
  default: () => null
}));

const shareId = "secure_share_benchmark";
const contentKey = "K".repeat(43);
const iv = "AAAAAAAAAAAAAAAA";
const describeCurrentMode =
  process.env.SECURE_SHARE_BENCHMARK_MODE === "legacy"
    ? describe.skip
    : describe;

function encrypted(cipherText: string) {
  return {
    version: 1,
    algorithm: "AES-GCM",
    cipherText,
    iv
  };
}

function participant(displayName = "guest1") {
  return {
    participantId: "participant_benchmark",
    guestNumber: 1,
    displayName,
    isSystemDefaultName: displayName === "guest1",
    canRename: true,
    renameCooldownEndsAt: displayName === "guest1"
      ? null
      : "2099-07-29T01:01:00.000Z",
    capabilities: {
      canRename: true,
      showsCommenterIpPrefix: true
    },
    currentIpPrefix: "203.226"
  };
}

function comments() {
  return Array.from({ length: 20 }, (_, index) => ({
    id: `comment_benchmark_${String(index).padStart(2, "0")}`,
    body: `벤치마크 댓글 ${index + 1}`,
    displayName: "guest1",
    badge: "guest",
    createdAt: "2026-07-29T00:00:00.000Z",
    canDelete: false,
    authorParticipantId: "participant_benchmark",
    ipPrefix: "203.226"
  }));
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }

  mocks.importKey.mockResolvedValue({ algorithm: { name: "AES-GCM" } });
  mocks.decryptText.mockImplementation(async (payload: { cipherText: string }) =>
    payload.cipherText === "dGl0bGU="
      ? "Profiler 제목"
      : "<p>Profiler 본문</p>"
  );
  mocks.getMetadata.mockResolvedValue({
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
      ownerPreview: false
    },
    requestId: "request_benchmark"
  });
  mocks.refreshSession.mockResolvedValue({
    ok: true,
    ownerPreview: false,
    sessionExpiresAt: "2099-07-30T01:00:00.000Z",
    capabilities: {
      permissionLevel: "comment",
      canComment: true,
      canSaveCopy: false,
      downloadAllowed: false,
      quickCopyButtonVisible: false,
      participantIdentityEnabled: true,
      participantLimitReached: false,
      commentIpPrefixEnabled: true
    },
    requestId: "request_benchmark"
  });
  mocks.getContent.mockResolvedValue({
    ok: true,
    schemaVersion: 2,
    encryptedTitle: encrypted("dGl0bGU="),
    encryptedBody: encrypted("Ym9keQ=="),
    attachments: [],
    requestId: "request_benchmark"
  });
  mocks.getParticipant.mockResolvedValue(participant());
  mocks.listComments.mockResolvedValue({
    ok: true,
    items: comments(),
    nextCursor: null,
    requestId: "request_benchmark"
  });
  mocks.renameParticipant.mockResolvedValue(participant("인기"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describeCurrentMode("SecurePublicShareViewer opt-in render profile", () => {
  it("profiles a participant rename with one full comment page", async () => {
    const commits: Array<{
      actualDurationMilliseconds: number;
      phase: "mount" | "nested-update" | "update";
    }> = [];
    const onRender: ProfilerOnRenderCallback = (
      _id,
      phase,
      actualDuration
    ) => {
      commits.push({
        actualDurationMilliseconds: actualDuration,
        phase
      });
    };

    render(
      <Profiler id="secure-share-viewer" onRender={onRender}>
        <SecurePublicShareViewer
          contentKey={contentKey}
          isAuthenticated={false}
          onRequireLogin={vi.fn()}
          shareId={shareId}
        />
      </Profiler>
    );

    expect(await screen.findByRole("heading", { name: "Profiler 제목" }))
      .toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText(/^벤치마크 댓글 \d+$/u)).toHaveLength(20);
    });
    await waitFor(() => {
      expect(mocks.getParticipant).toHaveBeenCalledTimes(1);
    });

    const initialCommits = commits.length;
    const decryptCallsBeforeRename = mocks.decryptText.mock.calls.length;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "이름 변경" }));
    const renameInput = screen.getByLabelText("표시 이름");
    await user.clear(renameInput);
    await user.type(renameInput, "인기");

    commits.length = 0;
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mocks.renameParticipant).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText("인기")).toHaveLength(21);
    });

    const renameCommits = commits.length;
    const renameActualDurationMilliseconds = commits.reduce(
      (total, commit) => total + commit.actualDurationMilliseconds,
      0
    );
    const decryptCallsAfterRename = mocks.decryptText.mock.calls.length;

    expect(decryptCallsAfterRename).toBe(decryptCallsBeforeRename);
    expect(mocks.getContent).toHaveBeenCalledTimes(1);
    expect(mocks.listComments).toHaveBeenCalledTimes(1);

    console.log(`SECURE_SHARE_REACT_PROFILE_JSON=${JSON.stringify({
      schemaVersion: 1,
      scenario: "rename-one-participant-with-20-visible-comments",
      initialCommits,
      renameCommits,
      renameActualDurationMilliseconds: Number(
        renameActualDurationMilliseconds.toFixed(2)
      ),
      visibleComments: 20,
      decryptCallsBeforeRename,
      decryptCallsAfterRename,
      contentFetches: mocks.getContent.mock.calls.length,
      commentPageFetches: mocks.listComments.mock.calls.length,
      note: "jsdom Profiler duration is diagnostic only; no latency threshold is asserted"
    })}`);
  });
});
