import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activatePreparedVaultIntegrityKey,
  getOrCreateVaultIntegrityKey,
  prepareVaultIntegrityKey,
  requireExistingVaultIntegrityKey
} from "./vaultIntegrity";

const mocks = vi.hoisted(() => ({
  candidateKey: { kind: "candidate" } as unknown as CryptoKey,
  db: { kind: "firestore" },
  generated: vi.fn(),
  getDocFromServer: vi.fn(),
  runTransaction: vi.fn(),
  serverTimestamp: vi.fn(() => ({ kind: "server-timestamp" })),
  transaction: { get: vi.fn(), set: vi.fn() },
  unwrappedKey: { kind: "unwrapped" } as unknown as CryptoKey,
  unwrap: vi.fn(),
  wrappedKey: { algorithm: "RSA-OAEP", version: 1, wrappedKey: "wrapped" },
  wrap: vi.fn()
}));

vi.mock("../lib/firebase", () => ({ db: mocks.db }));
vi.mock("../lib/crypto", () => ({
  generateNoteKey: mocks.generated,
  unwrapNoteKey: mocks.unwrap,
  wrapNoteKey: mocks.wrap
}));
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((...parts: unknown[]) => ({ parts })),
  getDocFromServer: mocks.getDocFromServer,
  runTransaction: mocks.runTransaction,
  serverTimestamp: mocks.serverTimestamp
}));

const profile = {
  publicKeyJwk: { e: "AQAB", kty: "RSA", n: "public" },
  uid: "vault-integrity-user"
};

describe("Vault integrity key persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generated.mockResolvedValue(mocks.candidateKey);
    mocks.wrap.mockResolvedValue(mocks.wrappedKey);
    mocks.unwrap.mockResolvedValue(mocks.unwrappedKey);
    mocks.runTransaction.mockImplementation(async (_db: unknown, callback: (transaction: typeof mocks.transaction) => unknown) => (
      callback(mocks.transaction)
    ));
  });

  it("creates a random key only as an owner-wrapped immutable document", async () => {
    const privateKey = { kind: "private-create" } as unknown as CryptoKey;
    mocks.transaction.get.mockResolvedValueOnce({ exists: () => false });

    await expect(getOrCreateVaultIntegrityKey(profile, privateKey)).resolves.toBe(mocks.candidateKey);
    expect(mocks.transaction.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      indexVersion: 1,
      ownerUid: profile.uid,
      wrappedKey: mocks.wrappedKey
    }));
  });

  it("uses the winning wrapped key after a concurrent creator and caches it in memory", async () => {
    const privateKey = { kind: "private-existing" } as unknown as CryptoKey;
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({ indexVersion: 1, ownerUid: profile.uid, wrappedKey: mocks.wrappedKey }),
      exists: () => true
    });

    const first = await getOrCreateVaultIntegrityKey(profile, privateKey);
    const second = await getOrCreateVaultIntegrityKey(profile, privateKey);

    expect(first).toBe(mocks.unwrappedKey);
    expect(second).toBe(first);
    expect(mocks.runTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.unwrap).toHaveBeenCalledWith(mocks.wrappedKey, privateKey);
    expect(mocks.transaction.set).not.toHaveBeenCalled();
  });

  it("fails closed for a malformed or cross-user stored key document", async () => {
    const privateKey = { kind: "private-malformed" } as unknown as CryptoKey;
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({ indexVersion: 1, ownerUid: "other", wrappedKey: mocks.wrappedKey }),
      exists: () => true
    });

    await expect(getOrCreateVaultIntegrityKey(profile, privateKey)).rejects.toThrow("확인할 수 없습니다");
    expect(mocks.unwrap).not.toHaveBeenCalled();
  });

  it("prepares a missing integrity key without creating the marker", async () => {
    const privateKey = { kind: "private-preflight" } as unknown as CryptoKey;
    mocks.getDocFromServer.mockResolvedValueOnce({ exists: () => false });

    const prepared = await prepareVaultIntegrityKey(profile, privateKey);

    expect(prepared).toMatchObject({ key: mocks.candidateKey, ownerUid: profile.uid, state: "candidate" });
    expect(mocks.getDocFromServer).toHaveBeenCalledOnce();
    expect(mocks.runTransaction).not.toHaveBeenCalled();
    expect(mocks.transaction.set).not.toHaveBeenCalled();
  });

  it("requires an existing marker without activating a missing Vault", async () => {
    const privateKey = { kind: "private-secondary-entry" } as unknown as CryptoKey;
    mocks.getDocFromServer.mockResolvedValueOnce({ exists: () => false });

    await expect(requireExistingVaultIntegrityKey(profile, privateKey))
      .rejects.toMatchObject({ name: "VaultIntegrityNotReadyError" });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
    expect(mocks.transaction.set).not.toHaveBeenCalled();
  });

  it("unwraps an existing marker for secondary Vault writes", async () => {
    const privateKey = { kind: "private-secondary-existing" } as unknown as CryptoKey;
    mocks.getDocFromServer.mockResolvedValueOnce({
      data: () => ({ indexVersion: 1, ownerUid: profile.uid, wrappedKey: mocks.wrappedKey }),
      exists: () => true
    });

    await expect(requireExistingVaultIntegrityKey(profile, privateKey)).resolves.toBe(mocks.unwrappedKey);
    expect(mocks.unwrap).toHaveBeenCalledWith(mocks.wrappedKey, privateKey);
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("activates a preflight candidate only after the caller explicitly commits it", async () => {
    const privateKey = { kind: "private-activate" } as unknown as CryptoKey;
    mocks.getDocFromServer.mockResolvedValueOnce({ exists: () => false });
    mocks.transaction.get.mockResolvedValueOnce({ exists: () => false });
    const prepared = await prepareVaultIntegrityKey(profile, privateKey);

    await expect(activatePreparedVaultIntegrityKey(prepared, privateKey)).resolves.toEqual({
      created: true,
      key: mocks.candidateKey,
      keyChanged: false
    });
    expect(mocks.transaction.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUid: profile.uid,
      wrappedKey: mocks.wrappedKey
    }));
  });

  it("returns the winning key and requires a new preflight after an activation race", async () => {
    const privateKey = { kind: "private-race" } as unknown as CryptoKey;
    mocks.getDocFromServer.mockResolvedValueOnce({ exists: () => false });
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({ indexVersion: 1, ownerUid: profile.uid, wrappedKey: mocks.wrappedKey }),
      exists: () => true
    });
    const prepared = await prepareVaultIntegrityKey(profile, privateKey);

    await expect(activatePreparedVaultIntegrityKey(prepared, privateKey)).resolves.toEqual({
      created: false,
      key: mocks.unwrappedKey,
      keyChanged: true
    });
    expect(mocks.transaction.set).not.toHaveBeenCalled();
  });
});
