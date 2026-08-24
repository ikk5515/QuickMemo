import { Loader2, Share2, X } from "lucide-react";
import { useMemo, useRef, useState, type RefObject } from "react";
import { useModalFocus } from "../../lib/useModalFocus";
import type { UserProfile } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import {
  updateVaultEntryParticipants,
  vaultShareCandidates
} from "./vaultParticipantSharing";

export interface VaultParticipantShareResult {
  folderId: string | null;
  participantUids: string[];
  revision: number;
  type: "personal" | "shared";
  wrappedKeys: DecryptedVaultNote["wrappedKeys"];
}

export function VaultParticipantShareDialog({
  hasUnsharedAssetEmbeds = false,
  note,
  onClose,
  onUpdated,
  privateKey,
  profile,
  returnFocusTo,
  users
}: {
  hasUnsharedAssetEmbeds?: boolean;
  note: DecryptedVaultNote;
  onClose: () => void;
  onUpdated: (result: VaultParticipantShareResult) => void;
  privateKey: CryptoKey;
  profile: UserProfile;
  returnFocusTo?: HTMLElement | null;
  users: readonly UserProfile[];
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(returnFocusTo ?? null);
  const candidates = useMemo(
    () => vaultShareCandidates(profile, users),
    [profile, users]
  );
  const candidateUids = useMemo(
    () => new Set(candidates.map((candidate) => candidate.uid)),
    [candidates]
  );
  const unavailableExistingParticipants = useMemo(() => note.participantUids
    .filter((uid) => uid !== profile.uid && !candidateUids.has(uid))
    .map((uid) => ({ uid, user: users.find((candidate) => candidate.uid === uid) ?? null })), [
      candidateUids,
      note.participantUids,
      profile.uid,
      users
    ]);
  const [selectedUids, setSelectedUids] = useState(
    () => new Set(note.participantUids)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedSignature = [...selectedUids].sort().join("\n");
  const initialSignature = [...note.participantUids].sort().join("\n");
  const changed = selectedSignature !== initialSignature;
  const addingParticipant = [...selectedUids].some(
    (uid) => uid !== profile.uid && !note.participantUids.includes(uid)
  );
  const folderBlocksShare = Boolean(note.folderId && addingParticipant);
  const assetRemovalIncomplete = hasUnsharedAssetEmbeds && [...selectedUids].some(
    (uid) => uid !== profile.uid
  );

  useModalFocus(dialogRef, {
    returnFocusRef: returnFocusRef as RefObject<HTMLElement | null>
  });

  async function save() {
    if (busy || !changed) return;
    setBusy(true);
    setError("");

    try {
      const requestedParticipantUids = [...selectedUids];
      const result = await updateVaultEntryParticipants(
        note,
        profile,
        privateKey,
        users,
        requestedParticipantUids
      );

      onUpdated(result);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : "공유 대상을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="vault-share-dialog-backdrop"
      onMouseDown={busy ? undefined : onClose}
      role="presentation"
    >
      <section
        aria-labelledby="vault-participant-share-title"
        aria-modal="true"
        className="vault-share-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
          }
        }}
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <span><Share2 aria-hidden="true" size={15} /> QuickMemo 사용자 공유</span>
            <h2 id="vault-participant-share-title">{note.title}</h2>
          </div>
          <button
            aria-label="사용자 공유 창 닫기"
            className="icon-button"
            disabled={busy}
            onClick={onClose}
            type="button"
          ><X aria-hidden="true" size={16} /></button>
        </header>

        <p className="vault-share-dialog-description">
          선택한 사용자에게만 노트 키를 각자의 공개키로 다시 감싸 전달합니다.
        </p>
        <div className="vault-share-user-list">
          {candidates.map((user) => {
            const owner = user.uid === profile.uid;
            const checked = selectedUids.has(user.uid);

            return (
              <label className="vault-share-user" key={user.uid}>
                <input
                  checked={checked}
                  disabled={busy || owner || (hasUnsharedAssetEmbeds && !checked)}
                  onChange={(event) => {
                    const next = new Set(selectedUids);
                    if (event.currentTarget.checked) next.add(user.uid);
                    else next.delete(user.uid);
                    next.add(profile.uid);
                    setSelectedUids(next);
                    setError("");
                  }}
                  type="checkbox"
                />
                <span className="mini-avatar" style={{ background: user.color }}>{user.avatarText}</span>
                <span>
                  <strong>{user.displayName}</strong>
                  <small>{owner ? "소유자" : "암호화 공유 대상"}</small>
                </span>
              </label>
            );
          })}
          {unavailableExistingParticipants.map(({ uid, user }) => {
            const checked = selectedUids.has(uid);
            return (
              <label className="vault-share-user" key={uid}>
                <input
                  checked={checked}
                  disabled={busy || !checked}
                  onChange={() => {
                    const next = new Set(selectedUids);
                    next.delete(uid);
                    next.add(profile.uid);
                    setSelectedUids(next);
                    setError("");
                  }}
                  type="checkbox"
                />
                <span className="mini-avatar" style={user ? { background: user.color } : undefined}>
                  {user?.avatarText || "?"}
                </span>
                <span>
                  <strong>{user?.displayName || "이전 공유 사용자"}</strong>
                  <small>현재 허용 대상이 아님 · 공유 해제만 가능</small>
                </span>
              </label>
            );
          })}
        </div>

        {folderBlocksShare ? (
          <p className="form-error" role="alert">
            사용자 공유 노트는 Vault 루트에 있어야 합니다. 먼저 이 노트를 루트로 이동해주세요.
          </p>
        ) : null}
        {hasUnsharedAssetEmbeds ? (
          <p className="form-error" role="alert">
            첨부 자산의 별도 ACL을 전달할 수 없어 새 사용자를 추가할 수 없습니다.
            계속하려면 기존 사용자 공유를 모두 해제해주세요.
          </p>
        ) : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}

        <footer>
          <button className="secondary-button" disabled={busy} onClick={onClose} type="button">취소</button>
          <button
            data-dialog-initial-focus
            disabled={busy || !changed || folderBlocksShare || assetRemovalIncomplete}
            onClick={() => void save()}
            type="button"
          >
            {busy ? <Loader2 aria-hidden="true" className="spin" size={15} /> : <Share2 aria-hidden="true" size={15} />}
            {busy ? "저장 중…" : "공유 대상 저장"}
          </button>
        </footer>
      </section>
    </div>
  );
}
