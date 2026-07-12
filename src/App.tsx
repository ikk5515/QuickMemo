import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext";

const AdminPage = lazy(() => import("./pages/AdminPage"));
const HomeRedirectPage = lazy(() => import("./pages/HomeRedirectPage"));
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

function RequireAuth({ children, adminOnly = false }: { children: ReactNode; adminOnly?: boolean }) {
  const { firebaseUser, loading, profile } = useAuth();

  if (loading) {
    return <PageLoadingFallback />;
  }

  if (!firebaseUser || !profile) {
    return <Navigate to="/login" replace />;
  }

  if (adminOnly && !profile.isAdmin) {
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
            <RequireAuth>
              <NotesPage />
            </RequireAuth>
          }
        />
        <Route
          path="/schedule"
          element={
            <RequireAuth>
              <SchedulePage />
            </RequireAuth>
          }
        />
        <Route
          path="/schedule/recurring"
          element={
            <RequireAuth>
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
