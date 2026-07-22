import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { hasFeatureAccess } from "./lib/featureAccess";
import { createLibraryCaptureLoginState } from "./lib/libraryCapture";
import type { AppFeature } from "./types";

const AdminPage = lazy(() => import("./pages/AdminPage"));
const HomeRedirectPage = lazy(() => import("./pages/HomeRedirectPage"));
const LibraryPage = lazy(() => import("./pages/LibraryPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const NotesPage = lazy(() => import("./pages/NotesPage"));
const PublicSharePage = lazy(() => import("./pages/PublicSharePage"));
const RecurringPage = lazy(() => import("./pages/RecurringPage"));
const SchedulePage = lazy(() => import("./pages/SchedulePage"));
const SetupPage = lazy(() => import("./pages/SetupPage"));

function PageLoadingFallback() {
  return (
    <div className="page-center" role="status" aria-live="polite">
      불러오는 중...
    </div>
  );
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

  if (!firebaseUser || !profile) {
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
  return (
    <Suspense fallback={<PageLoadingFallback />}>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/share/:shareId" element={<PublicSharePage />} />
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
              <NotesPage />
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
  );
}
