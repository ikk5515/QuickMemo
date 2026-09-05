import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { VaultDecryptionProvider } from "./context/VaultDecryptionContext";
import { hasFeatureAccess } from "./lib/featureAccess";
import { createLibraryCaptureLoginState } from "./lib/libraryCapture";
import {
  loadAdminPage,
  loadHomeRedirectPage,
  loadLibraryPage,
  loadLoginPage,
  loadNotesPage,
  loadPublicSharePage,
  loadPublicWikiPage,
  loadRecurringPage,
  loadSchedulePage,
  loadSetupPage,
  loadVaultPage,
  loadWikiPage,
  preloadProtectedRoute
} from "./lib/routePreload";
import type { AppFeature } from "./types";

const AdminPage = lazy(loadAdminPage);
const HomeRedirectPage = lazy(loadHomeRedirectPage);
const LibraryPage = lazy(loadLibraryPage);
const LoginPage = lazy(loadLoginPage);
const NotesPage = lazy(loadNotesPage);
const PublicSharePage = lazy(loadPublicSharePage);
const RecurringPage = lazy(loadRecurringPage);
const SchedulePage = lazy(loadSchedulePage);
const SetupPage = lazy(loadSetupPage);
const VaultPage = lazy(loadVaultPage);
const WikiPage = lazy(loadWikiPage);
const PublicWikiPage = lazy(loadPublicWikiPage);

const obsidianVaultEnabled = import.meta.env.VITE_OBSIDIAN_VAULT_ENABLED === "true";

function PageLoadingFallback() {
  return (
    <div className="page-center" role="status" aria-live="polite">
      불러오는 중...
    </div>
  );
}

function E2eNavigationBridge() {
  const navigate = useNavigate();

  return (
    <button
      aria-hidden="true"
      data-quickmemo-e2e-navigation
      hidden
      onClick={(event) => {
        const target = event.currentTarget.dataset.target;
        delete event.currentTarget.dataset.target;
        if (target) {
          navigate(target);
        }
      }}
      tabIndex={-1}
      type="button"
    />
  );
}

const e2eNavigationBridgeEnabled =
  !import.meta.env.PROD
  && import.meta.env.MODE === "test"
  && import.meta.env.VITE_E2E_NAVIGATION_BRIDGE === "true";

function AuthenticatedLoginTargetPreload() {
  const { firebaseUser, profile } = useAuth();
  const location = useLocation();

  useEffect(() => {
    if (
      location.pathname === "/login"
      && profile
      && firebaseUser?.uid === profile.uid
      && profile.isActive
    ) {
      preloadProtectedRoute("/home", profile);
    }
  }, [firebaseUser?.uid, location.pathname, profile]);

  return null;
}

function SecureShareCopyRecovery() {
  const { firebaseUser, profile } = useAuth();
  const lastRunAtRef = useRef(0);
  const uid = firebaseUser?.uid === profile?.uid
    && profile?.isActive
    && hasFeatureAccess(profile, "notes")
    ? profile.uid
    : null;

  useEffect(() => {
    if (!uid) {
      lastRunAtRef.current = 0;
      return undefined;
    }

    let active = true;
    const minimumRunIntervalMs = 30 * 60 * 1000;

    const recover = () => {
      const now = Date.now();
      if (now - lastRunAtRef.current < minimumRunIntervalMs) {
        return;
      }

      lastRunAtRef.current = now;
      void import("./services/secureShareCopyJobs")
        .then(({ reapStaleSecureShareCopyJobs }) =>
          active ? reapStaleSecureShareCopyJobs(uid) : undefined
        )
        .catch(() => undefined);
    };

    recover();
    const intervalId = window.setInterval(recover, 6 * 60 * 60 * 1000);
    window.addEventListener("focus", recover);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", recover);
    };
  }, [uid]);

  return null;
}

export function RequireAuth({
  children,
  adminOnly = false,
  feature
}: {
  children: ReactNode;
  adminOnly?: boolean;
  feature?: AppFeature;
}) {
  const { firebaseUser, loading, profile } = useAuth();
  const location = useLocation();

  if (loading) {
    return <PageLoadingFallback />;
  }

  if (!firebaseUser || !profile || profile.uid !== firebaseUser.uid || !profile.isActive) {
    let captureLoginState;
    try {
      captureLoginState = createLibraryCaptureLoginState(location.pathname, location.hash);
    } catch {
      // Malformed or body-bearing capture fragments are intentionally
      // discarded instead of being reflected through the login route.
      captureLoginState = null;
    }
    return <Navigate to="/login" replace state={captureLoginState ?? undefined} />;
  }

  if (adminOnly && !profile.isAdmin) {
    return <Navigate to="/home" replace />;
  }

  if (feature && !hasFeatureAccess(profile, feature)) {
    return <Navigate to="/home" replace />;
  }

  return children;
}

export default function App() {
  const location = useLocation();

  return (
    <VaultDecryptionProvider>
      {e2eNavigationBridgeEnabled && <E2eNavigationBridge />}
      <AuthenticatedLoginTargetPreload />
      <SecureShareCopyRecovery />
      <Suspense key={location.pathname} fallback={<PageLoadingFallback />}>
        <Routes location={location}>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/share/:shareId" element={<PublicSharePage />} />
          <Route path="/s/:compactToken" element={<PublicSharePage />} />
          <Route path="/wiki/public/:wikiId" element={<PublicWikiPage />} />
          <Route
            path="/home"
            element={
              <RequireAuth>
                <HomeRedirectPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app"
            element={
              <RequireAuth feature="notes">
                {obsidianVaultEnabled ? <VaultPage /> : <NotesPage />}
              </RequireAuth>
            }
          />
          <Route
            path="/wiki"
            element={
              <RequireAuth feature="notes">
                <WikiPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/legacy"
            element={
              <RequireAuth feature="notes">
                <NotesPage legacyReadOnly={obsidianVaultEnabled} />
              </RequireAuth>
            }
          />
          <Route
            path="/library"
            element={
              <RequireAuth feature="library">
                <LibraryPage />
              </RequireAuth>
            }
          />
          <Route
            path="/schedule"
            element={
              <RequireAuth feature="schedule">
                <SchedulePage />
              </RequireAuth>
            }
          />
          <Route
            path="/schedule/recurring"
            element={
              <RequireAuth feature="schedule">
                <RecurringPage />
              </RequireAuth>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAuth adminOnly>
                <AdminPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    </VaultDecryptionProvider>
  );
}
