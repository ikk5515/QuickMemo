import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireVaultPastedImageFolderLock,
  auditVaultFolderTreeServer,
  ensureVaultFolderTree,
  invalidateVaultFolderTreeReadiness,
  mutateVaultFolder,
  releaseVaultPastedImageFolderLock,
  repairVaultFolderTree
} from "./vaultFolderMutations";
import { VAULT_API_REQUEST_DEADLINE_MS } from "./vaultApiDeadline";

const firebaseMocks = vi.hoisted(() => ({
  appCheck: null as object | null,
  currentUser: null as { uid: string; getIdToken: () => Promise<string> } | null,
  getAppCheckToken: vi.fn()
}));

vi.mock("../lib/firebase", () => ({
  get appCheck() {
    return firebaseMocks.appCheck;
  },
  auth: {
    get currentUser() {
      return firebaseMocks.currentUser;
    }
  }
}));

vi.mock("firebase/app-check", () => ({ getToken: firebaseMocks.getAppCheckToken }));

const uid = "owner-a";
const pasteLockId = `vpl1_${"P".repeat(43)}`;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("Vault folder mutation API client", () => {
  beforeEach(() => {
    firebaseMocks.appCheck = null;
    firebaseMocks.currentUser = {
      uid,
      getIdToken: vi.fn().mockResolvedValue("firebase-id-token")
    };
    firebaseMocks.getAppCheckToken.mockReset();
    invalidateVaultFolderTreeReadiness(uid);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    invalidateVaultFolderTreeReadiness(uid);
    vi.unstubAllGlobals();
  });

  it("accepts the exact bootstrap and audit contracts", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        folderCount: 0,
        maximumFolderCount: 2_000,
        ok: true,
        revision: 0,
        schemaVersion: 1,
        status: "ready"
      }))
      .mockResolvedValueOnce(jsonResponse({
        folderCount: 0,
        matches: true,
        maximumFolderCount: 2_000,
        ok: true,
        revision: 0,
        schemaVersion: 1,
        status: "ok"
      }));

    await expect(ensureVaultFolderTree(uid)).resolves.toMatchObject({ status: "ready" });
    await expect(auditVaultFolderTreeServer(uid)).resolves.toMatchObject({ matches: true });
  });

  it("keeps valid readiness cached and uses an explicit uncached repair request", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        folderCount: 3,
        maximumFolderCount: 2_000,
        ok: true,
        revision: 7,
        schemaVersion: 1,
        status: "ready"
      }))
      .mockResolvedValueOnce(jsonResponse({
        folderCount: 4,
        maximumFolderCount: 2_000,
        ok: true,
        revision: 8,
        schemaVersion: 1,
        status: "created"
      }));

    await expect(ensureVaultFolderTree(uid)).resolves.toMatchObject({ revision: 7 });
    await expect(ensureVaultFolderTree(uid)).resolves.toMatchObject({ revision: 7 });
    expect(fetch).toHaveBeenCalledOnce();

    await expect(repairVaultFolderTree(uid)).resolves.toMatchObject({ revision: 8 });
    await expect(ensureVaultFolderTree(uid)).resolves.toMatchObject({ revision: 8 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body)))
      .toEqual({ action: "repair" });
  });

  it("rejects malformed, extra-field, and target-mismatched successes", async () => {
    const payload = {
      action: "trash" as const,
      expectedRevision: 1,
      folderId: "folder-a"
    };
    for (const body of [
      { folderId: "folder-a", maximumFolderCount: 2_000, ok: true, revision: 2, schemaVersion: 1 },
      { folderId: "folder-b", maximumFolderCount: 2_000, ok: true, revision: 2, schemaVersion: 1, treeRevision: 2 },
      { folderId: "folder-a", maximumFolderCount: 2_000, ok: true, revision: 2, schemaVersion: 1, treeRevision: 2, privateData: "never-trust" }
    ]) {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(body));
      await expect(mutateVaultFolder(uid, payload)).rejects.toMatchObject({
        code: "invalid_response",
        status: 200
      });
    }
  });

  it("preserves an aborted fetch without converting it to a retryable error", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    vi.mocked(fetch).mockImplementation(async () => {
      controller.abort(abortError);
      throw abortError;
    });

    await expect(mutateVaultFolder(uid, {
      action: "trash",
      expectedRevision: 1,
      folderId: "folder-a"
    }, controller.signal)).rejects.toBe(abortError);
  });

  it("bounds a stalled authentication step before a folder mutation reaches the network", async () => {
    vi.useFakeTimers();
    firebaseMocks.currentUser = {
      uid,
      getIdToken: vi.fn(() => new Promise<string>(() => undefined))
    };
    const request = mutateVaultFolder(uid, {
      action: "trash",
      expectedRevision: 1,
      folderId: "folder-a"
    });
    const rejected = expect(request).rejects.toMatchObject({
      code: "network_timeout",
      status: 0
    });

    await vi.advanceTimersByTimeAsync(VAULT_API_REQUEST_DEADLINE_MS);

    await rejected;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds a stalled folder fetch even when the transport ignores AbortSignal", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));
    const request = mutateVaultFolder(uid, {
      action: "trash",
      expectedRevision: 1,
      folderId: "folder-a"
    });
    const rejected = expect(request).rejects.toMatchObject({
      code: "network_timeout",
      status: 0
    });

    await vi.advanceTimersByTimeAsync(VAULT_API_REQUEST_DEADLINE_MS);

    await rejected;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries a timed-out folder create once with the exact same payload", async () => {
    vi.useFakeTimers();
    const payload = {
      action: "create" as const,
      color: "#8b82f6",
      encryptedName: {
        algorithm: "AES-GCM" as const,
        cipherText: "encrypted-folder-name",
        iv: "folder-name-iv",
        version: 1 as const
      },
      folderId: "folder-a",
      nameClaim: {
        claimId: "C".repeat(43),
        indexVersion: 1 as const,
        parentId: null
      },
      order: 0,
      parentId: null,
      wrappedKey: {
        algorithm: "RSA-OAEP" as const,
        version: 1 as const,
        wrappedKey: "wrapped-folder-key"
      }
    };
    vi.mocked(fetch)
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(jsonResponse({
        folderId: "folder-a",
        maximumFolderCount: 2_000,
        ok: true,
        revision: 1,
        schemaVersion: 1,
        treeRevision: 1
      }));

    const request = mutateVaultFolder(uid, payload);
    await vi.advanceTimersByTimeAsync(VAULT_API_REQUEST_DEADLINE_MS);

    await expect(request).resolves.toMatchObject({ folderId: "folder-a", revision: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))
      .toBe(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
  });

  it("sends exact acquire and release lock payloads through the authenticated API boundary", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        folderId: "folder-a",
        maximumFolderCount: 2_000,
        ok: true,
        revision: 7,
        schemaVersion: 1,
        treeRevision: 11
      }))
      .mockResolvedValueOnce(jsonResponse({
        folderId: "folder-a",
        maximumFolderCount: 2_000,
        ok: true,
        revision: 7,
        schemaVersion: 1,
        treeRevision: 11
      }));

    await expect(acquireVaultPastedImageFolderLock(uid, {
      expectedRevision: 7,
      folderId: "folder-a",
      lockId: pasteLockId
    })).resolves.toEqual(expect.objectContaining({ revision: 7, treeRevision: 11 }));
    await expect(releaseVaultPastedImageFolderLock(uid, {
      folderId: "folder-a",
      lockId: pasteLockId
    })).resolves.toEqual(expect.objectContaining({ revision: 7, treeRevision: 11 }));

    expect(vi.mocked(fetch).mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)))).toEqual([
      {
        action: "paste-lock-acquire",
        expectedRevision: 7,
        folderId: "folder-a",
        lockId: pasteLockId
      },
      {
        action: "paste-lock-release",
        folderId: "folder-a",
        lockId: pasteLockId
      }
    ]);
    const headers = new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer firebase-id-token");
    expect(headers.get("x-quickmemo-vault-folder-tree")).toBe("1");
  });

  it("retries acquire exactly once for each ambiguous transport or response failure", async () => {
    const success = () => jsonResponse({
      folderId: "folder-a",
      maximumFolderCount: 2_000,
      ok: true,
      revision: 7,
      schemaVersion: 1,
      treeRevision: 11
    });
    const ambiguousFailures: Array<() => Promise<Response>> = [
      () => Promise.reject(new Error("connection reset")),
      () => Promise.resolve(jsonResponse({ ok: true })),
      () => Promise.resolve(jsonResponse({ error: "service_unavailable" }, 503))
    ];

    for (const ambiguousFailure of ambiguousFailures) {
      vi.mocked(fetch)
        .mockImplementationOnce(ambiguousFailure)
        .mockResolvedValueOnce(success());
      await expect(acquireVaultPastedImageFolderLock(uid, {
        expectedRevision: 7,
        folderId: "folder-a",
        lockId: pasteLockId
      })).resolves.toMatchObject({ folderId: "folder-a", revision: 7 });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))
        .toBe(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
      vi.mocked(fetch).mockReset();
    }
  });

  it("retries a timed-out acquire once with the same lock id", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(jsonResponse({
        folderId: "folder-a",
        maximumFolderCount: 2_000,
        ok: true,
        revision: 7,
        schemaVersion: 1,
        treeRevision: 11
      }));

    const request = acquireVaultPastedImageFolderLock(uid, {
      expectedRevision: 7,
      folderId: "folder-a",
      lockId: pasteLockId
    });
    await vi.advanceTimersByTimeAsync(VAULT_API_REQUEST_DEADLINE_MS);

    await expect(request).resolves.toMatchObject({ folderId: "folder-a", revision: 7 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))
      .toBe(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
  });

  it("does not retry an explicitly aborted acquire or a definitive conflict", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("cancelled", "AbortError");
    vi.mocked(fetch).mockImplementationOnce(async () => {
      controller.abort(abortError);
      throw abortError;
    });
    await expect(acquireVaultPastedImageFolderLock(uid, {
      expectedRevision: 7,
      folderId: "folder-a",
      lockId: pasteLockId
    }, controller.signal)).rejects.toBe(abortError);
    expect(fetch).toHaveBeenCalledOnce();

    vi.mocked(fetch).mockReset().mockResolvedValueOnce(jsonResponse({
      error: "vault_paste_locked"
    }, 409));
    await expect(acquireVaultPastedImageFolderLock(uid, {
      expectedRevision: 7,
      folderId: "folder-a",
      lockId: pasteLockId
    })).rejects.toMatchObject({ code: "vault_paste_locked", status: 409 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries a matching release once when its response may have been lost", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("connection reset after commit"))
      .mockResolvedValueOnce(jsonResponse({
        folderId: "folder-a",
        maximumFolderCount: 2_000,
        ok: true,
        revision: 7,
        schemaVersion: 1,
        treeRevision: 11
      }));

    await expect(releaseVaultPastedImageFolderLock(uid, {
      folderId: "folder-a",
      lockId: pasteLockId
    })).resolves.toMatchObject({ folderId: "folder-a", revision: 7 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))
      .toBe(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
  });

  it("rejects extra lock response fields instead of trusting server metadata", async () => {
    const malformedResponse = () => jsonResponse({
      expiresAt: "2099-01-01T00:00:00.000Z",
      folderId: "folder-a",
      maximumFolderCount: 2_000,
      ok: true,
      revision: 7,
      schemaVersion: 1,
      treeRevision: 11
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(malformedResponse())
      .mockResolvedValueOnce(malformedResponse());

    await expect(acquireVaultPastedImageFolderLock(uid, {
      expectedRevision: 7,
      folderId: "folder-a",
      lockId: pasteLockId
    })).rejects.toMatchObject({ code: "invalid_response", status: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a lock request when the authenticated user is not the owner", async () => {
    await expect(acquireVaultPastedImageFolderLock("other-owner", {
      expectedRevision: 7,
      folderId: "folder-a",
      lockId: pasteLockId
    })).rejects.toMatchObject({ code: "authentication_required", status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
