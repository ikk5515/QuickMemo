import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useCallback, useState } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { CodeMirrorMarkdownEditor } from "../vault/CodeMirrorMarkdownEditor";
import { WikiReader, type WikiReaderProps } from "./WikiReader";
import type { WikiReadableNote } from "./wikiModel";

const notes: WikiReadableNote[] = ["A", "B", "C", "D"].map((id) => ({
  id, title: id, body: `## ${id}\n\n${id} original body`, contentFormat: "markdown-v1", entryKind: "markdown"
}));
const folders: WikiReaderProps["folders"] = [];
const initial = { pathname: "/wiki", search: "?note=D", state: { wikiWorkspace: {
  scope: "private:/wiki", activeId: "D", panels: notes.map(({ id }) => ({ id, width: 700, collapsed: false }))
} } };

function OwnerWorkspace() {
  const [active, setActive] = useState<string | null>("D");
  const [drafts, setDrafts] = useState(notes);
  const location = useLocation();
  const renderDocument = useCallback<NonNullable<WikiReaderProps["renderDocument"]>>((note, _entry, context) => (
    <CodeMirrorMarkdownEditor ariaLabel={`${note.id} editor`} autoFocus={context.active && !context.collapsed}
      documentKey={`wiki:${note.id}`} livePreview value={note.body}
      onChange={(body) => setDrafts((current) => current.map((entry) => entry.id === note.id ? { ...entry, body } : entry))} />
  ), []);
  return <><WikiReader notes={drafts} folders={folders} mode="private" renderDocument={renderDocument}
    onActiveDocumentChange={(id) => { if (id !== active) setActive(id); }} />
    <output data-testid="owner-active">{active}</output><output data-testid="owner-location">{location.search}</output></>;
}

beforeEach(() => localStorage.clear());

describe("owner Wiki strip activation with retained CodeMirror editors", () => {
  it("activates a collapsed strip through the owner callback and keeps the new caret, URL and all editor instances", async () => {
    const rendered = render(<MemoryRouter initialEntries={[initial]}><OwnerWorkspace /></MemoryRouter>);
    await screen.findByRole("list", { name: "그래프 노드" });
    const editors = [...rendered.container.querySelectorAll<HTMLElement>(".cm-content")];
    expect(editors).toHaveLength(4);
    const c = rendered.container.querySelector<HTMLElement>('.wiki-panel[data-note-id="C"]')!;
    expect(c).toHaveAttribute("aria-hidden", "true");
    const expand = screen.getByRole("button", { name: "C 문서 펼치기" });
    act(() => expand.focus());
    fireEvent.pointerDown(expand); fireEvent.mouseDown(expand); fireEvent.mouseUp(expand); fireEvent.click(expand);
    await waitFor(() => expect(screen.getByTestId("owner-active")).toHaveTextContent("C"));
    expect(screen.getByTestId("owner-location")).toHaveTextContent("?note=C");
    expect(c).toHaveAttribute("data-active", "true"); expect(c).not.toHaveAttribute("aria-hidden");
    const editor = within(c).getByRole("textbox", { name: "C editor" });
    expect(editor).toHaveFocus();
    act(() => {
      const view = EditorView.findFromDOM(editor)!;
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nC independent draft" } });
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(screen.getByTestId("owner-active")).toHaveTextContent("C");
    expect(screen.getByTestId("owner-location")).toHaveTextContent("?note=C");
    fireEvent.click(screen.getByRole("button", { name: "D 문서 펼치기" }));
    await waitFor(() => expect(screen.getByTestId("owner-active")).toHaveTextContent("D"));
    fireEvent.click(screen.getByRole("button", { name: "C 문서 펼치기" }));
    await waitFor(() => expect(screen.getByTestId("owner-active")).toHaveTextContent("C"));
    expect(EditorView.findFromDOM(editor)!.state.doc.toString()).toContain("C independent draft");
    expect([...rendered.container.querySelectorAll<HTMLElement>(".cm-content")]).toEqual(editors);
  });
});
