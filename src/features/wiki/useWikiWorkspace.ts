import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { VaultIndexEntry } from "../knowledge/types";
import { EMPTY_WIKI_WORKSPACE, normalizeWikiWorkspace, reduceWikiWorkspace, type ControlledWikiWorkspace, type WikiWorkspaceAction, type WikiWorkspaceState } from "./wikiWorkspace";

export function useWikiWorkspace(entries: readonly VaultIndexEntry[], mode: "private" | "public", basePath: string, controlled?: ControlledWikiWorkspace) {
  const location = useLocation();
  const navigate = useNavigate();
  const [navigationVersion, setNavigationVersion] = useState(0);
  const allowedIds = useMemo(() => new Set(entries.map((entry) => entry.id)), [entries]);
  // Render-time hrefs depend only on names/IDs, never on live body edits.
  const pathsKey = JSON.stringify(entries.map((entry) => [entry.id, entry.path]));
  const pathsById = useMemo(() => new Map<string, string>(JSON.parse(pathsKey) as [string, string][]), [pathsKey]);
  const scope = `${mode}:${basePath}`;
  const state = useMemo(() => {
    if (controlled) return normalizeWikiWorkspace(controlled.state, allowedIds);
    const saved: unknown = location.state?.wikiWorkspace;
    if (saved && typeof saved === "object" && "scope" in saved && saved.scope === scope) return normalizeWikiWorkspace(saved, allowedIds);
    const params = new URLSearchParams(location.search);
    const path = params.get("page");
    const matches = path ? entries.filter((entry) => entry.path === path) : [];
    const requested = mode === "public" ? matches.length === 1 ? matches[0].id : undefined : params.get("note");
    const explicit = mode === "public" ? params.has("page") : params.has("note");
    const id = explicit ? requested && allowedIds.has(requested) ? requested : undefined : entries[0]?.id;
    return id ? reduceWikiWorkspace(EMPTY_WIKI_WORKSPACE, { type: "open", id }) : EMPTY_WIKI_WORKSPACE;
  }, [allowedIds, controlled, entries, location.search, location.state, mode, scope]);
  const currentState = useRef(state);
  useLayoutEffect(() => { currentState.current = state; }, [state]);
  const urlFor = useCallback((id: string) => {
    const path = pathsById.get(id);
    const search = path !== undefined ? new URLSearchParams(mode === "public" ? { page: path } : { note: id }).toString() : "";
    return basePath + (search ? `?${search}` : "");
  }, [basePath, mode, pathsById]);
  function commit(next: WikiWorkspaceState, focus = true, replace = false) {
    const normalized = normalizeWikiWorkspace(next, allowedIds);
    // Independent save guards can settle in one React batch. Apply each action
    // to the previous commit even before Router renders the updated history.
    currentState.current = normalized;
    controlled?.onChange(normalized);
    // Browser history retains only IDs and UI geometry. Neither body text nor
    // crypto material is serialized, and every restoration rechecks authority.
    navigate(normalized.activeId ? urlFor(normalized.activeId) : basePath, {
      replace, state: { ...location.state, wikiWorkspace: { scope, ...normalized } }
    });
    if (focus) setNavigationVersion((version) => version + 1);
  }
  function dispatch(action: WikiWorkspaceAction, focus = true) {
    if (!allowedIds.has(action.id)) return;
    commit(reduceWikiWorkspace(currentState.current, action), focus, action.type === "resize");
  }
  useEffect(() => {
    // Replace the first entry so a reload/back restores the same workspace even
    // if the next inventory arrives in a different order.
    if (controlled || !state.panels.length || location.state?.wikiWorkspace?.scope === scope) return;
    navigate(state.activeId ? urlFor(state.activeId) : basePath, { replace: true,
      state: { ...location.state, wikiWorkspace: { scope, ...state } } });
  }, [basePath, controlled, location.state, navigate, scope, state, urlFor]);
  return { state, commit, dispatch, urlFor, navigationVersion };
}
