import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteHistorySnapshot } from "../../services/notes";
import type { EncryptedPayload, WrappedNoteKey } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import { VaultHistoryPanel } from "./VaultHistoryPanel";

const mocks = vi.hoisted(() => ({
  decryptText: vi.fn(),
  subscribeNoteHistory: vi.fn(),
  unwrapNoteKey: vi.fn()
}));

vi.mock("../../lib/crypto", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/crypto")>(),
  decryptText: mocks.decryptText,
  unwrapNoteKey: mocks.unwrapNoteKey
}));

vi.mock("../../services/notes", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/notes")>(),
  subscribeNoteHistory: mocks.subscribeNoteHistory
}));

const encryptedSummary: EncryptedPayload = {
  algorithm: "AES-GCM",
  cipherText: "summary",
  iv: "summary-iv",
  version: 1
};
const encryptedSnapshot: EncryptedPayload = {
  algorithm: "AES-GCM",
  cipherText: "snapshot",
  iv: "snapshot-iv",
  version: 1
};
const wrappedKeyA: WrappedNoteKey = { algorithm: "RSA-OAEP", version: 1, wrappedKey: "wrapped-a" };
const wrappedKeyB: WrappedNoteKey = { algorithm: "RSA-OAEP", version: 1, wrappedKey: "wrapped-b" };
const privateKeyA = { key: "private-a" } as unknown as CryptoKey;
const privateKeyB = { key: "private-b" } as unknown as CryptoKey;
const noteKey = { key: "note" } as unknown as CryptoKey;

function vaultNote(id = "note-a"): DecryptedVaultNote {
  return {
    body: "# 현재",
    contentFormat: "markdown-v1",
    encryptedBody: encryptedSnapshot,
    encryptedTitle: encryptedSummary,
    entryKind: "markdown",
    id,
    ownerUid: "user-a",
    participantUids: ["user-a", "user-b"],
    title: "현재 노트",
    type: "shared",
    updatedBy: "user-a",
    wrappedKeys: { "user-a": wrappedKeyA, "user-b": wrappedKeyB }
  };
}

function historyEntry(noteId: string): NoteHistorySnapshot {
  return {
    action: "content",
    actorUid: "user-a",
    changedFields: ["body"],
    encryptedSnapshot,
    encryptedSummary,
    id: `${noteId}-history`,
    noteId,
    readerUids: ["user-a", "user-b"],
    revision: 2
  };
}

describe("VaultHistoryPanel plaintext lifecycle", () => {
  let emitHistory: (entries: NoteHistorySnapshot[]) => void;
  let emitError: (error: Error) => void;
  let historyCallbacks: Array<(entries: NoteHistorySnapshot[]) => void>;

  beforeEach(() => {
    mocks.decryptText.mockReset();
    mocks.subscribeNoteHistory.mockReset();
    mocks.unwrapNoteKey.mockReset();
    historyCallbacks = [];
    mocks.unwrapNoteKey.mockResolvedValue(noteKey);
    mocks.decryptText.mockImplementation(async (payload: EncryptedPayload) => (
      payload.cipherText === "summary"
        ? "권한이 필요한 이전 요약"
        : JSON.stringify({
            body: "권한이 필요한 이전 본문",
            contentFormat: "markdown-v1",
            entryKind: "markdown",
            folderId: null,
            title: "이전 제목"
          })
    ));
    mocks.subscribeNoteHistory.mockImplementation((
      _noteId: string,
      _uid: string,
      _includeAll: boolean,
      next: (entries: NoteHistorySnapshot[]) => void,
      error: (caught: Error) => void
    ) => {
      emitHistory = next;
      emitError = error;
      historyCallbacks.push(next);
      return vi.fn();
    });
  });

  it("does not present synchronized revision history as an independent backup", () => {
    render(<VaultHistoryPanel note={vaultNote()} onRestore={vi.fn()} privateKey={privateKeyA} uid="user-a" />);

    expect(screen.getByText(/독립 백업은 아닙니다/u)).toBeInTheDocument();
    expect(screen.queryByText(/동기화와 별개/u)).not.toBeInTheDocument();
  });

  it("ignores a queued callback from a listener that was already unsubscribed", async () => {
    const rendered = render(
      <VaultHistoryPanel note={vaultNote()} onRestore={vi.fn()} privateKey={privateKeyA} uid="user-a" />
    );
    const staleCallback = historyCallbacks[0];
    await act(async () => rendered.rerender(
      <VaultHistoryPanel note={vaultNote("note-b")} onRestore={vi.fn()} privateKey={privateKeyA} uid="user-a" />
    ));

    await act(async () => staleCallback([historyEntry("note-a")]));

    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(screen.queryByText("권한이 필요한 이전 요약")).not.toBeInTheDocument();
    expect(screen.getByText("아직 저장된 수정 이력이 없습니다.")).toBeInTheDocument();
  });

  it("clears summaries and snapshot previews immediately when the authorized listener errors", async () => {
    render(<VaultHistoryPanel note={vaultNote()} onRestore={vi.fn()} privateKey={privateKeyA} uid="user-a" />);
    await act(async () => emitHistory([historyEntry("note-a")]));
    expect(await screen.findByText("권한이 필요한 이전 요약")).toBeInTheDocument();
    expect(screen.getByText("이전 제목 미리보기")).toBeInTheDocument();

    act(() => emitError(new Error("permission-denied")));

    expect(screen.queryByText("권한이 필요한 이전 요약")).not.toBeInTheDocument();
    expect(screen.queryByText("이전 제목 미리보기")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("접근 권한과 연결 상태");
  });

  it("never renders rows decrypted for a previous entry, uid or private-key scope", async () => {
    const rendered = render(
      <VaultHistoryPanel note={vaultNote()} onRestore={vi.fn()} privateKey={privateKeyA} uid="user-a" />
    );
    await act(async () => emitHistory([historyEntry("note-a")]));
    expect(await screen.findByText("권한이 필요한 이전 요약")).toBeInTheDocument();

    rendered.rerender(
      <VaultHistoryPanel note={vaultNote("note-b")} onRestore={vi.fn()} privateKey={privateKeyA} uid="user-a" />
    );
    expect(screen.queryByText("권한이 필요한 이전 요약")).not.toBeInTheDocument();
    await act(async () => emitHistory([historyEntry("note-b")]));
    expect(await screen.findByText("권한이 필요한 이전 요약")).toBeInTheDocument();

    rendered.rerender(
      <VaultHistoryPanel note={vaultNote("note-b")} onRestore={vi.fn()} privateKey={privateKeyA} uid="user-b" />
    );
    expect(screen.queryByText("권한이 필요한 이전 요약")).not.toBeInTheDocument();
    await act(async () => emitHistory([historyEntry("note-b")]));
    expect(await screen.findByText("권한이 필요한 이전 요약")).toBeInTheDocument();

    let resolveNewKey!: (key: CryptoKey) => void;
    mocks.unwrapNoteKey.mockImplementationOnce(() => new Promise((resolve) => {
      resolveNewKey = resolve;
    }));
    rendered.rerender(
      <VaultHistoryPanel note={vaultNote("note-b")} onRestore={vi.fn()} privateKey={privateKeyB} uid="user-b" />
    );
    expect(screen.queryByText("권한이 필요한 이전 요약")).not.toBeInTheDocument();
    await act(async () => resolveNewKey(noteKey));
  });
});
