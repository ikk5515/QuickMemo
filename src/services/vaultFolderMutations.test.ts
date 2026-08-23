import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditVaultFolderTreeServer,
  ensureVaultFolderTree,
  invalidateVaultFolderTreeReadiness,
  mutateVaultFolder,
  repairVaultFolderTree
} from "./vaultFolderMutations";

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
      controller.abort();
      throw abortError;
    });

    await expect(mutateVaultFolder(uid, {
      action: "trash",
      expectedRevision: 1,
      folderId: "folder-a"
    }, controller.signal)).rejects.toBe(abortError);
  });
});
