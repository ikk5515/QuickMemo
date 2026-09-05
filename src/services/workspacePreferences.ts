import { getToken } from "firebase/app-check";
import { appCheck, auth } from "../lib/firebase";
import type { SidebarPreference } from "../features/workspace/useResizableSidebar";

export interface WorkspacePreferences { memo: SidebarPreference; wiki: SidebarPreference }
export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = { memo: { width: 244, collapsed: false }, wiki: { width: 280, collapsed: false } };

function parse(value: unknown): WorkspacePreferences {
  if (!value || typeof value !== "object") throw new Error("화면 설정을 확인하지 못했습니다.");
  for (const key of ["memo", "wiki"] as const) {
    const item = (value as WorkspacePreferences)[key];
    if (!item || !Number.isInteger(item.width) || item.width < 180 || item.width > 520 || typeof item.collapsed !== "boolean") throw new Error("화면 설정을 확인하지 못했습니다.");
  }
  const source = value as WorkspacePreferences;
  return { memo: { width: source.memo.width, collapsed: source.memo.collapsed }, wiki: { width: source.wiki.width, collapsed: source.wiki.collapsed } };
}
async function request(uid: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const user = auth.currentUser;
  const check = () => { if (!user || user.uid !== uid || auth.currentUser !== user || signal?.aborted) throw new DOMException("취소되었습니다.", "AbortError"); };
  check();
  const idToken = await user!.getIdToken(); check();
  const headers: Record<string, string> = { authorization: `Bearer ${idToken}`, "content-type": "application/json", "x-quickmemo-workspace-preferences": "1" };
  if (appCheck) headers["X-Firebase-AppCheck"] = (await getToken(appCheck, false)).token;
  check();
  const response = await fetch("/api/vault-integrity?resource=workspace-preferences", { method: "POST", headers, body: JSON.stringify(body), signal,
    credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
  check();
  if (!response.ok) throw new Error("화면 설정을 동기화하지 못했습니다.");
  const text = await response.text(); check();
  if (text.length > 2048) throw new Error("화면 설정을 확인하지 못했습니다.");
  return parse(JSON.parse(text));
}
export function fetchWorkspacePreferences(uid: string, signal?: AbortSignal) { return request(uid, { action: "get" }, signal); }
export function saveWorkspaceSidebarPreference(uid: string, kind: "memo" | "wiki", value: SidebarPreference, signal?: AbortSignal) {
  return request(uid, { action: "set", kind, value: { width: Math.round(value.width), collapsed: value.collapsed } }, signal);
}
