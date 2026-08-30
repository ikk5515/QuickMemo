import { lazy, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { unwrapNoteKey } from "../../lib/crypto";
import type { UserProfile } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import { VaultNoteAttachmentsInline } from "./VaultNoteAttachmentsInline";
import { useVaultNoteAttachments } from "./useVaultNoteAttachments";
import { vaultNoteAttachmentAccess } from "./vaultNoteAttachmentAccess";
import {
  decryptPrivateNoteAttachmentNames,
  migrateLegacyPrivateNoteAttachmentNames,
  type PrivateNoteAttachmentSnapshot
} from "./noteAttachmentFileName";

const LazyVaultNoteAttachmentsDialog = lazy(() => import("./VaultNoteAttachmentsDialog"));

export interface VaultNoteAttachmentsRegionProps {
  disabled: boolean;
  note: DecryptedVaultNote;
  onOpenLibrary: () => void;
  privateKey: CryptoKey;
  profile: UserProfile;
}

export function VaultNoteAttachmentsRegion({
  disabled,
  note,
  onOpenLibrary,
  privateKey,
  profile
}: VaultNoteAttachmentsRegionProps) {
  const access = vaultNoteAttachmentAccess(note, profile);
  const attachments = useVaultNoteAttachments(access.allowed ? note.id : null);
  const wrappedKey = note.wrappedKeys[profile.uid];
  const [displayAttachments, setDisplayAttachments] = useState<PrivateNoteAttachmentSnapshot[]>([]);
  const [fileNamesLoading, setFileNamesLoading] = useState(false);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!access.allowed) setReturnFocusTo(null);
  }, [access.allowed]);

  useEffect(() => {
    const controller = new AbortController();

    if (!access.allowed || !wrappedKey || !attachments.attachments.length) {
      setDisplayAttachments((current) => current.length ? [] : current);
      setFileNamesLoading(false);
      return () => controller.abort();
    }

    setDisplayAttachments([]);
    setFileNamesLoading(true);
    void unwrapNoteKey(wrappedKey, privateKey)
      .then(async (noteKey) => {
        const decrypted = await decryptPrivateNoteAttachmentNames(attachments.attachments, noteKey);
        controller.signal.throwIfAborted();
        setDisplayAttachments(decrypted);
        setFileNamesLoading(false);

        if (note.ownerUid === profile.uid) {
          void migrateLegacyPrivateNoteAttachmentNames(
            attachments.attachments,
            noteKey,
            controller.signal
          ).catch(() => undefined);
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // Protected records already contain only a generic fallback. Historical
        // records intentionally retain their legacy name until migration succeeds.
        setDisplayAttachments(attachments.attachments);
        setFileNamesLoading(false);
      });

    return () => controller.abort();
  }, [access.allowed, attachments.attachments, note.id, note.ownerUid, privateKey, profile.uid, wrappedKey]);

  if (!access.allowed) return null;

  return (
    <>
      <VaultNoteAttachmentsInline
        attachments={displayAttachments}
        disabled={disabled}
        error={attachments.error}
        loading={attachments.loading || fileNamesLoading}
        onManage={setReturnFocusTo}
      />
      {returnFocusTo ? (
        <Suspense fallback={createPortal(
          <div aria-live="polite" className="vault-dialog-loading" role="status">첨부파일 관리 불러오는 중…</div>,
          document.body
        )}>
          <LazyVaultNoteAttachmentsDialog
            attachments={displayAttachments}
            attachmentsError={attachments.error}
            attachmentsLoading={attachments.loading || fileNamesLoading}
            attachmentSlotCount={attachments.reservedCount}
            note={note}
            onClose={() => setReturnFocusTo(null)}
            onOpenLibrary={() => {
              setReturnFocusTo(null);
              onOpenLibrary();
            }}
            privateKey={privateKey}
            profile={profile}
            returnFocusTo={returnFocusTo}
          />
        </Suspense>
      ) : null}
    </>
  );
}

export default VaultNoteAttachmentsRegion;
