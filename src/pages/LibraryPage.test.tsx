import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type PropsWithChildren } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryItemContent } from "../types";
import LibraryPage from "./LibraryPage";

const testData = vi.hoisted(() => {
  const profile = {
    allowedShareTargetUids: [],
    avatarText: "김",
    color: "#2f7d70",
    displayName: "김테스트",
    isActive: true,
    isAdmin: false,
    loginEmail: "tester@quickmemo.local",
    order: 1,
    publicKeyJwk: {},
    quickKey: 1,
    role: "user" as const,
    uid: "user-a"
  };

  return {
    auth: {
      firebaseUser: { uid: "user-a" },
      loading: false,
      privateKey: {} as CryptoKey | null,
      profile
    },
    libraryErrorSubscriber: null as null | ((error: Error) => void),
    librarySubscriber: null as null | ((items: unknown[]) => void),
    noteErrorSubscriber: null as null | ((error: Error) => void),
    noteSubscriber: null as null | ((notes: unknown[]) => void),
    sourceNoteSubscriber: null as null | ((note: unknown) => void),
    sourceNoteUnavailable: null as null | ((error?: Error) => void)
  };
});

const serviceMocks = vi.hoisted(() => ({
  createLibraryItem: vi.fn(),
  decryptLibraryItems: vi.fn(),
  deleteLibraryItem: vi.fn(),
  getEncryptedNoteAttachmentSource: vi.fn(),
  getNoteAttachments: vi.fn(),
  getVisibleNotesByIds: vi.fn(),
  markLibraryItemReviewed: vi.fn(),
  publishActiveNote: vi.fn(),
  subscribeLibraryItems: vi.fn(),
  subscribeUsers: vi.fn(),
  subscribeVisibleNoteById: vi.fn(),
  subscribeVisibleNotes: vi.fn(),
  touchLibraryItemOpened: vi.fn(),
  updateLibraryItem: vi.fn()
}));

const cryptoMocks = vi.hoisted(() => ({
  decryptText: vi.fn(),
  unwrapNoteKey: vi.fn()
}));

const attachmentCryptoMocks = vi.hoisted(() => ({
  decryptAttachmentToBlob: vi.fn(),
  decryptAttachmentToBytes: vi.fn()
}));

const attachmentExtractionMocks = vi.hoisted(() => ({
  extractLibraryAttachmentText: vi.fn()
}));

vi.mock("../components/AppShell", () => ({
  AppShell: ({ children }: PropsWithChildren) => <div data-testid="app-shell">{children}</div>
}));

vi.mock("../components/UnlockPanel", () => ({
  UnlockPanel: () => <div>잠금을 해제해주세요.</div>
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => testData.auth
}));

vi.mock("../services/library", () => ({
  createLibraryItem: serviceMocks.createLibraryItem,
  decryptLibraryItems: serviceMocks.decryptLibraryItems,
  deleteLibraryItem: serviceMocks.deleteLibraryItem,
  libraryInitialSubscriptionLimit: 120,
  libraryMaximumSubscriptionLimit: 1_200,
  librarySubscriptionStep: 120,
  LibraryItemRevisionConflictError: class LibraryItemRevisionConflictError extends Error {
    constructor() {
      super("자료가 다른 곳에서 변경되었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.");
    }
  },
  markLibraryItemReviewed: serviceMocks.markLibraryItemReviewed,
  subscribeLibraryItems: serviceMocks.subscribeLibraryItems,
  touchLibraryItemOpened: serviceMocks.touchLibraryItemOpened,
  updateLibraryItem: serviceMocks.updateLibraryItem
}));

vi.mock("../services/notes", () => ({
  getEncryptedNoteAttachmentSource: serviceMocks.getEncryptedNoteAttachmentSource,
  getNoteAttachments: serviceMocks.getNoteAttachments,
  getVisibleNotesByIds: serviceMocks.getVisibleNotesByIds,
  subscribeVisibleNoteById: serviceMocks.subscribeVisibleNoteById,
  subscribeVisibleNotes: serviceMocks.subscribeVisibleNotes
}));

vi.mock("../services/users", () => ({
  subscribeUsers: serviceMocks.subscribeUsers
}));

vi.mock("../services/activeNotes", () => ({
  publishActiveNote: serviceMocks.publishActiveNote
}));

vi.mock("../lib/crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/crypto")>();
  return {
    ...original,
    decryptText: cryptoMocks.decryptText,
    unwrapNoteKey: cryptoMocks.unwrapNoteKey
  };
});

vi.mock("../lib/attachmentCrypto", () => ({
  decryptAttachmentToBlob: attachmentCryptoMocks.decryptAttachmentToBlob,
  decryptAttachmentToBytes: attachmentCryptoMocks.decryptAttachmentToBytes
}));

vi.mock("../lib/libraryAttachmentExtraction", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/libraryAttachmentExtraction")>();
  return {
    ...original,
    extractLibraryAttachmentText: attachmentExtractionMocks.extractLibraryAttachmentText
  };
});

const timestamp = (millis: number) => ({ toMillis: () => millis });

function libraryContent(overrides: Partial<LibraryItemContent> = {}): LibraryItemContent {
  return {
    archivedAt: null,
    collection: "보안 자료",
    description: "운영 전에 확인할 메모",
    highlights: [],
    ocrText: "",
    readerBlocks: [{ id: "reader-block-a", kind: "paragraph", text: "암호화된 리더 본문입니다." }],
    selectionText: "핵심 문장",
    siteName: "example.com",
    sourceFileName: "",
    tags: ["보안", "리뷰"],
    title: "보안 가이드",
    url: "https://example.com/guide",
    version: 1,
    ...overrides
  };
}

function librarySnapshot(id = "library-a") {
  return {
    captureSource: "manual" as const,
    createdAt: timestamp(1_752_000_000_000),
    encryptedContent: { algorithm: "AES-GCM" as const, cipherText: "cipher", iv: "iv", version: 1 as const },
    generationId: "library-generation-a",
    id,
    isFavorite: false,
    kind: "link" as const,
    lastMutationId: "mutation-a",
    lastOpenedAt: null,
    lastReviewedAt: null,
    ownerUid: "user-a",
    reviewCount: 0,
    revision: 1,
    sourceAttachmentId: null,
    sourceNoteId: null,
    status: "inbox" as const,
    updatedAt: timestamp(1_753_000_000_000),
    urlFingerprint: "fingerprint",
    wrappedKeys: {
      "user-a": { algorithm: "RSA-OAEP" as const, version: 1 as const, wrappedKey: "wrapped" }
    }
  };
}

function managedAttachmentSnapshot(revision = 1, lastMutationId = "attachment-mutation-a") {
  return {
    ...librarySnapshot("managed-attachment-a"),
    captureSource: "attachment-ocr" as const,
    kind: "attachment" as const,
    lastMutationId,
    revision,
    sourceAttachmentId: "attachment-a",
    sourceNoteId: "note-a",
    urlFingerprint: null
  };
}

function noteSnapshot() {
  return {
    attachmentRevision: 1,
    createdBy: "user-a",
    encryptedBody: { algorithm: "AES-GCM" as const, cipherText: "body", iv: "iv", version: 1 as const },
    encryptedTitle: { algorithm: "AES-GCM" as const, cipherText: "title", iv: "iv", version: 1 as const },
    folderId: null,
    id: "note-a",
    isDeleted: false,
    ownerUid: "user-a",
    participantUids: ["user-a"],
    revision: 1,
    type: "personal" as const,
    updatedAt: timestamp(1_754_000_000_000),
    updatedBy: "user-a",
    wrappedKeys: {
      "user-a": { algorithm: "RSA-OAEP" as const, version: 1 as const, wrappedKey: "note-wrapped" }
    }
  };
}

function attachmentSnapshot() {
  return {
    algorithm: "AES-GCM" as const,
    createdAt: timestamp(1_754_100_000_000),
    extension: "pdf",
    fileName: "운영-체크리스트",
    id: "attachment-a",
    isReady: true,
    mimeType: "application/pdf",
    originalSize: 2048,
    uploadedBy: "user-a",
    version: 1 as const,
    noteId: "note-a"
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/library"]}>
      <LibraryPage />
    </MemoryRouter>
  );
}

function renderStrictPage() {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={["/library"]}>
        <LibraryPage />
      </MemoryRouter>
    </StrictMode>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, "chrome");
  window.history.replaceState(null, "", "/library");
  testData.auth.privateKey = {} as CryptoKey;
  testData.libraryErrorSubscriber = null;
  testData.librarySubscriber = null;
  testData.noteErrorSubscriber = null;
  testData.noteSubscriber = null;
  testData.sourceNoteSubscriber = null;
  testData.sourceNoteUnavailable = null;
  cryptoMocks.decryptText.mockResolvedValue("운영 노트");
  cryptoMocks.unwrapNoteKey.mockResolvedValue({} as CryptoKey);
  attachmentCryptoMocks.decryptAttachmentToBlob.mockResolvedValue(new Blob(["attachment"]));
  attachmentCryptoMocks.decryptAttachmentToBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
  attachmentExtractionMocks.extractLibraryAttachmentText.mockResolvedValue({
    confidence: null,
    likelyScanned: false,
    mode: "pdf-text",
    readerBlocks: [{ id: "pdf-page-1", kind: "paragraph", text: "PDF에서 추출한 본문" }],
    sourceTextCharacters: 14,
    storedTextCharacters: 14,
    truncated: false
  });
  serviceMocks.createLibraryItem.mockResolvedValue({ id: "created-a", revision: 1 });
  serviceMocks.deleteLibraryItem.mockResolvedValue(undefined);
  serviceMocks.getNoteAttachments.mockResolvedValue([attachmentSnapshot()]);
  serviceMocks.getVisibleNotesByIds.mockResolvedValue({ notes: [], resolvedNoteIds: [] });
  serviceMocks.markLibraryItemReviewed.mockImplementation(async (_id, _uid, revision: number) => ({
    lastMutationId: `mutation-reviewed-${revision + 1}`,
    revision: revision + 1
  }));
  serviceMocks.publishActiveNote.mockResolvedValue(undefined);
  serviceMocks.touchLibraryItemOpened.mockImplementation(async (_id, _uid, revision: number) => ({
    lastMutationId: `mutation-opened-${revision + 1}`,
    revision: revision + 1
  }));
  serviceMocks.updateLibraryItem.mockImplementation(async (item) => ({
    lastMutationId: `mutation-updated-${item.revision + 1}`,
    revision: item.revision + 1
  }));
  serviceMocks.subscribeLibraryItems.mockImplementation((_uid, callback, onError) => {
    testData.libraryErrorSubscriber = onError;
    testData.librarySubscriber = callback;
    callback([librarySnapshot()]);
    return vi.fn();
  });
  serviceMocks.subscribeUsers.mockImplementation((callback) => {
    callback([testData.auth.profile]);
    return vi.fn();
  });
  serviceMocks.subscribeVisibleNoteById.mockImplementation((_uid, _noteId, callback, onUnavailable) => {
    testData.sourceNoteSubscriber = callback;
    testData.sourceNoteUnavailable = onUnavailable;
    callback(noteSnapshot());
    return vi.fn();
  });
  serviceMocks.subscribeVisibleNotes.mockImplementation((_uid, _ownerUids, callback, onError) => {
    testData.noteErrorSubscriber = onError;
    testData.noteSubscriber = callback;
    callback([noteSnapshot()]);
    return vi.fn();
  });
  serviceMocks.decryptLibraryItems.mockImplementation(async (items) => ({
    failedItemIds: [],
    items: items.map((item: ReturnType<typeof librarySnapshot>) => ({
      ...item,
      content: libraryContent(),
      itemKey: {} as CryptoKey
    }))
  }));
});

describe("LibraryPage", () => {
  it("merges encrypted saved items with currently accessible note attachments and searches both", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("button", { name: "보안 가이드 열기" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "운영-체크리스트.pdf 열기" })).toBeInTheDocument();
    expect(serviceMocks.getNoteAttachments).toHaveBeenCalledWith("note-a");

    await user.type(screen.getByRole("searchbox", { name: "자료 검색" }), "체크리스트");

    expect(screen.queryByRole("button", { name: "보안 가이드 열기" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "운영-체크리스트.pdf 열기" })).toBeInTheDocument();
  });

  it("re-decrypts a deterministic document id after delete and recreate at the same revision", async () => {
    serviceMocks.decryptLibraryItems.mockImplementation(async (items) => ({
      failedItemIds: [],
      items: items.map((item: ReturnType<typeof librarySnapshot>) => ({
        ...item,
        content: libraryContent({
          title: item.generationId === "library-generation-a" ? "이전 세대 자료" : "새 세대 자료"
        }),
        itemKey: {} as CryptoKey
      }))
    }));
    renderPage();

    expect(await screen.findByRole("button", { name: "이전 세대 자료 열기" })).toBeInTheDocument();

    act(() => testData.librarySubscriber?.([{
      ...librarySnapshot(),
      generationId: "library-generation-b",
      lastMutationId: "mutation-recreated",
      revision: 1
    }]));

    expect(await screen.findByRole("button", { name: "새 세대 자료 열기" })).toBeInTheDocument();
    expect(serviceMocks.decryptLibraryItems).toHaveBeenCalledTimes(2);
  });

  it("bounds the live library window and expands it only after an explicit request", async () => {
    const user = userEvent.setup();
    serviceMocks.subscribeLibraryItems.mockImplementation((_uid, callback, onError, maximumItems) => {
      testData.libraryErrorSubscriber = onError;
      testData.librarySubscriber = callback;
      callback(Array.from({ length: Math.min(120, maximumItems) }, (_, index) => ({
        ...librarySnapshot(`library-${index}`),
        generationId: `library-generation-${index}`
      })));
      return vi.fn();
    });
    renderPage();

    const loadMore = await screen.findByRole("button", { name: "저장한 자료 120개 더 불러오기" });
    expect(serviceMocks.subscribeLibraryItems).toHaveBeenLastCalledWith(
      "user-a",
      expect.any(Function),
      expect.any(Function),
      120
    );

    await user.click(loadMore);

    await waitFor(() => expect(serviceMocks.subscribeLibraryItems).toHaveBeenLastCalledWith(
      "user-a",
      expect.any(Function),
      expect.any(Function),
      240
    ));
  });

  it("stores capture fields only through the encrypted library service", async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("button", { name: "보안 가이드 열기" });
    await user.click(screen.getByRole("button", { name: "자료 저장" }));

    const dialog = screen.getByRole("dialog", { name: "링크나 클립 저장" });
    await user.click(within(dialog).getByRole("radio", { name: "클립" }));
    await user.type(within(dialog).getByLabelText("제목"), "장애 대응 메모");
    await user.type(within(dialog).getByLabelText("컬렉션"), "운영");
    await user.type(within(dialog).getByLabelText("태그"), "장애, 긴급");
    await user.type(within(dialog).getByLabelText(/\uBA54\uBAA8$/), "장애 시 확인");
    await user.type(within(dialog).getByLabelText(/\uB9AC\uB354 \uBCF8\uBB38/), "첫 번째 단락\n\n두 번째 단락");
    await user.click(within(dialog).getByRole("button", { name: "자료 저장" }));

    await waitFor(() => expect(serviceMocks.createLibraryItem).toHaveBeenCalledTimes(1));
    expect(serviceMocks.createLibraryItem).toHaveBeenCalledWith(expect.objectContaining({
      captureSource: "manual",
      content: expect.objectContaining({
        collection: "운영",
        description: "장애 시 확인",
        readerBlocks: [
          expect.objectContaining({ text: "첫 번째 단락" }),
          expect.objectContaining({ text: "두 번째 단락" })
        ],
        tags: ["장애", "긴급"],
        title: "장애 대응 메모"
      }),
      kind: "clip",
      uid: "user-a"
    }));
    expect(screen.queryByRole("dialog", { name: "링크나 클립 저장" })).not.toBeInTheDocument();
  });

  it("splits a long single paragraph without silently truncating the encrypted reader body", async () => {
    const user = userEvent.setup();
    const longParagraph = `${"가".repeat(4_999)}😀끝`;
    renderPage();

    await screen.findByRole("button", { name: "보안 가이드 열기" });
    await user.click(screen.getByRole("button", { name: "자료 저장" }));
    const dialog = screen.getByRole("dialog", { name: "링크나 클립 저장" });
    await user.click(within(dialog).getByRole("radio", { name: "클립" }));
    fireEvent.change(within(dialog).getByLabelText("제목"), { target: { value: "긴 본문" } });
    fireEvent.change(within(dialog).getByLabelText(/리더 본문/), { target: { value: longParagraph } });
    await user.click(within(dialog).getByRole("button", { name: "자료 저장" }));

    await waitFor(() => expect(serviceMocks.createLibraryItem).toHaveBeenCalledTimes(1));
    const input = serviceMocks.createLibraryItem.mock.calls[0]?.[0];
    expect(input.content.readerBlocks).toHaveLength(2);
    expect(input.content.readerBlocks.map((block: { text: string }) => block.text).join("")).toBe(longParagraph);
    expect(input.content.readerBlocks[0].text.endsWith("\ud83d")).toBe(false);
    expect(input.content.readerBlocks[1].text.startsWith("\ude00")).toBe(false);
  });

  it("consumes a Chrome nonce once in StrictMode, clears the hash, and preserves structured blocks for review", async () => {
    const user = userEvent.setup();
    const nonce = "A".repeat(43);
    const extensionId = "a".repeat(32);
    const sendMessage = vi.fn((_extensionId: string, _message: unknown, callback: (response: unknown) => void) => {
      callback({
        ok: true,
        payload: {
          version: 1,
          source: "extension",
          title: "Chrome에서 캡처한 자료",
          url: "https://example.com/read",
          selectionText: "선택한 핵심 문장",
          blocks: [
            { kind: "heading", text: "주요 제목" },
            { kind: "quote", text: "인용한 문장" }
          ]
        }
      });
    });
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { runtime: { sendMessage } }
    });
    window.history.replaceState(null, "", `/library#capture=${nonce}&extension=${extensionId}`);

    renderStrictPage();

    const dialog = await screen.findByRole("dialog", { name: "링크나 클립 저장" });
    expect(window.location.hash).toBe("");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByLabelText("제목")).toHaveValue("Chrome에서 캡처한 자료");
    expect(within(dialog).getByLabelText(/리더 본문/)).toHaveValue("주요 제목\n\n인용한 문장");
    expect(within(dialog).getByText(/Chrome 확장 프로그램에서 가져왔습니다/)).toBeInTheDocument();
    expect(serviceMocks.createLibraryItem).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "자료 저장" }));
    await waitFor(() => expect(serviceMocks.createLibraryItem).toHaveBeenCalledTimes(1));
    expect(serviceMocks.createLibraryItem).toHaveBeenCalledWith(expect.objectContaining({
      captureSource: "browser-extension",
      content: expect.objectContaining({
        readerBlocks: [
          expect.objectContaining({ kind: "heading", text: "주요 제목" }),
          expect.objectContaining({ kind: "quote", text: "인용한 문장" })
        ],
        selectionText: "선택한 핵심 문장"
      })
    }));
  });

  it("imports Safari bookmarklet JSON into the review dialog without auto-saving", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "자료 저장" }));

    const dialog = screen.getByRole("dialog", { name: "링크나 클립 저장" });
    await user.click(within(dialog).getByText("Safari 또는 북마클릿에서 가져오기"));
    expect(within(dialog).getByRole("link", { name: "Chrome용 캡처 확장 프로그램 받기 (ZIP)" })).toHaveAttribute(
      "href",
      "/quickmemo-capture-extension.zip"
    );
    expect(within(dialog).getByRole("link", { name: "Chrome용 캡처 확장 프로그램 받기 (ZIP)" })).toHaveAttribute("download");
    const captureJson = JSON.stringify({
      version: 1,
      source: "bookmarklet",
      title: "Safari 캡처",
      url: "https://example.com/safari",
      blocks: [{ kind: "list-item", text: "확인할 항목" }]
    });
    fireEvent.change(within(dialog).getByLabelText("캡처 데이터"), { target: { value: captureJson } });
    await user.click(within(dialog).getByRole("button", { name: "내용 가져오기" }));

    expect(within(dialog).getByLabelText("제목")).toHaveValue("Safari 캡처");
    expect(within(dialog).getByLabelText("URL")).toHaveValue("https://example.com/safari");
    expect(within(dialog).getByText(/북마클릿에서 가져왔습니다/)).toBeInTheDocument();
    expect(serviceMocks.createLibraryItem).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "자료 저장" }));
    await waitFor(() => expect(serviceMocks.createLibraryItem).toHaveBeenCalledTimes(1));
    expect(serviceMocks.createLibraryItem).toHaveBeenCalledWith(expect.objectContaining({
      captureSource: "bookmarklet",
      content: expect.objectContaining({
        readerBlocks: [expect.objectContaining({ kind: "list-item", text: "확인할 항목" })]
      })
    }));
  });

  it("extracts an owned PDF locally and stores only the encrypted attachment library item", async () => {
    const user = userEvent.setup();
    serviceMocks.getEncryptedNoteAttachmentSource.mockResolvedValue(new Uint8Array([9, 8, 7]));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "운영-체크리스트.pdf 열기" }));
    expect(screen.getByText("파일은 이 기기에서만 처리됩니다.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "PDF 텍스트 추출" }));

    await waitFor(() => expect(attachmentExtractionMocks.extractLibraryAttachmentText).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ extension: "pdf", mimeType: "application/pdf", signal: expect.any(AbortSignal) })
    ));
    await waitFor(() => expect(serviceMocks.createLibraryItem).toHaveBeenCalledWith(expect.objectContaining({
      captureSource: "attachment-ocr",
      content: expect.objectContaining({
        highlights: [],
        readerBlocks: [{ id: "pdf-page-1", kind: "paragraph", text: "PDF에서 추출한 본문" }],
        sourceFileName: "운영-체크리스트.pdf",
        title: "운영-체크리스트.pdf"
      }),
      kind: "attachment",
      sourceAttachmentId: "attachment-a",
      sourceNoteId: "note-a",
      uid: "user-a"
    })));
  });

  it("does not offer a persistent OCR copy to a shared-note participant", async () => {
    const user = userEvent.setup();
    serviceMocks.subscribeVisibleNotes.mockImplementation((_uid, _ownerUids, callback, onError) => {
      testData.noteErrorSubscriber = onError;
      testData.noteSubscriber = callback;
      callback([{
        ...noteSnapshot(),
        ownerUid: "owner-b",
        participantUids: ["owner-b", "user-a"],
        type: "shared"
      }]);
      return vi.fn();
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "운영-체크리스트.pdf 열기" }));

    expect(screen.queryByRole("button", { name: "PDF 텍스트 추출" })).not.toBeInTheDocument();
    expect(screen.getByText("원본 노트 소유자만 텍스트를 저장할 수 있습니다.")).toBeInTheDocument();
    expect(serviceMocks.createLibraryItem).not.toHaveBeenCalled();
  });

  it("aborts in-flight extraction when source-note access disappears", async () => {
    const user = userEvent.setup();
    let extractionSignal: AbortSignal | undefined;
    attachmentExtractionMocks.extractLibraryAttachmentText.mockImplementation((_bytes, options) => {
      extractionSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    serviceMocks.getEncryptedNoteAttachmentSource.mockResolvedValue(new Uint8Array([9, 8, 7]));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "운영-체크리스트.pdf 열기" }));
    await user.click(screen.getByRole("button", { name: "PDF 텍스트 추출" }));
    await waitFor(() => expect(extractionSignal).toBeDefined());

    act(() => testData.noteErrorSubscriber?.(new Error("permission-denied")));

    await waitFor(() => expect(extractionSignal?.aborted).toBe(true));
    expect(serviceMocks.createLibraryItem).not.toHaveBeenCalled();
  });

  it("aborts managed attachment extraction when another tab changes its revision", async () => {
    const user = userEvent.setup();
    let extractionSignal: AbortSignal | undefined;
    attachmentExtractionMocks.extractLibraryAttachmentText.mockImplementation((_bytes, options) => {
      extractionSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    serviceMocks.getEncryptedNoteAttachmentSource.mockResolvedValue(new Uint8Array([9, 8, 7]));
    serviceMocks.subscribeLibraryItems.mockImplementation((_uid, callback, onError) => {
      testData.libraryErrorSubscriber = onError;
      testData.librarySubscriber = callback;
      callback([managedAttachmentSnapshot()]);
      return vi.fn();
    });
    serviceMocks.decryptLibraryItems.mockImplementation(async (items) => ({
      failedItemIds: [],
      items: items.map((item: ReturnType<typeof managedAttachmentSnapshot>) => ({
        ...item,
        content: libraryContent({ readerBlocks: [], sourceFileName: "운영-체크리스트.pdf", title: "운영-체크리스트.pdf", url: "" }),
        itemKey: {} as CryptoKey
      }))
    }));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "운영-체크리스트.pdf 열기" }));
    await user.click(screen.getByRole("button", { name: "PDF 텍스트 추출" }));
    await waitFor(() => expect(extractionSignal).toBeDefined());

    act(() => testData.librarySubscriber?.([managedAttachmentSnapshot(2, "attachment-mutation-b")]));

    await waitFor(() => expect(extractionSignal?.aborted).toBe(true));
    expect(await screen.findByRole("alert")).toHaveTextContent("다른 곳에서 변경되어 텍스트 추출을 중단했습니다");
    expect(serviceMocks.updateLibraryItem).not.toHaveBeenCalled();
  });

  it("clears a Chrome handoff and shows an accessible alert when the extension is unavailable", async () => {
    const nonce = "B".repeat(43);
    const extensionId = "b".repeat(32);
    window.history.replaceState(null, "", `/library#capture=${nonce}&extension=${extensionId}`);

    renderPage();

    const dialog = await screen.findByRole("dialog", { name: "링크나 클립 저장" });
    expect(window.location.hash).toBe("");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Chrome 확장 프로그램에 연결할 수 없습니다");
    expect(serviceMocks.createLibraryItem).not.toHaveBeenCalled();
  });

  it("supports favorite, review completion, and the styled delete confirmation", async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("button", { name: "보안 가이드 열기" });
    await user.click(screen.getByRole("button", { name: "보안 가이드 즐겨찾기" }));
    await waitFor(() => expect(serviceMocks.updateLibraryItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "library-a" }),
      "user-a",
      { isFavorite: true }
    ));

    await user.click(screen.getByRole("button", { name: /\uC624\uB298\uC758 \uB9AC\uBDF0/ }));
    await user.click(screen.getByRole("button", { name: "보안 가이드 검토 완료" }));
    await waitFor(() => expect(serviceMocks.markLibraryItemReviewed).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /\uC804\uCCB4 \uC790\uB8CC/ }));
    await user.click(screen.getByRole("button", { name: "보안 가이드 삭제" }));
    const confirmation = screen.getByRole("alertdialog", { name: "이 자료를 삭제할까요?" });
    expect(within(confirmation).getByRole("button", { name: "취소" })).toHaveFocus();
    await user.click(within(confirmation).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(serviceMocks.deleteLibraryItem).toHaveBeenCalledWith(
      "library-a",
      "user-a",
      3,
      "mutation-reviewed-3",
      "library-generation-a"
    ));
  });

  it("deletes only the generation shown when the confirmation dialog opened", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "보안 가이드 삭제" }));
    const confirmation = screen.getByRole("alertdialog", { name: "이 자료를 삭제할까요?" });

    act(() => testData.librarySubscriber?.([{
      ...librarySnapshot(),
      generationId: "library-generation-b",
      lastMutationId: "mutation-recreated",
      revision: 1
    }]));
    await user.click(within(confirmation).getByRole("button", { name: "삭제" }));

    await waitFor(() => expect(serviceMocks.deleteLibraryItem).toHaveBeenCalledWith(
      "library-a",
      "user-a",
      1,
      "mutation-a",
      "library-generation-a"
    ));
  });

  it("does not announce mutation success when the encrypted update fails", async () => {
    const user = userEvent.setup();
    serviceMocks.updateLibraryItem.mockRejectedValueOnce(new Error("암호화 자료를 변경하지 못했습니다."));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "보안 가이드 즐겨찾기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("암호화 자료를 변경하지 못했습니다.");
    expect(screen.getByRole("status")).not.toHaveTextContent("즐겨찾기에 추가했습니다.");
  });

  it("immediately removes a selected attachment when its source note permission disappears", async () => {
    const user = userEvent.setup();
    renderPage();

    const attachmentButton = await screen.findByRole("button", { name: "운영-체크리스트.pdf 열기" });
    await user.click(attachmentButton);
    expect(screen.getByRole("heading", { name: "운영-체크리스트.pdf" })).toBeInTheDocument();

    act(() => testData.noteErrorSubscriber?.(new Error("permission-denied")));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "운영-체크리스트.pdf" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "운영-체크리스트.pdf 열기" })).not.toBeInTheDocument();
    });
  });

  it("live-validates an older managed source and closes its actions when that source disappears", async () => {
    const user = userEvent.setup();
    serviceMocks.subscribeLibraryItems.mockImplementation((_uid, callback, onError) => {
      testData.libraryErrorSubscriber = onError;
      testData.librarySubscriber = callback;
      callback([managedAttachmentSnapshot()]);
      return vi.fn();
    });
    serviceMocks.subscribeVisibleNotes.mockImplementation((_uid, _ownerUids, callback, onError) => {
      testData.noteErrorSubscriber = onError;
      testData.noteSubscriber = callback;
      callback([]);
      return vi.fn();
    });
    serviceMocks.getVisibleNotesByIds.mockResolvedValue({ notes: [noteSnapshot()], resolvedNoteIds: ["note-a"] });
    serviceMocks.decryptLibraryItems.mockImplementation(async (items) => ({
      failedItemIds: [],
      items: items.map((item: ReturnType<typeof managedAttachmentSnapshot>) => ({
        ...item,
        content: libraryContent({ sourceFileName: "운영-체크리스트.pdf", title: "운영-체크리스트.pdf", url: "" }),
        itemKey: {} as CryptoKey
      }))
    }));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "운영-체크리스트.pdf 열기" }));
    await waitFor(() => expect(serviceMocks.subscribeVisibleNoteById).toHaveBeenCalledWith(
      "user-a",
      "note-a",
      expect.any(Function),
      expect.any(Function)
    ));
    expect(screen.getByRole("button", { name: "다운로드" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "원본 노트" })).toBeInTheDocument();

    act(() => testData.sourceNoteUnavailable?.(new Error("permission-denied")));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "다운로드" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "원본 노트" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("status")).toHaveTextContent("원본 연결을 닫았습니다");
  });

  it("shows the existing unlock experience instead of loading encrypted content without a private key", () => {
    testData.auth.privateKey = null;
    renderPage();

    expect(screen.getByText("잠금을 해제해주세요.")).toBeInTheDocument();
    expect(serviceMocks.subscribeLibraryItems).not.toHaveBeenCalled();
    expect(serviceMocks.subscribeVisibleNotes).not.toHaveBeenCalled();
  });
});
