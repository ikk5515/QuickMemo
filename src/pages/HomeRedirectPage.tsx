import { ArrowRight, CalendarDays, NotebookPen, Shield, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { useAuth } from "../context/AuthContext";
import { normalizePrimaryScheduleView } from "../lib/scheduleNavigation";
import { defaultUserPreferences, getCachedUserPreferences, getUserPreferences } from "../services/userPreferences";
import type { UserPreferencesDocument } from "../types";

export default function HomeRedirectPage() {
  const { profile } = useAuth();
  const [preferences, setPreferences] = useState<Pick<UserPreferencesDocument, "defaultHome" | "scheduleDefaultView"> | null>(() =>
    profile ? getCachedUserPreferences(profile.uid) : null
  );

  useEffect(() => {
    if (!profile) {
      setPreferences(null);
      return;
    }

    let active = true;
    const cachedPreferences = getCachedUserPreferences(profile.uid);
    setPreferences(cachedPreferences);

    void getUserPreferences(profile.uid)
      .then((nextPreferences) => {
        if (active) {
          setPreferences(nextPreferences);
        }
      })
      .catch(() => {
        if (active) {
          setPreferences(cachedPreferences ?? defaultUserPreferences);
        }
      });

    return () => {
      active = false;
    };
  }, [profile]);

  const startTarget = useMemo(() => {
    const defaultHome = preferences?.defaultHome ?? defaultUserPreferences.defaultHome;
    return defaultHome === "schedule" ? "/schedule" : "/app";
  }, [preferences?.defaultHome]);

  if (!profile) {
    return <Navigate to="/login" replace />;
  }

  const scheduleDefaultView = normalizePrimaryScheduleView(preferences?.scheduleDefaultView);
  const scheduleLabel =
    scheduleDefaultView === "calendar"
      ? "달력"
      : scheduleDefaultView === "matrix"
        ? "매트릭스"
        : "할 일";

  return (
    <AppShell>
      <section className="home-dashboard" aria-label="QuickMemo 홈">
        <header className="home-hero">
          <div>
            <p className="section-kicker">
              <Sparkles size={16} />
              생산성 홈
            </p>
            <h1>{profile.displayName}님의 작업 공간</h1>
            <p>메모, 일정, 공유 자료를 한 화면에서 빠르게 시작하세요.</p>
          </div>
          <Link className="home-primary-action" to={startTarget}>
            작업 시작
            <ArrowRight size={18} />
          </Link>
        </header>

        <div className="home-card-grid">
          <Link className="home-action-card notes" to="/app">
            <span>
              <NotebookPen size={22} />
            </span>
            <strong>노트 작업</strong>
            <p>문서, 첨부파일, 공유 노트를 한 작업 공간에서 정리합니다.</p>
            <em>바로 열기</em>
          </Link>
          <Link className="home-action-card schedule" to="/schedule">
            <span>
              <CalendarDays size={22} />
            </span>
            <strong>일정관리</strong>
            <p>기본 탭은 {scheduleLabel}입니다. 오늘 할 일과 반복 업무를 빠르게 확인하세요.</p>
            <em>일정 보기</em>
          </Link>
          {profile.isAdmin && (
            <Link className="home-action-card admin" to="/admin">
              <span>
                <Shield size={22} />
              </span>
              <strong>관리자</strong>
              <p>사용자 상태, 공유 권한, 계정 운영 작업을 안전하게 관리합니다.</p>
              <em>관리 열기</em>
            </Link>
          )}
        </div>
      </section>
    </AppShell>
  );
}
