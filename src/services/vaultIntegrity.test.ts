import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activatePreparedVaultIntegrityKey,
  createVaultIntegrityCutoverLeaseId,
  getOrCreateVaultIntegrityKey,
  prepareVaultIntegrityKey,
  requireExistingVaultIntegrityKey,
  reconcilePendingVaultIntegrityClaims,
  releaseVaultIntegrityCutoverLease,
  renewVaultIntegrityCutoverLease,
  sealVaultIntegrityCutover
} from "./vaultIntegrity";

const mocks = vi.hoisted(() => ({
  candidateKey: { kind: "candidate" } as unknown as CryptoKey,
  db: { kind: "firestore" },
  auth: { currentUser: null as { getIdToken: () => Promise<string>; uid: string } | null },
  fetch: vi.fn(),
  generated: vi.fn(),
  getDocFromServer: vi.fn(),
  getIdToken: vi.fn(),
  runTransaction: vi.fn(),
  serverTimestamp: vi.fn(() => ({ kind: "server-timestamp" })),
  transaction: { get: vi.fn(), set: vi.fn() },
  unwrappedKey: { kind: "unwrapped" } as unknown as CryptoKey,
  unwrap: vi.fn(),
  wrappedKey: { algorithm: "RSA-OAEP", version: 1, wrappedKey: "wrapped-value" },
  wrap: vi.fn()
}));

vi.mock("../lib/firebase", () => ({ appCheck: null, auth: mocks.auth, db: mocks.db }));
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
vi.mock("firebase/app-check", () => ({ getToken: vi.fn() }));

const profile = {
  publicKeyJwk: { e: "AQAB", kty: "RSA", n: "public" },
  uid: "vault-integrity-user"
};
const storedTimestamp = { toMillis: () => 1_768_000_000_000 };
const cutoverLease = {
  leaseGeneration: "g".repeat(43),
  leaseId: "l".repeat(43)
};

function storedMarker(extra: Record<string, unknown> = {}) {
  return {
    createdAt: storedTimestamp,
    indexVersion: 1,
    ownerUid: profile.uid,
    updatedAt: storedTimestamp,
    wrappedKey: mocks.wrappedKey,
    ...extra
  };
}

describe("Vault integrity key persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.auth.currentUser = null;
    mocks.generated.mockResolvedValue(mocks.candidateKey);
    mocks.wrap.mockResolvedValue(mocks.wrappedKey);
    mocks.unwrap.mockResolvedValue(mocks.unwrappedKey);
    mocks.runTransaction.mockImplementation(async (_db: unknown, callback: (transaction: typeof mocks.transaction) => unknown) => (
      callback(mocks.transaction)
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a random key only as an owner-wrapped immutable document", async () => {
    const privateKey = { kind: "private-create" } as unknown as CryptoKey;
    mocks.transaction.get.mockResolvedValueOnce({ exists: () => false });

    await expect(getOrCreateVaultIntegrityKey(profile, privateKey)).resolves.toBe(mocks.candidateKey);
    expect(mocks.transaction.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      cutoverState: "pending",
      cutoverVersion: 1,
      indexVersion: 1,
      ownerUid: profile.uid,
      wrappedKey: mocks.wrappedKey
    }));
  });

  it("uses the winning wrapped key after a concurrent creator and caches it in memory", async () => {
    const privateKey = { kind: "private-existing" } as unknown as CryptoKey;
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => storedMarker(),
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
      data: () => storedMarker({ ownerUid: "other" }),
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

  it("rejects a legacy or pending marker for secondary Vault writes", async () => {
    const privateKey = { kind: "private-secondary-existing" } as unknown as CryptoKey;
    mocks.getDocFromServer.mockResolvedValueOnce({
      data: () => storedMarker(),
      exists: () => true
    });

    await expect(requireExistingVaultIntegrityKey(profile, privateKey))
      .rejects.toMatchObject({ name: "VaultIntegrityNotReadyError" });
    expect(mocks.unwrap).toHaveBeenCalledWith(mocks.wrappedKey, privateKey);
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("accepts only the strict server-leased pending marker shape without exposing a raw token", async () => {
    const privateKey = { kind: "private-leased-pending" } as unknown as CryptoKey;
    mocks.getDocFromServer.mockResolvedValueOnce({
      data: () => storedMarker({
        cutoverLeaseAcquiredAt: storedTimestamp,
        cutoverLeaseExpiresAt: { toMillis: () => storedTimestamp.toMillis() + 90_000 },
        cutoverLeaseGeneration: cutoverLease.leaseGeneration,
        cutoverLeaseHash: "h".repeat(43),
        cutoverLeaseVersion: 1,
        cutoverState: "pending",
        cutoverVersion: 1
      }),
      exists: () => true
    });

    await expect(prepareVaultIntegrityKey(profile, privateKey)).resolves.toMatchObject({
      cutoverState: "pending",
      state: "existing"
    });
    expect(mocks.unwrap).toHaveBeenCalledWith(mocks.wrappedKey, privateKey);

    mocks.getDocFromServer.mockResolvedValueOnce({
      data: () => storedMarker({
        cutoverLeaseAcquiredAt: storedTimestamp,
        cutoverLeaseExpiresAt: { toMillis: () => storedTimestamp.toMillis() + 90_000 },
        cutoverLeaseGeneration: cutoverLease.leaseGeneration,
        cutoverLeaseHash: "h".repeat(43),
        cutoverLeaseId: cutoverLease.leaseId,
        cutoverLeaseVersion: 1,
        cutoverState: "pending",
        cutoverVersion: 1
      }),
      exists: () => true
    });
    await expect(prepareVaultIntegrityKey(profile, privateKey)).rejects.toThrow("완료 상태");
  });

  it("unwraps only an exact ready marker for secondary Vault writes", async () => {
    const privateKey = { kind: "private-secondary-ready" } as unknown as CryptoKey;
    mocks.getDocFromServer.mockResolvedValueOnce({
      data: () => storedMarker({
        cutoverState: "ready",
        cutoverVersion: 1,
        verifiedAt: storedTimestamp
      }),
      exists: () => true
    });

    await expect(requireExistingVaultIntegrityKey(profile, privateKey)).resolves.toBe(mocks.unwrappedKey);
    expect(mocks.unwrap).toHaveBeenCalledWith(mocks.wrappedKey, privateKey);
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when a ready marker has unknown fields", async () => {
    const privateKey = { kind: "private-ready-extra-field" } as unknown as CryptoKey;
    mocks.getDocFromServer.mockResolvedValueOnce({
      data: () => storedMarker({
        cutoverState: "ready",
        cutoverVersion: 1,
        unexpected: true,
        verifiedAt: storedTimestamp
      }),
      exists: () => true
    });

    await expect(prepareVaultIntegrityKey(profile, privateKey)).rejects.toThrow("완료 상태");
    expect(mocks.unwrap).not.toHaveBeenCalled();
  });

  it("activates a preflight candidate only after the caller explicitly commits it", async () => {
    const privateKey = { kind: "private-activate" } as unknown as CryptoKey;
    mocks.getDocFromServer.mockResolvedValueOnce({ exists: () => false });
    mocks.transaction.get.mockResolvedValueOnce({ exists: () => false });
    const prepared = await prepareVaultIntegrityKey(profile, privateKey);

    await expect(activatePreparedVaultIntegrityKey(prepared, privateKey)).resolves.toEqual({
      created: true,
      cutoverState: "pending",
      key: mocks.candidateKey,
      keyChanged: false
    });
    expect(mocks.transaction.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      cutoverState: "pending",
      cutoverVersion: 1,
      ownerUid: profile.uid,
      wrappedKey: mocks.wrappedKey
    }));
  });

  it("returns the winning key and requires a new preflight after an activation race", async () => {
    const privateKey = { kind: "private-race" } as unknown as CryptoKey;
    mocks.getDocFromServer.mockResolvedValueOnce({ exists: () => false });
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => storedMarker({ cutoverState: "pending", cutoverVersion: 1 }),
      exists: () => true
    });
    const prepared = await prepareVaultIntegrityKey(profile, privateKey);

    await expect(activatePreparedVaultIntegrityKey(prepared, privateKey)).resolves.toEqual({
      created: false,
      cutoverState: "pending",
      key: mocks.unwrappedKey,
      keyChanged: true
    });
    expect(mocks.transaction.set).not.toHaveBeenCalled();
  });

  it("posts exact counts to the authenticated server seal endpoint", async () => {
    mocks.getIdToken.mockResolvedValueOnce("firebase-id-token");
    mocks.auth.currentUser = { getIdToken: mocks.getIdToken, uid: profile.uid };
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      activeNoteCount: 3,
      cutoverVersion: 1,
      deletedNoteCount: 2,
      folderCount: 4,
      ok: true,
      state: "ready",
      verifiedAt: "2026-08-23T00:00:00.000Z"
    }), { headers: { "content-type": "application/json" }, status: 200 }));

    await expect(sealVaultIntegrityCutover(profile.uid, cutoverLease, {
      expectedActiveNoteCount: 3,
      expectedDeletedNoteCount: 2,
      expectedFolderCount: 4
    })).resolves.toMatchObject({ state: "ready", verifiedAt: "2026-08-23T00:00:00.000Z" });

    const [path, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/vault-integrity");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer firebase-id-token");
    expect(headers.get("x-quickmemo-vault-integrity")).toBe("1");
    expect(JSON.parse(String(init.body))).toEqual({
      action: "seal-ready",
      expectedActiveNoteCount: 3,
      expectedDeletedNoteCount: 2,
      expectedFolderCount: 4,
      ...cutoverLease
    });
  });

  it("creates 256-bit base64url lease ids and posts the exact renew/release credentials", async () => {
    expect(createVaultIntegrityCutoverLeaseId()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(createVaultIntegrityCutoverLeaseId()).not.toBe(createVaultIntegrityCutoverLeaseId());
    mocks.getIdToken.mockResolvedValue("firebase-id-token");
    mocks.auth.currentUser = { getIdToken: mocks.getIdToken, uid: profile.uid };
    mocks.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        leaseExpiresInSeconds: 90,
        ok: true,
        state: "pending"
      }), { headers: { "content-type": "application/json" }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        released: true,
        state: "released"
      }), { headers: { "content-type": "application/json" }, status: 200 }));

    await expect(renewVaultIntegrityCutoverLease(profile.uid, cutoverLease))
      .resolves.toMatchObject({ state: "pending" });
    await expect(releaseVaultIntegrityCutoverLease(profile.uid, cutoverLease)).resolves.toBe(true);
    expect(mocks.fetch.mock.calls.slice(-2).map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { action: "renew-cutover-lease", ...cutoverLease },
      { action: "release-cutover-lease", ...cutoverLease }
    ]);
  });

  it("returns only a bounded server Retry-After for a competing cutover tab", async () => {
    mocks.getIdToken.mockResolvedValueOnce("firebase-id-token");
    mocks.auth.currentUser = { getIdToken: mocks.getIdToken, uid: profile.uid };
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: "vault_cutover_busy",
      ok: false
    }), {
      headers: { "content-type": "application/json", "retry-after": "17" },
      status: 409
    }));

    await expect(reconcilePendingVaultIntegrityClaims(profile.uid, cutoverLease.leaseId))
      .rejects.toMatchObject({
        code: "vault_cutover_busy",
        retryAfterSeconds: 17,
        status: 409
      });
  });

  it("rejects a server seal response whose authoritative counts do not match", async () => {
    mocks.getIdToken.mockResolvedValueOnce("firebase-id-token");
    mocks.auth.currentUser = { getIdToken: mocks.getIdToken, uid: profile.uid };
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      activeNoteCount: 4,
      cutoverVersion: 1,
      deletedNoteCount: 2,
      folderCount: 4,
      ok: true,
      state: "ready",
      verifiedAt: "2026-08-23T00:00:00.000Z"
    }), { headers: { "content-type": "application/json" }, status: 200 }));

    await expect(sealVaultIntegrityCutover(profile.uid, cutoverLease, {
      expectedActiveNoteCount: 3,
      expectedDeletedNoteCount: 2,
      expectedFolderCount: 4
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects folder counts above the authoritative tree cap before authentication or fetch", async () => {
    await expect(sealVaultIntegrityCutover(profile.uid, cutoverLease, {
      expectedActiveNoteCount: 0,
      expectedDeletedNoteCount: 0,
      expectedFolderCount: 2_001
    })).rejects.toBeInstanceOf(RangeError);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reconciles stale claims through the authenticated pending-only action", async () => {
    mocks.getIdToken.mockResolvedValueOnce("firebase-id-token");
    mocks.auth.currentUser = { getIdToken: mocks.getIdToken, uid: profile.uid };
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      hasMore: false,
      leaseGeneration: cutoverLease.leaseGeneration,
      observedClaimCount: 2,
      ok: true,
      removedClaimCount: 2,
      state: "pending"
    }), { headers: { "content-type": "application/json" }, status: 200 }));

    await expect(reconcilePendingVaultIntegrityClaims(profile.uid, cutoverLease.leaseId)).resolves.toEqual({
      leaseGeneration: cutoverLease.leaseGeneration,
      observedClaimCount: 2,
      ok: true,
      passCount: 1,
      removedClaimCount: 2,
      state: "pending"
    });

    const [path, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/vault-integrity");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer firebase-id-token");
    expect(headers.get("x-quickmemo-vault-integrity")).toBe("1");
    expect(JSON.parse(String(init.body))).toEqual({
      action: "reconcile-stale-claims",
      leaseId: cutoverLease.leaseId
    });
  });

  it("enforces one full-inventory reconciliation request per invocation", async () => {
    mocks.getIdToken.mockResolvedValue("firebase-id-token");
    mocks.auth.currentUser = { getIdToken: mocks.getIdToken, uid: profile.uid };
    mocks.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        hasMore: true,
        leaseGeneration: cutoverLease.leaseGeneration,
        observedClaimCount: 400,
        ok: true,
        removedClaimCount: 400,
        state: "pending"
      }), { headers: { "content-type": "application/json" }, status: 200 }));

    await expect(reconcilePendingVaultIntegrityClaims(profile.uid, cutoverLease.leaseId))
      .rejects.toMatchObject({ code: "vault_reconciliation_incomplete", status: 409 });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      hasMore: false,
      leaseGeneration: cutoverLease.leaseGeneration,
      observedClaimCount: 0,
      ok: true,
      removedClaimCount: 0,
      state: "pending",
      targetId: "must-not-be-returned"
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    await expect(reconcilePendingVaultIntegrityClaims(profile.uid, cutoverLease.leaseId))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects reconciliation before fetch when the active user does not match", async () => {
    mocks.auth.currentUser = { getIdToken: mocks.getIdToken, uid: "other-user" };
    await expect(reconcilePendingVaultIntegrityClaims(profile.uid, cutoverLease.leaseId))
      .rejects.toMatchObject({ code: "authentication_required", status: 401 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
