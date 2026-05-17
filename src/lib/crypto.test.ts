import { describe, expect, it } from "vitest";
import {
  decryptBytes,
  decryptText,
  encryptBytes,
  encryptText,
  generateNoteKey,
  generateUserKeyBundle,
  unlockPrivateKey,
  unwrapNoteKey,
  wrapNoteKey
} from "./crypto";
import type { UserKeyDocument } from "../types";

describe("client encryption", () => {
  it("encrypts and decrypts note content with AES-GCM", async () => {
    const noteKey = await generateNoteKey();
    const encrypted = await encryptText("실시간 개인 메모", noteKey);

    await expect(decryptText(encrypted, noteKey)).resolves.toBe("실시간 개인 메모");
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
});
