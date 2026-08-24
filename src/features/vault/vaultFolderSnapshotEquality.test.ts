import { Timestamp } from "firebase/firestore";
import { describe, expect, it } from "vitest";
import {
  sameVaultFolderSnapshotsIgnoringPasteLock,
  type NoteFolderSnapshot
} from "../../services/notes";

function folder(
  id: string,
  overrides: Record<string, unknown> = {}
): NoteFolderSnapshot {
  return {
    color: "#7c5cff",
    id,
    name: "Encrypted Vault Folder",
    ownerUid: "user-a",
    parentId: null,
    revision: 1,
    ...overrides
  } as NoteFolderSnapshot;
}

describe("sameVaultFolderSnapshotsIgnoringPasteLock", () => {
  it("ignores only an added, changed, or removed top-level paste lock", () => {
    const unlocked = folder("folder-a");
    const firstLock = folder("folder-a", {
      vaultPasteLock: { expiresAt: new Timestamp(10, 0), id: "lock-a" }
    });
    const secondLock = folder("folder-a", {
      vaultPasteLock: { expiresAt: new Timestamp(20, 0), id: "lock-b" }
    });

    expect(sameVaultFolderSnapshotsIgnoringPasteLock([unlocked], [firstLock])).toBe(true);
    expect(sameVaultFolderSnapshotsIgnoringPasteLock([firstLock], [secondLock])).toBe(true);
    expect(sameVaultFolderSnapshotsIgnoringPasteLock([secondLock], [unlocked])).toBe(true);
  });

  it("compares every other known and unknown field", () => {
    const original = folder("folder-a", {
      encryptedName: { algorithm: "AES-GCM", cipherText: "cipher-a", iv: "iv", version: 1 },
      futureMetadata: { enabled: true }
    });

    expect(sameVaultFolderSnapshotsIgnoringPasteLock(
      [original],
      [folder("folder-a", {
        encryptedName: { algorithm: "AES-GCM", cipherText: "cipher-b", iv: "iv", version: 1 },
        futureMetadata: { enabled: true }
      })]
    )).toBe(false);
    expect(sameVaultFolderSnapshotsIgnoringPasteLock(
      [original],
      [folder("folder-a", {
        encryptedName: { algorithm: "AES-GCM", cipherText: "cipher-a", iv: "iv", version: 1 },
        futureMetadata: { enabled: false }
      })]
    )).toBe(false);
    for (const changed of [
      folder("folder-a", {
        encryptedName: { algorithm: "AES-GCM", cipherText: "cipher-a", iv: "iv", version: 1 },
        futureMetadata: { enabled: true },
        revision: 2
      }),
      folder("folder-a", {
        encryptedName: { algorithm: "AES-GCM", cipherText: "cipher-a", iv: "iv", version: 1 },
        futureMetadata: { enabled: true },
        parentId: "parent-a"
      }),
      folder("folder-a", {
        encryptedName: { algorithm: "AES-GCM", cipherText: "cipher-a", iv: "iv", version: 1 },
        futureMetadata: { enabled: true },
        isDeleted: true
      })
    ]) {
      expect(sameVaultFolderSnapshotsIgnoringPasteLock([original], [changed])).toBe(false);
    }
  });

  it("does not ignore a nested field with the paste-lock name", () => {
    expect(sameVaultFolderSnapshotsIgnoringPasteLock(
      [folder("folder-a", { futureMetadata: { vaultPasteLock: "before" } })],
      [folder("folder-a", { futureMetadata: { vaultPasteLock: "after" } })]
    )).toBe(false);
  });

  it("compares Timestamp and Date values semantically", () => {
    const before = folder("folder-a", {
      createdAt: new Timestamp(100, 25),
      futureDate: new Date("2026-08-25T00:00:00.000Z")
    });
    expect(sameVaultFolderSnapshotsIgnoringPasteLock([before], [folder("folder-a", {
      createdAt: new Timestamp(100, 25),
      futureDate: new Date("2026-08-25T00:00:00.000Z")
    })])).toBe(true);
    expect(sameVaultFolderSnapshotsIgnoringPasteLock([before], [folder("folder-a", {
      createdAt: new Timestamp(100, 26),
      futureDate: new Date("2026-08-25T00:00:00.000Z")
    })])).toBe(false);
    expect(sameVaultFolderSnapshotsIgnoringPasteLock([before], [folder("folder-a", {
      createdAt: new Timestamp(100, 25),
      futureDate: new Date("2026-08-25T00:00:00.001Z")
    })])).toBe(false);
  });

  it("keeps nested array order significant", () => {
    expect(sameVaultFolderSnapshotsIgnoringPasteLock(
      [folder("folder-a", { vaultAncestorIds: ["root", "parent"] })],
      [folder("folder-a", { vaultAncestorIds: ["parent", "root"] })]
    )).toBe(false);
  });

  it("ignores folder snapshot ordering while matching by id", () => {
    expect(sameVaultFolderSnapshotsIgnoringPasteLock(
      [folder("folder-a"), folder("folder-b", { revision: 2 })],
      [folder("folder-b", { revision: 2 }), folder("folder-a")]
    )).toBe(true);
  });

  it("fails closed for duplicate, added, removed, or invalid ids", () => {
    expect(sameVaultFolderSnapshotsIgnoringPasteLock(
      [folder("folder-a"), folder("folder-a")],
      [folder("folder-a"), folder("folder-b")]
    )).toBe(false);
    expect(sameVaultFolderSnapshotsIgnoringPasteLock(
      [folder("folder-a"), folder("folder-b")],
      [folder("folder-a"), folder("folder-a")]
    )).toBe(false);
    expect(sameVaultFolderSnapshotsIgnoringPasteLock(
      [folder("folder-a")],
      [folder("folder-a"), folder("folder-b")]
    )).toBe(false);
    expect(sameVaultFolderSnapshotsIgnoringPasteLock(
      [folder("folder-a"), folder("folder-b")],
      [folder("folder-a")]
    )).toBe(false);
    expect(sameVaultFolderSnapshotsIgnoringPasteLock(
      [folder("")],
      [folder("")]
    )).toBe(false);
  });
});
