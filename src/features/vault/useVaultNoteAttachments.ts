import { useEffect, useState } from "react";
import {
  subscribeNoteAttachments,
  type NoteAttachmentSnapshot
} from "../../services/notes";

interface VaultNoteAttachmentsState {
  attachments: NoteAttachmentSnapshot[];
  error: string;
  loading: boolean;
  noteId: string | null;
  reservedCount: number;
}

const emptyVaultNoteAttachmentsState: VaultNoteAttachmentsState = {
  attachments: [],
  error: "",
  loading: false,
  noteId: null,
  reservedCount: 0
};

export function useVaultNoteAttachments(noteId: string | null) {
  const [state, setState] = useState<VaultNoteAttachmentsState>(emptyVaultNoteAttachmentsState);

  useEffect(() => {
    if (!noteId) {
      setState(emptyVaultNoteAttachmentsState);
      return undefined;
    }

    let active = true;
    setState({ attachments: [], error: "", loading: true, noteId, reservedCount: 0 });
    const unsubscribe = subscribeNoteAttachments(
      noteId,
      (attachments, metadata) => {
        if (!active) return;
        setState({
          attachments,
          error: "",
          loading: !metadata.serverComplete,
          noteId,
          reservedCount: metadata.reservedCount
        });
      },
      () => {
        if (!active) return;
        setState({
          attachments: [],
          error: "첨부파일 목록을 불러오지 못했습니다.",
          loading: false,
          noteId,
          reservedCount: 0
        });
      }
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [noteId]);

  if (state.noteId !== noteId) {
    return {
      attachments: [] as NoteAttachmentSnapshot[],
      error: "",
      loading: Boolean(noteId),
      reservedCount: 0
    };
  }

  return {
    attachments: state.attachments,
    error: state.error,
    loading: state.loading,
    reservedCount: state.reservedCount
  };
}
