import { describe, expect, it, vi } from "vitest";
import type { NoteSnapshot } from "../services/notes";
import {
  AdminNoteDecryptionCache,
  resolveAdminNoteViews,
  type AdminNoteContent,
  type AdminNoteDecryptor
} from "./adminNoteDecryption";

const privateKeyA = {} as CryptoKey;
const privateKeyB = {} as CryptoKey;

function noteSnapshot(index: number): NoteSnapshot {
  return {
    id: `note-${index}`,
    type: "personal",
    ownerUid: "admin-a",
    participantUids: ["admin-a"],
    encryptedTitle: {
      version: 1,
      algorithm: "AES-GCM",
      cipherText: `title-${index}`,
      iv: `title-iv-${index}`
    },
    encryptedBody: {
      version: 1,
      algorithm: "AES-GCM",
      cipherText: `body-${index}`,
      iv: `body-iv-${index}`
    },
    wrappedKeys: {
      "admin-a": {
        version: 1,
        algorithm: "RSA-OAEP",
        wrappedKey: `wrapped-${index}`
      }
    },
    updatedBy: "admin-a"
  };
}

function readableContent(title: string): AdminNoteContent {
  return {
    title,
    bodyFormat: "html",
    bodyHtml: `<p>${title}</p>`,
    bodyPreview: title,
    bodySearchText: title,
    fontSize: 17,
    canReadContent: true,
    unavailableReason: null
  };
}

describe("admin note decryption cache", () => {
  it("decrypts only one changed note and limits a cold load to four concurrent decryptions", async () => {
    const cache = new AdminNoteDecryptionCache();
    const notes = Array.from({ length: 100 }, (_, index) => noteSnapshot(index));
    let active = 0;
    let maximumActive = 0;
    const decryptor = vi.fn<AdminNoteDecryptor>(async (note) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return readableContent(note.id);
    });

    await resolveAdminNoteViews({ cache, decryptor, notes, privateKey: privateKeyA, uid: "admin-a" });

    expect(decryptor).toHaveBeenCalledTimes(100);
    expect(maximumActive).toBe(4);

    decryptor.mockClear();
    maximumActive = 0;
    const changedNotes = notes.map((note, index) => index === 51
      ? {
          ...note,
          encryptedBody: { ...note.encryptedBody, cipherText: "changed-body" }
        }
      : {
          ...note,
          updatedBy: "metadata-only-change"
        });
    const views = await resolveAdminNoteViews({
      cache,
      decryptor,
      notes: changedNotes,
      privateKey: privateKeyA,
      uid: "admin-a"
    });

    expect(decryptor).toHaveBeenCalledTimes(1);
    expect(decryptor.mock.calls[0]?.[0].id).toBe("note-51");
    expect(views[0].updatedBy).toBe("metadata-only-change");
    expect(views[51].title).toBe("note-51");
  });

  it("never reuses plaintext after the account key scope changes", async () => {
    const cache = new AdminNoteDecryptionCache();
    const notes = [noteSnapshot(1), noteSnapshot(2)];
    const decryptor = vi.fn<AdminNoteDecryptor>(async (note) => readableContent(note.id));

    await resolveAdminNoteViews({ cache, decryptor, notes, privateKey: privateKeyA, uid: "admin-a" });
    decryptor.mockClear();
    await resolveAdminNoteViews({ cache, decryptor, notes, privateKey: privateKeyB, uid: "admin-a" });

    expect(decryptor).toHaveBeenCalledTimes(2);
  });

  it("does not let an older async run overwrite a newer ciphertext cache entry", async () => {
    const cache = new AdminNoteDecryptionCache();
    const original = noteSnapshot(1);
    const changed = {
      ...original,
      encryptedBody: { ...original.encryptedBody, cipherText: "new-body" }
    };
    let releaseOlder: ((content: AdminNoteContent) => void) | undefined;
    let markOlderStarted: (() => void) | undefined;
    const olderStarted = new Promise<void>((resolve) => {
      markOlderStarted = resolve;
    });
    const olderContent = new Promise<AdminNoteContent>((resolve) => {
      releaseOlder = resolve;
    });
    const olderRun = resolveAdminNoteViews({
      cache,
      decryptor: async () => {
        markOlderStarted?.();
        return olderContent;
      },
      notes: [original],
      privateKey: privateKeyA,
      uid: "admin-a"
    });
    await olderStarted;

    await resolveAdminNoteViews({
      cache,
      decryptor: async () => readableContent("new content"),
      notes: [changed],
      privateKey: privateKeyA,
      uid: "admin-a"
    });
    releaseOlder?.(readableContent("stale content"));
    await olderRun;

    const unexpectedDecrypt = vi.fn<AdminNoteDecryptor>(async () => readableContent("unexpected"));
    const latest = await resolveAdminNoteViews({
      cache,
      decryptor: unexpectedDecrypt,
      notes: [changed],
      privateKey: privateKeyA,
      uid: "admin-a"
    });

    expect(unexpectedDecrypt).not.toHaveBeenCalled();
    expect(latest[0].title).toBe("new content");
  });

  it("hides a changed note immediately while preserving cached unchanged notes", async () => {
    const cache = new AdminNoteDecryptionCache();
    const notes = [noteSnapshot(1), noteSnapshot(2)];
    await resolveAdminNoteViews({
      cache,
      decryptor: async (note) => readableContent(note.id),
      notes,
      privateKey: privateKeyA,
      uid: "admin-a"
    });
    const changed = [
      notes[0],
      { ...notes[1], encryptedTitle: { ...notes[1].encryptedTitle, cipherText: "changed-title" } }
    ];
    let releaseChanged: ((content: AdminNoteContent) => void) | undefined;
    const changedContent = new Promise<AdminNoteContent>((resolve) => {
      releaseChanged = resolve;
    });
    const onPending = vi.fn();
    const resolution = resolveAdminNoteViews({
      cache,
      decryptor: async () => changedContent,
      notes: changed,
      onPending,
      privateKey: privateKeyA,
      uid: "admin-a"
    });

    expect(onPending).toHaveBeenCalledTimes(1);
    expect(onPending.mock.calls[0]?.[0][0].canReadContent).toBe(true);
    expect(onPending.mock.calls[0]?.[0][1]).toMatchObject({
      canReadContent: false,
      bodyPreview: "노트 본문을 안전하게 확인하는 중입니다."
    });

    releaseChanged?.(readableContent("changed"));
    await resolution;
  });
});
