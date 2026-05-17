import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import AdminPage from "./pages/AdminPage";
import LoginPage from "./pages/LoginPage";
import NotesPage from "./pages/NotesPage";
import SetupPage from "./pages/SetupPage";

function RequireAuth({ children, adminOnly = false }: { children: ReactNode; adminOnly?: boolean }) {
  const { firebaseUser, loading, profile } = useAuth();

  if (loading) {
    return <div className="page-center">불러오는 중...</div>;
  }

  if (!firebaseUser || !profile) {
    return <Navigate to="/login" replace />;
  }

  if (adminOnly && !profile.isAdmin) {
    return <Navigate to="/app" replace />;
  }

  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/app"
        element={
          <RequireAuth>
            <NotesPage />
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
  );
}
