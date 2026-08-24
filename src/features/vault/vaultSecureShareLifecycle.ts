import {
  getSecureShareFeatureStatus,
  listOwnedSecureShares,
  revokeSecureShare,
  type SecureShareListOptions
} from "../../services/secureShares";
import type { SecureShareOwnerSummary } from "../../types";
import {
  parseVaultSecureShareList,
  parseVaultSecureShareMutation
} from "./vaultSecureShare";

interface VaultSecureShareLifecycleDependencies {
  featureStatus: () => Promise<unknown>;
  listShares: (idToken: string, options?: SecureShareListOptions) => Promise<unknown>;
  revokeShare: (shareId: string, idToken: string, idempotencyKey: string) => Promise<unknown>;
}

const defaultDependencies: VaultSecureShareLifecycleDependencies = {
  featureStatus: getSecureShareFeatureStatus,
  listShares: listOwnedSecureShares,
  revokeShare: revokeSecureShare
};

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function v2Enabled(value: unknown) {
  if (
    !plainRecord(value)
    || Object.keys(value).some((key) => key !== "emailEnabled" && key !== "v2Enabled")
    || typeof value.emailEnabled !== "boolean"
    || typeof value.v2Enabled !== "boolean"
  ) {
    throw new Error("보안 공유 기능 상태를 안전하게 확인하지 못했습니다.");
  }
  return value.v2Enabled;
}

function includesAsciiControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function idToken(value: unknown) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 16_384
    || includesAsciiControlCharacter(value)
  ) {
    throw new Error("보안 공유 소유자 권한을 안전하게 확인하지 못했습니다.");
  }
  return value;
}

export function vaultSecureShareRequiresRevocation(
  share: SecureShareOwnerSummary,
  now = Date.now()
) {
  return !share.revokedAt
    && Date.parse(share.expiresAt) > now
    && (share.status === "active" || share.status === "consumed" || share.status === "pending");
}

/**
 * A Secure Share is an encrypted snapshot and can otherwise outlive its source
 * note. Revoke every still-accessible snapshot before a Vault note is moved to
 * trash. Any malformed or incomplete owner response blocks deletion instead
 * of leaving content reachable without a management entry point.
 */
export async function revokeVaultSecureSharesBeforeTrash(
  input: {
    getIdToken: () => Promise<string>;
    now?: number;
    sourceNoteId: string;
  },
  dependencies: VaultSecureShareLifecycleDependencies = defaultDependencies
) {
  return revokeVaultSecureSharesBeforeSourcesTrash({
    getIdToken: input.getIdToken,
    ...(input.now === undefined ? {} : { now: input.now }),
    sourceNoteIds: [input.sourceNoteId]
  }, dependencies);
}

/**
 * Folder trash uses the same fail-closed lifecycle policy without repeating
 * feature/token requests for every child. Source histories are checked with a
 * small worker pool, while each returned share is still validated against the
 * requested source before revocation.
 */
export async function revokeVaultSecureSharesBeforeSourcesTrash(
  input: {
    getIdToken: () => Promise<string>;
    now?: number;
    sourceNoteIds: readonly string[];
  },
  dependencies: VaultSecureShareLifecycleDependencies = defaultDependencies
) {
  const sourceNoteIds = Array.from(new Set(input.sourceNoteIds));
  if (sourceNoteIds.some((sourceNoteId) => (
    !/^[A-Za-z0-9_-]{1,120}$/u.test(sourceNoteId)
  ))) {
    throw new Error("보안 공유 원본 노트 범위를 안전하게 확인하지 못했습니다.");
  }
  if (!sourceNoteIds.length) return 0;
  if (!v2Enabled(await dependencies.featureStatus())) return 0;

  const token = idToken(await input.getIdToken());
  let nextSourceIndex = 0;
  let revokedCount = 0;
  async function worker() {
    while (nextSourceIndex < sourceNoteIds.length) {
      const sourceNoteId = sourceNoteIds[nextSourceIndex];
      nextSourceIndex += 1;
      const shares = parseVaultSecureShareList(await dependencies.listShares(token, {
        limit: 100,
        sourceNoteId
      }), sourceNoteId);
      const targets = shares.filter((share) => (
        vaultSecureShareRequiresRevocation(share, input.now)
      ));

      for (const share of targets) {
        const revoked = parseVaultSecureShareMutation(await dependencies.revokeShare(
          share.shareId,
          token,
          `vault_source_trash_${crypto.randomUUID().replaceAll("-", "")}`
        ), share.shareId);
        if (
          revoked.sourceNoteId !== sourceNoteId
          || revoked.status !== "revoked"
          || !revoked.revokedAt
        ) {
          throw new Error("보안 공유 중단 상태를 안전하게 확인하지 못했습니다.");
        }
        revokedCount += 1;
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(4, sourceNoteIds.length) },
    worker
  ));
  return revokedCount;
}
