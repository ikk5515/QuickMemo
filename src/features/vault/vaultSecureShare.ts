import {
  encryptText,
  exportAesKeyBase64Url,
  generateNoteKey,
  unwrapNoteKey,
  wrapNoteKey
} from "../../lib/crypto";
import { buildSecureShareUrl } from "../../lib/secureShareUrl";
import { createPublicShareGeneration } from "../../services/publicShares";
import { getNoteRevisionState } from "../../services/notes";
import {
  activateSecureShare,
  createSecureShare,
  getSecureShareOwnerDetails,
  revokeSecureShare
} from "../../services/secureShares";
import {
  normalizeSecureShareEmail,
  secureShareAllowedEmailLimit,
  type SecureSharePolicyInput
} from "../../lib/secureSharePolicy";
import { markdownEditorContentPrefix } from "../../lib/editorContent";
import type {
  SecureShareOwnerSummary,
  UserProfile,
  WrappedNoteKey
} from "../../types";
import type { DecryptedVaultNote } from "./vaultData";

export const secureShareMarkdownPrefix = markdownEditorContentPrefix;
const secureShareIdentifierPattern = /^[A-Za-z0-9_-]{6,128}$/u;
const secureShareStatuses = new Set(["active", "consumed", "expired", "pending", "revoked"]);
const secureShareAccessModes = new Set(["allowed_emails", "anyone_with_link", "authenticated_users"]);
const secureSharePermissionLevels = new Set(["comment", "save_copy", "view"]);

interface VaultSecureShareDependencies {
  activateSecureShare: typeof activateSecureShare;
  buildSecureShareUrl: typeof buildSecureShareUrl;
  createPublicShareGeneration: typeof createPublicShareGeneration;
  createSecureShare: typeof createSecureShare;
  encryptText: typeof encryptText;
  exportAesKeyBase64Url: typeof exportAesKeyBase64Url;
  generateNoteKey: typeof generateNoteKey;
  getNoteRevisionState: typeof getNoteRevisionState;
  getSecureShareOwnerDetails: typeof getSecureShareOwnerDetails;
  revokeSecureShare: typeof revokeSecureShare;
  unwrapNoteKey: typeof unwrapNoteKey;
  wrapNoteKey: typeof wrapNoteKey;
}

const defaultDependencies: VaultSecureShareDependencies = {
  activateSecureShare,
  buildSecureShareUrl,
  createPublicShareGeneration,
  createSecureShare,
  encryptText,
  exportAesKeyBase64Url,
  generateNoteKey,
  getNoteRevisionState,
  getSecureShareOwnerDetails,
  revokeSecureShare,
  unwrapNoteKey,
  wrapNoteKey
};

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredDate(value: unknown, field: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`보안 공유 ${field} 응답이 올바르지 않습니다.`);
  }
  return value;
}

function optionalDate(value: unknown, field: string) {
  return value === null || value === undefined ? null : requiredDate(value, field);
}

function ownerWrappedKey(value: unknown): WrappedNoteKey | undefined {
  if (value === undefined) return undefined;
  if (
    !plainRecord(value)
    || value.version !== 1
    || value.algorithm !== "RSA-OAEP"
    || typeof value.wrappedKey !== "string"
    || value.wrappedKey.length < 8
    || value.wrappedKey.length > 4096
  ) {
    throw new Error("보안 공유 소유자 키 응답이 올바르지 않습니다.");
  }
  return { algorithm: "RSA-OAEP", version: 1, wrappedKey: value.wrappedKey };
}

export function parseVaultSecureShareSummary(value: unknown): SecureShareOwnerSummary {
  if (!plainRecord(value)) throw new Error("보안 공유 응답이 올바르지 않습니다.");
  const {
    accessMode,
    attachmentCount,
    contentRevision,
    consumedAt,
    createdAt,
    currentGeneration,
    downloadAllowed,
    expiresAt,
    hasPassword,
    lastAccessAt,
    oneTimeEnabled,
    permissionLevel,
    policyVersion,
    quickCopyButtonVisible,
    ready,
    requiresEmailVerification,
    revokedAt,
    schemaVersion,
    shareId,
    showCommenterIpPrefix,
    sourceAttachmentRevision,
    sourceNoteId,
    sourceRevision,
    sourceSyncMode,
    status,
    successfulAccessCount,
    updatedAt
  } = value;

  if (
    schemaVersion !== 2
    || typeof shareId !== "string"
    || !secureShareIdentifierPattern.test(shareId)
    || typeof sourceNoteId !== "string"
    || !secureShareIdentifierPattern.test(sourceNoteId)
    || typeof status !== "string"
    || !secureShareStatuses.has(status)
    || typeof accessMode !== "string"
    || !secureShareAccessModes.has(accessMode)
    || typeof permissionLevel !== "string"
    || !secureSharePermissionLevels.has(permissionLevel)
    || typeof ready !== "boolean"
    || typeof hasPassword !== "boolean"
    || typeof requiresEmailVerification !== "boolean"
    || typeof oneTimeEnabled !== "boolean"
    || typeof downloadAllowed !== "boolean"
    || typeof quickCopyButtonVisible !== "boolean"
    || (showCommenterIpPrefix !== undefined && typeof showCommenterIpPrefix !== "boolean")
    || !Number.isSafeInteger(attachmentCount)
    || Number(attachmentCount) < 0
    || Number(attachmentCount) > 100
    || (contentRevision !== undefined && (!Number.isSafeInteger(contentRevision) || Number(contentRevision) < 1))
    || (currentGeneration !== undefined && (
      typeof currentGeneration !== "string"
      || (currentGeneration.length > 0 && !secureShareIdentifierPattern.test(currentGeneration))
    ))
    || !Number.isSafeInteger(policyVersion)
    || Number(policyVersion) < 1
    || !Number.isSafeInteger(successfulAccessCount)
    || Number(successfulAccessCount) < 0
    || (sourceRevision !== undefined && (!Number.isSafeInteger(sourceRevision) || Number(sourceRevision) < 0))
    || (sourceAttachmentRevision !== undefined && (
      !Number.isSafeInteger(sourceAttachmentRevision)
      || Number(sourceAttachmentRevision) < 0
    ))
    || (sourceSyncMode !== undefined && sourceSyncMode !== "revision_bound")
    || (sourceSyncMode === "revision_bound" && (
      sourceRevision === undefined
      || sourceAttachmentRevision === undefined
    ))
  ) {
    throw new Error("보안 공유 응답의 필드가 올바르지 않습니다.");
  }

  return {
    accessMode: accessMode as SecureShareOwnerSummary["accessMode"],
    attachmentCount: Number(attachmentCount),
    contentRevision: contentRevision === undefined ? 1 : Number(contentRevision),
    consumedAt: optionalDate(consumedAt, "사용 완료 시간"),
    createdAt: requiredDate(createdAt, "생성 시간"),
    currentGeneration: typeof currentGeneration === "string" ? currentGeneration : "",
    downloadAllowed,
    expiresAt: requiredDate(expiresAt, "만료 시간"),
    hasPassword,
    lastAccessAt: optionalDate(lastAccessAt, "최근 접근 시간"),
    oneTimeEnabled,
    ownerWrappedShareKey: ownerWrappedKey(value.ownerWrappedShareKey),
    permissionLevel: permissionLevel as SecureShareOwnerSummary["permissionLevel"],
    policyVersion: Number(policyVersion),
    quickCopyButtonVisible,
    ready,
    requiresEmailVerification,
    revokedAt: optionalDate(revokedAt, "중단 시간"),
    schemaVersion: 2,
    shareId,
    showCommenterIpPrefix: permissionLevel === "comment" && showCommenterIpPrefix === true,
    sourceAttachmentRevision: sourceAttachmentRevision === undefined
      ? undefined
      : Number(sourceAttachmentRevision),
    sourceNoteId,
    sourceRevision: sourceRevision === undefined ? undefined : Number(sourceRevision),
    sourceSyncMode: sourceSyncMode === "revision_bound" ? sourceSyncMode : undefined,
    status: status as SecureShareOwnerSummary["status"],
    successfulAccessCount: Number(successfulAccessCount),
    updatedAt: requiredDate(updatedAt, "수정 시간")
  };
}

export function parseVaultSecureShareList(value: unknown, expectedSourceNoteId: string) {
  if (
    !plainRecord(value)
    || value.ok !== true
    || !Array.isArray(value.shares)
    || (value.nextCursor !== null && value.nextCursor !== undefined)
  ) {
    throw new Error("보안 공유 목록 응답이 올바르지 않습니다.");
  }
  const shares = value.shares.map(parseVaultSecureShareSummary);
  if (shares.some((share) => share.sourceNoteId !== expectedSourceNoteId)) {
    throw new Error("보안 공유 목록의 원본 노트가 요청과 일치하지 않습니다.");
  }
  return shares;
}

export function parseVaultSecureShareMutation(value: unknown, expectedShareId?: string) {
  if (!plainRecord(value) || value.ok !== true) {
    throw new Error("보안 공유 변경 응답이 올바르지 않습니다.");
  }
  const share = parseVaultSecureShareSummary(value.share);
  if (expectedShareId && share.shareId !== expectedShareId) {
    throw new Error("보안 공유 변경 대상이 일치하지 않습니다.");
  }
  return share;
}

export function parseVaultSecureShareOwnerDetails(value: unknown) {
  if (
    !plainRecord(value)
    || value.ok !== true
    || !plainRecord(value.policy)
    || !Array.isArray(value.policy.allowedEmails)
    || value.policy.allowedEmails.length > secureShareAllowedEmailLimit
  ) {
    throw new Error("보안 공유 상세 응답이 올바르지 않습니다.");
  }
  const share = parseVaultSecureShareSummary(value.share);
  const allowedEmails: string[] = [];
  const seenEmails = new Set<string>();
  for (const candidate of value.policy.allowedEmails) {
    const normalized = normalizeSecureShareEmail(candidate);
    if (!normalized || normalized !== candidate || seenEmails.has(normalized)) {
      throw new Error("보안 공유 이메일 정책 응답이 올바르지 않습니다.");
    }
    seenEmails.add(normalized);
    allowedEmails.push(normalized);
  }
  if (
    (value.policy.passwordEnabled !== undefined && typeof value.policy.passwordEnabled !== "boolean")
    || (value.policy.emailVerificationRequired !== undefined
      && typeof value.policy.emailVerificationRequired !== "boolean")
    || (value.policy.oneTimeEnabled !== undefined && typeof value.policy.oneTimeEnabled !== "boolean")
    || (value.policy.downloadAllowed !== undefined && typeof value.policy.downloadAllowed !== "boolean")
    || (value.policy.quickCopyButtonVisible !== undefined
      && typeof value.policy.quickCopyButtonVisible !== "boolean")
    || (value.policy.showCommenterIpPrefix !== undefined
      && typeof value.policy.showCommenterIpPrefix !== "boolean")
  ) {
    throw new Error("보안 공유 정책 응답이 올바르지 않습니다.");
  }
  return {
    initialPolicy: {
      accessMode: share.accessMode,
      allowedEmails,
      customExpiresAt: share.expiresAt,
      downloadAllowed: share.downloadAllowed,
      emailVerificationRequired: share.requiresEmailVerification,
      expirationPreset: "custom" as const,
      oneTimeEnabled: share.oneTimeEnabled,
      oneTimeScope: "global" as const,
      passwordEnabled: share.hasPassword,
      permissionLevel: share.permissionLevel,
      quickCopyButtonVisible: share.quickCopyButtonVisible,
      showCommenterIpPrefix: share.permissionLevel === "comment"
        && share.showCommenterIpPrefix === true
    } satisfies SecureSharePolicyInput,
    share
  };
}

export function vaultSecureShareBlocksCreation(
  share: SecureShareOwnerSummary,
  now = Date.now()
) {
  return !share.revokedAt
    && Date.parse(share.expiresAt) > now
    && (share.status === "active" || share.status === "pending");
}

export function vaultSecureShareBody(note: Pick<DecryptedVaultNote, "body" | "contentFormat">) {
  return note.contentFormat === "markdown-v1"
    ? `${secureShareMarkdownPrefix}${note.body.replace(/\r\n?/gu, "\n")}`
    : note.body;
}

function operationId(operation: string) {
  return `${operation}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function createVaultSecureShare(
  input: {
    emailFeatureEnabled: boolean;
    idToken: string;
    note: DecryptedVaultNote;
    origin: string;
    policy: SecureSharePolicyInput;
    profile: UserProfile;
  },
  dependencies: VaultSecureShareDependencies = defaultDependencies
) {
  const { emailFeatureEnabled, idToken, note, origin, policy, profile } = input;
  if (note.isDeleted || note.ownerUid !== profile.uid) {
    throw new Error("노트 소유자만 활성 노트의 보안 공유 링크를 만들 수 있습니다.");
  }
  if (note.contentFormat !== "markdown-v1" && note.contentFormat !== "legacy-html-v1") {
    throw new Error("Markdown 또는 기존 노트만 보안 링크로 공유할 수 있습니다.");
  }
  const sourceState = await dependencies.getNoteRevisionState(note.id);
  if (sourceState.revision !== (note.revision ?? 0)) {
    throw new Error("다른 기기에서 노트가 변경되었습니다. 최신 내용을 불러온 뒤 다시 공유해주세요.");
  }

  const shareKey = await dependencies.generateNoteKey();
  const [contentKey, encryptedTitle, encryptedBody, wrappedKey] = await Promise.all([
    dependencies.exportAesKeyBase64Url(shareKey),
    dependencies.encryptText(note.title || "제목 없음", shareKey),
    dependencies.encryptText(vaultSecureShareBody(note), shareKey),
    dependencies.wrapNoteKey(shareKey, profile.publicKeyJwk)
  ]);
  let createdShareId = "";

  try {
    const created = parseVaultSecureShareMutation(await dependencies.createSecureShare({
      attachmentCount: 0,
      encryptedBody,
      encryptedTitle,
      idempotencyKey: operationId("vault_create"),
      ownerWrappedShareKey: wrappedKey,
      policy,
      sourceAttachmentRevision: sourceState.attachmentRevision,
      sourceNoteId: note.id,
      sourceRevision: sourceState.revision,
      sourceSyncMode: "revision_bound"
    }, idToken, { now: new Date(), emailFeatureEnabled }));
    createdShareId = created.shareId;
    if (created.sourceNoteId !== note.id || created.status !== "pending") {
      throw new Error("보안 공유 생성 상태를 확인하지 못했습니다.");
    }
    const generation = dependencies.createPublicShareGeneration();
    const activated = parseVaultSecureShareMutation(await dependencies.activateSecureShare(
      createdShareId,
      {
        attachmentCount: 0,
        generation,
        idempotencyKey: operationId("vault_activate")
      },
      idToken
    ), createdShareId);
    if (activated.status !== "active" || !activated.ready) {
      throw new Error("보안 공유 링크를 활성화하지 못했습니다.");
    }
    return {
      contentKey,
      share: activated,
      url: dependencies.buildSecureShareUrl(createdShareId, contentKey, origin)
    };
  } catch (caught) {
    if (createdShareId) {
      try {
        await dependencies.revokeSecureShare(
          createdShareId,
          idToken,
          operationId("vault_create_cleanup")
        );
      } catch {
        throw new Error(
          "보안 공유 생성이 중단되었고 준비 중 링크 정리도 완료하지 못했습니다. 공유 관리에서 링크를 중단해주세요.",
          { cause: caught }
        );
      }
    }
    throw caught;
  }
}

export async function recoverVaultSecureShareUrl(
  input: {
    idToken: string;
    origin: string;
    privateKey: CryptoKey;
    share: SecureShareOwnerSummary;
  },
  dependencies: VaultSecureShareDependencies = defaultDependencies
) {
  const details = await dependencies.getSecureShareOwnerDetails(
    input.share.shareId,
    input.idToken
  );
  if (!plainRecord(details) || details.ok !== true) {
    throw new Error("보안 공유 상세 응답이 올바르지 않습니다.");
  }
  const share = parseVaultSecureShareSummary(details.share);
  if (share.shareId !== input.share.shareId || share.sourceNoteId !== input.share.sourceNoteId) {
    throw new Error("보안 공유 상세 대상이 일치하지 않습니다.");
  }
  if (!share.ownerWrappedShareKey) {
    throw new Error("이 브라우저에서 공유 링크 키를 복구할 수 없습니다.");
  }
  const shareKey = await dependencies.unwrapNoteKey(
    share.ownerWrappedShareKey,
    input.privateKey
  );
  const contentKey = await dependencies.exportAesKeyBase64Url(shareKey);
  return {
    contentKey,
    share,
    url: dependencies.buildSecureShareUrl(share.shareId, contentKey, input.origin)
  };
}
