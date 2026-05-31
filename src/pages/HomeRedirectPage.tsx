import { useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getUserPreferences } from "../services/userPreferences";

export default function HomeRedirectPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!profile) {
      return;
    }

    let active = true;

    void getUserPreferences(profile.uid)
      .then((preferences) => {
        if (!active) {
          return;
        }

        navigate(preferences.defaultHome === "schedule" ? "/schedule" : "/app", { replace: true });
      })
      .catch(() => {
        if (active) {
          navigate("/app", { replace: true });
        }
      });

    return () => {
      active = false;
    };
  }, [navigate, profile]);

  if (!profile) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="page-center app-loading-page" role="status" aria-live="polite">
      <section className="loading-card">
        <span className="brand-mark">Q</span>
        <strong>기본 화면을 준비하고 있습니다</strong>
        <p>저장된 시작 화면으로 곧 이동합니다.</p>
      </section>
    </div>
  );
}
