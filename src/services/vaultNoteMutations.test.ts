import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpaqueVaultNoteId,
  mutateVaultNote,
  vaultNoteAccessPayload,
  vaultNoteApiActions,
  VaultNoteApiError,
  vaultNoteBackfillClaimPayload,
  vaultNoteCreatePayload,
  vaultNoteImportCreatePayload,
  vaultNoteLifecyclePayload,
  vaultNoteMigrateLegacyPayload,
  vaultNoteMovePayload,
  vaultNotePurgePayload,
  vaultNoteResolveCollisionPayload,
  vaultNoteSecureCopyCreatePayload,
  vaultNoteSecureCopyLifecyclePayload,
  vaultNoteUpdatePayload,
  type VaultNoteUpdatePayload
} from "./vaultNoteMutations";
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

vi.mock("firebase/app-check", () => ({
  getToken: firebaseMocks.getAppCheckToken
}));

const uid = "owner-a";
const encryptedTitle = {
  algorithm: "AES-GCM" as const,
  cipherText: "encrypted-title",
  iv: "title-iv",
  version: 1 as const
};
const encryptedBody = {
  ...encryptedTitle,
  cipherText: "encrypted-body",
  iv: "body-iv"
};
const wrappedKey = {
  algorithm: "RSA-OAEP" as const,
  version: 1 as const,
  wrappedKey: "wrapped-note-key"
};
const claim = {
  claimId: "C".repeat(43),
  indexVersion: 1 as const,
  parentId: null
};
const createInput = {
  contentFormat: "asset-v1" as const,
  encryptedBody,
  encryptedTitle,
  entryKind: "asset" as const,
  nameClaim: claim,
  ownerUid: uid,
  participantUids: [uid],
  type: "personal" as const,
  wrappedKeys: { [uid]: wrappedKey }
};
const updatePayload: VaultNoteUpdatePayload = {
  action: "update",
  encryptedBody,
  encryptedTitle,
  expectedContentFormat: "markdown-v1",
  expectedEntryKind: "markdown",
  expectedRevision: 4,
  noteId: "note-a",
  readerUids: [uid],
  nameClaim: claim
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("Vault note mutation API client", () => {
  beforeEach(() => {
    firebaseMocks.appCheck = null;
    firebaseMocks.currentUser = {
      uid,
      getIdToken: vi.fn().mockResolvedValue("firebase-id-token")
    };
    firebaseMocks.getAppCheckToken.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("checks create cancellation after a pending auth token and before any request", async () => {
    let finish!: (value: string) => void;
    firebaseMocks.currentUser!.getIdToken = () => new Promise((resolve) => { finish = resolve; });
    const controller = new AbortController();
    const pending = mutateVaultNote(uid, vaultNoteCreatePayload(createInput), undefined, () => controller.signal.throwIfAborted());
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); finish("test-token"); await rejected;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not dispatch an earlier user's mutation after auth changes during token loading", async () => {
    let finish!: (value: string) => void;
    firebaseMocks.currentUser!.getIdToken = () => new Promise((resolve) => { finish = resolve; });
    const pending = mutateVaultNote(uid, vaultNoteCreatePayload(createInput));
    const rejected = expect(pending).rejects.toMatchObject({ code: "authentication_required" });
    firebaseMocks.currentUser = { uid: "another-owner", getIdToken: async () => "other-token" }; finish("old-token");
    await rejected; expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves an already-dispatched create receipt for rollback after the pre-send scope ends", async () => {
    const controller = new AbortController();
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const payload = vaultNoteCreatePayload(createInput);
    const pending = mutateVaultNote(uid, payload, undefined, () => controller.signal.throwIfAborted());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(); finish(jsonResponse({ ok: true, noteId: payload.noteId, revision: 1, lastMutationId: "receipt" }));
    await expect(pending).resolves.toMatchObject({ noteId: payload.noteId, revision: 1, lastMutationId: "receipt" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("publishes every server-owned Vault note mutation action", () => {
    expect(vaultNoteApiActions).toEqual([
      "access",
      "backfill-claim",
      "create",
      "import-create",
      "migrate-legacy",
      "move",
      "purge",
      "resolve-collision",
      "restore",
      "secure-copy-abort",
      "secure-copy-activate",
      "secure-copy-create",
      "trash",
      "update"
    ]);
  });

  it("creates a cryptographically opaque client note id and binds it to create payloads", () => {
    const generated = createOpaqueVaultNoteId();
    expect(generated).toMatch(/^vn1_[A-Za-z0-9_-]{43}$/u);

    const noteId = `vn1_${"N".repeat(43)}`;
    expect(vaultNoteCreatePayload(createInput, noteId)).toEqual(expect.objectContaining({
      action: "create",
      noteId
    }));
    expect(() => vaultNoteCreatePayload(createInput, "predictable-note-id"))
      .toThrow("생성 식별자");

    const vaultPasteLockId = `vpl1_${"L".repeat(43)}`;
    expect(vaultNoteCreatePayload({
      ...createInput,
      folderId: "pasted-images",
      nameClaim: { ...claim, parentId: "pasted-images" },
      vaultPasteLockId
    }, noteId)).toMatchObject({
      folderId: "pasted-images",
      vaultPasteLockId
    });
  });

  it("retries an ambiguous create response once with the exact same opaque id and ciphertext", async () => {
    const noteId = `vn1_${"R".repeat(43)}`;
    const payload = vaultNoteCreatePayload(createInput, noteId);
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(jsonResponse({
        lastMutationId: "history-created",
        noteId,
        ok: true,
        revision: 1
      }));

    await expect(mutateVaultNote(uid, payload)).resolves.toMatchObject({ noteId, revision: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstBody = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body);
    const secondBody = String(vi.mocked(fetch).mock.calls[1]?.[1]?.body);
    expect(secondBody).toBe(firstBody);
    expect(JSON.parse(firstBody)).toEqual(expect.objectContaining({
      encryptedBody,
      encryptedTitle,
      noteId
    }));
  });

  it("retries a timed-out create once with the same idempotent payload", async () => {
    vi.useFakeTimers();
    const noteId = `vn1_${"T".repeat(43)}`;
    const payload = vaultNoteCreatePayload(createInput, noteId);
    vi.mocked(fetch)
      // The hard race must release even a WebKit-like transport that ignores
      // AbortSignal instead of waiting for the fetch promise to reject.
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(jsonResponse({
        lastMutationId: "history-timeout-retry",
        noteId,
        ok: true,
        revision: 1
      }));

    const request = mutateVaultNote(uid, payload);
    await vi.advanceTimersByTimeAsync(VAULT_API_REQUEST_DEADLINE_MS);

    await expect(request).resolves.toMatchObject({ noteId, revision: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))
      .toBe(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
  });

  it("bounds a stalled fetch even when the transport ignores AbortSignal", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));
    const request = mutateVaultNote(uid, updatePayload);
    const rejected = expect(request).rejects.toMatchObject({
      code: "network_timeout",
      status: 0
    });

    await vi.advanceTimersByTimeAsync(VAULT_API_REQUEST_DEADLINE_MS);

    await rejected;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not retry a definitive create conflict", async () => {
    const payload = vaultNoteCreatePayload(createInput, `vn1_${"C".repeat(43)}`);
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      error: "vault_note_conflict",
      ok: false
    }, 409));

    await expect(mutateVaultNote(uid, payload)).rejects.toMatchObject({
      code: "vault_note_conflict",
      status: 409
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends ciphertext unchanged with owner auth, App Check, and no-store controls", async () => {
    firebaseMocks.appCheck = {};
    firebaseMocks.getAppCheckToken.mockResolvedValue({ token: "app-check-token" });
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      lastMutationId: "history-a",
      noteId: "note-a",
      ok: true,
      revision: 5
    }));

    await expect(mutateVaultNote(uid, updatePayload)).resolves.toEqual({
      lastMutationId: "history-a",
      noteId: "note-a",
      ok: true,
      revision: 5
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe("/api/vault-notes");
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    expect(headers.get("authorization")).toBe("Bearer firebase-id-token");
    expect(headers.get("x-firebase-appcheck")).toBe("app-check-token");
    expect(headers.get("x-quickmemo-vault-notes")).toBe("1");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual(updatePayload);
    expect(body).not.toHaveProperty("uid");
    expect(body).not.toHaveProperty("ownerUid");
  });

  it("continues without an App Check header when best-effort token lookup fails", async () => {
    firebaseMocks.appCheck = {};
    firebaseMocks.getAppCheckToken.mockRejectedValue(new Error("unavailable"));
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      lastMutationId: "history-a",
      noteId: "note-a",
      ok: true,
      revision: 5
    }));

    await mutateVaultNote(uid, updatePayload);

    const headers = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
    expect(headers.has("x-firebase-appcheck")).toBe(false);
  });

  it("rejects a missing or mismatched authenticated owner before token or network access", async () => {
    firebaseMocks.currentUser = {
      uid: "different-owner",
      getIdToken: vi.fn().mockResolvedValue("unexpected-token")
    };

    await expect(mutateVaultNote(uid, updatePayload)).rejects.toMatchObject({
      code: "authentication_required",
      status: 401
    });
    expect(firebaseMocks.currentUser.getIdToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a revision conflict to a typed, non-sensitive client error", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      actualRevision: 7,
      error: "revision_conflict",
      ok: false
    }, 409));

    const caught = await mutateVaultNote(uid, updatePayload).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(VaultNoteApiError);
    expect(caught).toMatchObject({
      actualRevision: 7,
      code: "revision_conflict",
      status: 409
    });
    expect((caught as Error).message).toContain("다른 탭");
  });

  it("does not retain malformed conflict metadata from an error response", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      actualRevision: "private-note-title",
      error: "revision_conflict",
      ok: false
    }, 409));

    const caught = await mutateVaultNote(uid, updatePayload).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(VaultNoteApiError);
    expect(caught).not.toHaveProperty("actualRevision", "private-note-title");
    expect((caught as VaultNoteApiError).actualRevision).toBeUndefined();
  });

  it("rejects non-JSON success responses instead of trusting an ambiguous commit", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("ok", {
      headers: { "content-type": "text/plain" },
      status: 200
    }));

    await expect(mutateVaultNote(uid, updatePayload)).rejects.toMatchObject({
      code: "invalid_response",
      status: 200
    });
  });

  it("rejects an HTTP success body that does not affirm the server commit", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      error: "request_failed",
      ok: false
    }));

    await expect(mutateVaultNote(uid, updatePayload)).rejects.toMatchObject({
      code: "invalid_response",
      status: 200
    });
  });

  it("rejects malformed or action-mismatched success bodies", async () => {
    for (const payload of [
      { lastMutationId: "history-a", noteId: "different-note", ok: true, revision: 5 },
      { lastMutationId: "history-a", noteId: "note-a", ok: true, revision: "5" },
      { lastMutationId: "history-a", noteId: "note-a", ok: true, revision: 5, state: "active" }
    ]) {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(payload));
      await expect(mutateVaultNote(uid, updatePayload)).rejects.toMatchObject({
        code: "invalid_response",
        status: 200
      });
    }
  });

  it("preserves AbortSignal cancellation rather than converting it to a retryable error", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    vi.mocked(fetch).mockImplementation(async () => {
      controller.abort(abortError);
      throw abortError;
    });

    await expect(mutateVaultNote(uid, updatePayload, controller.signal)).rejects.toBe(abortError);
  });

  it("bounds a stalled authentication step before any mutation reaches the network", async () => {
    vi.useFakeTimers();
    firebaseMocks.currentUser = {
      uid,
      getIdToken: vi.fn(() => new Promise<string>(() => undefined))
    };
    const request = mutateVaultNote(uid, updatePayload);
    const rejected = expect(request).rejects.toMatchObject({
      code: "network_timeout",
      status: 0
    });

    await vi.advanceTimersByTimeAsync(VAULT_API_REQUEST_DEADLINE_MS);

    await rejected;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("strips client identity fields when adapting existing note mutation inputs", () => {
    const markdownCreateInput = {
      contentFormat: "markdown-v1",
      encryptedBody,
      encryptedTitle,
      entryKind: "markdown",
      nameClaim: claim,
      ownerUid: uid,
      participantUids: [uid],
      type: "personal",
      wrappedKeys: { [uid]: wrappedKey }
    } satisfies Parameters<typeof vaultNoteCreatePayload>[0];
    const createPayload = vaultNoteCreatePayload(markdownCreateInput);
    expect(createPayload).not.toHaveProperty("ownerUid");
    expect(createPayload.noteId).toMatch(/^vn1_[A-Za-z0-9_-]{43}$/u);
    expect(vaultNoteImportCreatePayload(
      markdownCreateInput,
      "import-note-a",
      `vi1_${"I".repeat(43)}`
    )).toEqual(expect.objectContaining({
      action: "import-create",
      importJobId: `vi1_${"I".repeat(43)}`,
      noteId: "import-note-a"
    }));

    expect(vaultNoteAccessPayload({
      expectedRevision: 4,
      folderId: null,
      noteId: "note-a",
      participantUids: [uid],
      type: "personal",
      uid,
      wrappedKeys: { [uid]: wrappedKey }
    }, claim)).toEqual(expect.objectContaining({
      action: "access",
      expectedRevision: 4,
      nameClaim: claim,
      noteId: "note-a"
    }));

    expect(vaultNoteLifecyclePayload({
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: [uid],
      uid,
      vaultPasteLockId: `vpl1_${"L".repeat(43)}`
    }, "trash")).toEqual({
      action: "trash",
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: [uid],
      vaultPasteLockId: `vpl1_${"L".repeat(43)}`
    });
    expect(vaultNoteLifecyclePayload({
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: [uid],
      uid,
      vaultPasteLockId: `vpl1_${"L".repeat(43)}`
    }, "restore")).not.toHaveProperty("vaultPasteLockId");

    expect(vaultNotePurgePayload({
      encryptedBody,
      encryptedTitle,
      expectedRevision: 4,
      noteId: "note-a",
      ownerUid: uid,
      uid,
      wrappedKey
    })).toEqual({
      action: "purge",
      encryptedBody,
      encryptedTitle,
      expectedRevision: 4,
      noteId: "note-a",
      wrappedKey
    });

    expect(vaultNoteUpdatePayload({
      ...updatePayload,
      uid
    })).toEqual(updatePayload);

    expect(vaultNoteMovePayload({
      expectedRevision: 4,
      folderId: null,
      nameClaim: claim,
      noteId: "note-a",
      readerUids: [uid],
      uid
    })).toEqual(expect.objectContaining({
      action: "move",
      nameClaim: claim,
      noteId: "note-a"
    }));

    expect(vaultNoteBackfillClaimPayload({
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 4,
      nameClaim: claim,
      noteId: "note-a",
      readerUids: [uid],
      uid
    })).not.toHaveProperty("uid");

    expect(vaultNoteMigrateLegacyPayload({
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 4,
      nameClaim: claim,
      noteId: "legacy-note",
      readerUids: [uid],
      uid
    })).toEqual(expect.objectContaining({
      action: "migrate-legacy",
      nameClaim: claim,
      noteId: "legacy-note"
    }));

    expect(vaultNoteResolveCollisionPayload({
      changedFields: ["name-claim", "title"],
      encryptedTitle,
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 4,
      nameClaim: claim,
      noteId: "note-a",
      readerUids: [uid],
      uid
    })).toEqual(expect.objectContaining({ action: "resolve-collision" }));

    const secureCopyInput = {
      copyJobId: "secure-copy-job-123456",
      contentFormat: "legacy-html-v1" as const,
      encryptedBody,
      encryptedTitle,
      entryKind: "legacy-html" as const,
      expectedAttachmentCount: 2,
      noteId: "copy-note-a",
      nameClaim: claim,
      ownerUid: uid,
      participantUids: [uid],
      type: "personal" as const,
      wrappedKeys: { [uid]: wrappedKey }
    } satisfies Parameters<typeof vaultNoteSecureCopyCreatePayload>[0];
    expect(vaultNoteSecureCopyCreatePayload(secureCopyInput)).not.toHaveProperty("ownerUid");
    expect(vaultNoteSecureCopyLifecyclePayload({
      copyJobId: secureCopyInput.copyJobId,
      expectedRevision: 1,
      noteId: "copy-note-a",
      uid
    }, "secure-copy-activate")).toEqual({
      action: "secure-copy-activate",
      copyJobId: secureCopyInput.copyJobId,
      expectedRevision: 1,
      noteId: "copy-note-a"
    });
  });
});
