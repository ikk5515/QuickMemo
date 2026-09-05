import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "../vault/vaultData";
import { prepareWikiPublication } from "./prepareWikiPublication";
import { WikiReader } from "./WikiReader";
import type { WikiReadableNote } from "./wikiModel";

beforeEach(() => localStorage.clear());
const folders = [{ id: "public-folder", displayName: "공개 지식", parentId: null }];
const source: WikiReadableNote = { id: "start", title: "시작 문서", folderId: "public-folder", entryKind: "markdown", contentFormat: "markdown-v1", body: "" };
const linked: WikiReadableNote = { id: "linked", title: "연결 문서", folderId: "public-folder", entryKind: "markdown", contentFormat: "markdown-v1", body: "# 연결 문서\n\n## 세부 항목\n\n공개 본문" };
const encodedPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const sourcePath = "공개 지식/시작 문서.md";
const linkedPath = "공개 지식/연결 문서.md";
const basePath = "/wiki/public-test";
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname + location.search}</output>; }
function Reader({ notes }: { notes: WikiReadableNote[] }) {
  return <MemoryRouter initialEntries={[`${basePath}?${new URLSearchParams({ page: sourcePath })}`]}>
    <WikiReader mode="public" basePath={basePath} notes={notes} folders={folders} /><Location />
  </MemoryRouter>;
}
async function ready() { await screen.findByRole("list", { name: "그래프 노드" }); }

describe("public document activation uses the current approved path catalog", () => {
  it("opens a freshly prepared encoded absolute folder link, preserving the earlier panel and readable URL", async () => {
    const envelope = { version: 1 as const, algorithm: "AES-GCM" as const, cipherText: "fixture", iv: "fixture" };
    const owner = { ownerUid: "owner", type: "personal" as const, participantUids: ["owner"], revision: 1, updatedBy: "owner", encryptedBody: envelope, encryptedTitle: envelope, wrappedKeys: {} };
    const original: DecryptedVaultNote[] = [{ ...owner, ...source, body: "[[연결 문서]]" }, { ...owner, ...linked }];
    const originalFolders: DecryptedVaultFolder[] = folders.map((folder) => ({ ...folder, ownerUid: "owner", name: "encrypted", color: "#123456" }));
    const prepared = prepareWikiPublication({ rootFolderId: "public-folder", notes: original, folders: originalFolders });
    expect(prepared.contents[0].body).toBe(`[[/${encodedPath(linkedPath)}|연결 문서]]`);
    const notes = [source, linked].map((note) => ({ ...note, body: prepared.contents.find((content) => content.sourceNoteId === note.id)!.body }));
    const { container } = render(<Reader notes={notes} />); await ready();
    const first = screen.getByRole("article", { name: source.title }); first.scrollTop = 215;
    const link = within(first).getByRole("button", { name: linked.title });
    fireEvent.focus(link);
    expect(await screen.findByRole("region", { name: "연결된 메모 미리보기" })).toHaveTextContent("공개 본문");
    fireEvent.click(link);
    await waitFor(() => expect(container.querySelectorAll(".wiki-panel")).toHaveLength(2));
    expect(first).toBeInTheDocument(); expect(first.scrollTop).toBe(215);
    const active = screen.getByRole("article", { name: linked.title });
    expect(active).toHaveAttribute("data-active", "true"); await waitFor(() => expect(active).toHaveFocus());
    const backlinks = within(active).getByRole("region", { name: "이 메모를 연결한 메모" });
    expect(await within(backlinks).findByRole("link", { name: source.title })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(`${basePath}?${new URLSearchParams({ page: linkedPath })}`);
  });

  it.each([false, true])("opens the exact root document from a nested source (legacy bare=%s)", async (legacy) => {
    const target = `${legacy ? "" : "/"}${encodedPath("연결 문서.md")}`;
    const { container } = render(<Reader notes={[{ ...source, body: `[[${target}|루트 열기]]` }, { ...linked, folderId: null }]} />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "루트 열기" }));
    await waitFor(() => expect(container.querySelectorAll(".wiki-panel")).toHaveLength(2));
    expect(container.querySelector('.wiki-panel[data-active="true"]')).toHaveAttribute("data-note-id", "linked");
    const backlinks = within(screen.getByRole("article", { name: linked.title })).getByRole("region", { name: "이 메모를 연결한 메모" });
    expect(await within(backlinks).findByRole("link", { name: source.title })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(`${basePath}?${new URLSearchParams({ page: "연결 문서.md" })}`);
  });

  it("distinguishes absolute root and existing relative same-name documents without escaping the catalog", async () => {
    const notes = [{ ...source, body: `[[/${encodedPath("연결 문서.md")}|루트 열기]]\n\n[[${encodedPath("연결 문서.md")}|상대 열기]]\n\n[[/개인/숨긴 문서.md|비공개 제목]]` },
      { ...linked, folderId: null }, { ...linked, id: "relative" }];
    const { container } = render(<Reader notes={notes} />); await ready();
    const first = screen.getByRole("article", { name: source.title });
    expect(within(first).queryByRole("button", { name: "비공개 제목" })).not.toBeInTheDocument();
    fireEvent.click(within(first).getByRole("button", { name: "루트 열기" }));
    expect(container.querySelector('.wiki-panel[data-active="true"]')).toHaveAttribute("data-note-id", "linked");
    fireEvent.click(screen.getByRole("button", { name: `${source.title} 문서 펼치기` }));
    fireEvent.click(within(first).getByRole("button", { name: "상대 열기" }));
    expect(container.querySelector('.wiki-panel[data-active="true"]')).toHaveAttribute("data-note-id", "relative");
    expect(container.querySelectorAll(".wiki-panel")).toHaveLength(3);
  });
});
