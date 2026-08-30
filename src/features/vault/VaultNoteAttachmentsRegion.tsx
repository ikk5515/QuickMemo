import { lazy, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { UserProfile } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import { VaultNoteAttachmentsInline } from "./VaultNoteAttachmentsInline";
import { useVaultNoteAttachments } from "./useVaultNoteAttachments";
import { vaultNoteAttachmentAccess } from "./vaultNoteAttachmentAccess";

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
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!access.allowed) setReturnFocusTo(null);
  }, [access.allowed]);

  if (!access.allowed) return null;

  return (
    <>
      <VaultNoteAttachmentsInline
        attachments={attachments.attachments}
        disabled={disabled}
        error={attachments.error}
        loading={attachments.loading}
        onManage={setReturnFocusTo}
      />
      {returnFocusTo ? (
        <Suspense fallback={createPortal(
          <div aria-live="polite" className="vault-dialog-loading" role="status">첨부파일 관리 불러오는 중…</div>,
          document.body
        )}>
          <LazyVaultNoteAttachmentsDialog
            attachments={attachments.attachments}
            attachmentsError={attachments.error}
            attachmentsLoading={attachments.loading}
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
