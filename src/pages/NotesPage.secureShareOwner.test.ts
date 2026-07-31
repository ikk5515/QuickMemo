import { describe, expect, it } from "vitest";
import {
  canCreateSecureShareFromHistory,
  parseSecureShareListResponse,
  parseSecureShareMutationResponse,
  parseSecureShareOwnerDetailsResponse,
  parseSecureShareOwnerSummary,
  refreshedSecureShareSettingsFlags,
  requestSecureShareEmailDraftWithoutRollback,
  resolveSecureShareManagementSelection,
  secureShareNewEmailRecipients,
  secureShareEmailRecipientMemoryKey,
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
  it("refreshes email readiness before opening secure share settings", () => {
    const currentFlags = {
      clientV2Enabled: true,
      emailEnabled: false,
      liveContentSyncEnabled: true,
      v2Enabled: true
    };

    expect(refreshedSecureShareSettingsFlags(currentFlags, {
      emailEnabled: true,
      v2Enabled: true
    })).toEqual({
      clientV2Enabled: true,
      emailEnabled: true,
      liveContentSyncEnabled: true,
      v2Enabled: true
    });

    expect(refreshedSecureShareSettingsFlags(currentFlags, {
      emailEnabled: true,
      v2Enabled: false
    })).toEqual({
      clientV2Enabled: true,
      emailEnabled: false,
      liveContentSyncEnabled: false,
      v2Enabled: false
    });
  });

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

  it("rejects non-canonical or duplicate owner-only recipient addresses", () => {
    const emailShare = {
      ...validSummary,
      accessMode: "allowed_emails",
      requiresEmailVerification: true
    };

    for (const allowedEmails of [
      ["Viewer@Example.com"],
      ["viewer@example.com", "viewer@example.com"],
      ["not an email"]
    ]) {
      expect(() => parseSecureShareOwnerDetailsResponse({
        ok: true,
        share: emailShare,
        policy: { allowedEmails, expirationPreset: "seven_days" },
        attachmentReuseManifests: [validAttachmentReuseManifest]
      })).toThrow(/정책 응답/);
    }
  });

  it("targets only newly added canonical recipients after an edit", () => {
    const previousPolicy = {
      accessMode: "allowed_emails" as const,
      allowedEmails: ["existing@example.com"],
      customExpiresAt: null,
      downloadAllowed: false,
      emailVerificationRequired: true,
      expirationPreset: "seven_days" as const,
      oneTimeEnabled: false,
      oneTimeScope: "global" as const,
      passwordEnabled: false,
      permissionLevel: "view" as const,
      quickCopyButtonVisible: false,
      showCommenterIpPrefix: false
    };

    expect(secureShareNewEmailRecipients(previousPolicy, {
      ...previousPolicy,
      allowedEmails: ["existing@example.com", "new@example.com"]
    })).toEqual(["new@example.com"]);
    expect(secureShareNewEmailRecipients(previousPolicy, {
      ...previousPolicy,
      accessMode: "authenticated_users",
      allowedEmails: []
    })).toEqual([]);
  });

  it("keeps a committed share intact when the external composer request fails", () => {
    const shareId = `ss2_${"S".repeat(40)}`;
    const contentKey = "K".repeat(43);
    const shareUrl = `https://quickmemo.example/share/${shareId}#key=${contentKey}`;
    const input = {
      expectedOrigin: "https://quickmemo.example",
      expectedShareId: shareId,
      recipients: ["viewer@example.com"],
      shareUrl
    };

    expect(requestSecureShareEmailDraftWithoutRollback(input, () => {
      throw new Error(`external handler failed: ${shareUrl}`);
    })).toBe(false);
    expect(requestSecureShareEmailDraftWithoutRollback(input, () => undefined)).toBe(true);
    expect(requestSecureShareEmailDraftWithoutRollback({
      ...input,
      recipients: Array.from({ length: 100 }, (_, index) => (
        `${String(index).padStart(3, "0")}${"x".repeat(58)}@${"d".repeat(50)}.example`
      ))
    }, () => undefined)).toBe(false);
  });

  it("never resolves account A invitation recipients from account B", () => {
    const recipients = new Map<string, string[]>();
    const shareId = "ss2_same_share_id_123456";

    recipients.set(
      secureShareEmailRecipientMemoryKey("owner-a", shareId),
      ["private-a@example.com"]
    );

    expect(recipients.get(
      secureShareEmailRecipientMemoryKey("owner-b", shareId)
    )).toBeUndefined();
    recipients.clear();
    expect(recipients.size).toBe(0);
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
