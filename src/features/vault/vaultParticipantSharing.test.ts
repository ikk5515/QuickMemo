import { describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import {
  planVaultParticipantShare,
  updateVaultEntryParticipants,
  vaultShareCandidates
} from "./vaultParticipantSharing";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    allowedShareTargetUids: ["user-b"],
    avatarText: "A",
    color: "#000000",
    displayName: "사용자 A",
    isActive: true,
    isAdmin: false,
    loginEmail: "user-a@example.com",
    order: 0,
    publicKeyJwk: { kty: "RSA" },
    quickKey: 1,
    role: "user",
    uid: "user-a",
    ...overrides
  };
}

function note(overrides: Partial<DecryptedVaultNote> = {}): DecryptedVaultNote {
  return {
    body: "본문",
    contentFormat: "markdown-v1",
    encryptedBody: { algorithm: "AES-GCM", cipherText: "body", iv: "iv", version: 1 },
    encryptedTitle: { algorithm: "AES-GCM", cipherText: "title", iv: "iv", version: 1 },
    entryKind: "markdown",
    folderId: null,
    id: "note-a",
    isDeleted: false,
    ownerUid: "user-a",
    participantUids: ["user-a"],
    revision: 4,
    title: "노트",
    type: "personal",
    updatedBy: "user-a",
    wrappedKeys: {
      "user-a": { algorithm: "RSA-OAEP", version: 1, wrappedKey: "owner-key" }
    },
    ...overrides
  };
}

describe("Vault participant sharing", () => {
  it("shows only active, administratively allowed targets to a normal user", () => {
    const owner = profile();
    const users = [
      owner,
      profile({ displayName: "사용자 B", uid: "user-b" }),
      profile({ displayName: "사용자 C", uid: "user-c" }),
      profile({ displayName: "비활성", isActive: false, uid: "user-d" })
    ];

    expect(vaultShareCandidates(owner, users).map((user) => user.uid)).toEqual([
      "user-a",
      "user-b"
    ]);
  });

  it("keeps the owner and rejects unauthorized or foldered share transitions", () => {
    const owner = profile();
    const users = [owner, profile({ displayName: "사용자 B", uid: "user-b" })];

    expect(planVaultParticipantShare(note(), owner, users, ["user-b"])).toMatchObject({
      participantUids: ["user-a", "user-b"],
      type: "shared"
    });
    expect(() => planVaultParticipantShare(note(), owner, users, ["user-c"]))
      .toThrow("허용한 활성 사용자");
    expect(() => planVaultParticipantShare(note({ folderId: "folder-a" }), owner, users, ["user-b"]))
      .toThrow("Vault 루트");
  });

  it("allows an unavailable existing participant to be removed but never retained", () => {
    const owner = profile({ allowedShareTargetUids: [] });
    const unavailable = profile({ isActive: false, uid: "user-b" });
    const shared = note({ participantUids: ["user-a", "user-b"], type: "shared" });

    expect(() => planVaultParticipantShare(shared, owner, [owner, unavailable], ["user-b"]))
      .toThrow("기존 공유 사용자를 해제");
    expect(planVaultParticipantShare(shared, owner, [owner, unavailable], []))
      .toMatchObject({ participantUids: ["user-a"], type: "personal" });
  });

  it("wraps the note key per participant and commits one revision-checked access mutation", async () => {
    const owner = profile();
    const target = profile({ displayName: "사용자 B", uid: "user-b" });
    const noteKey = {} as CryptoKey;
    const privateKey = {} as CryptoKey;
    const updateRevisionedNoteAccess = vi.fn().mockResolvedValue({ noteId: "note-a", revision: 5 });
    const wrapNoteKey = vi.fn(async (_key: CryptoKey, publicKey: JsonWebKey) => ({
      algorithm: "RSA-OAEP" as const,
      version: 1 as const,
      wrappedKey: publicKey === owner.publicKeyJwk ? "owner-next" : "target-next"
    }));

    await updateVaultEntryParticipants(
      note(),
      owner,
      privateKey,
      [owner, target],
      ["user-b"],
      {
        unwrapNoteKey: vi.fn().mockResolvedValue(noteKey),
        updateRevisionedNoteAccess,
        wrapNoteKey
      }
    );

    expect(wrapNoteKey).toHaveBeenCalledTimes(2);
    expect(updateRevisionedNoteAccess).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 4,
      folderId: null,
      participantUids: ["user-a", "user-b"],
      type: "shared",
      wrappedKeys: {
        "user-a": expect.objectContaining({ wrappedKey: "owner-next" }),
        "user-b": expect.objectContaining({ wrappedKey: "target-next" })
      }
    }));
  });
});
