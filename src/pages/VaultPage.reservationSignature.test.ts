import { describe, expect, it } from "vitest";
import type { NoteFolderSnapshot, NoteSnapshot } from "../services/notes";
import {
  ownedFolderReservationSignature,
  ownedNoteReservationSignature
} from "./VaultPage";

const encrypted = (cipherText: string) => ({
  algorithm: "AES-GCM" as const,
  cipherText,
  iv: "iv",
  version: 1 as const
});

function note(overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    id: "note-1",
    contentFormat: "markdown-v1",
    encryptedBody: encrypted("body"),
    encryptedTitle: encrypted("title"),
    entryKind: "markdown",
    folderId: null,
    ownerUid: "owner",
    participantUids: ["owner"],
    revision: 1,
    type: "personal",
    updatedBy: "owner",
    vaultNameClaimId: "claim",
    vaultNameIndexVersion: 1,
    wrappedKeys: {},
    ...overrides
  };
}

function folder(overrides: Partial<NoteFolderSnapshot> = {}): NoteFolderSnapshot {
  return {
    color: "#fff",
    encryptedName: encrypted("folder"),
    id: "folder-1",
    name: "암호화 폴더",
    order: 0,
    ownerUid: "owner",
    parentId: null,
    revision: 1,
    vaultNameClaimId: "claim",
    vaultNameIndexVersion: 1,
    ...overrides
  };
}

describe("Vault name-reservation signatures", () => {
  it("keeps body-only saves outside the name-bearing server snapshot identity", () => {
    const before = ownedNoteReservationSignature([note()], "owner");
    const after = ownedNoteReservationSignature([
      note({ encryptedBody: encrypted("changed-body"), revision: 99 })
    ], "owner");
    expect(after).toBe(before);
  });

  it("tracks note title and parent changes without restarting the sealed cutover", () => {
    const before = ownedNoteReservationSignature([note()], "owner");
    expect(ownedNoteReservationSignature([
      note({ encryptedTitle: encrypted("renamed") })
    ], "owner")).not.toBe(before);
    expect(ownedNoteReservationSignature([
      note({ folderId: "folder-2" })
    ], "owner")).not.toBe(before);
  });

  it("includes active owner-shared entries but excludes another owner's share", () => {
    const personal = note();
    const ownerShared = note({ id: "owner-shared", type: "shared" });
    const otherShared = note({ id: "other-shared", ownerUid: "other", type: "shared" });
    expect(ownedNoteReservationSignature([personal, ownerShared], "owner"))
      .not.toBe(ownedNoteReservationSignature([personal], "owner"));
    expect(ownedNoteReservationSignature([personal, otherShared], "owner"))
      .toBe(ownedNoteReservationSignature([personal], "owner"));
  });

  it("ignores folder presentation revisions but tracks encrypted name and parent", () => {
    const before = ownedFolderReservationSignature([folder()], "owner");
    expect(ownedFolderReservationSignature([
      folder({ color: "#000", order: 10, revision: 7 })
    ], "owner")).toBe(before);
    expect(ownedFolderReservationSignature([
      folder({ encryptedName: encrypted("renamed-folder") })
    ], "owner")).not.toBe(before);
    expect(ownedFolderReservationSignature([
      folder({ parentId: "parent" })
    ], "owner")).not.toBe(before);
  });

});
