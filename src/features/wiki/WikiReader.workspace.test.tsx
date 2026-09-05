import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WikiReader, type WikiReaderProps } from "./WikiReader";
import type { WikiReadableNote } from "./wikiModel";

const folders: WikiReaderProps["folders"] = [];
const notes: WikiReadableNote[] = ["A", "B", "C", "D"].map((id) => ({ id, title: id, body: `## ${id} heading\n${id} body`, entryKind: "markdown", contentFormat: "markdown-v1" }));
beforeEach(() => localStorage.clear());
function Location() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output data-testid="location">{JSON.stringify({ pathname: location.pathname, search: location.search, state: location.state })}</output>
    <button onClick={() => navigate(-1)}>History back</button></>;
}
function Editor({ note }: { note: WikiReadableNote }) {
  const [text, setText] = useState(note.body);
  return <textarea aria-label={`${note.id} editor`} value={text} onChange={(event) => setText(event.target.value)} />;
}
function treeOpen(id: string) { fireEvent.click(within(screen.getByRole("navigation", { name: "위키 폴더와 메모" })).getByRole("link", { name: id })); }
async function ready() { await screen.findByRole("list", { name: "그래프 노드" }); }

describe("Wiki workspace editor lifetime and history", () => {
  it("renders current link destinations when the authorized inventory arrives after mount", async () => {
    const view = render(<MemoryRouter><WikiReader notes={[]} folders={folders} /></MemoryRouter>);
    view.rerender(<MemoryRouter><WikiReader notes={notes} folders={folders} /></MemoryRouter>);
    expect(within(screen.getByRole("navigation", { name: "위키 폴더와 메모" })).getByRole("link", { name: "B" })).toHaveAttribute("href", "/wiki?note=B");
    await ready();
  });
  it("keeps the workspace mounted until its exit save guard succeeds", async () => {
    let finish: ((allowed: boolean) => void) | undefined;
    const guard = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<MemoryRouter initialEntries={["/wiki"]}><Routes><Route path="/wiki" element={<WikiReader notes={notes} folders={folders} homeLink={{ href: "/app", label: "메모" }} onBeforeExit={guard} />} /><Route path="/app" element={<h1>메모 화면</h1>} /></Routes><Location /></MemoryRouter>);
    await ready();
    const link = screen.getByRole("link", { name: "메모" });
    fireEvent.click(link); fireEvent.click(link);
    expect(guard).toHaveBeenCalledTimes(1); expect(link).toHaveAttribute("aria-disabled", "true");
    expect(JSON.parse(screen.getByTestId("location").textContent!).pathname).toBe("/wiki");
    await act(async () => finish?.(false));
    expect(JSON.parse(screen.getByTestId("location").textContent!).pathname).toBe("/wiki");
    expect(screen.getByRole("article", { name: "A" })).toBeInTheDocument();
    fireEvent.click(link); await act(async () => finish?.(true));
    expect(JSON.parse(screen.getByTestId("location").textContent!).pathname).toBe("/app");
  });
  it("keeps keyboard focus on a link when an already expanded neighboring document becomes active", async () => {
    const history = { wikiWorkspace: { scope: "private:/wiki", activeId: "B", panels: [
      { id: "A", width: 320, resized: true, collapsed: false }, { id: "B", width: 320, resized: true, collapsed: false }
    ] } };
    const data = [{ ...notes[0], body: "[[B]]" }, notes[1]];
    render(<MemoryRouter initialEntries={[{ pathname: "/wiki", search: "?note=B", state: history }]}><WikiReader notes={data} folders={folders} /></MemoryRouter>);
    await ready();
    const previous = screen.getByRole("article", { name: "A" });
    const link = within(previous).getByRole("button", { name: "B" });
    act(() => link.focus());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(previous).toHaveAttribute("data-active", "true"); expect(link).toHaveFocus();
  });
  it.each(["/wiki?note=foreign", "/wiki/published?page=foreign.md", "/wiki/published?page="])("does not substitute another note for an explicit unavailable address: %s", async (path) => {
    const publicMode = path.startsWith("/wiki/published");
    const view = render(<MemoryRouter initialEntries={[path]}><WikiReader notes={notes} folders={folders} mode={publicMode ? "public" : "private"} basePath={publicMode ? "/wiki/published" : "/wiki"} /></MemoryRouter>);
    expect(view.container.querySelectorAll(".wiki-panel")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "열린 문서가 없습니다" })).toBeInTheDocument();
    await act(async () => undefined);
  });
  it("uses the editor activation modifier for a workspace panel and Shift for a separate browser tab", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const data = [{ ...notes[0], body: "[[B]]" }, notes[1]];
    const reference = { kind: "wikilink" as const, target: "B", path: "B", raw: "[[B]]", subpath: null, display: "B", embed: false };
    render(<MemoryRouter><WikiReader notes={data} folders={folders} renderDocument={(_note, _entry, context) => <>
      <button onClick={() => context.openLink(reference, { ctrlKey: true })}>Follow editor link</button>
      <button onClick={() => context.openLink(reference, { metaKey: true, shiftKey: true })}>Separate tab</button>
    </>} /></MemoryRouter>);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Separate tab" }));
    expect(open).toHaveBeenCalledWith("/wiki?note=B", "_blank", "noopener,noreferrer");
    open.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Follow editor link" }));
    expect(screen.getByRole("article", { name: "B" })).toHaveAttribute("data-active", "true");
    expect(open).not.toHaveBeenCalled(); open.mockRestore();
  });
  it("preserves sibling editor state/DOM and skips their renders while one note changes or the sidebar resizes", async () => {
    const renderDocument = vi.fn((note: WikiReadableNote) => <Editor note={note} />);
    const view = render(<MemoryRouter><WikiReader notes={notes} folders={folders} renderDocument={renderDocument} /></MemoryRouter>);
    await ready(); treeOpen("B"); treeOpen("C"); treeOpen("D");
    const instances = [...view.container.querySelectorAll("textarea")];
    fireEvent.click(screen.getByRole("button", { name: "B 문서 펼치기" }));
    const editor = screen.getByRole("textbox", { name: "B editor" });
    fireEvent.change(editor, { target: { value: "unsaved B" } }); editor.scrollTop = 72;
    treeOpen("A"); renderDocument.mockClear();
    view.rerender(<MemoryRouter><WikiReader notes={[{ ...notes[0], body: "A changed" }, ...notes.slice(1)]} folders={folders} renderDocument={renderDocument} /></MemoryRouter>);
    expect(renderDocument.mock.calls.map(([note]) => note.id)).toEqual(["A"]);
    renderDocument.mockClear();
    fireEvent.keyDown(screen.getByRole("separator", { name: "위키 목록 너비 조절" }), { key: "ArrowRight" });
    expect(renderDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: /^QuickMemo$/ }));
    expect(view.container.querySelectorAll(".wiki-panel")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "B 문서 펼치기" }));
    expect(screen.getByRole("textbox", { name: "B editor" })).toBe(editor);
    expect(editor).toHaveValue("unsaved B"); expect(editor.scrollTop).toBe(72);
    expect([...view.container.querySelectorAll("textarea")]).toEqual(instances);
    await act(async () => undefined);
  });
  it("waits for the save guard and closes the requested document against the latest workspace", async () => {
    let finish: ((allowed: boolean) => void) | undefined;
    const guard = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const view = render(<MemoryRouter><WikiReader notes={notes} folders={folders} beforeCloseDocument={guard} /></MemoryRouter>);
    await ready(); treeOpen("B"); treeOpen("C");
    fireEvent.click(screen.getByRole("button", { name: "B 문서 닫기" }));
    expect(guard).toHaveBeenCalledWith("B"); treeOpen("D");
    await act(async () => { finish?.(true); });
    await waitFor(() => expect([...view.container.querySelectorAll<HTMLElement>(".wiki-panel")].map((panel) => panel.dataset.noteId)).toEqual(["A", "C", "D"]));
    expect(screen.getByRole("article", { name: "D" })).toHaveAttribute("data-active", "true");
  });
  it("closes both requested documents when their save guards settle together", async () => {
    let finish: ((allowed: boolean) => void) | undefined;
    const saved = new Promise<boolean>((resolve) => { finish = resolve; });
    const view = render(<MemoryRouter><WikiReader notes={notes} folders={folders} beforeCloseDocument={() => saved} /></MemoryRouter>);
    await ready(); treeOpen("B"); treeOpen("C"); treeOpen("D");
    fireEvent.click(screen.getByRole("button", { name: "B 문서 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "C 문서 닫기" }));
    await act(async () => { finish?.(true); });
    await waitFor(() => expect([...view.container.querySelectorAll<HTMLElement>(".wiki-panel")].map((panel) => panel.dataset.noteId)).toEqual(["A", "D"]));
    expect(screen.getByRole("article", { name: "D" })).toHaveAttribute("data-active", "true");
  });
  it("keeps a refused close mounted and does not steal focus from an owner editor", async () => {
    function AutofocusEditor() { return <textarea autoFocus aria-label="Focused editor" />; }
    const view = render(<MemoryRouter><WikiReader notes={notes.slice(0, 1)} folders={folders} beforeCloseDocument={async () => false} renderDocument={() => <AutofocusEditor />} /></MemoryRouter>);
    const editor = screen.getByRole("textbox", { name: "Focused editor" });
    await ready(); expect(editor).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "A 문서 닫기" }));
    await act(async () => undefined);
    expect(view.container.querySelectorAll(".wiki-panel")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Focused editor" })).toBe(editor);
  });
  it("restores authorized metadata on refresh and replaces resize history without leaking IDs into public URLs", async () => {
    const view = render(<MemoryRouter initialEntries={["/wiki/published"]}><WikiReader notes={notes} folders={folders} basePath="/wiki/published" mode="public" /><Location /></MemoryRouter>);
    await ready(); treeOpen("B"); treeOpen("C");
    fireEvent.keyDown(screen.getByRole("separator", { name: "C 문서 너비 조절" }), { key: "Home" });
    const saved = JSON.parse(screen.getByTestId("location").textContent!);
    expect(new URLSearchParams(saved.search).get("page")).toBe("C.md");
    expect(new URLSearchParams(saved.search).has("note")).toBe(false);
    expect(new URLSearchParams(saved.search).has("pane")).toBe(false);
    expect(saved.state.wikiWorkspace.panels.map((panel: { id: string }) => panel.id)).toEqual(["A", "B", "C"]);
    expect(JSON.stringify(saved.state)).not.toContain("body");
    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    expect(view.container.querySelectorAll(".wiki-panel")).toHaveLength(2);
    view.unmount();
    const refreshed = render(<MemoryRouter initialEntries={[saved]}><WikiReader notes={notes.filter((note) => note.id !== "B")} folders={folders} basePath="/wiki/published" mode="public" /></MemoryRouter>);
    expect([...refreshed.container.querySelectorAll<HTMLElement>(".wiki-panel")].map((panel) => panel.dataset.noteId)).toEqual(["A", "C"]);
    expect(screen.getByRole("article", { name: "C" })).toHaveAttribute("data-active", "true");
    await ready();
  });
});
