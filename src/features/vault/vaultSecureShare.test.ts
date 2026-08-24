import { describe, expect, it, vi } from "vitest";
import type { SecureShareOwnerSummary, UserProfile } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import {
  createVaultSecureShare,
  parseVaultSecureShareList,
  parseVaultSecureShareOwnerDetails,
  parseVaultSecureShareSummary,
  secureShareMarkdownPrefix,
  vaultSecureShareBlocksCreation,
  vaultSecureShareBody
} from "./vaultSecureShare";

const encrypted = { algorithm: "AES-GCM" as const, cipherText: "cipher", iv: "iv", version: 1 as const };
const wrapped = { algorithm: "RSA-OAEP" as const, version: 1 as const, wrappedKey: "wrapped-key-value" };

function owner(): UserProfile {
  return {
    avatarText: "A",
    color: "#000",
    displayName: "소유자",
    isActive: true,
    isAdmin: false,
    loginEmail: "owner@example.com",
    order: 0,
    publicKeyJwk: { kty: "RSA" },
    quickKey: 1,
    role: "user",
    uid: "owner-a"
  };
}

function note(overrides: Partial<DecryptedVaultNote> = {}): DecryptedVaultNote {
  return {
    body: "# 제목\r\n본문",
    contentFormat: "markdown-v1",
    encryptedBody: encrypted,
    encryptedTitle: encrypted,
    entryKind: "markdown",
    folderId: null,
    id: "note-a1",
    isDeleted: false,
    ownerUid: "owner-a",
    participantUids: ["owner-a"],
    revision: 7,
    title: "공유 노트",
    type: "personal",
    updatedBy: "owner-a",
    wrappedKeys: { "owner-a": wrapped },
    ...overrides
  };
}

function share(overrides: Partial<SecureShareOwnerSummary> = {}): SecureShareOwnerSummary {
  const now = Date.now();
  return {
    accessMode: "anyone_with_link",
    attachmentCount: 0,
    consumedAt: null,
    contentRevision: 1,
    createdAt: new Date(now).toISOString(),
    currentGeneration: "gen_123456",
    downloadAllowed: true,
    expiresAt: new Date(now + 60_000).toISOString(),
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
    shareId: "ss2_share_123456",
    showCommenterIpPrefix: false,
    sourceAttachmentRevision: 0,
    sourceNoteId: "note-a1",
    sourceRevision: 7,
    sourceSyncMode: "revision_bound",
    status: "active",
    successfulAccessCount: 0,
    updatedAt: new Date(now).toISOString(),
    ...overrides
  };
}

function response(summary: SecureShareOwnerSummary) {
  return { ok: true, share: summary };
}

describe("Vault Secure Share", () => {
  it("marks Markdown explicitly without converting or storing plaintext elsewhere", () => {
    expect(vaultSecureShareBody(note())).toBe(`${secureShareMarkdownPrefix}# 제목\n본문`);
    expect(vaultSecureShareBody(note({
      body: "<p>기존</p>",
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html"
    }))).toBe("<p>기존</p>");
  });

  it("strictly validates owner list scope and blocking states", () => {
    const parsed = parseVaultSecureShareSummary(share());
    expect(parsed.sourceSyncMode).toBe("revision_bound");
    expect(vaultSecureShareBlocksCreation(parsed)).toBe(true);
    expect(vaultSecureShareBlocksCreation(share({ status: "revoked", revokedAt: new Date().toISOString() }))).toBe(false);
    expect(parseVaultSecureShareList({ ok: true, nextCursor: null, shares: [share()] }, "note-a1"))
      .toHaveLength(1);
    expect(() => parseVaultSecureShareList({
      ok: true,
      nextCursor: null,
      shares: [share({ sourceNoteId: "other-note" })]
    }, "note-a1")).toThrow("원본 노트");
    expect(() => parseVaultSecureShareSummary({
      ...share(),
      sourceSyncMode: "live"
    })).toThrow("필드");
    expect(() => parseVaultSecureShareSummary({
      ...share(),
      sourceRevision: undefined
    })).toThrow("필드");
  });

  it("strictly restores an editable owner policy without exposing a password", () => {
    const details = parseVaultSecureShareOwnerDetails({
      ok: true,
      policy: {
        allowedEmails: ["reader@example.com"],
        downloadAllowed: true,
        emailVerificationRequired: true,
        oneTimeEnabled: false,
        passwordEnabled: true,
        quickCopyButtonVisible: true,
        showCommenterIpPrefix: false
      },
      share: share({
        accessMode: "allowed_emails",
        hasPassword: true,
        requiresEmailVerification: true
      })
    });
    expect(details.initialPolicy).toMatchObject({
      accessMode: "allowed_emails",
      allowedEmails: ["reader@example.com"],
      passwordEnabled: true
    });
    expect(details.initialPolicy).not.toHaveProperty("password");
    expect(() => parseVaultSecureShareOwnerDetails({
      ok: true,
      policy: { allowedEmails: ["Reader@EXAMPLE.com"] },
      share: share()
    })).toThrow("이메일 정책");
  });

  it("creates then activates an encrypted zero-attachment link against the latest source revisions", async () => {
    const pending = share({ currentGeneration: "", ready: false, status: "pending" });
    const active = share({ permissionLevel: "save_copy" });
    const createSecureShare = vi.fn().mockResolvedValue(response(pending));
    const activateSecureShare = vi.fn().mockResolvedValue(response(active));
    const revokeSecureShare = vi.fn();
    const result = await createVaultSecureShare({
      emailFeatureEnabled: true,
      idToken: "id-token",
      note: note(),
      origin: "https://quickmemo.example",
      policy: {
        accessMode: "anyone_with_link",
        allowedEmails: [],
        customExpiresAt: null,
        downloadAllowed: true,
        emailVerificationRequired: false,
        expirationPreset: "seven_days",
        oneTimeEnabled: false,
        oneTimeScope: "global",
        passwordEnabled: false,
        permissionLevel: "save_copy",
        quickCopyButtonVisible: true,
        showCommenterIpPrefix: false
      },
      profile: owner()
    }, {
      activateSecureShare,
      buildSecureShareUrl: vi.fn(() => "https://quickmemo.example/share/ss2_share_123456#key=content-key"),
      createPublicShareGeneration: vi.fn(() => "gen_123456"),
      createSecureShare,
      encryptText: vi.fn().mockResolvedValue(encrypted),
      exportAesKeyBase64Url: vi.fn().mockResolvedValue("content-key"),
      generateNoteKey: vi.fn().mockResolvedValue({} as CryptoKey),
      getNoteRevisionState: vi.fn().mockResolvedValue({ attachmentRevision: 0, revision: 7 }),
      getSecureShareOwnerDetails: vi.fn(),
      revokeSecureShare,
      unwrapNoteKey: vi.fn(),
      wrapNoteKey: vi.fn().mockResolvedValue(wrapped)
    });

    expect(result.share.status).toBe("active");
    expect(result.url).toContain("#key=content-key");
    expect(createSecureShare).toHaveBeenCalledWith(expect.objectContaining({
      attachmentCount: 0,
      policy: expect.objectContaining({ permissionLevel: "save_copy" }),
      sourceAttachmentRevision: 0,
      sourceNoteId: "note-a1",
      sourceRevision: 7,
      sourceSyncMode: "revision_bound"
    }), "id-token", expect.any(Object));
    expect(activateSecureShare).toHaveBeenCalledTimes(1);
    expect(revokeSecureShare).not.toHaveBeenCalled();
  });

  it("revokes a prepared share if activation does not complete", async () => {
    const pending = share({ currentGeneration: "", ready: false, status: "pending" });
    const revokeSecureShare = vi.fn().mockResolvedValue(response(share({ status: "revoked" })));

    await expect(createVaultSecureShare({
      emailFeatureEnabled: false,
      idToken: "id-token",
      note: note(),
      origin: "https://quickmemo.example",
      policy: {
        accessMode: "anyone_with_link",
        allowedEmails: [],
        customExpiresAt: null,
        downloadAllowed: true,
        emailVerificationRequired: false,
        expirationPreset: "seven_days",
        oneTimeEnabled: false,
        oneTimeScope: "global",
        passwordEnabled: false,
        permissionLevel: "view",
        quickCopyButtonVisible: true,
        showCommenterIpPrefix: false
      },
      profile: owner()
    }, {
      activateSecureShare: vi.fn().mockRejectedValue(new Error("activate failed")),
      buildSecureShareUrl: vi.fn(),
      createPublicShareGeneration: vi.fn(() => "gen_123456"),
      createSecureShare: vi.fn().mockResolvedValue(response(pending)),
      encryptText: vi.fn().mockResolvedValue(encrypted),
      exportAesKeyBase64Url: vi.fn().mockResolvedValue("content-key"),
      generateNoteKey: vi.fn().mockResolvedValue({} as CryptoKey),
      getNoteRevisionState: vi.fn().mockResolvedValue({ attachmentRevision: 0, revision: 7 }),
      getSecureShareOwnerDetails: vi.fn(),
      revokeSecureShare,
      unwrapNoteKey: vi.fn(),
      wrapNoteKey: vi.fn().mockResolvedValue(wrapped)
    })).rejects.toThrow("activate failed");

    expect(revokeSecureShare).toHaveBeenCalledWith(
      "ss2_share_123456",
      "id-token",
      expect.stringMatching(/^vault_create_cleanup_/u)
    );
  });
});
