import { hasFeatureAccess } from "../../lib/featureAccess";
import type { UserProfile } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";

export function vaultNoteAttachmentAccess(
  note: DecryptedVaultNote,
  profile: UserProfile
): { allowed: true; reason: "" } | { allowed: false; reason: string } {
  if (!profile.isActive || !hasFeatureAccess(profile, "notes")) {
    return { allowed: false, reason: "활성화된 노트 권한이 있어야 파일을 관리할 수 있습니다." };
  }
  if (note.isDeleted || note.ownerUid !== profile.uid || note.type !== "personal") {
    return { allowed: false, reason: "내 개인 활성 노트의 파일만 관리할 수 있습니다." };
  }
  if (note.contentFormat !== "markdown-v1" || note.entryKind !== "markdown") {
    return { allowed: false, reason: "Markdown 노트에서만 파일을 첨부할 수 있습니다." };
  }
  if (!note.wrappedKeys[profile.uid]) {
    return { allowed: false, reason: "이 노트의 암호화 키를 확인할 수 없습니다." };
  }
  return { allowed: true, reason: "" };
}
