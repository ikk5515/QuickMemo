import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLibraryItem, decryptLibraryItems, DuplicateLibraryItemError, type LibraryItemSnapshot } from "./library";
import type { LibraryItemContent } from "../types";

const firestoreMocks = vi.hoisted(() => {
  const transaction = {
    get: vi.fn(),
    set: vi.fn()
  };

  return {
    collection: vi.fn(),
    db: { __type: "firestore" },
    doc: vi.fn((...parts: unknown[]) => ({ id: String(parts.at(-1)), parts })),
    getDoc: vi.fn(),
    limit: vi.fn(),
    onSnapshot: vi.fn(() => vi.fn()),
    orderBy: vi.fn(),
    query: vi.fn(),
    runTransaction: vi.fn(),
    serverTimestamp: vi.fn(() => ({ __type: "serverTimestamp" })),
    setDoc: vi.fn(),
    transaction,
    where: vi.fn()
  };
});

const cryptoMocks = vi.hoisted(() => ({
  generateNoteKey: vi.fn(),
  unwrapNoteKey: vi.fn(),
  wrapNoteKey: vi.fn()
}));

const contentMocks = vi.hoisted(() => {
  let generatedId = 0;

  return {
    decryptLibraryItemContent: vi.fn(),
    encryptLibraryItemContent: vi.fn(),
    libraryAttachmentFingerprint: vi.fn(),
    libraryUrlFingerprint: vi.fn(),
    nextLibraryId: vi.fn(() => {
      generatedId += 1;
      return `library-generated-${generatedId}`;
    }),
    normalizeLibraryItemContent: vi.fn((content: LibraryItemContent) => content),
    resetIds() {
      generatedId = 0;
    }
  };
});

vi.mock("../lib/firebase", () => ({ db: firestoreMocks.db }));
vi.mock("firebase/firestore", () => ({
  collection: firestoreMocks.collection,
  doc: firestoreMocks.doc,
  getDoc: firestoreMocks.getDoc,
  limit: firestoreMocks.limit,
  onSnapshot: firestoreMocks.onSnapshot,
  orderBy: firestoreMocks.orderBy,
  query: firestoreMocks.query,
  runTransaction: firestoreMocks.runTransaction,
  serverTimestamp: firestoreMocks.serverTimestamp,
  setDoc: firestoreMocks.setDoc,
  where: firestoreMocks.where
}));
vi.mock("../lib/crypto", () => ({
  generateNoteKey: cryptoMocks.generateNoteKey,
  unwrapNoteKey: cryptoMocks.unwrapNoteKey,
  wrapNoteKey: cryptoMocks.wrapNoteKey
}));
vi.mock("../lib/libraryContent", () => ({
  decryptLibraryItemContent: contentMocks.decryptLibraryItemContent,
  encryptLibraryItemContent: contentMocks.encryptLibraryItemContent,
  libraryAttachmentFingerprint: contentMocks.libraryAttachmentFingerprint,
  libraryUrlFingerprint: contentMocks.libraryUrlFingerprint,
  nextLibraryId: contentMocks.nextLibraryId,
  normalizeLibraryItemContent: contentMocks.normalizeLibraryItemContent
}));

const content: LibraryItemContent = {
  archivedAt: null,
  collection: "",
  description: "",
  highlights: [],
  ocrText: "",
  readerBlocks: [],
  selectionText: "",
  siteName: "example.com",
  sourceFileName: "",
  tags: [],
  title: "Example",
  url: "https://example.com/",
  version: 1
};

function createInput() {
  return {
    content,
    kind: "link" as const,
    privateKey: {} as CryptoKey,
    publicKeyJwk: { kty: "RSA" },
    uid: "user-a"
  };
}

describe("library create persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contentMocks.resetIds();
    cryptoMocks.generateNoteKey.mockResolvedValue({ __type: "aes-key" } as unknown as CryptoKey);
    cryptoMocks.unwrapNoteKey.mockResolvedValue({ __type: "vault-key" } as unknown as CryptoKey);
    cryptoMocks.wrapNoteKey.mockResolvedValue({
      algorithm: "RSA-OAEP",
      version: 1,
      wrappedKey: "wrapped-key"
    });
    contentMocks.encryptLibraryItemContent.mockResolvedValue({
      algorithm: "AES-GCM",
      cipherText: "cipher",
      iv: "iv",
      version: 1
    });
    contentMocks.libraryUrlFingerprint.mockResolvedValue("url-fingerprint");
    firestoreMocks.transaction.get.mockResolvedValue({ exists: () => false });
    firestoreMocks.runTransaction.mockImplementation(async (
      _db: unknown,
      updateFunction: (transaction: typeof firestoreMocks.transaction) => unknown
    ) => updateFunction(firestoreMocks.transaction));
    firestoreMocks.setDoc.mockResolvedValue(undefined);
  });

  it("uses the owner-bound transaction only for the vault and creates a new item without a missing read", async () => {
    await expect(createLibraryItem(createInput())).resolves.toMatchObject({
      id: "link-url-fingerprint",
      revision: 1
    });

    expect(firestoreMocks.transaction.get).toHaveBeenCalledOnce();
    expect(firestoreMocks.transaction.get).toHaveBeenCalledWith({
      id: "user-a",
      parts: [firestoreMocks.db, "libraryVaults", "user-a"]
    });
    expect(firestoreMocks.setDoc).toHaveBeenCalledWith(
      {
        id: "link-url-fingerprint",
        parts: [firestoreMocks.db, "libraryItems", "link-url-fingerprint"]
      },
      expect.objectContaining({ ownerUid: "user-a", revision: 1 })
    );
    expect(firestoreMocks.getDoc).not.toHaveBeenCalled();
  });


  it("shares one vault transaction and key initialization across 24 simultaneous captures", async () => {
    const input = createInput();
    await Promise.all(Array.from({ length: 24 }, () => createLibraryItem(input)));

    expect(firestoreMocks.runTransaction).toHaveBeenCalledOnce();
    expect(cryptoMocks.generateNoteKey).toHaveBeenCalledTimes(25);
    expect(cryptoMocks.wrapNoteKey).toHaveBeenCalledTimes(25);
    expect(firestoreMocks.setDoc).toHaveBeenCalledTimes(24);

    await createLibraryItem(input);
    expect(firestoreMocks.runTransaction).toHaveBeenCalledOnce();
  });

  it("retries vault initialization after a failed transaction", async () => {
    const input = createInput();
    firestoreMocks.runTransaction.mockRejectedValueOnce(new Error("unavailable"));

    await expect(createLibraryItem(input)).rejects.toThrow("unavailable");
    await expect(createLibraryItem(input)).resolves.toMatchObject({ revision: 1 });
    expect(firestoreMocks.runTransaction).toHaveBeenCalledTimes(2);
  });

  it("isolates cached vault initialization by both user and unlocked private key", async () => {
    const input = createInput();
    await Promise.all([
      createLibraryItem(input),
      createLibraryItem({ ...input, uid: "user-b" }),
      createLibraryItem({ ...input, privateKey: {} as CryptoKey })
    ]);

    expect(firestoreMocks.runTransaction).toHaveBeenCalledTimes(3);
  });

  it("stops a cancelled 120-item decrypt after the four already running items", async () => {
    const controller = new AbortController();
    const resolvers: ((key: CryptoKey) => void)[] = [];
    cryptoMocks.unwrapNoteKey.mockImplementation(() => new Promise<CryptoKey>((resolve) => {
      resolvers.push(resolve);
    }));
    contentMocks.decryptLibraryItemContent.mockResolvedValue(content);
    const items = Array.from({ length: 120 }, (_, index): LibraryItemSnapshot => ({
      id: `item-${index}`,
      ownerUid: "user-a",
      generationId: `generation-${index}`,
      kind: "link",
      status: "inbox",
      captureSource: "manual",
      isFavorite: false,
      urlFingerprint: `fingerprint-${index}`,
      sourceNoteId: null,
      sourceAttachmentId: null,
      revision: 1,
      lastMutationId: `mutation-${index}`,
      reviewCount: 0,
      wrappedKeys: { "user-a": { algorithm: "RSA-OAEP", version: 1, wrappedKey: "wrapped" } },
      encryptedContent: { algorithm: "AES-GCM", version: 1, iv: "iv", cipherText: "cipher" }
    }));
    const result = decryptLibraryItems(items, "user-a", {} as CryptoKey, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });

    expect(cryptoMocks.unwrapNoteKey).toHaveBeenCalledTimes(4);
    controller.abort();
    resolvers.forEach((resolve) => resolve({} as CryptoKey));
    await rejected;
    expect(cryptoMocks.unwrapNoteKey).toHaveBeenCalledTimes(4);
  });

  it("does no crypto work for a list that was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(decryptLibraryItems([], "user-a", {} as CryptoKey, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(cryptoMocks.unwrapNoteKey).not.toHaveBeenCalled();
  });

  it("maps an update-denied deterministic collision to a duplicate only after an owned read", async () => {
    const denied = { code: "permission-denied" };
    firestoreMocks.transaction.get.mockResolvedValue({
      data: () => ({ ownerUid: "user-a", wrappedKey: { wrappedKey: "existing" } }),
      exists: () => true
    });
    firestoreMocks.setDoc.mockRejectedValue(denied);
    firestoreMocks.getDoc.mockResolvedValue({
      data: () => ({ ownerUid: "user-a" }),
      exists: () => true,
      id: "link-url-fingerprint"
    });

    await expect(createLibraryItem(createInput())).rejects.toBeInstanceOf(DuplicateLibraryItemError);
    expect(firestoreMocks.getDoc).toHaveBeenCalledOnce();
  });

  it("fails closed when a denied item cannot be read as the current user's document", async () => {
    const denied = { code: "firestore/permission-denied" };
    firestoreMocks.setDoc.mockRejectedValue(denied);
    firestoreMocks.getDoc.mockRejectedValue({ code: "permission-denied" });

    await expect(createLibraryItem(createInput())).rejects.toBe(denied);
  });
});
