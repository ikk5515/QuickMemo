import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchWorkspacePreferences, saveWorkspaceSidebarPreference } from "../../services/workspacePreferences";
import { useLocalSidebarPreference } from "./sidebarPreference";
import { clampSidebarWidth, type ControlledSidebarPreference, type SidebarPreference } from "./useResizableSidebar";

function pendingKey(scope: string) { return `quickmemo:sidebar:pending:v1:${scope}`; }
function readPending(scope: string): SidebarPreference | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingKey(scope)) ?? "null") as SidebarPreference | null;
    return value && Number.isInteger(value.width) && value.width >= 180 && value.width <= 520 && typeof value.collapsed === "boolean" ? { width: value.width, collapsed: value.collapsed } : null;
  } catch { return null; }
}
function pending(scope: string, value: SidebarPreference | null) {
  try { if (value) localStorage.setItem(pendingKey(scope), JSON.stringify(value)); else localStorage.removeItem(pendingKey(scope)); } catch { /* Storage can be unavailable in private browsing. */ }
}

/** Server preference is authoritative until the user interacts in this mounted scope. */
export function useWorkspaceSidebarPreference(kind: "memo" | "wiki", uid: string | null): ControlledSidebarPreference {
  const local = useLocalSidebarPreference(kind, uid ?? "anonymous");
  const scope = `${uid ?? "anonymous"}:${kind}`;
  const [dirty, setDirty] = useState<{ scope: string; value: SidebarPreference } | null>(() => {
    const value = uid ? readPending(scope) : null; return value ? { scope, value } : null;
  });
  const scopeRef = useRef(scope);
  useLayoutEffect(() => { scopeRef.current = scope; }, [scope]);
  const dirtyRef = useRef(dirty);
  const operations = useRef<{ scope: string; controller: AbortController; queue: Promise<void>; touched: boolean } | null>(null);
  const localChange = local.onChange;
  const onChange = useCallback((value: SidebarPreference) => {
    if (scopeRef.current !== scope) return;
    const safe = { width: clampSidebarWidth(value.width, 180, 520), collapsed: Boolean(value.collapsed) };
    if (operations.current?.scope === scope) operations.current.touched = true;
    localChange(safe);
    if (uid) {
      const next = { scope, value: safe };
      // Publish synchronously before an older network acknowledgement can run.
      dirtyRef.current = next; pending(scope, safe); setDirty(next);
    }
  }, [localChange, scope, uid]);

  useEffect(() => {
    if (!uid) return;
    const controller = new AbortController();
    const work = { scope, controller, queue: Promise.resolve(), touched: false };
    operations.current = work;
    const unsynced = readPending(scope);
    if (unsynced) {
      const next = { scope, value: unsynced }; dirtyRef.current = next; localChange(unsynced); setDirty(next);
    } else if (dirtyRef.current?.scope !== scope) { dirtyRef.current = null; setDirty(null); }
    void fetchWorkspacePreferences(uid, controller.signal).then((preferences) => {
      if (!controller.signal.aborted && scopeRef.current === scope && !work.touched && !unsynced) localChange(preferences[kind]);
    }).catch(() => { /* Offline/browser cache remains usable. No secret or document content is cached. */ });
    return () => { controller.abort(); if (operations.current === work) operations.current = null; };
  }, [kind, localChange, scope, uid]);

  useEffect(() => {
    if (!uid || !dirty || dirty.scope !== scope) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    let queued = false;
    const save = async () => {
      const work = operations.current;
      if (!alive || queued || !work || work.scope !== scope || work.controller.signal.aborted || scopeRef.current !== scope) return;
      queued = true;
      // Do not abort an older in-flight write when another drag arrives: append
      // the newest value after it, so late network responses cannot win.
      work.queue = work.queue.catch(() => undefined).then(async () => {
        try {
          if (work.controller.signal.aborted || scopeRef.current !== scope || dirtyRef.current !== dirty) return;
          const result = await saveWorkspaceSidebarPreference(uid, kind, dirty.value, work.controller.signal);
          if (result[kind].width !== dirty.value.width || result[kind].collapsed !== dirty.value.collapsed) throw new Error("Preference acknowledgement mismatch");
          if (dirtyRef.current === dirty && !work.controller.signal.aborted && scopeRef.current === scope) {
            // Another tab may have recorded a newer recovery value meanwhile.
            const stored = readPending(scope);
            if (stored?.width === dirty.value.width && stored.collapsed === dirty.value.collapsed) pending(scope, null);
            dirtyRef.current = null; setDirty(null);
          }
        } catch {
          if (alive && !work.controller.signal.aborted && dirtyRef.current === dirty && attempt++ < 3) timer = setTimeout(() => void save(), Math.min(30_000, 2000 * 2 ** attempt));
        } finally { queued = false; }
      });
    };
    const reconnect = () => { attempt = 0; clearTimeout(timer); void save(); };
    window.addEventListener("online", reconnect);
    timer = setTimeout(() => void save(), 500);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener("online", reconnect); };
  }, [dirty, kind, scope, uid]);

  return { width: local.width, collapsed: local.collapsed, onChange };
}
