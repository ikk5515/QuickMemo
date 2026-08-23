import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "../features/vault/vaultData";
import type { VaultTreeTarget } from "../features/vault/fileTreeSelection";
import { VaultFileTree } from "./VaultPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function folder(id: string, displayName: string, parentId: string | null = null) {
  return { displayName, id, parentId } as DecryptedVaultFolder;
}

function note(id: string, title: string, folderId: string | null = null) {
  return {
    body: "",
    contentFormat: "markdown-v1",
    encryptedBody: { algorithm: "AES-GCM", cipherText: "", iv: "", version: 1 },
    encryptedTitle: { algorithm: "AES-GCM", cipherText: "", iv: "", version: 1 },
    entryKind: "markdown",
    folderId,
    id,
    ownerUid: "owner",
    participantUids: [],
    title,
    type: "personal",
    updatedBy: "owner",
    wrappedKeys: {}
  } satisfies DecryptedVaultNote;
}

function renderTree({
  expandedFolderIds = new Set<string>(),
  folders = [] as DecryptedVaultFolder[],
  notes = [note("a", "A"), note("b", "B"), note("c", "C")]
} = {}) {
  const callbacks = {
    onBulkMove: vi.fn(async (targets: readonly VaultTreeTarget[], folderId: string | null): Promise<boolean | void> => {
      void folderId;
      void targets;
    }),
    onBulkTrash: vi.fn(async (targets: readonly VaultTreeTarget[]): Promise<boolean | void> => {
      void targets;
    }),
    onContextEntry: vi.fn(),
    onContextFolder: vi.fn(),
    onDropEntry: vi.fn(async () => undefined),
    onDropFolder: vi.fn(async () => undefined),
    onOpenEntry: vi.fn(),
    onRenameTarget: vi.fn(async () => undefined),
    onSelectFolder: vi.fn(),
    onToggleFolder: vi.fn()
  };
  render(
    <VaultFileTree
      expandedFolderIds={expandedFolderIds}
      folders={folders}
      mutationDisabled={false}
      notes={notes}
      selectedFolderId={null}
      {...callbacks}
    />
  );
  return callbacks;
}

describe("VaultFileTree multi-select UI", () => {
  it("toggles Cmd/Ctrl selection and clears it on an ordinary click", () => {
    const callbacks = renderTree();
    const first = screen.getByRole("treeitem", { name: "A" });
    const second = screen.getByRole("treeitem", { name: "B" });
    const mode = screen.getByRole("button", { name: "다중 선택" });
    expect(mode).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("tree")).not.toHaveAttribute("aria-multiselectable");
    fireEvent.click(mode);
    expect(mode).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tree")).toHaveAttribute("aria-multiselectable", "true");

    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("2개 선택")).toBeInTheDocument();
    expect(callbacks.onOpenEntry).not.toHaveBeenCalled();

    fireEvent.click(second);
    expect(first).toHaveAttribute("aria-selected", "false");
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("1개 선택")).toBeInTheDocument();
    expect(callbacks.onOpenEntry).not.toHaveBeenCalled();
  });

  it("selects a visible Shift range without opening every entry", () => {
    const callbacks = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "다중 선택" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "A" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "C" }), { shiftKey: true });

    for (const name of ["A", "B", "C"]) {
      expect(screen.getByRole("treeitem", { name })).toHaveAttribute("aria-selected", "true");
    }
    expect(callbacks.onOpenEntry).not.toHaveBeenCalled();
  });

  it("clears the selection when selection mode is closed", () => {
    renderTree();
    const mode = screen.getByRole("button", { name: "다중 선택" });
    const first = screen.getByRole("treeitem", { name: "A" });
    fireEvent.click(mode);
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-selected", "true");

    fireEvent.click(mode);
    expect(mode).toHaveAttribute("aria-pressed", "false");
    expect(first).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByText(/개 선택/u)).not.toBeInTheDocument();
  });

  it("requires one explicit confirmation before bounded bulk trash", async () => {
    const callbacks = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "다중 선택" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "A" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "B" }), { metaKey: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const trash = screen.getByRole("button", { name: "선택 항목 휴지통으로 이동" });

    fireEvent.click(trash);
    expect(callbacks.onBulkTrash).not.toHaveBeenCalled();
    fireEvent.click(trash);
    await waitFor(() => expect(callbacks.onBulkTrash).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(callbacks.onBulkTrash.mock.calls[0][0]).toHaveLength(2);
  });

  it("keeps the selection when parent-side bulk preflight rejects the action", async () => {
    const callbacks = renderTree();
    callbacks.onBulkTrash.mockResolvedValueOnce(false);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "다중 선택" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "선택 항목 휴지통으로 이동" }));

    await waitFor(() => expect(callbacks.onBulkTrash).toHaveBeenCalledTimes(1));
    expect(screen.getByText("1개 선택")).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "A" })).toHaveAttribute("aria-selected", "true");
  });

  it("moves a canonical selection through the existing folder dialog", async () => {
    const callbacks = renderTree({
      expandedFolderIds: new Set(["source"]),
      folders: [folder("source", "Source")],
      notes: [note("a", "A", "source"), note("b", "B", "source")]
    });
    fireEvent.click(screen.getByRole("button", { name: "다중 선택" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "A" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "B" }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "선택 항목 이동" }));
    fireEvent.click(screen.getByRole("button", { name: "Vault 루트" }));

    await waitFor(() => expect(callbacks.onBulkMove).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "a", kind: "entry" }),
        expect.objectContaining({ id: "b", kind: "entry" })
      ]),
      null
    ));
  });

  it("exposes rename only for one selected target", async () => {
    const callbacks = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "다중 선택" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "선택 항목 이름 변경" }));
    await waitFor(() => expect(callbacks.onRenameTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", kind: "entry" })
    ));
    fireEvent.click(screen.getByRole("treeitem", { name: "B" }), { ctrlKey: true });
    expect(screen.getByRole("button", { name: "선택 항목 이름 변경" })).toBeDisabled();
  });

  it.each([
    [{ ctrlKey: true }, { target: "new-tab" }],
    [{ altKey: true, metaKey: true }, { target: "new-group" }],
    [{ altKey: true, metaKey: true, shiftKey: true }, { target: "new-window" }]
  ] as const)("preserves modifier-based open intent %# outside explicit selection mode", (modifiers, intent) => {
    const callbacks = renderTree();
    fireEvent.click(screen.getByRole("treeitem", { name: "B" }), modifiers);
    expect(callbacks.onOpenEntry).toHaveBeenCalledWith("b", intent);
    expect(screen.queryByText(/개 선택/u)).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "B" })).toHaveAttribute("aria-selected", "false");
  });
});
