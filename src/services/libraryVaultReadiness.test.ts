import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  DecryptedVaultFolder,
  DecryptedVaultNote
} from "../features/vault/vaultData";
import { vaultNameFingerprint } from "../features/vault/vaultIntegrity";
import {
  assertLibraryVaultPromotionReady,
  type LibraryVaultReadinessDependencies
} from "./libraryVaultReadiness";

const privateKey = {} as CryptoKey;
const profile = { uid: "owner-a" };
let vaultIntegrityKey: CryptoKey;

async function readySnapshot() {
  const folderClaim = await vaultNameFingerprint(vaultIntegrityKey, {
    name: "Projects",
    parentId: null,
    targetType: "folder"
  });
  const noteClaim = await vaultNameFingerprint(vaultIntegrityKey, {
    kind: "markdown",
    name: "Note",
    parentId: "folder-a",
    targetType: "entry"
  });
  const folder = {
    color: "#7c5cff",
    displayName: "Projects",
    id: "folder-a",
    name: "암호화 폴더",
    order: 1,
    ownerUid: profile.uid,
    parentId: null,
    vaultNameClaimId: folderClaim,
    vaultNameIndexVersion: 1
  } as DecryptedVaultFolder;
  const note = {
    body: "body",
    contentFormat: "markdown-v1",
    encryptedBody: { algorithm: "AES-GCM", cipherText: "body", iv: "iv", version: 1 },
    encryptedTitle: { algorithm: "AES-GCM", cipherText: "title", iv: "iv", version: 1 },
    entryKind: "markdown",
    folderId: folder.id,
    id: "note-a",
    ownerUid: profile.uid,
    participantUids: [profile.uid],
    title: "Note",
    type: "personal",
    updatedBy: profile.uid,
    vaultNameClaimId: noteClaim,
    vaultNameIndexVersion: 1,
    wrappedKeys: {}
  } as DecryptedVaultNote;
  return { folders: [folder], notes: [note] };
}

describe("Library Vault readiness", () => {
  beforeAll(async () => {
    vaultIntegrityKey = await crypto.subtle.generateKey(
      { length: 256, name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"]
    );
  });

  it("accepts a complete owner-only snapshot whose blinded claims match", async () => {
    const snapshot = await readySnapshot();
    const dependencies = { loadSnapshot: vi.fn().mockResolvedValue(snapshot) } satisfies LibraryVaultReadinessDependencies;
    await expect(assertLibraryVaultPromotionReady({
      privateKey, profile, vaultIntegrityKey
    }, dependencies)).resolves.toBeUndefined();
  });

  it("blocks promotion while any legacy name claim is missing", async () => {
    const snapshot = await readySnapshot();
    snapshot.notes[0].vaultNameClaimId = undefined;
    const dependencies = { loadSnapshot: vi.fn().mockResolvedValue(snapshot) } satisfies LibraryVaultReadinessDependencies;
    await expect(assertLibraryVaultPromotionReady({
      privateKey, profile, vaultIntegrityKey
    }, dependencies)).rejects.toThrow("먼저 Vault를 열어");
  });

  it("blocks an incomplete folder snapshot before any Inbox write", async () => {
    const snapshot = await readySnapshot();
    snapshot.notes[0].folderId = "missing-folder";
    const dependencies = { loadSnapshot: vi.fn().mockResolvedValue(snapshot) } satisfies LibraryVaultReadinessDependencies;
    await expect(assertLibraryVaultPromotionReady({
      privateKey, profile, vaultIntegrityKey
    }, dependencies)).rejects.toThrow("상위 폴더");
  });
});
