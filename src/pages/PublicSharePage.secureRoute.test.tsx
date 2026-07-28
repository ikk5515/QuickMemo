import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PublicSharePage from "./PublicSharePage";

const mocks = vi.hoisted(() => ({
  auth: {
    firebaseUser: null,
    loading: false,
    privateKey: null,
    profile: null
  } as Record<string, unknown>,
  getSecureShareFeatureStatus: vi.fn(),
  secureViewerProps: null as null | Record<string, unknown>,
  saveSecureShareCopy: vi.fn(),
  subscribePublicNoteShare: vi.fn()
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => mocks.auth
}));

vi.mock("../components/SecurePublicShareViewer", () => ({
  SecurePublicShareViewer: (props: Record<string, unknown>) => {
    mocks.secureViewerProps = props;
    return (
      <section>
        <span>secure-viewer</span>
        <button onClick={() => (props.onRequireLogin as () => void)()} type="button">
          secure-login
        </button>
        <button
          onClick={() => {
            void (props.onSaveCopy as (payload: unknown) => Promise<void>)({
              attachments: [{
                id: "attachment_123456",
                fileName: "report.pdf",
                extension: "pdf",
                mimeType: "application/pdf",
                originalSize: 4
              }]
            }).catch(() => undefined);
          }}
          type="button"
        >
          secure-save-copy
        </button>
      </section>
    );
  }
}));

vi.mock("../lib/secureShareSaveCopy", () => ({
  SecureShareSaveCopyError: class SecureShareSaveCopyError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  saveSecureShareCopy: mocks.saveSecureShareCopy
}));

vi.mock("../services/publicShares", () => ({
  getEncryptedPublicShareAttachmentSource: vi.fn(),
  getPublicNoteShareAttachments: vi.fn(async () => []),
  publicShareActive: vi.fn(() => false),
  subscribePublicNoteShare: mocks.subscribePublicNoteShare
}));

vi.mock("../services/secureShares", () => ({
  getSecureShareFeatureStatus: mocks.getSecureShareFeatureStatus
}));

function LoginStateProbe() {
  const location = useLocation();
  return <pre>{JSON.stringify({ hash: location.hash, state: location.state })}</pre>;
}

function TestRoute({ entry }: { entry: string }) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/share/:shareId" element={<PublicSharePage />} />
        <Route path="/login" element={<LoginStateProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderRoute(entry: string) {
  return render(<TestRoute entry={entry} />);
}

describe("PublicSharePage Secure Share v2 route wrapper", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_SECURE_SHARE_V2_ENABLED", "true");
    mocks.auth = {
      firebaseUser: null,
      loading: false,
      privateKey: null,
      profile: null
    };
    mocks.getSecureShareFeatureStatus.mockReset();
    mocks.getSecureShareFeatureStatus.mockResolvedValue({
      emailEnabled: false,
      v2Enabled: true
    });
    mocks.secureViewerProps = null;
    mocks.saveSecureShareCopy.mockReset();
    mocks.subscribePublicNoteShare.mockReset();
    mocks.subscribePublicNoteShare.mockImplementation(
      (_shareId: string, callback: (share: null) => void) => {
        callback(null);
        return () => undefined;
      }
    );
  });

  it("routes only ss2 identifiers to the secure viewer and parses the key fragment", async () => {
    const contentKey = "A".repeat(43);
    renderRoute(`/share/ss2_secure_123456#key=${contentKey}`);

    expect(await screen.findByText("secure-viewer")).toBeInTheDocument();
    expect(mocks.secureViewerProps).toMatchObject({
      contentKey,
      isAuthenticated: false,
      shareId: "ss2_secure_123456"
    });
    expect(mocks.getSecureShareFeatureStatus).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(JSON.stringify(mocks.getSecureShareFeatureStatus.mock.calls)).not.toContain(contentKey);
    expect(mocks.subscribePublicNoteShare).not.toHaveBeenCalled();
  });

  it("fails closed with one generic state when either feature gate is unavailable", async () => {
    mocks.getSecureShareFeatureStatus.mockResolvedValue({
      emailEnabled: false,
      v2Enabled: false
    });
    renderRoute(`/share/ss2_secure_123456#key=${"E".repeat(43)}`);

    expect(await screen.findByRole("heading", { name: "보안 공유를 사용할 수 없습니다." }))
      .toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.getSecureShareFeatureStatus).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("secure-viewer")).not.toBeInTheDocument();
  });

  it("shows a neutral loading state while the server feature gate is pending", async () => {
    mocks.getSecureShareFeatureStatus.mockImplementation(
      () => new Promise(() => undefined)
    );
    renderRoute(`/share/ss2_secure_123456#key=${"G".repeat(43)}`);

    expect(await screen.findByRole("heading", { name: "보안 공유를 확인하는 중" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "보안 공유를 사용할 수 없습니다." }))
      .not.toBeInTheDocument();
    expect(screen.queryByText("secure-viewer")).not.toBeInTheDocument();
  });

  it("does not call the server gate when the client feature flag is disabled", async () => {
    vi.stubEnv("VITE_SECURE_SHARE_V2_ENABLED", "false");
    renderRoute(`/share/ss2_secure_123456#key=${"F".repeat(43)}`);

    expect(await screen.findByRole("heading", { name: "보안 공유를 사용할 수 없습니다." }))
      .toBeInTheDocument();
    expect(mocks.getSecureShareFeatureStatus).not.toHaveBeenCalled();
    expect(screen.queryByText("secure-viewer")).not.toBeInTheDocument();
  });

  it("passes login return data only through Router state and removes the fragment from /login", async () => {
    const contentKey = "B".repeat(43);
    renderRoute(`/share/ss2_secure_123456#key=${contentKey}`);
    fireEvent.click(await screen.findByRole("button", { name: "secure-login" }));

    await waitFor(() => {
      const state = JSON.parse(screen.getByText(/secure_share_v2/u).textContent ?? "{}");
      expect(state).toEqual({
        hash: "",
        state: {
          kind: "secure_share_v2",
          returnTo: "/share/ss2_secure_123456",
          shareFragment: `#key=${contentKey}`
        }
      });
    });
  });

  it("keeps a v1 identifier on the legacy subscription flow", async () => {
    renderRoute(`/share/legacy_share_123456#key=${"C".repeat(43)}`);

    expect(await screen.findByRole("heading", { name: "공유 노트를 열 수 없습니다" }))
      .toBeInTheDocument();
    expect(screen.queryByText("secure-viewer")).not.toBeInTheDocument();
    expect(mocks.getSecureShareFeatureStatus).not.toHaveBeenCalled();
  });

  it("shows route-level file progress and lets the user cancel through AbortController", async () => {
    const contentKey = "D".repeat(43);
    const profile = {
      uid: "owner_123456",
      isActive: true,
      isAdmin: false,
      featureAccess: { notes: true, library: false, schedule: false },
      publicKeyJwk: {}
    };
    mocks.auth = {
      firebaseUser: {
        uid: profile.uid,
        getIdToken: vi.fn(async () => "header.payload.signature")
      },
      loading: false,
      privateKey: {},
      profile
    };
    mocks.saveSecureShareCopy.mockImplementation(async (input: {
      onProgress: (progress: Record<string, unknown>) => void;
      signal: AbortSignal;
    }) => {
      input.onProgress({
        fileCount: 1,
        fileIndex: 1,
        fileName: "report.pdf",
        loadedBytes: 2,
        percent: 50,
        phase: "uploading",
        totalBytes: 4
      });
      await new Promise<void>((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true
        });
      });
    });

    renderRoute(`/share/ss2_secure_123456#key=${contentKey}`);
    fireEvent.click(await screen.findByRole("button", { name: "secure-save-copy" }));

    expect(await screen.findByText(/파일 1\/1 · report.pdf/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "복사본 저장 취소" }));

    expect(await screen.findByText("복사본 저장 중 오류가 발생했습니다.")).toBeInTheDocument();
    expect(mocks.saveSecureShareCopy).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function)
    }));
  });

  it("aborts an active copy and rejects its stale callback when the authenticated identity changes", async () => {
    const entry = `/share/ss2_secure_123456#key=${"I".repeat(43)}`;
    const firstProfile = {
      uid: "owner_first_123456",
      isActive: true,
      isAdmin: false,
      featureAccess: { notes: true, library: false, schedule: false },
      publicKeyJwk: {}
    };
    const nextProfile = {
      ...firstProfile,
      uid: "owner_next_123456",
      publicKeyJwk: { kty: "RSA" }
    };
    mocks.auth = {
      firebaseUser: {
        uid: firstProfile.uid,
        getIdToken: vi.fn(async () => "header.payload.first-signature")
      },
      loading: false,
      privateKey: { account: "first" },
      profile: firstProfile
    };
    const activeSignal = { current: null as AbortSignal | null };
    mocks.saveSecureShareCopy.mockImplementation(async (input: {
      signal: AbortSignal;
    }) => {
      activeSignal.current = input.signal;
      await new Promise<void>((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new DOMException("copy aborted", "AbortError")),
          { once: true }
        );
      });
    });

    const view = renderRoute(entry);
    fireEvent.click(await screen.findByRole("button", { name: "secure-save-copy" }));
    await waitFor(() => expect(mocks.saveSecureShareCopy).toHaveBeenCalledTimes(1));
    const staleSaveCopy = mocks.secureViewerProps?.onSaveCopy as
      | ((payload: unknown) => Promise<void>)
      | undefined;
    expect(staleSaveCopy).toBeTypeOf("function");
    if (!staleSaveCopy) {
      throw new Error("stale save-copy callback was not captured");
    }
    expect(activeSignal.current?.aborted).toBe(false);

    mocks.auth = {
      firebaseUser: {
        uid: nextProfile.uid,
        getIdToken: vi.fn(async () => "header.payload.next-signature")
      },
      loading: false,
      privateKey: { account: "next" },
      profile: nextProfile
    };
    view.rerender(<TestRoute entry={entry} />);

    await waitFor(() => expect(activeSignal.current?.aborted).toBe(true));
    await expect(staleSaveCopy({ attachments: [] })).rejects.toThrow(
      /로그인 상태가 변경/
    );
    expect(mocks.saveSecureShareCopy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("보안 공유의 독립 복사본을 QuickMemo에 저장했습니다."))
      .not.toBeInTheDocument();
  });
});
