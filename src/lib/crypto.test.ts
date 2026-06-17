import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  decryptBytes,
  decryptText,
  derivePublicShareContentKey,
  encryptBytes,
  encryptText,
  exportAesKeyBase64Url,
  generateNoteKey,
  generateUserKeyBundle,
  hashPublicSharePassword,
  unlockPrivateKey,
  unwrapNoteKey,
  verifyPublicSharePassword,
  wrapNoteKey
} from "./crypto";
import type { UserKeyDocument } from "../types";
import { parseEditorContent, plainTextToEditorHtml, serializeEditorContent } from "./editorContent";

describe("client encryption", () => {
  it("encrypts and decrypts note content with AES-GCM", async () => {
    const noteKey = await generateNoteKey();
    const encrypted = await encryptText("실시간 개인 메모", noteKey);

    await expect(decryptText(encrypted, noteKey)).resolves.toBe("실시간 개인 메모");
  });

  it("keeps note tab characters through editor serialization and AES-GCM encryption", async () => {
    const noteKey = await generateNoteKey();
    const html = plainTextToEditorHtml("root\n\tchild\n\t\tgrandchild\n이름\t나이\t메모");
    const serialized = serializeEditorContent(html, 17);
    const encrypted = await encryptText(serialized, noteKey);
    const decrypted = await decryptText(encrypted, noteKey);
    const parsed = parseEditorContent(decrypted);

    expect(decrypted).toContain("\tchild");
    expect(decrypted).toContain("\t\tgrandchild");
    expect(parsed.html).toContain("이름\t나이\t메모");
  });

  it("encrypts and decrypts binary attachments with AES-GCM", async () => {
    const noteKey = await generateNoteKey();
    const fileBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const encrypted = await encryptBytes(fileBytes, noteKey);

    expect(encrypted.cipherBytes.byteLength).toBe(fileBytes.byteLength + 16);
    await expect(decryptBytes(encrypted, noteKey)).resolves.toEqual(fileBytes);
  });

  it("locks a private key with a password and unwraps note keys", async () => {
    const password = "strong-password";
    const bundle = await generateUserKeyBundle(password);
    const keyDocument: UserKeyDocument = {
      uid: "user-1",
      ...bundle
    };
    const privateKey = await unlockPrivateKey(keyDocument, password);
    const noteKey = await generateNoteKey();
    const wrapped = await wrapNoteKey(noteKey, bundle.publicKeyJwk);
    const unwrapped = await unwrapNoteKey(wrapped, privateKey);
    const encrypted = await encryptText("공유 노트", noteKey);

    await expect(decryptText(encrypted, unwrapped)).resolves.toBe("공유 노트");
  });

  it("rejects a wrong password for a locked private key", async () => {
    const bundle = await generateUserKeyBundle("right-password");
    const keyDocument: UserKeyDocument = {
      uid: "user-1",
      ...bundle
    };

    await expect(unlockPrivateKey(keyDocument, "wrong-password")).rejects.toThrow();
  });

  it("keeps public share password verifiers separate from content encryption keys", async () => {
    const password = "share-password";
    const shareKeyValue = await exportAesKeyBase64Url(await generateNoteKey());
    const passwordHash = await hashPublicSharePassword(password, shareKeyValue);
    const contentKey = await derivePublicShareContentKey(shareKeyValue, password, passwordHash);
    const encrypted = await encryptText("protected public note", contentKey);
    const leakedVerifierKey = await crypto.subtle.importKey(
      "raw",
      base64ToBytes(passwordHash.hash),
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );

    expect(passwordHash.version).toBe(2);
    await expect(verifyPublicSharePassword(password, passwordHash, shareKeyValue)).resolves.toBe(true);
    await expect(verifyPublicSharePassword("wrong-password", passwordHash, shareKeyValue)).resolves.toBe(false);
    await expect(decryptText(encrypted, contentKey)).resolves.toBe("protected public note");
    await expect(decryptText(encrypted, leakedVerifierKey)).rejects.toThrow();
  });
});
