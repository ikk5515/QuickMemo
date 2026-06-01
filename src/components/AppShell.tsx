import { CalendarDays, KeyRound, LogOut, Moon, NotebookPen, Settings, Shield, Sun, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { hasFirebaseConfig } from "../lib/firebase";
import {
  applyThemePreference,
  getStoredThemePreference,
  resolveThemePreference,
  subscribeSystemThemeChange,
  writeStoredThemePreference,
  type ResolvedTheme
} from "../lib/theme";
import { normalizePrimaryScheduleView } from "../lib/scheduleNavigation";
import {
  defaultMatrixLabels,
  matrixLabelFields,
  matrixLabelMaxLength,
  normalizeMatrixLabels,
  sanitizeMatrixLabelsForSave,
  validateMatrixLabels
} from "../lib/matrixLabels";
import {
  getCachedUserPreferences,
  saveUserPreferences,
  subscribeUserPreferences,
  type SaveUserPreferencesInput
} from "../services/userPreferences";
import type { MatrixLabels, ThemePreference, UserPreferencesDocument } from "../types";

export function AppShell({ children, onNavigateHome }: { children: ReactNode; onNavigateHome?: () => void }) {
  const { changePassword, profile, signOut } = useAuth();
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferencesDocument | null>(() =>
    profile ? getCachedUserPreferences(profile.uid) : null
  );
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    profile ? getCachedUserPreferences(profile.uid)?.theme ?? getStoredThemePreference() ?? "system" : getStoredThemePreference() ?? "system"
  );
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveThemePreference(themePreference));
  const [themeStatus, setThemeStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) {
      setPreferences(null);
      return undefined;
    }

    const cachedPreferences = getCachedUserPreferences(profile.uid);
    if (cachedPreferences) {
      setPreferences(cachedPreferences);
    }

    return subscribeUserPreferences(profile.uid, setPreferences);
  }, [profile]);

  useEffect(() => {
    const nextPreference = preferences?.theme ?? getStoredThemePreference() ?? "system";

    setThemePreference(nextPreference);
    writeStoredThemePreference(nextPreference);
    setResolvedTheme(applyThemePreference(nextPreference));
  }, [preferences?.theme]);

  useEffect(() => {
    if (themePreference !== "system") {
      return undefined;
    }

    return subscribeSystemThemeChange((nextResolvedTheme) => {
      setResolvedTheme(nextResolvedTheme);
      document.documentElement.dataset.theme = nextResolvedTheme;
      document.documentElement.style.colorScheme = nextResolvedTheme;
    });
  }, [themePreference]);

  async function toggleTheme() {
    const nextPreference: ThemePreference = resolvedTheme === "dark" ? "light" : "dark";

    setThemeStatus(null);
    setThemePreference(nextPreference);
    setResolvedTheme(applyThemePreference(nextPreference));
    writeStoredThemePreference(nextPreference);

    if (!profile) {
      return;
    }

    try {
      await saveUserPreferences(profile.uid, { theme: nextPreference });
    } catch {
      setThemeStatus("테마 설정은 이 브라우저에만 저장되었습니다.");
    }
  }

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
          <ThemeToggleButton onToggle={() => void toggleTheme()} resolvedTheme={resolvedTheme} />
          {profile && (
            <button className="icon-button" type="button" onClick={() => setSettingsModalOpen(true)} aria-label="설정">
              <Settings size={18} />
            </button>
          )}
          <button className="icon-button" type="button" onClick={() => void signOut()} aria-label="로그아웃">
            <LogOut size={18} />
          </button>
          {themeStatus && (
            <span className="sr-only" role="status">
              {themeStatus}
            </span>
          )}
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

export function ThemeToggleButton({
  onToggle,
  resolvedTheme
}: {
  onToggle: () => void;
  resolvedTheme: ResolvedTheme;
}) {
  const isDark = resolvedTheme === "dark";
  const label = isDark ? "라이트모드로 전환" : "다크모드로 전환";
  const Icon = isDark ? Sun : Moon;

  return (
    <button
      aria-label={label}
      aria-pressed={isDark}
      className="icon-button theme-toggle-button"
      onClick={onToggle}
      title={label}
      type="button"
    >
      <Icon size={18} />
    </button>
  );
}

export function SettingsModal({
  onClose,
  onSave,
  preferences
}: {
  onClose: () => void;
  onSave: (preferences: SaveUserPreferencesInput) => Promise<void>;
  preferences: UserPreferencesDocument | null;
}) {
  const [defaultHome, setDefaultHome] = useState<UserPreferencesDocument["defaultHome"]>(preferences?.defaultHome ?? "notes");
  const [scheduleDefaultView, setScheduleDefaultView] = useState<UserPreferencesDocument["scheduleDefaultView"]>(
    normalizePrimaryScheduleView(preferences?.scheduleDefaultView)
  );
  const [matrixLabels, setMatrixLabels] = useState<MatrixLabels>(() => normalizeMatrixLabels(preferences?.matrixLabels));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savedMatrixLabels = useMemo(() => normalizeMatrixLabels(preferences?.matrixLabels), [preferences]);
  const nextMatrixLabels = useMemo(() => sanitizeMatrixLabelsForSave(matrixLabels), [matrixLabels]);
  const hasChanges =
    defaultHome !== (preferences?.defaultHome ?? "notes")
    || scheduleDefaultView !== normalizePrimaryScheduleView(preferences?.scheduleDefaultView)
    || !sameMatrixLabels(nextMatrixLabels, savedMatrixLabels);

  useEffect(() => {
    setDefaultHome(preferences?.defaultHome ?? "notes");
    setScheduleDefaultView(normalizePrimaryScheduleView(preferences?.scheduleDefaultView));
    setMatrixLabels(normalizeMatrixLabels(preferences?.matrixLabels));
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
    const validationError = validateMatrixLabels(matrixLabels);

    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await onSave({ defaultHome, matrixLabels: nextMatrixLabels, scheduleDefaultView });
      setMessage("설정을 저장했습니다.");
    } catch {
      setError("설정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  function updateMatrixLabel(key: keyof MatrixLabels, value: string) {
    setError(null);
    setMessage(null);
    setMatrixLabels((current) => ({ ...current, [key]: value }));
  }

  function resetMatrixLabels() {
    const nextDefaultLabels = { ...defaultMatrixLabels };

    setError(null);
    setMessage(
      sameMatrixLabels(nextDefaultLabels, savedMatrixLabels)
        ? "이미 기본 명칭입니다."
        : "기본 명칭으로 되돌렸습니다. 저장을 눌러 적용하세요."
    );
    setMatrixLabels(nextDefaultLabels);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="password-modal app-settings-modal"
        role="dialog"
        aria-labelledby="settings-modal-title"
        aria-describedby="settings-modal-description"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="icon-button password-change-close" type="button" onClick={onClose} aria-label="설정 닫기">
          <X size={16} />
        </button>
        <h2 id="settings-modal-title">설정</h2>
        <p id="settings-modal-description" className="settings-modal-description">
          홈, 일정관리 기본 탭, 매트릭스 표시 명칭을 설정합니다.
        </p>
        <form className="form-grid compact" onSubmit={(event) => void submitSettings(event)}>
          <section className="settings-form-section" aria-labelledby="settings-workspace-title">
            <h3 id="settings-workspace-title">작업 환경</h3>
            <label>
              작업 시작 기본 화면
              <select
                onChange={(event) => setDefaultHome(event.target.value as UserPreferencesDocument["defaultHome"])}
                value={defaultHome}
              >
                <option value="notes">노트</option>
                <option value="schedule">일정관리</option>
              </select>
            </label>
            <label>
              일정관리 기본 화면
              <select
                onChange={(event) => setScheduleDefaultView(event.target.value as UserPreferencesDocument["scheduleDefaultView"])}
                value={scheduleDefaultView}
              >
                <option value="todo">할 일</option>
                <option value="calendar">달력</option>
                <option value="matrix">매트릭스</option>
              </select>
            </label>
          </section>
          <section className="settings-form-section matrix-label-settings" aria-labelledby="matrix-label-settings-title">
            <div className="settings-section-heading">
              <div>
                <h3 id="matrix-label-settings-title">매트릭스 명칭 설정</h3>
                <p>각 영역의 표시 명칭만 바꾸며 일정 분류 기준은 유지됩니다.</p>
              </div>
              <button className="secondary-button" type="button" onClick={resetMatrixLabels}>
                기본값으로 초기화
              </button>
            </div>
            <div className="matrix-label-grid">
              {matrixLabelFields.map((field) => {
                const inputId = `matrix-label-${field.key}`;
                const helperId = `${inputId}-helper`;
                const value = matrixLabels[field.key];
                const invalid = value.trim().length === 0 || value.trim().length > matrixLabelMaxLength;

                return (
                  <label key={field.key} htmlFor={inputId}>
                    {field.label}
                    <input
                      id={inputId}
                      aria-describedby={helperId}
                      aria-invalid={invalid}
                      maxLength={matrixLabelMaxLength}
                      onBlur={(event) => updateMatrixLabel(field.key, event.target.value.trim())}
                      onChange={(event) => updateMatrixLabel(field.key, event.target.value)}
                      value={value}
                    />
                    <small id={helperId}>{field.description} · 최대 {matrixLabelMaxLength}자</small>
                  </label>
                );
              })}
            </div>
            <p className="settings-inline-status" role="status">
              {hasChanges ? "변경사항 있음" : "저장된 설정과 같습니다."}
            </p>
          </section>
          {error && <p className="form-error">{error}</p>}
          {message && <p className="form-success">{message}</p>}
          <button disabled={busy || !hasChanges} type="submit">
            {busy ? "저장 중..." : "저장"}
          </button>
        </form>
      </section>
    </div>
  );
}

function sameMatrixLabels(left: MatrixLabels, right: MatrixLabels) {
  return matrixLabelFields.every(({ key }) => left[key] === right[key]);
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
      <section
        className="password-modal password-change-modal"
        role="dialog"
        aria-labelledby="password-change-title"
        aria-describedby="password-change-description"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="icon-button password-change-close" type="button" onClick={onClose} aria-label="비밀번호 변경 닫기">
          <X size={16} />
        </button>
        <h2 id="password-change-title">비밀번호 변경</h2>
        <p id="password-change-description" className="settings-modal-description">
          현재 비밀번호를 확인한 뒤 새 비밀번호를 저장합니다.
        </p>
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
