import { useCallback, useEffect, useRef, useState } from "react";
import { clampSidebarWidth, type SidebarPreference } from "./useResizableSidebar";

const DEFAULT_SIDEBAR: SidebarPreference = { width: 280, collapsed: false };
/** Only non-sensitive UI dimensions are persisted. No document identifiers, text, or keys. */
export function readSidebarPreference(key: string, fallback = DEFAULT_SIDEBAR): SidebarPreference {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object" || !("width" in value) || !("collapsed" in value)
      || typeof value.width !== "number" || !Number.isFinite(value.width) || typeof value.collapsed !== "boolean") return fallback;
    return { width: clampSidebarWidth(value.width, 180, 520), collapsed: value.collapsed };
  } catch { return fallback; }
}
export function useLocalSidebarPreference(name: "wiki" | "memo", identity = "anonymous") {
  const key = `quickmemo:sidebar:v1:${name}:${identity}`;
  const fallback = name === "memo" ? { width: 244, collapsed: false } : DEFAULT_SIDEBAR;
  const [stored, setStored] = useState(() => ({ key, value: readSidebarPreference(key, fallback) }));
  const pending = useRef<{ key: string; value: SidebarPreference } | null>(null);
  const value = stored.key === key ? stored.value : readSidebarPreference(key, fallback);
  const onChange = useCallback((next: SidebarPreference) => {
    const safe = { width: clampSidebarWidth(next.width, 180, 520), collapsed: Boolean(next.collapsed) };
    pending.current = { key, value: safe };
    setStored({ key, value: safe });
  }, [key]);
  useEffect(() => {
    if (stored.key !== key) return;
    // Coalesce drag frames, and tolerate privacy-mode storage restrictions.
    const timer = setTimeout(() => { try { localStorage.setItem(key, JSON.stringify(stored.value)); } catch { /* Memory state remains usable. */ } }, 180);
    return () => clearTimeout(timer);
  }, [key, stored]);
  useEffect(() => {
    const flush = () => {
      if (pending.current?.key !== key) return;
      try { localStorage.setItem(key, JSON.stringify(pending.current.value)); } catch { /* Storage remains optional. */ }
    };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [key]);
  return { ...value, onChange };
}
