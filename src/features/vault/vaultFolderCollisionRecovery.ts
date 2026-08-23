import { encryptText, unwrapNoteKey } from "../../lib/crypto";
import { resolveEncryptedNoteFolderCollision } from "../../services/notes";
import type { UserProfile } from "../../types";
import { migrateLegacyVaultFolder, type DecryptedVaultFolder } from "./vaultData";
import {
  VAULT_NAME_INDEX_VERSION,
  canonicalVaultName,
  vaultNameFingerprint
} from "./vaultIntegrity";

/**
 * Resolves only a deferred, claimless folder collision. It is split from the
 * initial Vault bundle because healthy Vaults never need this recovery path.
 */
export async function resolveVaultFolderNameCollision(
  folder: DecryptedVaultFolder,
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  privateKey: CryptoKey,
  vaultIntegrityKey: CryptoKey,
  replacement: { name: string; parentId: string | null }
) {
  if (folder.ownerUid !== profile.uid) {
    throw new Error("Vault 폴더 이름 충돌은 소유자만 해결할 수 있습니다.");
  }
  if (
    folder.vaultNameClaimId !== undefined
    || folder.vaultNameIndexVersion !== undefined
  ) {
    throw new Error("이 폴더는 이미 Vault 이름 예약을 보유하고 있습니다.");
  }
  if (Boolean(folder.encryptedName) !== Boolean(folder.wrappedKey)) {
    throw new Error("암호화 폴더 정보가 부분적으로 기록되어 복구를 중단했습니다.");
  }
  const normalizedName = replacement.name.trim().normalize("NFC");
  if (!normalizedName || normalizedName.length > 120) {
    throw new Error("폴더 이름은 1~120자로 입력해주세요.");
  }
  canonicalVaultName(normalizedName, "folder");
  const nameChanged = normalizedName !== folder.displayName;
  const parentChanged = replacement.parentId !== (folder.parentId ?? null);
  if (!nameChanged && !parentChanged) {
    throw new Error("충돌을 해결하려면 폴더 이름 또는 위치를 변경해주세요.");
  }
  if (!folder.encryptedName || !folder.wrappedKey) {
    return migrateLegacyVaultFolder(
      profile,
      vaultIntegrityKey,
      folder,
      folder.order ?? 0,
      {
        replacementName: normalizedName,
        targetParentId: replacement.parentId
      }
    );
  }
  const [encryptedName, claimId] = await Promise.all([
    nameChanged
      ? unwrapNoteKey(folder.wrappedKey, privateKey)
          .then((folderKey) => encryptText(normalizedName, folderKey))
      : Promise.resolve(undefined),
    vaultNameFingerprint(vaultIntegrityKey, {
      name: normalizedName,
      parentId: replacement.parentId,
      targetType: "folder"
    })
  ]);
  const collisionInput = {
    expectedRevision: folder.revision ?? 1,
    folderId: folder.id,
    nameClaim: {
      claimId,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      parentId: replacement.parentId
    },
    ownerUid: profile.uid
  };
  return encryptedName
    ? resolveEncryptedNoteFolderCollision({
        ...collisionInput,
        encryptedName,
        ...(parentChanged ? { parentId: replacement.parentId } : {})
      })
    : resolveEncryptedNoteFolderCollision({
        ...collisionInput,
        parentId: replacement.parentId
      });
}
