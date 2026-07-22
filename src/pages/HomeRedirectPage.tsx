import { ArrowRight, CalendarDays, LibraryBig, LockKeyhole, NotebookPen, Shield, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { useAuth } from "../context/AuthContext";
import { normalizeFeatureAccess, resolveAccessibleHome } from "../lib/featureAccess";
import { normalizePrimaryScheduleView, scheduleViewHref } from "../lib/scheduleNavigation";
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

  const scheduleDefaultView = normalizePrimaryScheduleView(preferences?.scheduleDefaultView);
  const scheduleTarget = scheduleViewHref(scheduleDefaultView);
  const featureAccess = normalizeFeatureAccess(profile);
  const accessibleHome = resolveAccessibleHome(profile, preferences?.defaultHome ?? defaultUserPreferences.defaultHome);
  const startTarget = useMemo(() => {
    if (accessibleHome === "schedule") {
      return scheduleTarget;
    }

    return accessibleHome === "library" ? "/library" : accessibleHome === "notes" ? "/app" : null;
  }, [accessibleHome, scheduleTarget]);

  if (!profile) {
    return <Navigate to="/login" replace />;
  }

  const scheduleLabel =
    scheduleDefaultView === "calendar"
      ? "달력"
      : scheduleDefaultView === "matrix"
        ? "매트릭스"
        : scheduleDefaultView === "recurring"
          ? "반복 업무"
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
          {startTarget && (
            <Link className="home-primary-action" to={startTarget}>
              작업 시작
              <ArrowRight size={18} />
            </Link>
          )}
        </header>

        <div className="home-card-grid">
          {featureAccess.notes && <Link className="home-action-card notes" to="/app">
            <span>
              <NotebookPen size={22} />
            </span>
            <strong>노트 작업</strong>
            <p>문서, 첨부파일, 공유 노트를 한 작업 공간에서 정리합니다.</p>
            <em>바로 열기</em>
          </Link>}
          {featureAccess.schedule && <Link className="home-action-card schedule" to={scheduleTarget}>
            <span>
              <CalendarDays size={22} />
            </span>
            <strong>일정관리</strong>
            <p>기본 탭은 {scheduleLabel}입니다. 오늘 할 일과 반복 업무를 빠르게 확인하세요.</p>
            <em>일정 보기</em>
          </Link>}
          {featureAccess.library && <Link className="home-action-card library" to="/library">
            <span>
              <LibraryBig size={22} />
            </span>
            <strong>자료실</strong>
            <p>노트 첨부파일과 저장한 링크를 검색하고 다시 읽을 자료로 정리합니다.</p>
            <em>자료 보기</em>
          </Link>}
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
        {!startTarget && !profile.isAdmin && (
          <section className="home-access-empty" role="status" aria-live="polite">
            <LockKeyhole size={24} aria-hidden="true" />
            <div>
              <h2>사용 가능한 기능이 없습니다</h2>
              <p>노트, 자료실 또는 일정관리 권한을 관리자에게 요청해 주세요.</p>
            </div>
          </section>
        )}
      </section>
    </AppShell>
  );
}
