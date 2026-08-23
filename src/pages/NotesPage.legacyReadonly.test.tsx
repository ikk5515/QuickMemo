import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../types";
import NotesPage, { resolveLegacyNotesAccessMode } from "./NotesPage";

const firestoreState = vi.hoisted(() => ({
  markerMode: "present" as "cache-missing" | "missing" | "present",
  markerNext: null as null | ((snapshot: unknown) => void),
  queryDocuments: [] as Array<{ data: () => unknown; id: string }>
}));

const noteMutationMocks = vi.hoisted(() => ({
  confirmNoteRead: vi.fn(),
  createNoteAttachment: vi.fn(),
  createNoteFolder: vi.fn(),
  createRevisionedEncryptedNote: vi.fn(),
  deleteNoteAttachment: vi.fn(),
  deleteNoteFolder: vi.fn(),
  deleteRevisionedNote: vi.fn(),
  getEncryptedNoteAttachmentSource: vi.fn(async () => new Uint8Array([1, 2, 3])),
  markNoteRead: vi.fn(),
  purgeNote: vi.fn(),
  restoreRevisionedNote: vi.fn(),
  setNotePinned: vi.fn(),
  updateNoteFolder: vi.fn(),
  updateRevisionedEncryptedNote: vi.fn(),
  updateRevisionedNoteAccess: vi.fn()
}));

const clipboardWriteText = vi.hoisted(() => vi.fn(async () => undefined));
const downloadBlobMock = vi.hoisted(() => vi.fn());
const attachmentState = vi.hoisted(() => ({ items: [] as unknown[] }));
const decryptAttachmentToBlobMock = vi.hoisted(() => vi.fn());
const subscribeNoteAttachments = vi.hoisted(() => vi.fn((
  _noteId: string,
  callback: (attachments: unknown[]) => void
) => {
  callback(attachmentState.items);
  return vi.fn();
}));

const authState = vi.hoisted(() => ({
  privateKey: {} as CryptoKey,
  profile: {
    avatarText: "테",
    color: "#2f7d70",
    displayName: "테스트",
    isActive: true,
    isAdmin: false,
    loginEmail: "test@example.com",
    order: 1,
    publicKeyJwk: {},
    quickKey: 1,
    role: "user",
    uid: "user-a"
  } as UserProfile
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    firebaseUser: { uid: "user-a" },
    privateKey: authState.privateKey,
    profile: authState.profile
  })
}));

vi.mock("../components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>
}));

vi.mock("../components/UnlockPanel", () => ({
  UnlockPanel: () => <div>잠금 해제</div>
}));

vi.mock("../features/vault/browserDownload", () => ({
  downloadBlob: downloadBlobMock
}));

vi.mock("../lib/attachmentCrypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/attachmentCrypto")>();
  return {
    ...actual,
    decryptAttachmentToBlob: decryptAttachmentToBlobMock
  };
});

vi.mock("../lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crypto")>();
  return {
    ...actual,
    decryptText: vi.fn(async (payload: { plaintext?: string }) => payload.plaintext ?? ""),
    unwrapNoteKey: vi.fn(async () => ({} as CryptoKey))
  };
});

vi.mock("../services/notes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/notes")>();
  return { ...actual, ...noteMutationMocks, subscribeNoteAttachments };
});

vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...actual,
    onSnapshot: vi.fn((target: { path?: string }, ...args: unknown[]) => {
      const next = (typeof args[0] === "function" ? args[0] : args[1]) as (snapshot: unknown) => void;
      const isIntegrityDocument = target.path === "vaultIntegrity/user-a";

      if (isIntegrityDocument) {
        firestoreState.markerNext = next;
        if (firestoreState.markerMode === "present") {
          next({ exists: () => true, metadata: { fromCache: false } });
        } else if (firestoreState.markerMode === "missing") {
          next({ exists: () => false, metadata: { fromCache: false } });
        } else {
          next({ exists: () => false, metadata: { fromCache: true } });
        }
      } else if (typeof target.path === "string") {
        next({
          data: () => undefined,
          exists: () => false,
          metadata: { fromCache: false }
        });
      } else {
        next({
          docs: firestoreState.queryDocuments,
          empty: firestoreState.queryDocuments.length === 0,
          metadata: { fromCache: false },
          size: firestoreState.queryDocuments.length
        });
      }

      return vi.fn();
    })
  };
});

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}{location.search}</span>;
}

function legacyDocument() {
  return {
    data: () => ({
      contentFormat: "legacy-html-v1",
      encryptedBody: { plaintext: "<!--qm-font-size:18--><h2>안전한 제목</h2><p>보존할 본문</p>" },
      encryptedTitle: { plaintext: "기존 회의록" },
      entryKind: "legacy-html",
      isDeleted: false,
      ownerUid: "user-a",
      participantUids: ["user-a"],
      revision: 3,
      type: "personal",
      updatedBy: "user-a",
      wrappedKeys: { "user-a": { algorithm: "RSA-OAEP", version: 1, wrappedKey: "wrapped" } }
    }),
    id: "legacy-note-a"
  };
}

function expectNoLegacyMutationControls() {
  [
    /새 노트/u,
    /^저장$/u,
    /삭제/u,
    /복구/u,
    /공유하기/u,
    /첨부/u,
    /폴더 만들기/u,
    /즐겨찾기/u
  ].forEach((name) => expect(screen.queryByRole("button", { name })).not.toBeInTheDocument());
}

beforeEach(() => {
  firestoreState.markerMode = "present";
  firestoreState.markerNext = null;
  firestoreState.queryDocuments = [];
  attachmentState.items = [];
  clipboardWriteText.mockClear();
  decryptAttachmentToBlobMock.mockReset();
  downloadBlobMock.mockReset();
  Object.values(noteMutationMocks).forEach((mutation) => mutation.mockClear());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteText }
  });
});

describe("legacy NotesPage cutover", () => {
  it("keeps an owned historical legacy note visible when deletion metadata is absent", async () => {
    const existingDocument = legacyDocument();
    firestoreState.queryDocuments = [{
      ...existingDocument,
      data: () => {
        const historicalData = existingDocument.data() as Record<string, unknown>;
        Reflect.deleteProperty(historicalData, "isDeleted");
        return historicalData;
      }
    }];

    render(
      <MemoryRouter initialEntries={["/app/legacy"]}>
        <Routes>
          <Route path="/app/legacy" element={<NotesPage legacyReadOnly />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "기존 회의록" })).toBeInTheDocument();
    expect(screen.getByText("보존할 본문")).toBeInTheDocument();
  });

  it("mounts only the read-only reader when the Vault feature is enabled", async () => {
    firestoreState.queryDocuments = [legacyDocument()];
    const attachmentBlob = new Blob(["보존 첨부"], { type: "text/plain" });
    attachmentState.items = [{
      algorithm: "AES-GCM",
      extension: "txt",
      fileName: "보존자료",
      id: "legacy-attachment-a",
      mimeType: "text/plain",
      noteId: "legacy-note-a",
      originalSize: 13,
      uploadedBy: "user-a",
      version: 1
    }];
    decryptAttachmentToBlobMock.mockResolvedValue(attachmentBlob);

    render(
      <MemoryRouter initialEntries={["/app/legacy"]}>
        <Routes>
          <Route path="/app/legacy" element={<NotesPage legacyReadOnly />} />
          <Route path="/app" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "기존 노트 보관함" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "기존 회의록" })).toBeInTheDocument();
    expect(screen.getByText("보존할 본문")).toBeInTheDocument();
    expectNoLegacyMutationControls();

    fireEvent.keyDown(window, { ctrlKey: true, key: "s" });
    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.contextMenu(screen.getByRole("button", { name: /기존 회의록/u }));
    Object.values(noteMutationMocks).forEach((mutation) => expect(mutation).not.toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Markdown 미리보기 복사" }));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith("## 안전한 제목\n\n보존할 본문"));

    fireEvent.click(screen.getByRole("button", { name: "원본 HTML 텍스트 내보내기" }));
    expect(downloadBlobMock).toHaveBeenCalledWith(expect.any(Blob), "기존 회의록.html.txt");
    expect((downloadBlobMock.mock.calls[0][0] as Blob).type).toBe("text/plain;charset=utf-8");

    fireEvent.click(await screen.findByRole("button", { name: /보존자료\.txt.*다운로드/u }));
    await waitFor(() => expect(downloadBlobMock).toHaveBeenLastCalledWith(attachmentBlob, "보존자료.txt"));

    fireEvent.click(screen.getByRole("button", { name: "Vault에서 Markdown 복사본 만들기" }));
    expect(await screen.findByTestId("location")).toHaveTextContent("/app?entry=legacy-note-a");
  });

  it("keeps legacy mutations locked when a server-side Vault integrity marker exists", async () => {
    firestoreState.markerMode = "present";

    render(
      <MemoryRouter initialEntries={["/app"]}>
        <NotesPage legacyReadOnly={false} />
      </MemoryRouter>
    );

    expect(await screen.findByText(/Vault 이름 무결성 보호가 이미 적용/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vault에서 Markdown 복사본 만들기" })).not.toBeInTheDocument();
    expectNoLegacyMutationControls();
    Object.values(noteMutationMocks).forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  });

  it("does not mount the writable editor for an offline cache miss and preserves flag-off behavior only after a server-confirmed missing marker", () => {
    firestoreState.markerMode = "cache-missing";

    render(
      <MemoryRouter initialEntries={["/app"]}>
        <NotesPage legacyReadOnly={false} />
      </MemoryRouter>
    );

    expect(screen.getByRole("status")).toHaveTextContent("Vault 무결성 상태를 확인하는 중");
    expectNoLegacyMutationControls();

    expect(resolveLegacyNotesAccessMode(false, "user-a", null)).toBe("checking");
    expect(resolveLegacyNotesAccessMode(false, "user-a", { status: "missing", uid: "user-a" })).toBe("writable");
    expect(resolveLegacyNotesAccessMode(false, "user-a", { status: "present", uid: "user-a" })).toBe("read-only");
    expect(resolveLegacyNotesAccessMode(false, "user-a", { status: "error", uid: "user-a" })).toBe("read-only");
    expect(resolveLegacyNotesAccessMode(true, "user-a", { status: "missing", uid: "user-a" })).toBe("read-only");
  });
});
