import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";

declare const workspaceSaveSessionBrand: unique symbol;
export type WorkspaceSaveSessionToken = { readonly [workspaceSaveSessionBrand]: true };

const maxWorkspaceRevision = 999_999_999_999;

function validRevision(revision: unknown): revision is number {
  return typeof revision === "number"
    && Number.isSafeInteger(revision)
    && revision >= 1
    && revision <= maxWorkspaceRevision;
}

/**
 * A completed write can outlive a folder/ACL cleanup. Its numeric revision is
 * still our own receipt, but its old layout must never be restored. This
 * lifetime is narrower than an account: changing keys or unmounting revokes it.
 */
export function useWorkspaceSaveSession(
  uid: string | null | undefined,
  privateKey: CryptoKey | null,
  revisionRef: RefObject<number | undefined>
) {
  const activeSession = useRef<WorkspaceSaveSessionToken | null>(null);

  useLayoutEffect(() => {
    if (!uid || !privateKey) return undefined;
    const token = {} as WorkspaceSaveSessionToken;
    activeSession.current = token;
    return () => {
      if (activeSession.current === token) activeSession.current = null;
    };
  }, [uid, privateKey]);

  const capture = useCallback(() => activeSession.current, []);
  const isCurrent = useCallback((token: WorkspaceSaveSessionToken | null) => (
    token !== null && activeSession.current === token
  ), []);
  const acknowledge = useCallback((token: WorkspaceSaveSessionToken | null, revision: unknown) => {
    if (!isCurrent(token) || !validRevision(revision)) return false;
    const known = revisionRef.current;
    if (known !== undefined && (
      !Number.isSafeInteger(known)
      || known < 0
      || known > maxWorkspaceRevision
      || revision < known
    )) return false;
    revisionRef.current = revision;
    return true;
  }, [isCurrent, revisionRef]);

  return useMemo(() => ({ capture, isCurrent, acknowledge }), [capture, isCurrent, acknowledge]);
}
