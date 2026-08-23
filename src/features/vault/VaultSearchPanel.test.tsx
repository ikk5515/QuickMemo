import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DecryptedVaultNote } from "./vaultData";
import { VaultSearchPanel, vaultSearchResultContext } from "./VaultSearchPanel";

function note(id: string, title: string, body: string): DecryptedVaultNote {
  return {
    body,
    contentFormat: "markdown-v1",
    encryptedBody: { algorithm: "AES-GCM", cipherText: "body", iv: "iv", version: 1 },
    encryptedTitle: { algorithm: "AES-GCM", cipherText: "title", iv: "iv", version: 1 },
    entryKind: "markdown",
    id,
    isDeleted: false,
    ownerUid: "owner",
    participantUids: ["owner"],
    revision: 1,
    title,
    type: "personal",
    updatedBy: "owner",
    wrappedKeys: {}
  };
}

describe("VaultSearchPanel", () => {
  it("shows a bounded matching-line context without evaluating regex input", () => {
    const item = note("a", "검색", `첫 줄\n${"앞 ".repeat(80)}찾는문구 뒤`);
    expect(vaultSearchResultContext(item, 'content:"찾는문구"')).toContain("찾는문구");
    expect(vaultSearchResultContext(item, "/(a+)+$/")).toBe("첫 줄");
    expect(vaultSearchResultContext(item, '"찾는문구"').length).toBeLessThanOrEqual(222);
  });

  it("saves, restores, removes a search bookmark and opens a result", () => {
    const onAddBookmark = vi.fn();
    const onOpen = vi.fn();
    const onQueryChange = vi.fn();
    const onRemoveBookmark = vi.fn();
    render(
      <VaultSearchPanel
        bookmarks={[{ id: "saved", label: "프로젝트", query: "tag:project", createdAt: 1 }]}
        notes={[note("a", "검색 노트", "프로젝트 문맥") ]}
        onAddBookmark={onAddBookmark}
        onOpen={onOpen}
        onQueryChange={onQueryChange}
        onRemoveBookmark={onRemoveBookmark}
        pathsByEntryId={new Map([["a", "Folder/검색 노트.md"]])}
        query="project"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "현재 검색 저장" }));
    fireEvent.change(screen.getByLabelText("검색 북마크 이름"), { target: { value: "  자주 쓰는 검색  " } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(onAddBookmark).toHaveBeenCalledWith("자주 쓰는 검색");

    fireEvent.click(screen.getByRole("button", { name: "프로젝트" }));
    expect(onQueryChange).toHaveBeenCalledWith("tag:project");
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 검색 북마크 삭제" }));
    expect(onRemoveBookmark).toHaveBeenCalledWith("saved");
    fireEvent.click(screen.getByRole("button", { name: /검색 노트/u }));
    expect(onOpen).toHaveBeenCalledWith("a");
  });
});
