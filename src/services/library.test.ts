import { describe, expect, it } from "vitest";
import { generateNoteKey, generateUserKeyBundle, unlockPrivateKey, wrapNoteKey } from "../lib/crypto";
import { emptyLibraryItemContent, encryptLibraryItemContent } from "../lib/libraryContent";
import {
  decryptLibraryItem,
  decryptLibraryItems,
  libraryMutationPreconditionMatches,
  type LibraryItemSnapshot
} from "./library";

async function encryptedItem(ownerUid = "user-a") {
  const password = "correct horse battery staple";
  const bundle = await generateUserKeyBundle(password);
  const privateKey = await unlockPrivateKey({ uid: ownerUid, ...bundle }, password);
  const itemKey = await generateNoteKey();
  const content = {
    ...emptyLibraryItemContent(),
    title: "개인 자료",
    url: "https://example.com/private"
  };
  const item: LibraryItemSnapshot = {
    id: "library-item-1",
    ownerUid,
    generationId: "library-generation-1",
    kind: "link",
    status: "inbox",
    captureSource: "manual",
    isFavorite: false,
    encryptedContent: await encryptLibraryItemContent(content, itemKey),
    wrappedKeys: { [ownerUid]: await wrapNoteKey(itemKey, bundle.publicKeyJwk) },
    urlFingerprint: "opaque-fingerprint",
    sourceNoteId: null,
    sourceAttachmentId: null,
    revision: 1,
    lastMutationId: "mutation-1",
    reviewCount: 0,
    lastOpenedAt: null,
    lastReviewedAt: null
  };

  return { content, item, privateKey };
}

describe("library service decryption boundary", () => {
  it("decrypts an item only for its owner", async () => {
    const { content, item, privateKey } = await encryptedItem();

    await expect(decryptLibraryItem(item, "user-a", privateKey)).resolves.toMatchObject({ content });
    await expect(decryptLibraryItem(item, "user-b", privateKey)).rejects.toThrow("소유자");
  });

  it("rejects a forged wrapped-key participant", async () => {
    const { item, privateKey } = await encryptedItem();
    const forged = { ...item, wrappedKeys: { ...item.wrappedKeys, "user-b": item.wrappedKeys["user-a"] } };

    await expect(decryptLibraryItem(forged, "user-a", privateKey)).rejects.toThrow("암호화 키");
  });

  it("isolates corrupt documents instead of failing the whole list", async () => {
    const { item, privateKey } = await encryptedItem();
    const corrupt: LibraryItemSnapshot = {
      ...item,
      id: "corrupt-item",
      encryptedContent: { ...item.encryptedContent, cipherText: "not-valid-ciphertext" }
    };
    const result = await decryptLibraryItems([item, corrupt], "user-a", privateKey);

    expect(result.items.map((value) => value.id)).toEqual([item.id]);
    expect(result.failedItemIds).toEqual([corrupt.id]);
  });

  it("rejects stale generations even when a deterministic id is recreated at the same revision", () => {
    const current = {
      generationId: "generation-new",
      lastMutationId: "new-mutation",
      ownerUid: "user-a",
      revision: 1
    };

    expect(libraryMutationPreconditionMatches(current, "user-a", 1, "new-mutation", "generation-old")).toBe(false);
    expect(libraryMutationPreconditionMatches(current, "user-a", 1, "old-mutation", "generation-new")).toBe(false);
    expect(libraryMutationPreconditionMatches(current, "user-a", 1, "new-mutation", "generation-new")).toBe(true);
    expect(libraryMutationPreconditionMatches(current, "user-b", 1, "new-mutation", "generation-new")).toBe(false);
  });
});
