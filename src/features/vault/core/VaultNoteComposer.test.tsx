import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultNoteComposer } from "./VaultNoteComposer";
import type { ComposerEntrySnapshot, NoteComposerAdapter } from "./noteComposer";

const active: ComposerEntrySnapshot = {
  body: "앞 선택 뒤",
  contentFormat: "markdown-v1",
  dirty: false,
  folderId: null,
  id: "source",
  revision: 2,
  title: "원본"
};

function composerAdapter(): NoteComposerAdapter {
  return {
    createMarkdownCopy: vi.fn(async () => ({ entryId: "new-entry", revision: 1 })),
    flushDirtyDraft: vi.fn(async (guard) => guard),
    readEntry: vi.fn(async (id) => id === active.id ? active : null),
    saveMarkdown: vi.fn(async ({ expectedRevision }) => ({ revision: expectedRevision + 1 })),
    trashEntry: vi.fn(async () => undefined)
  };
}

describe("VaultNoteComposer", () => {
  it("runs the revision-aware split workflow and opens the created entry", async () => {
    const adapter = composerAdapter();
    const onComplete = vi.fn();
    render(
      <VaultNoteComposer
        activeEntry={active}
        adapter={adapter}
        mergeCandidates={[]}
        onComplete={onComplete}
        selection={{ start: 2, end: 4 }}
      />
    );

    fireEvent.change(screen.getByLabelText("새 노트 이름"), { target: { value: "분리 노트" } });
    fireEvent.click(screen.getByRole("button", { name: /새 노트로 분리/ }));

    await waitFor(() => expect(adapter.createMarkdownCopy).toHaveBeenCalledWith(expect.objectContaining({
      body: "선택",
      title: "분리 노트"
    })));
    expect(adapter.saveMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      body: "앞 [[분리 노트]] 뒤",
      expectedRevision: 2
    }));
    expect(onComplete).toHaveBeenCalledWith("new-entry");
    expect(screen.getByRole("status")).toHaveTextContent("분리했습니다");
  });

  it("moves between split and merge tabs with the keyboard", () => {
    render(
      <VaultNoteComposer
        activeEntry={active}
        adapter={composerAdapter()}
        mergeCandidates={[]}
        selection={null}
      />
    );
    const splitTab = screen.getByRole("tab", { name: "노트 분리" });
    splitTab.focus();
    fireEvent.keyDown(splitTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "노트 합치기" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("노트 합치기");
  });
});
