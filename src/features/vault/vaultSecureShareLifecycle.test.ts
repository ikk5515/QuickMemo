import { describe, expect, it, vi } from "vitest";
import type { SecureShareOwnerSummary } from "../../types";
import {
  revokeVaultSecureSharesBeforeSourcesTrash,
  revokeVaultSecureSharesBeforeTrash,
  vaultSecureShareRequiresRevocation
} from "./vaultSecureShareLifecycle";

const now = Date.parse("2026-08-24T00:00:00.000Z");

function share(overrides: Partial<SecureShareOwnerSummary> = {}): SecureShareOwnerSummary {
  return {
    accessMode: "anyone_with_link",
    attachmentCount: 0,
    consumedAt: null,
    contentRevision: 1,
    createdAt: "2026-08-23T00:00:00.000Z",
    currentGeneration: "generation-a",
    downloadAllowed: true,
    expiresAt: "2026-08-31T00:00:00.000Z",
    hasPassword: false,
    lastAccessAt: null,
    oneTimeEnabled: false,
    permissionLevel: "view",
    policyVersion: 1,
    quickCopyButtonVisible: true,
    ready: true,
    requiresEmailVerification: false,
    revokedAt: null,
    schemaVersion: 2,
    shareId: "share-a1",
    showCommenterIpPrefix: false,
    sourceAttachmentRevision: 0,
    sourceNoteId: "note-a1",
    sourceRevision: 4,
    status: "active",
    successfulAccessCount: 0,
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...overrides
  };
}

function response(summary: SecureShareOwnerSummary) {
  return { ok: true, share: summary };
}

describe("Vault Secure Share trash lifecycle", () => {
  it("treats active, pending, and consumed unexpired snapshots as revocable", () => {
    expect(vaultSecureShareRequiresRevocation(share(), now)).toBe(true);
    expect(vaultSecureShareRequiresRevocation(share({ status: "pending" }), now)).toBe(true);
    expect(vaultSecureShareRequiresRevocation(share({ status: "consumed" }), now)).toBe(true);
    expect(vaultSecureShareRequiresRevocation(share({ status: "expired" }), now)).toBe(false);
  });

  it("does not request an identity token when the server disables v2 access", async () => {
    const getIdToken = vi.fn();
    const listShares = vi.fn();
    await expect(revokeVaultSecureSharesBeforeTrash({
      getIdToken,
      sourceNoteId: "note-a1"
    }, {
      featureStatus: vi.fn().mockResolvedValue({ emailEnabled: false, v2Enabled: false }),
      listShares,
      revokeShare: vi.fn()
    })).resolves.toBe(0);
    expect(getIdToken).not.toHaveBeenCalled();
    expect(listShares).not.toHaveBeenCalled();
  });

  it("revokes every live source snapshot and strictly verifies the response", async () => {
    const active = share();
    const consumed = share({ shareId: "share-b2", status: "consumed" });
    const expired = share({ expiresAt: "2026-08-20T00:00:00.000Z", shareId: "share-c3", status: "expired" });
    const revokeShare = vi.fn(async (shareId: string) => response(share({
      ready: false,
      revokedAt: "2026-08-24T01:00:00.000Z",
      shareId,
      status: "revoked"
    })));

    await expect(revokeVaultSecureSharesBeforeTrash({
      getIdToken: vi.fn().mockResolvedValue("token"),
      now,
      sourceNoteId: "note-a1"
    }, {
      featureStatus: vi.fn().mockResolvedValue({ emailEnabled: true, v2Enabled: true }),
      listShares: vi.fn().mockResolvedValue({ nextCursor: null, ok: true, shares: [active, consumed, expired] }),
      revokeShare
    })).resolves.toBe(2);
    expect(revokeShare).toHaveBeenCalledTimes(2);
  });

  it("blocks trash when history or revocation identity does not match the source", async () => {
    const dependencies = {
      featureStatus: vi.fn().mockResolvedValue({ emailEnabled: true, v2Enabled: true }),
      listShares: vi.fn().mockResolvedValue({ nextCursor: null, ok: true, shares: [share()] }),
      revokeShare: vi.fn().mockResolvedValue(response(share({ sourceNoteId: "note-other", status: "revoked" })))
    };
    await expect(revokeVaultSecureSharesBeforeTrash({
      getIdToken: vi.fn().mockResolvedValue("token"),
      now,
      sourceNoteId: "note-a1"
    }, dependencies)).rejects.toThrow("중단 상태");
  });

  it("checks a folder's source histories with one feature and token request", async () => {
    const getIdToken = vi.fn().mockResolvedValue("token");
    const listShares = vi.fn(async (_token: string, options?: { sourceNoteId?: string }) => ({
      nextCursor: null,
      ok: true,
      shares: [share({
        shareId: options?.sourceNoteId === "note-a1" ? "share-a1" : "share-b2",
        sourceNoteId: options?.sourceNoteId ?? ""
      })]
    }));
    const revokeShare = vi.fn(async (shareId: string) => response(share({
      ready: false,
      revokedAt: "2026-08-24T01:00:00.000Z",
      shareId,
      sourceNoteId: shareId === "share-a1" ? "note-a1" : "note-b2",
      status: "revoked"
    })));
    const featureStatus = vi.fn().mockResolvedValue({ emailEnabled: true, v2Enabled: true });

    await expect(revokeVaultSecureSharesBeforeSourcesTrash({
      getIdToken,
      now,
      sourceNoteIds: ["note-a1", "note-b2"]
    }, { featureStatus, listShares, revokeShare })).resolves.toBe(2);
    expect(featureStatus).toHaveBeenCalledTimes(1);
    expect(getIdToken).toHaveBeenCalledTimes(1);
    expect(listShares).toHaveBeenCalledTimes(2);
    expect(revokeShare).toHaveBeenCalledTimes(2);
  });
});
