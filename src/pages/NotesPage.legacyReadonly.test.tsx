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
  markNoteRead: vi.fn(),
  purgeNote: vi.fn(),
  restoreRevisionedNote: vi.fn(),
  setNotePinned: vi.fn(),
  updateNoteFolder: vi.fn(),
  updateRevisionedEncryptedNote: vi.fn(),
  updateRevisionedNoteAccess: vi.fn()
}));

const clipboardWriteText = vi.hoisted(() => vi.fn(async () => undefined));
const subscribeNoteAttachments = vi.hoisted(() => vi.fn((
  _noteId: string,
  callback: (attachments: unknown[]) => void
) => {
  callback([]);
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
  clipboardWriteText.mockClear();
  Object.values(noteMutationMocks).forEach((mutation) => mutation.mockClear());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteText }
  });
});

describe("legacy NotesPage cutover", () => {
  it("mounts only the read-only reader when the Vault feature is enabled", async () => {
    firestoreState.queryDocuments = [legacyDocument()];

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
