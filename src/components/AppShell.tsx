import {
  CalendarDays,
  Files,
  KeyRound,
  LibraryBig,
  LogOut,
  Menu,
  Moon,
  Settings,
  Shield,
  Sun,
  X,
  type LucideIcon
} from "lucide-react";
import { type FormEvent, type MouseEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { minimumNewPasswordLength, newPasswordMeetsMinimum } from "../lib/passwordPolicy";
import { hasFirebaseConfig } from "../lib/firebase";
import { appFeatures, defaultFeatureAccess, normalizeFeatureAccess, resolveAccessibleHome } from "../lib/featureAccess";
import {
  applyThemePreference,
  getStoredThemePreference,
  resolveThemePreference,
  subscribeSystemThemeChange,
  writeStoredThemePreference,
  type ResolvedTheme
} from "../lib/theme";
import { normalizePrimaryScheduleView } from "../lib/scheduleNavigation";
import { preloadProtectedRoute } from "../lib/routePreload";
import {
  defaultMatrixLabels,
  matrixLabelFields,
  matrixLabelMaxLength,
  normalizeMatrixLabels,
  sanitizeMatrixLabelsForSave,
  validateMatrixLabels
} from "../lib/matrixLabels";
import { normalizeScheduleCategoryFilter } from "../lib/scheduleCategory";
import { useModalFocus } from "../lib/useModalFocus";
import {
  getCachedUserPreferences,
  saveUserPreferences,
  subscribeUserPreferences,
  type SaveUserPreferencesInput
} from "../services/userPreferences";
import type {
  ActiveScheduleView,
  DefaultHomeView,
  FeatureAccess,
  MatrixLabels,
  ScheduleCategoryFilter,
  ThemePreference,
  UserPreferencesDocument
} from "../types";
import { AppSelect } from "./AppSelect";

type WorkspacePanelIntent = "files" | "search";
type WorkspaceSection = "files" | "library" | "schedule" | "admin";

interface WorkspaceNavigationItem {
  href: string;
  icon: LucideIcon;
  label: string;
  section: WorkspaceSection;
}

function workspaceSectionFromLocation(pathname: string): WorkspaceSection | null {
  if (pathname === "/app" || pathname === "/app/legacy") {
    return "files";
  }
  if (pathname === "/library") {
    return "library";
  }
  if (pathname.startsWith("/schedule")) {
    return "schedule";
  }
  if (pathname === "/admin") {
    return "admin";
  }
  return null;
}

export function AppShell({
  children,
  onBeforeExit,
  onNavigateHome,
  variant = "default"
}: {
  children: ReactNode;
  onBeforeExit?: () => Promise<boolean>;
  onNavigateHome?: (intent?: WorkspacePanelIntent) => void;
  variant?: "default" | "vault";
}) {
  const { changePassword, privateKey, profile, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [workspaceDrawerOpen, setWorkspaceDrawerOpen] = useState(false);
  const passwordModalTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsModalTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceDrawerRef = useRef<HTMLElement>(null);
  const workspaceDrawerReturnFocusRef = useRef<HTMLElement>(null);
  const workspaceDrawerTriggerRef = useRef<HTMLButtonElement>(null);
  const pendingModalReturnFocusRef = useRef<HTMLElement | null>(null);
  const [preferences, setPreferences] = useState<UserPreferencesDocument | null>(() =>
    profile ? getCachedUserPreferences(profile.uid) : null
  );
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    profile ? getCachedUserPreferences(profile.uid)?.theme ?? getStoredThemePreference() ?? "system" : getStoredThemePreference() ?? "system"
  );
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveThemePreference(themePreference));
  const [themeStatus, setThemeStatus] = useState<string | null>(null);
  const featureAccess = useMemo(
    () => normalizeFeatureAccess(profile),
    [profile]
  );
  const preferencesCryptoContext = useMemo(
    () => profile && privateKey ? { privateKey, profile } : undefined,
    [privateKey, profile]
  );
  const activeWorkspaceSection = workspaceSectionFromLocation(location.pathname);
  const navigationItems: WorkspaceNavigationItem[] = [];

  if (featureAccess.notes) {
    navigationItems.push({ href: "/app?panel=files", icon: Files, label: "메모", section: "files" });
  }
  if (featureAccess.schedule) {
    navigationItems.push({ href: "/schedule", icon: CalendarDays, label: "일정", section: "schedule" });
  }
  if (featureAccess.library) {
    navigationItems.push({ href: "/library", icon: LibraryBig, label: "자료실", section: "library" });
  }

  useModalFocus(workspaceDrawerRef, {
    enabled: workspaceDrawerOpen,
    returnFocusRef: workspaceDrawerReturnFocusRef
  });

  useEffect(() => {
    if (!profile) {
      setPreferences(null);
      return undefined;
    }

    const cachedPreferences = getCachedUserPreferences(profile.uid);
    setPreferences(cachedPreferences);

    return subscribeUserPreferences(
      profile.uid,
      setPreferences,
      undefined,
      preferencesCryptoContext
    );
  }, [preferencesCryptoContext, profile]);

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

  useEffect(() => {
    if (!workspaceDrawerOpen) {
      return undefined;
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setWorkspaceDrawerOpen(false);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [workspaceDrawerOpen]);

  useEffect(() => {
    if (passwordModalOpen || settingsModalOpen || !pendingModalReturnFocusRef.current) {
      return;
    }

    const preferredTarget = pendingModalReturnFocusRef.current;
    const focusTarget = preferredTarget.isConnected
      ? preferredTarget
      : workspaceDrawerTriggerRef.current;

    pendingModalReturnFocusRef.current = null;
    focusTarget?.focus({ preventScroll: true });
  }, [passwordModalOpen, settingsModalOpen]);

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
      await saveUserPreferences(profile.uid, { theme: nextPreference }, preferencesCryptoContext);
    } catch {
      setThemeStatus("테마 설정은 이 브라우저에만 저장되었습니다.");
    }
  }

  function guardedNavigation(destination: string, after?: () => void) {
    return (event: MouseEvent<HTMLAnchorElement>) => {
      if (!onBeforeExit) {
        after?.();
        return;
      }
      event.preventDefault();
      void onBeforeExit().then((canExit) => {
        if (canExit) {
          after?.();
          navigate(destination);
        }
      });
    };
  }

  async function guardedSignOut() {
    if (!onBeforeExit || await onBeforeExit()) {
      await signOut();
    }
  }

  function modalReturnTarget(trigger: HTMLButtonElement) {
    return trigger.closest(".obsidian-workspace-drawer")
      ? workspaceDrawerTriggerRef.current ?? trigger
      : trigger;
  }

  function openPasswordModal(trigger: HTMLButtonElement) {
    passwordModalTriggerRef.current = modalReturnTarget(trigger);
    setWorkspaceDrawerOpen(false);
    setPasswordModalOpen(true);
  }

  function openSettingsModal(trigger: HTMLButtonElement) {
    settingsModalTriggerRef.current = modalReturnTarget(trigger);
    setWorkspaceDrawerOpen(false);
    setSettingsModalOpen(true);
  }

  function closePasswordModal() {
    pendingModalReturnFocusRef.current = passwordModalTriggerRef.current ?? workspaceDrawerTriggerRef.current;
    setPasswordModalOpen(false);
  }

  function closeSettingsModal() {
    pendingModalReturnFocusRef.current = settingsModalTriggerRef.current ?? workspaceDrawerTriggerRef.current;
    setSettingsModalOpen(false);
  }

  function navigationAfter(section: WorkspaceSection) {
    setWorkspaceDrawerOpen(false);
    if (section === "files") {
      onNavigateHome?.(section);
    }
  }

  function preloadNavigation(destination: string) {
    preloadProtectedRoute(destination, profile);
  }

  const activeWorkspaceLabel = navigationItems.find((item) => item.section === activeWorkspaceSection)?.label
    ?? (activeWorkspaceSection === "admin" ? "관리자" : "메모");

  const accountActions = (
    <>
      <button
        aria-label="비밀번호 변경"
        className="icon-button"
        onClick={(event) => openPasswordModal(event.currentTarget)}
        title="비밀번호 변경"
        type="button"
      >
        <KeyRound size={18} />
        <span className="account-action-label">비밀번호 변경</span>
      </button>
      <ThemeToggleButton onToggle={() => void toggleTheme()} resolvedTheme={resolvedTheme} showLabel />
      <button
        aria-label="설정"
        className="icon-button"
        onClick={(event) => openSettingsModal(event.currentTarget)}
        title="설정"
        type="button"
      >
        <Settings size={18} />
        <span className="account-action-label">설정</span>
      </button>
      <button className="icon-button" type="button" onClick={() => void guardedSignOut()} aria-label="로그아웃" title="로그아웃">
        <LogOut size={18} />
        <span className="account-action-label">로그아웃</span>
      </button>
    </>
  );

  return (
    <div className={`app-frame ${variant === "vault" ? "app-frame-vault" : "app-frame-workspace"}`}>
      {!hasFirebaseConfig && (
        <div className="config-banner">
          `.env.local`에 Firebase 설정을 넣거나 `VITE_USE_FIREBASE_EMULATORS=true`로 에뮬레이터를 사용하세요.
        </div>
      )}
      <header className={`topbar obsidian-titlebar ${variant === "vault" ? "vault-titlebar" : ""}`}>
        <Link
          aria-label="QuickMemo 작업공간"
          className="brand obsidian-titlebar-brand"
          to="/home"
          onFocus={() => preloadNavigation("/home")}
          onPointerEnter={() => preloadNavigation("/home")}
          onClick={guardedNavigation("/home", () => {
            setWorkspaceDrawerOpen(false);
            onNavigateHome?.();
          })}
        >
          <span className="brand-mark">Q</span>
          <span>QuickMemo</span>
        </Link>
        <span className="obsidian-titlebar-context" aria-live="polite">{activeWorkspaceLabel}</span>
        <div className="topbar-user obsidian-titlebar-user">
          {profile && (
            <span className="mini-avatar" style={{ background: profile.color }} title={profile.displayName}>
              {profile.avatarText}
            </span>
          )}
          {variant === "vault" ? <div className="obsidian-titlebar-actions">{accountActions}</div> : null}
          {themeStatus && (
            <span className="sr-only" role="status">
              {themeStatus}
            </span>
          )}
        </div>
      </header>
      {variant === "vault" ? (
        <main className="vault-main">{children}</main>
      ) : (
        <div className={`obsidian-app-workspace ${workspaceDrawerOpen ? "drawer-open" : ""}`}>
          <aside aria-label="작업공간 리본" className="obsidian-app-ribbon">
            <nav aria-label="주요 메뉴" className="obsidian-ribbon-primary">
              {navigationItems.map((item) => {
                const Icon = item.icon;
                const active = activeWorkspaceSection === item.section;

                return (
                  <Link
                    aria-current={active ? "page" : undefined}
                    aria-label={item.label}
                    className={`workspace-ribbon-link ${active ? "active" : ""}`}
                    data-workspace-section={item.section}
                    key={item.section}
                    onClick={guardedNavigation(item.href, () => navigationAfter(item.section))}
                    onFocus={() => preloadNavigation(item.href)}
                    onPointerEnter={() => preloadNavigation(item.href)}
                    title={item.label}
                    to={item.href}
                  >
                    <Icon size={19} aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
            <button
              className="workspace-menu-trigger"
              aria-controls="quickmemo-workspace-drawer"
              aria-expanded={workspaceDrawerOpen}
              aria-label={workspaceDrawerOpen ? "작업공간 메뉴 닫기" : "작업공간 메뉴 열기"}
              onClick={(event) => {
                if (!workspaceDrawerOpen) {
                  workspaceDrawerReturnFocusRef.current = event.currentTarget;
                }
                setWorkspaceDrawerOpen((open) => !open);
              }}
              ref={workspaceDrawerTriggerRef}
              title="작업공간 메뉴"
              type="button"
            >
              <Menu size={19} aria-hidden="true" />
              <span>메뉴</span>
            </button>
          </aside>

          {workspaceDrawerOpen ? (
            <>
              <button
                aria-label="작업공간 메뉴 닫기"
                className="obsidian-drawer-backdrop"
                onClick={() => setWorkspaceDrawerOpen(false)}
                type="button"
              />
              <aside
                aria-label="QuickMemo 작업공간 메뉴"
                aria-modal="true"
                className="obsidian-workspace-drawer"
                id="quickmemo-workspace-drawer"
                ref={workspaceDrawerRef}
                role="dialog"
                tabIndex={-1}
              >
                <header>
                  <div>
                    <span>QUICKMEMO</span>
                    <strong>작업공간</strong>
                  </div>
                  <button
                    aria-label="작업공간 메뉴 닫기"
                    className="icon-button"
                    data-dialog-initial-focus
                    onClick={() => setWorkspaceDrawerOpen(false)}
                    type="button"
                  >
                    <X size={17} />
                  </button>
                </header>
                <nav aria-label="작업공간 이동">
                  {navigationItems.map((item) => {
                    const Icon = item.icon;
                    const active = activeWorkspaceSection === item.section;

                    return (
                      <Link
                        aria-current={active ? "page" : undefined}
                        className={`obsidian-drawer-link ${active ? "active" : ""}`}
                        key={item.section}
                        onClick={guardedNavigation(item.href, () => navigationAfter(item.section))}
                        onFocus={() => preloadNavigation(item.href)}
                        onPointerEnter={() => preloadNavigation(item.href)}
                        to={item.href}
                      >
                        <Icon size={18} />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </nav>
                <footer>
                  {profile ? (
                    <div className="obsidian-drawer-profile">
                      <span className="mini-avatar" style={{ background: profile.color }}>{profile.avatarText}</span>
                      <span>
                        <strong>{profile.displayName}</strong>
                        <small>{profile.isAdmin ? "관리자" : "사용자"}</small>
                      </span>
                    </div>
                  ) : null}
                  {profile?.isAdmin && (
                    <Link
                      aria-current={activeWorkspaceSection === "admin" ? "page" : undefined}
                      className="obsidian-drawer-link"
                      onClick={guardedNavigation("/admin", () => setWorkspaceDrawerOpen(false))}
                      onFocus={() => preloadNavigation("/admin")}
                      onPointerEnter={() => preloadNavigation("/admin")}
                      to="/admin"
                    >
                      <Shield size={18} aria-hidden="true" />
                      <span>관리자</span>
                    </Link>
                  )}
                  <div className="obsidian-drawer-account-actions">{accountActions}</div>
                </footer>
              </aside>
            </>
          ) : null}

          <main aria-hidden={workspaceDrawerOpen ? true : undefined} className="obsidian-workspace-main">
            {children}
          </main>
        </div>
      )}
      {passwordModalOpen && (
        <PasswordChangeModal
          onChangePassword={changePassword}
          onClose={closePasswordModal}
          returnFocusRef={passwordModalTriggerRef}
        />
      )}
      {settingsModalOpen && profile && (
        <SettingsModal
          featureAccess={featureAccess}
          matrixLabelsUnlocked={Boolean(preferencesCryptoContext)}
          preferences={preferences}
          onClose={closeSettingsModal}
          onSave={(nextPreferences) => saveUserPreferences(
            profile.uid,
            nextPreferences,
            preferencesCryptoContext
          )}
          returnFocusRef={settingsModalTriggerRef}
        />
      )}
    </div>
  );
}

export function ThemeToggleButton({
  onToggle,
  resolvedTheme,
  showLabel = false
}: {
  onToggle: () => void;
  resolvedTheme: ResolvedTheme;
  showLabel?: boolean;
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
      {showLabel && <span className="account-action-label">{label}</span>}
    </button>
  );
}

export function SettingsModal({
  featureAccess = defaultFeatureAccess,
  matrixLabelsUnlocked = true,
  onClose,
  onSave,
  preferences,
  returnFocusRef
}: {
  featureAccess?: FeatureAccess;
  matrixLabelsUnlocked?: boolean;
  onClose: () => void;
  onSave: (preferences: SaveUserPreferencesInput) => Promise<void>;
  preferences: UserPreferencesDocument | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const preferredDefaultHome = preferences?.defaultHome ?? "notes";
  const savedAccessibleHome = resolveAccessibleHome({ featureAccess }, preferredDefaultHome);
  const [defaultHome, setDefaultHome] = useState<DefaultHomeView | null>(savedAccessibleHome);
  const [scheduleDefaultView, setScheduleDefaultView] = useState<ActiveScheduleView>(
    normalizePrimaryScheduleView(preferences?.scheduleDefaultView)
  );
  const [scheduleDefaultCategory, setScheduleDefaultCategory] = useState<ScheduleCategoryFilter>(
    normalizeScheduleCategoryFilter(preferences?.scheduleDefaultCategory)
  );
  const [matrixLabels, setMatrixLabels] = useState<MatrixLabels>(() => normalizeMatrixLabels(preferences?.matrixLabels));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settingsEditedRef = useRef(false);
  const savedMatrixLabels = useMemo(() => normalizeMatrixLabels(preferences?.matrixLabels), [preferences]);
  const nextMatrixLabels = useMemo(() => sanitizeMatrixLabelsForSave(matrixLabels), [matrixLabels]);
  const availableDefaultHomes = appFeatures.filter((feature) => featureAccess[feature]);
  const hasChanges =
    defaultHome !== savedAccessibleHome
    || (featureAccess.schedule && scheduleDefaultView !== normalizePrimaryScheduleView(preferences?.scheduleDefaultView))
    || (
      featureAccess.schedule
      && scheduleDefaultCategory !== normalizeScheduleCategoryFilter(preferences?.scheduleDefaultCategory)
    )
    || (
      featureAccess.schedule
      && matrixLabelsUnlocked
      && !sameMatrixLabels(nextMatrixLabels, savedMatrixLabels)
    );

  useModalFocus(dialogRef, { returnFocusRef });

  useEffect(() => {
    if (settingsEditedRef.current) {
      return;
    }

    setDefaultHome(resolveAccessibleHome({ featureAccess }, preferences?.defaultHome ?? "notes"));
    setScheduleDefaultView(normalizePrimaryScheduleView(preferences?.scheduleDefaultView));
    setScheduleDefaultCategory(normalizeScheduleCategoryFilter(preferences?.scheduleDefaultCategory));
    setMatrixLabels(normalizeMatrixLabels(preferences?.matrixLabels));
  }, [featureAccess, preferences]);

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
    const validationError = featureAccess.schedule ? validateMatrixLabels(matrixLabels) : null;

    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const nextPreferences: SaveUserPreferencesInput = {};

      if (defaultHome) {
        nextPreferences.defaultHome = defaultHome;
      }
      if (featureAccess.schedule) {
        if (matrixLabelsUnlocked) nextPreferences.matrixLabels = nextMatrixLabels;
        nextPreferences.scheduleDefaultCategory = scheduleDefaultCategory;
        nextPreferences.scheduleDefaultView = scheduleDefaultView;
      }

      await onSave(nextPreferences);
      settingsEditedRef.current = false;
      setMessage("설정을 저장했습니다.");
    } catch {
      setError("설정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  function updateMatrixLabel(key: keyof MatrixLabels, value: string) {
    settingsEditedRef.current = true;
    setError(null);
    setMessage(null);
    setMatrixLabels((current) => ({ ...current, [key]: value }));
  }

  function resetMatrixLabels() {
    const nextDefaultLabels = { ...defaultMatrixLabels };

    settingsEditedRef.current = true;
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
        ref={dialogRef}
        tabIndex={-1}
      >
        <button className="icon-button password-change-close" type="button" onClick={onClose} aria-label="설정 닫기">
          <X size={16} />
        </button>
        <h2 id="settings-modal-title">설정</h2>
        <p id="settings-modal-description" className="settings-modal-description">
          작업 시작 화면, 일정관리 기본 보기와 분류, 매트릭스 표시 명칭을 설정합니다.
        </p>
        <form className="form-grid compact" onSubmit={(event) => void submitSettings(event)}>
          <section className="settings-form-section" aria-labelledby="settings-workspace-title">
            <h3 id="settings-workspace-title">작업 환경</h3>
            {availableDefaultHomes.length > 0 ? (
              <label>
                작업 시작 기본 화면
                <AppSelect
                  onChange={(event) => {
                    settingsEditedRef.current = true;
                    setError(null);
                    setMessage(null);
                    setDefaultHome(event.target.value as DefaultHomeView);
                  }}
                  value={defaultHome ?? ""}
                >
                  {featureAccess.notes && <option value="notes">노트</option>}
                  {featureAccess.library && <option value="library">자료실</option>}
                  {featureAccess.schedule && <option value="schedule">일정관리</option>}
                </AppSelect>
              </label>
            ) : (
              <p className="settings-access-note" role="status">
                현재 사용할 수 있는 작업 기능이 없습니다. 관리자에게 권한을 요청해 주세요.
              </p>
            )}
            {featureAccess.schedule && (
              <label>
                일정관리 기본 화면
                <AppSelect
                  onChange={(event) => {
                    settingsEditedRef.current = true;
                    setError(null);
                    setMessage(null);
                    setScheduleDefaultView(event.target.value as ActiveScheduleView);
                  }}
                  value={scheduleDefaultView}
                >
                  <option value="calendar">달력</option>
                  <option value="matrix">매트릭스</option>
                </AppSelect>
              </label>
            )}
            {featureAccess.schedule && (
              <label>
                일정 기본 분류 보기
                <AppSelect
                  onChange={(event) => {
                    settingsEditedRef.current = true;
                    setError(null);
                    setMessage(null);
                    setScheduleDefaultCategory(event.target.value as ScheduleCategoryFilter);
                  }}
                  value={scheduleDefaultCategory}
                >
                  <option value="all">전체</option>
                  <option value="work">업무</option>
                  <option value="personal">개인</option>
                </AppSelect>
              </label>
            )}
          </section>
          {featureAccess.schedule && <section className="settings-form-section matrix-label-settings" aria-labelledby="matrix-label-settings-title">
            <div className="settings-section-heading">
              <div>
                <h3 id="matrix-label-settings-title">매트릭스 명칭 설정</h3>
                <p>각 영역의 표시 명칭만 바꾸며 일정 분류 기준은 유지됩니다.</p>
              </div>
              <button
                className="secondary-button"
                disabled={!matrixLabelsUnlocked}
                type="button"
                onClick={resetMatrixLabels}
              >
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
                      disabled={!matrixLabelsUnlocked}
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
            {!matrixLabelsUnlocked ? (
              <p className="settings-access-note" role="status">
                암호화 키를 연 뒤 사용자 지정 명칭을 확인하거나 변경할 수 있습니다.
              </p>
            ) : null}
            <p className="settings-inline-status" role="status">
              {hasChanges ? "변경사항 있음" : "저장된 설정과 같습니다."}
            </p>
          </section>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {message && <p className="form-success" role="status">{message}</p>}
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
  onClose,
  returnFocusRef
}: {
  onChangePassword: (currentPassword: string, nextPassword: string) => Promise<void>;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useModalFocus(dialogRef, { returnFocusRef });

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

    if (!newPasswordMeetsMinimum(nextPassword)) {
      setError(`새 비밀번호는 ${minimumNewPasswordLength}자 이상이어야 합니다.`);
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
        ref={dialogRef}
        tabIndex={-1}
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
              data-dialog-initial-focus
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
              minLength={minimumNewPasswordLength}
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
              minLength={minimumNewPasswordLength}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              type="password"
              value={confirmPassword}
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          {message && <p className="form-success" role="status">{message}</p>}
          <button disabled={busy} type="submit">
            {busy ? "변경 중..." : "변경"}
          </button>
        </form>
      </section>
    </div>
  );
}
