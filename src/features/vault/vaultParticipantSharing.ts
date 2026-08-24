import { unwrapNoteKey, wrapNoteKey } from "../../lib/crypto";
import { updateRevisionedNoteAccess } from "../../services/notes";
import type { UserProfile, WrappedNoteKey } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";

export interface VaultParticipantSharePlan {
  folderId: string | null;
  participantUids: string[];
  participants: UserProfile[];
  type: "personal" | "shared";
}

interface VaultParticipantSharingDependencies {
  unwrapNoteKey: typeof unwrapNoteKey;
  updateRevisionedNoteAccess: typeof updateRevisionedNoteAccess;
  wrapNoteKey: typeof wrapNoteKey;
}

const defaultDependencies: VaultParticipantSharingDependencies = {
  unwrapNoteKey,
  updateRevisionedNoteAccess,
  wrapNoteKey
};

export function vaultShareCandidates(
  profile: Pick<UserProfile, "allowedShareTargetUids" | "isAdmin" | "uid">,
  users: readonly UserProfile[]
) {
  const permitted = new Set(profile.allowedShareTargetUids ?? []);

  return users
    .filter((user) => (
      user.isActive
      && (
        user.uid === profile.uid
        || profile.isAdmin
        || permitted.has(user.uid)
      )
    ))
    .sort((left, right) => (
      Number(right.uid === profile.uid) - Number(left.uid === profile.uid)
      || left.displayName.localeCompare(right.displayName, "ko")
      || left.uid.localeCompare(right.uid)
    ));
}

export function planVaultParticipantShare(
  note: Pick<
    DecryptedVaultNote,
    "entryKind" | "folderId" | "isDeleted" | "ownerUid" | "participantUids"
  >,
  profile: Pick<UserProfile, "allowedShareTargetUids" | "isAdmin" | "uid">,
  users: readonly UserProfile[],
  requestedParticipantUids: readonly string[]
): VaultParticipantSharePlan {
  if (note.isDeleted) {
    throw new Error("휴지통의 노트는 공유할 수 없습니다.");
  }
  if (note.ownerUid !== profile.uid) {
    throw new Error("노트 소유자만 공유 대상을 변경할 수 있습니다.");
  }
  if (note.entryKind !== "markdown" && note.entryKind !== "legacy-html") {
    throw new Error("Markdown 또는 기존 노트만 사용자와 공유할 수 있습니다.");
  }

  const candidates = vaultShareCandidates(profile, users);
  const candidatesByUid = new Map(candidates.map((user) => [user.uid, user]));
  const participantUids = [
    profile.uid,
    ...Array.from(new Set(requestedParticipantUids))
      .filter((uid) => uid !== profile.uid)
      .sort()
  ];
  const participants = participantUids.map((uid) => candidatesByUid.get(uid));

  if (participants.some((participant) => !participant)) {
    const retainedUnavailableParticipant = participantUids.some((uid) => (
      uid !== profile.uid
      && note.participantUids.includes(uid)
      && !candidatesByUid.has(uid)
    ));
    throw new Error(retainedUnavailableParticipant
      ? "현재 허용 대상이 아닌 기존 공유 사용자를 해제한 뒤 저장해주세요."
      : "관리자가 허용한 활성 사용자에게만 공유할 수 있습니다.");
  }
  if (participantUids.length > 1 && note.folderId) {
    throw new Error("사용자 공유 노트는 Vault 루트에 있어야 합니다. 먼저 루트로 이동해주세요.");
  }

  return {
    folderId: note.folderId ?? null,
    participantUids,
    participants: participants as UserProfile[],
    type: participantUids.length > 1 ? "shared" : "personal"
  };
}

export async function updateVaultEntryParticipants(
  note: DecryptedVaultNote,
  profile: UserProfile,
  privateKey: CryptoKey,
  users: readonly UserProfile[],
  requestedParticipantUids: readonly string[],
  dependencies: VaultParticipantSharingDependencies = defaultDependencies
) {
  const plan = planVaultParticipantShare(
    note,
    profile,
    users,
    requestedParticipantUids
  );
  const ownerWrappedKey = note.wrappedKeys[profile.uid];

  if (!ownerWrappedKey) {
    throw new Error("노트의 소유자 암호화 키를 찾을 수 없습니다.");
  }

  const noteKey = await dependencies.unwrapNoteKey(ownerWrappedKey, privateKey);
  const wrappedKeyEntries = await Promise.all(plan.participants.map(async (participant) => {
    if (!participant.publicKeyJwk) {
      throw new Error("공유 대상의 암호화 키를 찾을 수 없습니다.");
    }
    return [
      participant.uid,
      await dependencies.wrapNoteKey(noteKey, participant.publicKeyJwk)
    ] as const;
  }));
  const wrappedKeys = Object.fromEntries(wrappedKeyEntries) as Record<string, WrappedNoteKey>;

  const result = await dependencies.updateRevisionedNoteAccess({
    expectedRevision: note.revision ?? 0,
    folderId: plan.type === "personal" ? plan.folderId : null,
    noteId: note.id,
    participantUids: plan.participantUids,
    type: plan.type,
    uid: profile.uid,
    wrappedKeys
  });
  return {
    ...result,
    folderId: plan.type === "personal" ? plan.folderId : null,
    participantUids: plan.participantUids,
    type: plan.type,
    wrappedKeys
  };
}
