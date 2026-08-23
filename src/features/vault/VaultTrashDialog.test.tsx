import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "./vaultData";
import { VaultTrashDialog } from "./VaultTrashDialog";

function deletedNote(id: string, title: string): DecryptedVaultNote {
  return {
    body: "# body",
    contentFormat: "markdown-v1",
    encryptedBody: { algorithm: "AES-GCM", cipherText: "body", iv: "iv", version: 1 },
    encryptedTitle: { algorithm: "AES-GCM", cipherText: "title", iv: "iv", version: 1 },
    entryKind: "markdown",
    id,
    isDeleted: true,
    ownerUid: "owner",
    participantUids: ["owner"],
    revision: 3,
    title,
    type: "personal",
    updatedBy: "owner",
    wrappedKeys: {}
  };
}

function deletedFolder(id: string, displayName: string): DecryptedVaultFolder {
  return {
    color: "#7c5cff",
    displayName,
    encryptedName: { algorithm: "AES-GCM", cipherText: "name", iv: "iv", version: 1 },
    id,
    isDeleted: true,
    name: "암호화 폴더",
    ownerUid: "owner",
    parentId: null,
    revision: 4,
    vaultNameClaimId: "C".repeat(43),
    vaultNameIndexVersion: 1,
    wrappedKey: { algorithm: "RSA-OAEP", version: 1, wrappedKey: "key" }
  };
}

describe("VaultTrashDialog", () => {
  it("keeps restore disabled until the server-confirmed snapshot is ready", () => {
    render(
      <VaultTrashDialog
        busyEntryIds={new Set()}
        busyFolderIds={new Set()}
        folders={[]}
        loading={false}
        notes={[deletedNote("a", "삭제 노트")]}
        onClose={vi.fn()}
        onRestore={vi.fn()}
        onRestoreFolder={vi.fn()}
        serverReady={false}
      />
    );
    expect(screen.getByText("서버 확인을 완료하지 못해 복원을 잠갔습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "삭제 노트 복원" })).not.toBeInTheDocument();
  });

  it("searches and restores a selected encrypted entry", () => {
    const onRestore = vi.fn();
    render(
      <VaultTrashDialog
        busyEntryIds={new Set()}
        busyFolderIds={new Set()}
        folders={[]}
        loading={false}
        notes={[deletedNote("a", "회의 기록"), deletedNote("b", "독서 기록")]}
        onClose={vi.fn()}
        onRestore={onRestore}
        onRestoreFolder={vi.fn()}
        serverReady
      />
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "삭제된 항목 검색" }), {
      target: { value: "독서" }
    });
    expect(screen.queryByText("회의 기록")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "독서 기록 복원" }));
    expect(onRestore).toHaveBeenCalledWith("b");
  });

  it("shows the logical subtree size and restores an outer encrypted folder tombstone", () => {
    const onRestoreFolder = vi.fn();
    render(
      <VaultTrashDialog
        busyEntryIds={new Set()}
        busyFolderIds={new Set()}
        folders={[{ entryCount: 8, folder: deletedFolder("folder-a", "프로젝트"), folderCount: 3 }]}
        loading={false}
        notes={[]}
        onClose={vi.fn()}
        onRestore={vi.fn()}
        onRestoreFolder={onRestoreFolder}
        serverReady
      />
    );
    expect(screen.getByText(/하위 폴더 3개 · 항목 8개/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 폴더 복원" }));
    expect(onRestoreFolder).toHaveBeenCalledWith("folder-a");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <VaultTrashDialog
        busyEntryIds={new Set()}
        busyFolderIds={new Set()}
        folders={[]}
        loading={false}
        notes={[]}
        onClose={onClose}
        onRestore={vi.fn()}
        onRestoreFolder={vi.fn()}
        serverReady
      />
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
