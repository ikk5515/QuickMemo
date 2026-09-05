import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { VaultDecryptionSession } from "../features/vault/vaultDecryptionSession";
import { hasFeatureAccess } from "../lib/featureAccess";
import { registerUnlockedSessionResource } from "../lib/unlockedSessionResources";
import { useAuth } from "./AuthContext";

const VaultDecryptionContext = createContext<VaultDecryptionSession | null>(null);

export function VaultDecryptionProvider({ children }: { children: ReactNode }) {
  const { firebaseUser, profile, privateKey } = useAuth();
  const uid = firebaseUser?.uid === profile?.uid && profile?.isActive && hasFeatureAccess(profile, "notes")
    ? profile.uid
    : null;
  const [session, setSession] = useState<VaultDecryptionSession | null>(null);

  useLayoutEffect(() => {
    if (!uid || !privateKey) return undefined;
    const next = new VaultDecryptionSession(uid, privateKey);
    const unregister = registerUnlockedSessionResource(() => next.dispose());
    setSession(next);
    return () => {
      unregister();
      next.dispose();
    };
  }, [uid, privateKey]);

  // Hide the old session during render, before effect cleanup. Only the
  // currently authenticated, active, unlocked owner can receive it.
  const current = uid && privateKey && session?.matches(uid, privateKey) ? session : null;
  return <VaultDecryptionContext.Provider value={current}>{children}</VaultDecryptionContext.Provider>;
}

export function useVaultDecryptionSession() {
  return useContext(VaultDecryptionContext);
}
