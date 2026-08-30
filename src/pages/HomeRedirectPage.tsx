import { Loader2, LockKeyhole } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { useAuth } from "../context/AuthContext";
import { resolveAccessibleHome } from "../lib/featureAccess";
import { preloadProtectedRoute } from "../lib/routePreload";
import { normalizePrimaryScheduleView, scheduleViewHref } from "../lib/scheduleNavigation";
import { defaultUserPreferences, getCachedUserPreferences, getUserPreferences } from "../services/userPreferences";
import type { UserPreferencesDocument } from "../types";

export const HOME_REDIRECT_PREFERENCES_TIMEOUT_MS = 4_000;

export default function HomeRedirectPage() {
  const { profile } = useAuth();
  const [preferences, setPreferences] = useState<Pick<UserPreferencesDocument, "defaultHome" | "scheduleDefaultView"> | null>(() =>
    profile ? getCachedUserPreferences(profile.uid) : null
  );
  const [preferencesResolved, setPreferencesResolved] = useState(() => (
    profile ? getCachedUserPreferences(profile.uid) !== null : false
  ));

  useEffect(() => {
    if (!profile) {
      setPreferences(null);
      setPreferencesResolved(false);
      return;
    }

    let active = true;
    const cachedPreferences = getCachedUserPreferences(profile.uid);
    setPreferences(cachedPreferences);
    setPreferencesResolved(cachedPreferences !== null);
    const fallbackTimeoutId = window.setTimeout(() => {
      if (active) {
        setPreferences(cachedPreferences ?? defaultUserPreferences);
        setPreferencesResolved(true);
      }
    }, HOME_REDIRECT_PREFERENCES_TIMEOUT_MS);

    void getUserPreferences(profile.uid)
      .then((nextPreferences) => {
        if (active) {
          window.clearTimeout(fallbackTimeoutId);
          setPreferences(nextPreferences);
          setPreferencesResolved(true);
        }
      })
      .catch(() => {
        if (active) {
          window.clearTimeout(fallbackTimeoutId);
          setPreferences(cachedPreferences ?? defaultUserPreferences);
          setPreferencesResolved(true);
        }
      });

    return () => {
      active = false;
      window.clearTimeout(fallbackTimeoutId);
    };
  }, [profile]);

  const scheduleDefaultView = normalizePrimaryScheduleView(preferences?.scheduleDefaultView);
  const scheduleTarget = scheduleViewHref(scheduleDefaultView);
  const accessibleHome = resolveAccessibleHome(profile, preferences?.defaultHome ?? defaultUserPreferences.defaultHome);
  const startTarget = useMemo(() => {
    if (accessibleHome === "schedule") {
      return scheduleTarget;
    }

    return accessibleHome === "library" ? "/library" : accessibleHome === "notes" ? "/app?panel=files" : null;
  }, [accessibleHome, scheduleTarget]);

  useEffect(() => {
    if (preferencesResolved && startTarget) {
      preloadProtectedRoute(startTarget, profile);
    }
  }, [preferencesResolved, profile, startTarget]);

  if (!profile) {
    return <Navigate to="/login" replace />;
  }

  if (!preferencesResolved) {
    return (
      <main className="app-frame workspace-route-gate">
        <section className="workspace-route-state" role="status" aria-live="polite">
          <Loader2 className="spin" size={22} aria-hidden="true" />
          <h1>작업공간을 여는 중입니다</h1>
          <p>기본 화면과 접근 권한을 확인하고 있습니다.</p>
        </section>
      </main>
    );
  }

  if (startTarget) {
    return <Navigate to={startTarget} replace />;
  }

  if (profile.isAdmin) {
    return <Navigate to="/admin" replace />;
  }

  return (
    <AppShell>
      <section className="workspace-route-state workspace-route-unavailable" role="status" aria-live="polite">
        <LockKeyhole size={24} aria-hidden="true" />
        <h1>사용 가능한 기능이 없습니다</h1>
        <p>노트, 자료실 또는 일정관리 권한을 관리자에게 요청해 주세요.</p>
      </section>
    </AppShell>
  );
}
