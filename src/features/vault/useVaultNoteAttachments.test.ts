import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteAttachmentSnapshot } from "../../services/notes";

const noteServiceMocks = vi.hoisted(() => ({
  subscribeNoteAttachments: vi.fn(),
  unsubscribe: vi.fn()
}));

vi.mock("../../services/notes", () => ({
  subscribeNoteAttachments: noteServiceMocks.subscribeNoteAttachments
}));

import { useVaultNoteAttachments } from "./useVaultNoteAttachments";

function attachment(id: string): NoteAttachmentSnapshot {
  return {
    algorithm: "AES-GCM-CHUNKED",
    blobPath: `users/user-a/notes/note-a/attachments/${id}/data`,
    chunkCount: 1,
    chunkIvs: [],
    chunkSize: 4 * 1024 * 1024,
    encryptedSize: 20,
    extension: "txt",
    fileName: id,
    id,
    isReady: true,
    mimeType: "text/plain",
    noteId: "note-a",
    originalSize: 4,
    storageProvider: "vercel-blob",
    uploadedBy: "user-a",
    version: 2
  };
}

beforeEach(() => {
  noteServiceMocks.subscribeNoteAttachments.mockReset();
  noteServiceMocks.unsubscribe.mockReset();
});

describe("useVaultNoteAttachments", () => {
  it("keeps one active metadata listener and clears the previous note immediately", async () => {
    let onNext: ((items: NoteAttachmentSnapshot[], metadata: {
      fromCache: boolean;
      hasPendingWrites: boolean;
      reservedCount: number;
      serverComplete: boolean;
    }) => void) | undefined;
    noteServiceMocks.subscribeNoteAttachments.mockImplementation((
      _noteId: string,
      next: typeof onNext
    ) => {
      onNext = next;
      return noteServiceMocks.unsubscribe;
    });
    const { result, rerender } = renderHook(
      ({ noteId }: { noteId: string | null }) => useVaultNoteAttachments(noteId),
      { initialProps: { noteId: "note-a" as string | null } }
    );

    expect(result.current).toEqual({ attachments: [], error: "", loading: true, reservedCount: 0 });
    act(() => onNext?.([attachment("first")], {
      fromCache: true,
      hasPendingWrites: false,
      reservedCount: 2,
      serverComplete: false
    }));
    expect(result.current.attachments.map((item) => item.id)).toEqual(["first"]);
    expect(result.current.loading).toBe(true);
    expect(result.current.reservedCount).toBe(2);
    act(() => onNext?.([attachment("first")], {
      fromCache: false,
      hasPendingWrites: false,
      reservedCount: 1,
      serverComplete: true
    }));
    expect(result.current.loading).toBe(false);
    expect(noteServiceMocks.subscribeNoteAttachments).toHaveBeenCalledTimes(1);

    rerender({ noteId: "note-b" });
    expect(result.current).toEqual({ attachments: [], error: "", loading: true, reservedCount: 0 });
    expect(noteServiceMocks.unsubscribe).toHaveBeenCalledOnce();
    await waitFor(() => expect(noteServiceMocks.subscribeNoteAttachments).toHaveBeenCalledTimes(2));
  });

  it("fails closed on listener errors and unsubscribes when access is removed", async () => {
    let onError: (() => void) | undefined;
    noteServiceMocks.subscribeNoteAttachments.mockImplementation((
      _noteId: string,
      _next: (items: NoteAttachmentSnapshot[]) => void,
      error: () => void
    ) => {
      onError = error;
      return noteServiceMocks.unsubscribe;
    });
    const { result, rerender } = renderHook(
      ({ noteId }: { noteId: string | null }) => useVaultNoteAttachments(noteId),
      { initialProps: { noteId: "note-a" as string | null } }
    );

    act(() => onError?.());
    expect(result.current).toEqual({
      attachments: [],
      error: "첨부파일 목록을 불러오지 못했습니다.",
      loading: false,
      reservedCount: 0
    });

    rerender({ noteId: null });
    expect(result.current).toEqual({ attachments: [], error: "", loading: false, reservedCount: 0 });
    await waitFor(() => expect(noteServiceMocks.unsubscribe).toHaveBeenCalledOnce());
  });
});
