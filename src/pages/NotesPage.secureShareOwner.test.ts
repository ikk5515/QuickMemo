import { describe, expect, it } from "vitest";
import {
  canCreateSecureShareFromHistory,
  parseSecureShareListResponse,
  parseSecureShareMutationResponse,
  parseSecureShareOwnerDetailsResponse,
  parseSecureShareOwnerSummary,
  resolveSecureShareManagementSelection,
  secureShareManagementCapabilities,
  secureShareManagementStatus
} from "./NotesPage";

const validSummary = {
  accessMode: "anyone_with_link",
  attachmentCount: 1,
  consumedAt: null,
  createdAt: "2026-07-28T00:00:00.000Z",
  downloadAllowed: false,
  expiresAt: "2026-07-29T00:00:00.000Z",
  hasPassword: true,
  lastAccessAt: null,
  oneTimeEnabled: false,
  ownerWrappedShareKey: {
    version: 1,
    algorithm: "RSA-OAEP",
    wrappedKey: "wrapped-owner-key"
  },
  permissionLevel: "comment",
  policyVersion: 1,
  quickCopyButtonVisible: false,
  ready: true,
  requiresEmailVerification: false,
  revokedAt: null,
  schemaVersion: 2,
  shareId: "ss2_secure_share_123456",
  showCommenterIpPrefix: true,
  sourceAttachmentRevision: 3,
  sourceNoteId: "note_123456",
  sourceRevision: 7,
  status: "active",
  successfulAccessCount: 0,
  updatedAt: "2026-07-28T00:00:01.000Z"
};
const validAttachmentReuseManifest = {
  id: "attachment_public_123456",
  sourceAttachmentId: "attachment_source_123456",
  digest: "D".repeat(43),
  sourceEncryptionVersion: 2
};

describe("Secure Share v2 owner DTO boundary", () => {
  it("accepts a complete server-authoritative owner summary", () => {
    expect(parseSecureShareOwnerSummary(validSummary)).toMatchObject({
      schemaVersion: 2,
      shareId: validSummary.shareId,
      showCommenterIpPrefix: true,
      sourceRevision: 7,
      ownerWrappedShareKey: validSummary.ownerWrappedShareKey
    });
  });

  it("defaults legacy owner summaries to hidden prefixes and rejects invalid values", () => {
    const legacySummary = { ...validSummary } as Record<string, unknown>;
    delete legacySummary.showCommenterIpPrefix;

    expect(parseSecureShareOwnerSummary(legacySummary))
      .toMatchObject({ showCommenterIpPrefix: false });
    expect(parseSecureShareOwnerSummary({
      ...validSummary,
      permissionLevel: "view",
      showCommenterIpPrefix: true
    })).toMatchObject({ showCommenterIpPrefix: false });
    expect(() => parseSecureShareOwnerSummary({
      ...validSummary,
      showCommenterIpPrefix: "true"
    })).toThrow(/필드가 올바르지/);
  });

  it("rejects schema downgrade, invalid timestamps, and mismatched mutations", () => {
    expect(() => parseSecureShareOwnerSummary({ ...validSummary, schemaVersion: 1 })).toThrow();
    expect(() => parseSecureShareOwnerSummary({ ...validSummary, expiresAt: "not-a-date" })).toThrow();
    expect(() => parseSecureShareMutationResponse(
      { ok: true, share: validSummary },
      "ss2_another_share"
    )).toThrow(/대상이 일치/);
  });

  it("validates owner lists before exposing them to UI state", () => {
    expect(parseSecureShareListResponse({
      ok: true,
      shares: [validSummary],
      nextCursor: null
    })).toHaveLength(1);
    expect(() => parseSecureShareListResponse({
      ok: true,
      shares: [{ ...validSummary, ready: "yes" }],
      nextCursor: null
    })).toThrow();
  });

  it("maps owner-only policy details into the settings modal contract", () => {
    const details = parseSecureShareOwnerDetailsResponse({
      ok: true,
      share: {
        ...validSummary,
        accessMode: "allowed_emails",
        requiresEmailVerification: true
      },
      policy: {
        allowedEmails: ["viewer@example.com"],
        customExpiresAt: validSummary.expiresAt,
        expirationPreset: "custom"
      },
      attachmentReuseManifests: [validAttachmentReuseManifest]
    });

    expect(details.initialPolicy).toMatchObject({
      accessMode: "allowed_emails",
      allowedEmails: ["viewer@example.com"],
      passwordEnabled: true,
      permissionLevel: "comment",
      showCommenterIpPrefix: true
    });
  });

  it("maps a missing legacy prefix policy to false in the settings contract", () => {
    const legacyShare = { ...validSummary } as Record<string, unknown>;
    delete legacyShare.showCommenterIpPrefix;

    const details = parseSecureShareOwnerDetailsResponse({
      ok: true,
      share: legacyShare,
      policy: {
        allowedEmails: [],
        expirationPreset: "seven_days"
      },
      attachmentReuseManifests: [validAttachmentReuseManifest]
    });

    expect(details.initialPolicy.showCommenterIpPrefix).toBe(false);
  });

  it("accepts only minimal owner attachment reuse manifests", () => {
    const details = parseSecureShareOwnerDetailsResponse({
      ok: true,
      share: validSummary,
      policy: { allowedEmails: [], expirationPreset: "seven_days" },
      attachmentReuseManifests: [validAttachmentReuseManifest]
    });

    expect(details.attachmentReuseManifests).toEqual([validAttachmentReuseManifest]);
    expect(() => parseSecureShareOwnerDetailsResponse({
      ok: true,
      share: validSummary,
      policy: { allowedEmails: [], expirationPreset: "seven_days" },
      attachmentReuseManifests: [{
        ...validAttachmentReuseManifest,
        blobUrl: "https://blob.example/private"
      }]
    })).toThrow(/상세 응답/);
    expect(() => parseSecureShareOwnerDetailsResponse({
      ok: true,
      share: validSummary,
      policy: { allowedEmails: [], expirationPreset: "seven_days" },
      attachmentReuseManifests: [{
        id: validAttachmentReuseManifest.id,
        sourceAttachmentId: validAttachmentReuseManifest.sourceAttachmentId
      }]
    })).toThrow(/첨부파일 상세 응답/);
  });

  it("derives display status and action availability from server state plus expiration", () => {
    const active = parseSecureShareOwnerSummary(validSummary);
    const consumed = parseSecureShareOwnerSummary({
      ...validSummary,
      consumedAt: "2026-07-28T00:30:00.000Z",
      shareId: "ss2_consumed_share_123456",
      status: "consumed"
    });
    const expired = parseSecureShareOwnerSummary({
      ...validSummary,
      expiresAt: "2026-07-27T23:59:59.000Z",
      shareId: "ss2_expired_share_123456"
    });
    const revoked = parseSecureShareOwnerSummary({
      ...validSummary,
      expiresAt: "2026-07-27T23:59:59.000Z",
      revokedAt: "2026-07-27T23:00:00.000Z",
      shareId: "ss2_revoked_share_123456",
      status: "revoked"
    });
    const now = Date.parse("2026-07-28T01:00:00.000Z");

    expect(secureShareManagementStatus(active, now)).toBe("active");
    expect(secureShareManagementStatus(expired, now)).toBe("expired");
    expect(secureShareManagementStatus(revoked, now)).toBe("revoked");
    expect(secureShareManagementCapabilities(active, now)).toMatchObject({
      canCopy: true,
      canEdit: true,
      canPreview: true,
      canRevoke: true
    });
    expect(secureShareManagementCapabilities(consumed, now)).toMatchObject({
      canCopy: false,
      canEdit: false,
      canPreview: true,
      canRevoke: true
    });
    expect(secureShareManagementCapabilities(expired, now)).toMatchObject({
      canCopy: false,
      canEdit: false,
      canPreview: false,
      canRevoke: false
    });
  });

  it("allows a new share only when no active or pending share remains", () => {
    const consumed = parseSecureShareOwnerSummary({
      ...validSummary,
      consumedAt: "2026-07-28T00:30:00.000Z",
      shareId: "ss2_consumed_share_123456",
      status: "consumed"
    });
    const revoked = parseSecureShareOwnerSummary({
      ...validSummary,
      revokedAt: "2026-07-28T00:30:00.000Z",
      shareId: "ss2_revoked_share_123456",
      status: "revoked"
    });
    const pending = parseSecureShareOwnerSummary({
      ...validSummary,
      ready: false,
      shareId: "ss2_pending_share_123456",
      status: "pending"
    });
    const now = Date.parse("2026-07-28T01:00:00.000Z");

    expect(canCreateSecureShareFromHistory([consumed, revoked], now)).toBe(true);
    expect(canCreateSecureShareFromHistory([consumed, pending], now)).toBe(false);
  });

  it("preserves a historical selection and reconciles a missing selection to the live share", () => {
    const active = parseSecureShareOwnerSummary(validSummary);
    const consumed = parseSecureShareOwnerSummary({
      ...validSummary,
      consumedAt: "2026-07-28T00:30:00.000Z",
      shareId: "ss2_consumed_share_123456",
      status: "consumed"
    });
    const revoked = parseSecureShareOwnerSummary({
      ...validSummary,
      revokedAt: "2026-07-28T00:30:00.000Z",
      shareId: "ss2_revoked_share_123456",
      status: "revoked"
    });
    const now = Date.parse("2026-07-28T01:00:00.000Z");

    expect(resolveSecureShareManagementSelection(
      [active, consumed, revoked],
      revoked.shareId,
      now
    )?.shareId).toBe(revoked.shareId);
    expect(resolveSecureShareManagementSelection(
      [consumed, active],
      "ss2_missing_share_123456",
      now
    )?.shareId).toBe(active.shareId);
    expect(resolveSecureShareManagementSelection([], active.shareId, now)).toBeNull();
  });
});
