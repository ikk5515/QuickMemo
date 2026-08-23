import { afterEach, describe, expect, it, vi } from "vitest";
import { logVaultApiRejection } from "../../api/_vault-api-observability.js";
import {
  parseVaultIntegrityMarker,
  requireVaultCutoverLease,
  requireVaultIntegrityMarker,
  vaultCutoverLeaseCredential
} from "../../api/_vault-integrity-marker.js";
import { __vaultIntegrityTesting } from "../../api/vault-integrity.js";

const uid = "user-a";
const timestamp = "2026-08-23T00:00:00.000Z";
const wrappedKey = {
  algorithm: "RSA-OAEP",
  version: 1,
  wrappedKey: "wrapped-value"
};
const legacyMarker = {
  createdAt: timestamp,
  indexVersion: 1,
  ownerUid: uid,
  updatedAt: timestamp,
  wrappedKey
};
const pendingMarker = {
  ...legacyMarker,
  cutoverState: "pending",
  cutoverVersion: 1
};
const readyMarker = {
  ...legacyMarker,
  cutoverState: "ready",
  cutoverVersion: 1,
  verifiedAt: timestamp
};
const leaseId = "l".repeat(43);
const leaseGeneration = "g".repeat(43);
const leaseCredential = vaultCutoverLeaseCredential(leaseId, leaseGeneration);
const leasedPendingMarker = {
  ...pendingMarker,
  cutoverLeaseAcquiredAt: timestamp,
  cutoverLeaseExpiresAt: "2026-08-23T00:01:30.000Z",
  cutoverLeaseGeneration: leaseGeneration,
  cutoverLeaseHash: leaseCredential.hash,
  cutoverLeaseVersion: 1
};

function claimId(index: number) {
  return String(index).padStart(43, "0");
}

function activeNote(index: number, override: Record<string, unknown> = {}) {
  return {
    __id: `note-${index}`,
    contentFormat: "markdown-v1",
    encryptedBody: { version: 1 },
    encryptedTitle: { version: 1 },
    entryKind: "markdown",
    folderId: null,
    isDeleted: false,
    ownerUid: uid,
    type: "personal",
    vaultNameClaimId: claimId(index),
    vaultNameIndexVersion: 1,
    ...override
  };
}

function entryClaim(index: number, override: Record<string, unknown> = {}) {
  return {
    __id: claimId(index),
    indexVersion: 1,
    ownerUid: uid,
    parentId: null,
    targetId: `note-${index}`,
    targetType: "entry",
    ...override
  };
}

function emptyTree() {
  return {
    folderCount: 0,
    nodes: {},
    ownerUid: uid,
    revision: 1,
    schemaVersion: 1
  };
}

function validate(
  notes: Array<Record<string, unknown>>,
  claims: Array<Record<string, unknown>>,
  expectedActiveNoteCount = notes.length
) {
  return __vaultIntegrityTesting.validateVaultIntegrityInventory(
    uid,
    { claims, folders: [], notes, treeDocument: emptyTree() },
    {
      expectedActiveNoteCount,
      expectedDeletedNoteCount: 0,
      expectedFolderCount: 0
    }
  );
}

function expectConflict(action: () => unknown, code: string) {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code, statusCode: 409 });
    return;
  }

  throw new Error(`Expected ${code}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Vault integrity marker backend contract", () => {
  it("strictly distinguishes legacy, pending, and ready markers", () => {
    expect(parseVaultIntegrityMarker(legacyMarker, uid)).toMatchObject({ legacy: true, state: "pending" });
    expect(parseVaultIntegrityMarker(pendingMarker, uid)).toMatchObject({ legacy: false, state: "pending" });
    expect(parseVaultIntegrityMarker(leasedPendingMarker, uid)).toMatchObject({
      lease: { generation: leaseGeneration, hash: leaseCredential.hash, version: 1 },
      legacy: false,
      state: "pending"
    });
    expect(parseVaultIntegrityMarker(readyMarker, uid)).toMatchObject({ legacy: false, state: "ready" });
    expect(requireVaultIntegrityMarker(readyMarker, uid, "ready")).toMatchObject({ state: "ready" });
    expectConflict(() => requireVaultIntegrityMarker(pendingMarker, uid, "ready"), "vault_integrity_not_ready");
    expect(requireVaultCutoverLease(
      leasedPendingMarker,
      uid,
      leaseCredential,
      Date.parse("2026-08-23T00:00:30.000Z")
    )).toMatchObject({ state: "pending" });
  });

  it.each([
    ["legacy extra field", { ...legacyMarker, extra: true }],
    ["legacy cutover state without version", { ...legacyMarker, cutoverState: "pending" }],
    ["legacy cutover version without state", { ...legacyMarker, cutoverVersion: 1 }],
    ["pending extra field", { ...pendingMarker, extra: true }],
    ["leased pending raw token", { ...leasedPendingMarker, cutoverLeaseId: leaseId }],
    ["leased pending invalid generation", { ...leasedPendingMarker, cutoverLeaseGeneration: "short" }],
    ["pending with ready state but no attestation", { ...pendingMarker, cutoverState: "ready" }],
    ["ready without verifiedAt", { ...readyMarker, verifiedAt: undefined }],
    ["ready with an invalid verifiedAt", { ...readyMarker, verifiedAt: "not-a-timestamp" }],
    ["wrapped key with an extra field", { ...legacyMarker, wrappedKey: { ...wrappedKey, plaintext: "secret" } }]
  ])("rejects the partial or non-exact %s shape", (_label, marker) => {
    expectConflict(() => parseVaultIntegrityMarker(marker, uid), "vault_integrity_invalid");
  });
});

describe("Vault integrity inventory attestation", () => {
  it("accepts a bijective active note claim only when the target type is entry", () => {
    expect(validate([activeNote(1)], [entryClaim(1)])).toEqual({
      activeNoteCount: 1,
      deletedNoteCount: 0,
      folderCount: 0
    });

    expectConflict(
      () => validate([activeNote(1)], [entryClaim(1, { targetType: "folder" })]),
      "vault_claim_invalid"
    );
  });

  it("rejects orphan and mismatched claims", () => {
    expectConflict(
      () => validate([activeNote(1)], [entryClaim(1), entryClaim(2)]),
      "vault_claim_invalid"
    );
    expectConflict(
      () => validate([activeNote(1)], [entryClaim(1, { targetId: "different-note" })]),
      "vault_claim_invalid"
    );
  });

  it("rejects duplicate claim ids and duplicate claim targets", () => {
    expectConflict(
      () => validate(
        [activeNote(1), activeNote(2, { vaultNameClaimId: claimId(1) })],
        [entryClaim(1), entryClaim(2, { __id: claimId(1) })]
      ),
      "vault_claim_invalid"
    );
    expectConflict(
      () => validate(
        [activeNote(1)],
        [entryClaim(1), entryClaim(2, { targetId: "note-1" })]
      ),
      "vault_claim_invalid"
    );
  });

  it("validates the maximum 20,000-note and 20,000-claim fixture within a generous budget", () => {
    const notes = Array.from({ length: 20_000 }, (_, index) => activeNote(index));
    const claims = Array.from({ length: 20_000 }, (_, index) => entryClaim(index));
    const startedAt = performance.now();

    expect(validate(notes, claims, 20_000)).toEqual({
      activeNoteCount: 20_000,
      deletedNoteCount: 0,
      folderCount: 0
    });
    expect(performance.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);

  it("keeps server inventory queries bounded above the accepted maximum", () => {
    expect(__vaultIntegrityTesting.noteInventoryQuery(uid)).toMatchObject({ limit: 20_001 });
    expect(__vaultIntegrityTesting.folderInventoryQuery(uid)).toMatchObject({ limit: 2_001 });
    expect(__vaultIntegrityTesting.claimInventoryQuery()).toMatchObject({ limit: 25_001 });
  });
});

describe("Vault API conflict observability", () => {
  it("logs only allowlisted operational fields and excludes request PII", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sensitiveValues = [
      "uid-private",
      "note-private",
      "folder-private",
      "private-title",
      "/private/path.md",
      "ciphertext-private",
      "content-private",
      "token-private"
    ];

    logVaultApiRejection({
      action: "seal-ready",
      error: {
        body: {
          ciphertext: sensitiveValues[5],
          content: sensitiveValues[6],
          folderId: sensitiveValues[2],
          noteId: sensitiveValues[1],
          path: sensitiveValues[4],
          title: sensitiveValues[3],
          token: sensitiveValues[7],
          uid: sensitiveValues[0]
        },
        code: "vault_claim_invalid",
        message: sensitiveValues.join(" "),
        statusCode: 409
      },
      requestId: "request-safe-001",
      route: "/api/vault-integrity",
      supportedActions: new Set(["seal-ready"])
    });

    expect(warn).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      "action",
      "errorCode",
      "event",
      "requestId",
      "route",
      "statusCode"
    ]);
    expect(payload).toEqual({
      action: "seal-ready",
      errorCode: "vault_claim_invalid",
      event: "vault_request_rejected",
      requestId: "request-safe-001",
      route: "/api/vault-integrity",
      statusCode: 409
    });
    for (const sensitiveValue of sensitiveValues) {
      expect(JSON.stringify(payload)).not.toContain(sensitiveValue);
    }
  });

  it("normalizes unknown action and error taxonomies and ignores non-conflicts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const supportedActions = new Set(["seal-ready"]);

    logVaultApiRejection({
      action: "private-note-id",
      error: { code: "private-error", statusCode: 409 },
      requestId: "request-safe-002",
      route: "/api/vault-integrity",
      supportedActions
    });
    logVaultApiRejection({
      action: "seal-ready",
      error: { code: "vault_claim_invalid", statusCode: 400 },
      requestId: "request-safe-003",
      route: "/api/vault-integrity",
      supportedActions
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      action: "unknown",
      errorCode: "request_failed",
      statusCode: 409
    });
  });
});
