import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../types";
import type { NoteAttachmentSnapshot } from "../../services/notes";
import type { DecryptedVaultNote } from "./vaultData";

const noteServiceMocks = vi.hoisted(() => ({
  createNoteAttachment: vi.fn(),
  deleteNoteAttachment: vi.fn(),
  getEncryptedNoteAttachmentSource: vi.fn(),
  subscribeNoteAttachments: vi.fn(),
  unsubscribeNoteAttachments: vi.fn()
}));

const attachmentCryptoMocks = vi.hoisted(() => ({
  decryptAttachmentToBlob: vi.fn(),
  encryptAttachmentBlob: vi.fn()
}));

const cryptoMocks = vi.hoisted(() => ({
  unwrapNoteKey: vi.fn()
}));

const downloadBlobMock = vi.hoisted(() => vi.fn());
const useModalFocusMock = vi.hoisted(() => vi.fn());
const attachmentState = vi.hoisted(() => ({
  items: [] as NoteAttachmentSnapshot[]
}));

vi.mock("../../services/notes", () => ({
  createNoteAttachment: noteServiceMocks.createNoteAttachment,
  deleteNoteAttachment: noteServiceMocks.deleteNoteAttachment,
  getEncryptedNoteAttachmentSource: noteServiceMocks.getEncryptedNoteAttachmentSource,
  subscribeNoteAttachments: noteServiceMocks.subscribeNoteAttachments
}));

vi.mock("../../lib/attachmentCrypto", () => ({
  decryptAttachmentToBlob: attachmentCryptoMocks.decryptAttachmentToBlob,
  encryptAttachmentBlob: attachmentCryptoMocks.encryptAttachmentBlob
}));

vi.mock("../../lib/crypto", () => ({
  unwrapNoteKey: cryptoMocks.unwrapNoteKey
}));

vi.mock("../../lib/useModalFocus", () => ({
  useModalFocus: useModalFocusMock
}));

vi.mock("./browserDownload", () => ({
  downloadBlob: downloadBlobMock
}));

import { VaultNoteAttachmentsDialog } from "./VaultNoteAttachmentsDialog";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    allowedShareTargetUids: [],
    avatarText: "테",
    color: "#2f7d70",
    displayName: "테스트 사용자",
    featureAccess: { library: true, notes: true, schedule: true },
    isActive: true,
    isAdmin: false,
    loginEmail: "test@example.com",
    order: 1,
    publicKeyJwk: {},
    quickKey: 1,
    role: "user",
    uid: "user-a",
    ...overrides
  };
}

function note(overrides: Partial<DecryptedVaultNote> = {}): DecryptedVaultNote {
  return {
    body: "# 본문",
    contentFormat: "markdown-v1",
    encryptedBody: { algorithm: "AES-GCM", cipherText: "body", iv: "iv", version: 1 },
    encryptedTitle: { algorithm: "AES-GCM", cipherText: "title", iv: "iv", version: 1 },
    entryKind: "markdown",
    folderId: null,
    id: "note-a1",
    isDeleted: false,
    ownerUid: "user-a",
    participantUids: ["user-a"],
    revision: 4,
    title: "첨부 테스트 노트",
    type: "personal",
    updatedBy: "user-a",
    wrappedKeys: {
      "user-a": { algorithm: "RSA-OAEP", version: 1, wrappedKey: "owner-key" }
    },
    ...overrides
  };
}

function attachment(overrides: Partial<NoteAttachmentSnapshot> = {}): NoteAttachmentSnapshot {
  return {
    algorithm: "AES-GCM-CHUNKED",
    blobPath: "users/user-a/notes/note-a1/attachments/attachment-a/data",
    chunkCount: 1,
    chunkIvs: [],
    chunkSize: 4 * 1024 * 1024,
    encryptedSize: 20,
    extension: "txt",
    fileName: "자료",
    id: "attachment-a",
    isReady: true,
    mimeType: "text/plain",
    noteId: "note-a1",
    originalSize: 4,
    storageProvider: "vercel-blob",
    uploadedBy: "user-a",
    version: 2,
    ...overrides
  };
}

function renderDialog(options: {
  note?: DecryptedVaultNote;
  profile?: UserProfile;
} = {}) {
  const props = {
    note: options.note ?? note(),
    onClose: vi.fn(),
    onOpenLibrary: vi.fn(),
    privateKey: {} as CryptoKey,
    profile: options.profile ?? profile()
  };

  return {
    ...render(<VaultNoteAttachmentsDialog {...props} />),
    props
  };
}

beforeEach(() => {
  attachmentState.items = [];
  noteServiceMocks.createNoteAttachment.mockReset().mockResolvedValue(undefined);
  noteServiceMocks.deleteNoteAttachment.mockReset().mockResolvedValue(undefined);
  noteServiceMocks.getEncryptedNoteAttachmentSource.mockReset();
  noteServiceMocks.unsubscribeNoteAttachments.mockReset();
  noteServiceMocks.subscribeNoteAttachments.mockReset().mockImplementation((
    _noteId: string,
    onNext: (attachments: NoteAttachmentSnapshot[]) => void
  ) => {
    onNext(attachmentState.items);
    return noteServiceMocks.unsubscribeNoteAttachments;
  });
  attachmentCryptoMocks.decryptAttachmentToBlob.mockReset();
  attachmentCryptoMocks.encryptAttachmentBlob.mockReset();
  cryptoMocks.unwrapNoteKey.mockReset();
  downloadBlobMock.mockReset();
  useModalFocusMock.mockReset();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("VaultNoteAttachmentsDialog", () => {
  it("fails closed without starting an attachment subscription or API work", async () => {
    renderDialog({
      profile: profile({ featureAccess: { library: true, notes: false, schedule: true } })
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("활성화된 노트 권한");
    expect(noteServiceMocks.subscribeNoteAttachments).not.toHaveBeenCalled();
    expect(noteServiceMocks.createNoteAttachment).not.toHaveBeenCalled();
    expect(noteServiceMocks.getEncryptedNoteAttachmentSource).not.toHaveBeenCalled();
    expect(noteServiceMocks.deleteNoteAttachment).not.toHaveBeenCalled();
    expect(attachmentCryptoMocks.encryptAttachmentBlob).not.toHaveBeenCalled();
    expect(attachmentCryptoMocks.decryptAttachmentToBlob).not.toHaveBeenCalled();
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it("subscribes on an allowed mount without prefetching encrypted Blob data", async () => {
    attachmentState.items = [attachment()];

    renderDialog();

    expect(await screen.findByText("자료.txt")).toBeInTheDocument();
    expect(noteServiceMocks.subscribeNoteAttachments).toHaveBeenCalledWith(
      "note-a1",
      expect.any(Function),
      expect.any(Function)
    );
    expect(noteServiceMocks.getEncryptedNoteAttachmentSource).not.toHaveBeenCalled();
    expect(attachmentCryptoMocks.decryptAttachmentToBlob).not.toHaveBeenCalled();
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it("encrypts a selected file before calling the existing attachment upload API", async () => {
    const noteKey = {} as CryptoKey;
    const encryptedBlob = new Blob([new Uint8Array([9, 8, 7])], {
      type: "application/octet-stream"
    });
    const encryption = {
      algorithm: "AES-GCM-CHUNKED" as const,
      chunkCount: 1,
      chunkIvs: [new Uint8Array(12)],
      chunkSize: 4 * 1024 * 1024,
      encryptedSize: 20,
      version: 2 as const
    };
    cryptoMocks.unwrapNoteKey.mockResolvedValue(noteKey);
    attachmentCryptoMocks.encryptAttachmentBlob.mockResolvedValue({
      blob: encryptedBlob,
      metadata: encryption
    });
    renderDialog();
    await screen.findByText("이 노트에 첨부된 파일이 없습니다.");
    const input = document.querySelector<HTMLInputElement>('.vault-attachments-dialog input[type="file"]');
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [new File(["memo"], "memo.txt", { type: "text/plain" })] }
    });

    await waitFor(() => expect(noteServiceMocks.createNoteAttachment).toHaveBeenCalledOnce());
    expect(attachmentCryptoMocks.encryptAttachmentBlob).toHaveBeenCalledWith(
      expect.any(File),
      noteKey,
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(noteServiceMocks.createNoteAttachment).toHaveBeenCalledWith(expect.objectContaining({
      encryptedBlob,
      encryption,
      extension: "txt",
      fileName: "memo",
      mimeType: "text/plain",
      noteId: "note-a1",
      originalSize: 4,
      uploadedBy: "user-a"
    }));
    expect(attachmentCryptoMocks.encryptAttachmentBlob.mock.invocationCallOrder[0])
      .toBeLessThan(noteServiceMocks.createNoteAttachment.mock.invocationCallOrder[0]);
  });

  it("gets and decrypts ciphertext only after an explicit download click", async () => {
    const item = attachment();
    const noteKey = {} as CryptoKey;
    const encryptedSource = { bytes: new Uint8Array([1, 2, 3]) };
    const decryptedBlob = new Blob(["memo"], { type: "text/plain" });
    attachmentState.items = [item];
    cryptoMocks.unwrapNoteKey.mockResolvedValue(noteKey);
    noteServiceMocks.getEncryptedNoteAttachmentSource.mockResolvedValue(encryptedSource);
    attachmentCryptoMocks.decryptAttachmentToBlob.mockResolvedValue(decryptedBlob);
    renderDialog();

    const downloadButton = await screen.findByRole("button", { name: "자료.txt 다운로드" });
    expect(noteServiceMocks.getEncryptedNoteAttachmentSource).not.toHaveBeenCalled();
    expect(attachmentCryptoMocks.decryptAttachmentToBlob).not.toHaveBeenCalled();
    expect(downloadBlobMock).not.toHaveBeenCalled();

    await userEvent.click(downloadButton);

    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledWith(decryptedBlob, "자료.txt"));
    expect(noteServiceMocks.getEncryptedNoteAttachmentSource).toHaveBeenCalledOnce();
    expect(noteServiceMocks.getEncryptedNoteAttachmentSource).toHaveBeenCalledWith(item);
    expect(attachmentCryptoMocks.decryptAttachmentToBlob).toHaveBeenCalledWith(
      item,
      noteKey,
      encryptedSource
    );
    expect(noteServiceMocks.getEncryptedNoteAttachmentSource.mock.invocationCallOrder[0])
      .toBeLessThan(attachmentCryptoMocks.decryptAttachmentToBlob.mock.invocationCallOrder[0]);
    expect(attachmentCryptoMocks.decryptAttachmentToBlob.mock.invocationCallOrder[0])
      .toBeLessThan(downloadBlobMock.mock.invocationCallOrder[0]);
  });

  it("deletes through the existing note attachment API without downloading the Blob", async () => {
    const item = attachment();
    attachmentState.items = [item];
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderDialog();

    await userEvent.click(await screen.findByRole("button", { name: "자료.txt 삭제" }));

    await waitFor(() => expect(noteServiceMocks.deleteNoteAttachment).toHaveBeenCalledWith(
      "note-a1",
      "attachment-a"
    ));
    expect(confirm).toHaveBeenCalledWith("'자료.txt' 파일을 노트와 자료실 목록에서 삭제할까요?");
    expect(noteServiceMocks.getEncryptedNoteAttachmentSource).not.toHaveBeenCalled();
    expect(attachmentCryptoMocks.decryptAttachmentToBlob).not.toHaveBeenCalled();
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });
});
