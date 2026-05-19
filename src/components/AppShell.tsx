import { CalendarDays, KeyRound, LogOut, NotebookPen, Settings, Shield, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { hasFirebaseConfig } from "../lib/firebase";
import { saveUserPreferences, subscribeUserPreferences } from "../services/userPreferences";
import type { UserPreferencesDocument } from "../types";

export function AppShell({ children, onNavigateHome }: { children: ReactNode; onNavigateHome?: () => void }) {
  const { changePassword, profile, signOut } = useAuth();
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferencesDocument | null>(null);

  useEffect(() => {
    if (!profile) {
      setPreferences(null);
      return undefined;
    }

    return subscribeUserPreferences(profile.uid, setPreferences);
  }, [profile]);

  return (
    <div className="app-frame">
      {!hasFirebaseConfig && (
        <div className="config-banner">
          `.env.local`에 Firebase 설정을 넣거나 `VITE_USE_FIREBASE_EMULATORS=true`로 에뮬레이터를 사용하세요.
        </div>
      )}
      <header className="topbar">
        <Link className="brand" to="/home" onClick={onNavigateHome}>
          <span className="brand-mark">Q</span>
          <span>QuickMemo</span>
        </Link>
        <nav className="nav-links" aria-label="주요 메뉴">
          <NavLink to="/app" onClick={onNavigateHome}>
            <NotebookPen size={18} />
            노트
          </NavLink>
          <NavLink to="/schedule">
            <CalendarDays size={18} />
            일정관리
          </NavLink>
          {profile?.isAdmin && (
            <NavLink to="/admin">
              <Shield size={18} />
              관리자
            </NavLink>
          )}
        </nav>
        <div className="topbar-user">
          {profile && (
            <span className="mini-avatar" style={{ background: profile.color }}>
              {profile.avatarText}
            </span>
          )}
          {profile && (
            <button
              className="secondary-button topbar-password-button"
              type="button"
              onClick={() => setPasswordModalOpen(true)}
            >
              <KeyRound size={16} />
              <span>비밀번호 변경</span>
            </button>
          )}
          {profile && (
            <button className="icon-button" type="button" onClick={() => setSettingsModalOpen(true)} aria-label="설정">
              <Settings size={18} />
            </button>
          )}
          <button className="icon-button" type="button" onClick={() => void signOut()} aria-label="로그아웃">
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <main>{children}</main>
      {passwordModalOpen && (
        <PasswordChangeModal
          onChangePassword={changePassword}
          onClose={() => setPasswordModalOpen(false)}
        />
      )}
      {settingsModalOpen && profile && (
        <SettingsModal
          preferences={preferences}
          onClose={() => setSettingsModalOpen(false)}
          onSave={(nextPreferences) => saveUserPreferences(profile.uid, nextPreferences)}
        />
      )}
    </div>
  );
}

function SettingsModal({
  onClose,
  onSave,
  preferences
}: {
  onClose: () => void;
  onSave: (preferences: Pick<UserPreferencesDocument, "defaultHome" | "scheduleDefaultView">) => Promise<void>;
  preferences: UserPreferencesDocument | null;
}) {
  const [defaultHome, setDefaultHome] = useState<UserPreferencesDocument["defaultHome"]>(preferences?.defaultHome ?? "notes");
  const [scheduleDefaultView, setScheduleDefaultView] = useState<UserPreferencesDocument["scheduleDefaultView"]>(
    preferences?.scheduleDefaultView ?? "todo"
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDefaultHome(preferences?.defaultHome ?? "notes");
    setScheduleDefaultView(preferences?.scheduleDefaultView ?? "todo");
  }, [preferences]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await onSave({ defaultHome, scheduleDefaultView });
      setMessage("설정을 저장했습니다.");
    } catch {
      setError("설정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="password-modal app-settings-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <button className="icon-button password-change-close" type="button" onClick={onClose} aria-label="설정 닫기">
          <X size={16} />
        </button>
        <h2>설정</h2>
        <form className="form-grid compact" onSubmit={(event) => void submitSettings(event)}>
          <label>
            처음 들어갈 화면
            <select
              onChange={(event) => setDefaultHome(event.target.value as UserPreferencesDocument["defaultHome"])}
              value={defaultHome}
            >
              <option value="notes">노트</option>
              <option value="schedule">일정관리</option>
            </select>
          </label>
          <label>
            일정관리 기본 탭
            <select
              onChange={(event) => setScheduleDefaultView(event.target.value as UserPreferencesDocument["scheduleDefaultView"])}
              value={scheduleDefaultView}
            >
              <option value="todo">할 일</option>
              <option value="calendar">달력</option>
              <option value="matrix">매트릭스</option>
              <option value="completed">완료</option>
            </select>
          </label>
          {error && <p className="form-error">{error}</p>}
          {message && <p className="form-success">{message}</p>}
          <button disabled={busy} type="submit">
            {busy ? "저장 중..." : "저장"}
          </button>
        </form>
      </section>
    </div>
  );
}

function PasswordChangeModal({
  onChangePassword,
  onClose
}: {
  onChangePassword: (currentPassword: string, nextPassword: string) => Promise<void>;
  onClose: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (nextPassword.length < 6) {
      setError("새 비밀번호는 6자 이상이어야 합니다.");
      return;
    }

    if (nextPassword !== confirmPassword) {
      setError("새 비밀번호 확인이 일치하지 않습니다.");
      return;
    }

    setBusy(true);

    try {
      await onChangePassword(currentPassword, nextPassword);
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      setMessage("비밀번호를 변경했습니다.");
    } catch (changeError) {
      setError(firebaseAuthErrorMessage(changeError, "비밀번호를 변경하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="password-modal password-change-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <button className="icon-button password-change-close" type="button" onClick={onClose} aria-label="비밀번호 변경 닫기">
          <X size={16} />
        </button>
        <h2>비밀번호 변경</h2>
        <form className="form-grid compact" onSubmit={(event) => void submitPasswordChange(event)}>
          <label>
            현재 비밀번호
            <input
              autoComplete="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              type="password"
              value={currentPassword}
            />
          </label>
          <label>
            새 비밀번호
            <input
              autoComplete="new-password"
              onChange={(event) => setNextPassword(event.target.value)}
              required
              type="password"
              value={nextPassword}
            />
          </label>
          <label>
            새 비밀번호 확인
            <input
              autoComplete="new-password"
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              type="password"
              value={confirmPassword}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          {message && <p className="form-success">{message}</p>}
          <button disabled={busy} type="submit">
            {busy ? "변경 중..." : "변경"}
          </button>
        </form>
      </section>
    </div>
  );
}
