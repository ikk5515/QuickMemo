import { useAuth } from "../context/AuthContext";
import { AppShell } from "../components/AppShell";
import { UnlockPanel } from "../components/UnlockPanel";
import { hasFeatureAccess } from "../lib/featureAccess";
import { useWorkspaceSidebarPreference } from "../features/workspace/useWorkspaceSidebarPreference";
import VaultPage from "./VaultPage";

function UnlockedWikiWorkspace({ uid }: { uid: string }) {
  const sidebar = useWorkspaceSidebarPreference("wiki", uid);
  return <VaultPage surface="wiki" wikiSidebarPreference={sidebar} />;
}

/** Private wiki shares the encrypted draft, save, conflict, and editor session controllers. */
export default function WikiPage() {
  const { firebaseUser, profile, privateKey } = useAuth();
  if (!profile || !firebaseUser || firebaseUser.uid !== profile.uid || !profile.isActive || !hasFeatureAccess(profile, "notes")) return null;
  if (!privateKey) return <AppShell variant="vault"><UnlockPanel /></AppShell>;
  return <UnlockedWikiWorkspace key={profile.uid} uid={profile.uid} />;
}
