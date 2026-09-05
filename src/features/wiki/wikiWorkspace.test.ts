import { describe, expect, it } from "vitest";
import { EMPTY_WIKI_WORKSPACE, normalizeWikiWorkspace, reduceWikiWorkspace, wikiWorkspaceLayout, type WikiWorkspaceState } from "./wikiWorkspace";

function opened(ids = ["a", "b", "c", "d"]) { return ids.reduce((state, id) => reduceWikiWorkspace(state, { type: "open", id }), EMPTY_WIKI_WORKSPACE); }
const ids = (state: WikiWorkspaceState) => state.panels.map((panel) => panel.id);

describe("ordered Wiki document workspace", () => {
  it("appends without eviction and activates an existing document without deleting or moving any neighbor", () => {
    const state = opened(Array.from({ length: 30 }, (_, index) => String(index)));
    expect(state.panels).toHaveLength(30);
    const active = reduceWikiWorkspace(state, { type: "open", id: "3" });
    expect(ids(active)).toEqual(ids(state)); expect(active.activeId).toBe("3");
  });
  it.each(["a", "b", "c", "d"])("closes only %s and preserves other document metadata", (id) => {
    const state = opened();
    const result = reduceWikiWorkspace(state, { type: "close", id });
    expect(ids(result)).toEqual(ids(state).filter((candidate) => candidate !== id));
    result.panels.forEach((panel) => expect(panel).toBe(state.panels.find((item) => item.id === panel.id)));
    expect(result.activeId).toBe(id === "d" ? "c" : "d");
  });
  it("activates the nearest surviving document, supports all closed, and restores an explicitly collapsed empty selection", () => {
    const active = reduceWikiWorkspace(opened(), { type: "activate", id: "b" });
    expect(reduceWikiWorkspace(active, { type: "close", id: "b" }).activeId).toBe("c");
    const collapsed = reduceWikiWorkspace(opened(["a"]), { type: "toggle-collapse", id: "a" });
    expect(normalizeWikiWorkspace(collapsed, new Set(["a"]))).toEqual(collapsed);
    expect(reduceWikiWorkspace(collapsed, { type: "close", id: "a" })).toEqual(EMPTY_WIKI_WORKSPACE);
  });
  it.each(["close", "toggle-collapse"] as const)("expands a previously collapsed neighbor selected by %s and lets it collapse on the first click", (type) => {
    let state = reduceWikiWorkspace(opened(["a", "b"]), { type: "activate", id: "a" });
    state = reduceWikiWorkspace(state, { type: "toggle-collapse", id: "b" });
    state = reduceWikiWorkspace(state, { type, id: "a" });
    expect(state.activeId).toBe("b");
    expect(state.panels.find((panel) => panel.id === "b")?.collapsed).toBe(false);
    state = reduceWikiWorkspace(state, { type: "toggle-collapse", id: "b" });
    expect(state.activeId).not.toBe("b");
    expect(state.panels.find((panel) => panel.id === "b")?.collapsed).toBe(true);
  });
  it("reorders and resizes independently without changing the active editor", () => {
    let state = reduceWikiWorkspace(opened(), { type: "reorder", id: "a", toIndex: 2 });
    expect(ids(state)).toEqual(["b", "c", "a", "d"]); expect(state.activeId).toBe("d");
    state = reduceWikiWorkspace(state, { type: "resize", id: "c", width: 410 });
    expect(state.panels.find((panel) => panel.id === "c")?.width).toBe(410);
    expect(reduceWikiWorkspace(state, { type: "resize", id: "c", width: -1 }).panels[1].width).toBe(280);
  });
  it("filters restored history against current authority, strips unrelated fields and clamps malformed geometry", () => {
    const state = normalizeWikiWorkspace({ activeId: "secret", body: "must never persist", panels: [
      { id: "a", width: Infinity }, { id: "secret", width: 700 }, { id: "b", width: 10, collapsed: true }, { id: "a", width: 1000 }
    ] }, new Set(["a", "b"]));
    expect(state).toEqual({ activeId: "b", panels: [{ id: "a", width: 700, collapsed: false }, { id: "b", width: 280, collapsed: false }] });
  });
  it("keeps preceding and following 36px strips in order around the active 592px document", () => {
    const state = reduceWikiWorkspace(opened(), { type: "activate", id: "a" });
    expect(wikiWorkspaceLayout(state, 700)).toEqual({ compact: false, placements: [
      { id: "a", x: 0, width: 592, collapsed: false }, { id: "b", x: 592, width: 36, collapsed: true },
      { id: "c", x: 628, width: 36, collapsed: true }, { id: "d", x: 664, width: 36, collapsed: true }
    ] });
    const middle = wikiWorkspaceLayout(reduceWikiWorkspace(state, { type: "activate", id: "c" }), 700);
    expect(middle.placements.map((panel) => [panel.x, panel.width, panel.collapsed])).toEqual([[0, 36, true], [36, 36, true], [72, 592, false], [664, 36, true]]);
  });
  it("uses a compact document chooser when strips cannot fit, without dropping a document", () => {
    const state = opened(Array.from({ length: 40 }, (_, index) => String(index)));
    for (const width of [280, 320, 700]) {
      const layout = wikiWorkspaceLayout(state, width);
      expect(layout.compact).toBe(true); expect(layout.placements).toHaveLength(40);
      expect(layout.placements.filter((panel) => !panel.collapsed).map((panel) => panel.id)).toEqual(["39"]);
      expect(layout.placements.every((panel) => panel.width === width && panel.x === 0)).toBe(true);
    }
  });
  it("fills the default available reading area but honors an explicitly resized document", () => {
    const state = opened(["a", "b"]);
    expect(wikiWorkspaceLayout(state, 860).placements.at(-1)?.width).toBe(824);
    const resized = reduceWikiWorkspace(state, { type: "resize", id: "b", width: 500 });
    expect(wikiWorkspaceLayout(resized, 860).placements.at(-1)?.width).toBe(500);
    expect(normalizeWikiWorkspace(resized, new Set(["a", "b"]))).toEqual(resized);
  });
});
