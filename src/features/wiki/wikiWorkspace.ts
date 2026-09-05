export const WIKI_DOCUMENT_WIDTH = 700;
export const WIKI_DOCUMENT_STRIP_WIDTH = 36;
export interface WikiWorkspacePanel { id: string; width: number; collapsed: boolean; resized?: boolean }
export interface WikiWorkspaceState { panels: readonly WikiWorkspacePanel[]; activeId: string | null }
export interface ControlledWikiWorkspace { state: WikiWorkspaceState; onChange: (state: WikiWorkspaceState) => void }
export type WikiWorkspaceAction =
  | { type: "open" | "activate" | "close" | "toggle-collapse"; id: string }
  | { type: "resize"; id: string; width: number }
  | { type: "reorder"; id: string; toIndex: number };
export const EMPTY_WIKI_WORKSPACE: WikiWorkspaceState = { panels: [], activeId: null };

function panelWidth(width: unknown) { return typeof width === "number" && Number.isFinite(width) ? Math.round(Math.max(280, Math.min(1200, width))) : WIKI_DOCUMENT_WIDTH; }
function withActivePanel(panels: readonly WikiWorkspacePanel[], activeId: string | null): WikiWorkspaceState {
  return { panels: panels.map((panel) => panel.id === activeId && panel.collapsed ? { ...panel, collapsed: false } : panel), activeId };
}

/** History is untrusted metadata. Only currently authorized IDs survive normalization. */
export function normalizeWikiWorkspace(value: unknown, allowedIds: ReadonlySet<string>): WikiWorkspaceState {
  if (!value || typeof value !== "object" || !("panels" in value) || !Array.isArray(value.panels)) return EMPTY_WIKI_WORKSPACE;
  const panels: WikiWorkspacePanel[] = [];
  const seen = new Set<string>();
  for (const candidate of value.panels) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string" || seen.has(candidate.id) || !allowedIds.has(candidate.id)) continue;
    seen.add(candidate.id); panels.push({ id: candidate.id, width: panelWidth(candidate.width), collapsed: candidate.collapsed === true, ...(candidate.resized === true ? { resized: true } : {}) });
    if (panels.length >= allowedIds.size) break;
  }
  const activeId = "activeId" in value && value.activeId === null ? null : "activeId" in value && typeof value.activeId === "string" && seen.has(value.activeId) ? value.activeId : panels.at(-1)?.id ?? null;
  return withActivePanel(panels, activeId);
}

export function reduceWikiWorkspace(state: WikiWorkspaceState, action: WikiWorkspaceAction): WikiWorkspaceState {
  const index = state.panels.findIndex((panel) => panel.id === action.id);
  if (action.type === "open" || action.type === "activate") {
    if (index < 0 && action.type === "activate") return state;
    const panels = index < 0 ? [...state.panels, { id: action.id, width: WIKI_DOCUMENT_WIDTH, collapsed: false }]
      : state.panels.map((panel) => panel.id === action.id && panel.collapsed ? { ...panel, collapsed: false } : panel);
    return { panels, activeId: action.id };
  }
  if (index < 0) return state;
  if (action.type === "close") {
    const panels = state.panels.filter((panel) => panel.id !== action.id);
    const activeId = state.activeId === action.id ? panels[Math.min(index, panels.length - 1)]?.id ?? null : state.activeId;
    return withActivePanel(panels, activeId);
  }
  if (action.type === "reorder") {
    const panels = [...state.panels];
    const [panel] = panels.splice(index, 1);
    panels.splice(Math.max(0, Math.min(panels.length, Math.round(action.toIndex))), 0, panel);
    return { panels, activeId: state.activeId };
  }
  if (action.type === "resize") return { ...state, panels: state.panels.map((panel) => panel.id === action.id ? { ...panel, width: panelWidth(action.width), resized: true } : panel) };
  const collapsed = !state.panels[index].collapsed;
  const activeId = collapsed && state.activeId === action.id
    ? state.panels[index + 1]?.id ?? state.panels[index - 1]?.id ?? null : state.activeId;
  return withActivePanel(state.panels.map((panel) => panel.id === action.id ? { ...panel, collapsed } : panel), activeId);
}

export interface WikiPanelPlacement { id: string; x: number; width: number; collapsed: boolean }
export function wikiWorkspaceLayout(state: WikiWorkspaceState, availableWidth: number) {
  const width = Math.max(0, Number.isFinite(availableWidth) ? availableWidth : 0);
  const compact = width < 480 || width - Math.max(0, state.panels.length - 1) * WIKI_DOCUMENT_STRIP_WIDTH < 280;
  if (compact) return { compact, placements: state.panels.map((panel) => ({ id: panel.id, x: 0, width, collapsed: panel.id !== state.activeId })) };
  const expanded = new Set(state.panels.filter((panel) => !panel.collapsed).map((panel) => panel.id));
  if (state.activeId) expanded.add(state.activeId);
  const activeIndex = state.panels.findIndex((panel) => panel.id === state.activeId);
  let desired = state.panels.reduce((sum, panel) => sum + (expanded.has(panel.id) ? panel.width : WIKI_DOCUMENT_STRIP_WIDTH), 0);
  const oldest = state.panels.map((panel, index) => ({ panel, distance: Math.abs(index - activeIndex) }))
    .filter(({ panel }) => panel.id !== state.activeId && expanded.has(panel.id)).sort((a, b) => b.distance - a.distance);
  for (const { panel } of oldest) {
    if (desired <= width) break;
    expanded.delete(panel.id); desired -= panel.width - WIKI_DOCUMENT_STRIP_WIDTH;
  }
  const inactiveWidth = state.panels.reduce((sum, panel) => sum + (panel.id === state.activeId ? 0 : expanded.has(panel.id) ? panel.width : WIKI_DOCUMENT_STRIP_WIDTH), 0);
  let x = 0;
  const placements = state.panels.map((panel) => {
    const panelWidth = panel.id === state.activeId ? Math.min(panel.resized ? panel.width : width, Math.max(WIKI_DOCUMENT_STRIP_WIDTH, width - inactiveWidth))
      : expanded.has(panel.id) ? panel.width : WIKI_DOCUMENT_STRIP_WIDTH;
    const placement = { id: panel.id, x, width: panelWidth, collapsed: !expanded.has(panel.id) };
    x += panelWidth; return placement;
  });
  return { compact, placements };
}
