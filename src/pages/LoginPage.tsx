import { LockKeyhole } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { AvatarButton } from "../components/AvatarButton";
import { useAuth } from "../context/AuthContext";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { parseLibraryCaptureLoginState } from "../lib/libraryCapture";
import { findRosterByShortcut } from "../lib/roster";
import { secureShareLoginDestination } from "../lib/shareLoginReturn";
import { useModalFocus } from "../lib/useModalFocus";
import { subscribeRoster } from "../services/users";
import type { PublicRosterUser } from "../types";

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { firebaseUser, profile, loginRosterUser } = useAuth();
  const [roster, setRoster] = useState<PublicRosterUser[]>([]);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState<PublicRosterUser | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sortedRoster = useMemo(() => roster.filter((user) => user.isActive), [roster]);
  const passwordDialogRef = useRef<HTMLElement>(null);
  const passwordDialogTriggerRef = useRef<HTMLElement>(null);
  const captureLoginState = useMemo(() => {
    try {
      return parseLibraryCaptureLoginState(location.state);
    } catch {
      return null;
    }
  }, [location.state]);
  const captureRedirectTarget = captureLoginState
    ? `${captureLoginState.returnTo}${captureLoginState.captureFragment}`
    : null;
  const secureShareRedirectTarget = useMemo(
    () => secureShareLoginDestination(location.state),
    [location.state]
  );
  const redirectTarget = secureShareRedirectTarget ?? captureRedirectTarget ?? "/home";

  useModalFocus(passwordDialogRef, {
    enabled: selectedUser !== null,
    returnFocusRef: passwordDialogTriggerRef
  });

  const rosterButtonFor = useCallback((user: PublicRosterUser) => {
    const activeUserIndex = sortedRoster.findIndex((candidate) => candidate.uid === user.uid);
    return activeUserIndex >= 0
      ? document.querySelectorAll<HTMLElement>(".roster-grid .avatar-button").item(activeUserIndex)
      : null;
  }, [sortedRoster]);

  const openPasswordDialog = useCallback((user: PublicRosterUser, trigger?: HTMLElement | null) => {
    passwordDialogTriggerRef.current = trigger ?? rosterButtonFor(user);
    setSelectedUser(user);
    setPassword("");
    setError(null);
  }, [rosterButtonFor]);

  useEffect(() => {
    if (location.hash) {
      navigate("/login", {
        replace: true,
        state: secureShareRedirectTarget
          ? location.state
          : captureLoginState ?? undefined
      });
    }
  }, [captureLoginState, location.hash, location.state, navigate, secureShareRedirectTarget]);

  useEffect(() => {
    return subscribeRoster(
      (nextRoster) => {
        setRoster(nextRoster);
        setRosterLoading(false);
      },
      () => {
        setRosterLoading(false);
        setError("로그인 사용자 목록을 불러오지 못했습니다.");
      }
    );
  }, []);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (selectedUser || event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) {
        return;
      }

      const shortcutUser = findRosterByShortcut(roster, event.key);

      if (shortcutUser) {
        event.preventDefault();
        const trigger = rosterButtonFor(shortcutUser);
        trigger?.focus({ preventScroll: true });
        openPasswordDialog(shortcutUser, trigger);
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openPasswordDialog, roster, rosterButtonFor, selectedUser]);

  const closePasswordDialog = useCallback(() => {
    if (pending) {
      return;
    }
    setSelectedUser(null);
    setPassword("");
    setError(null);
  }, [pending]);

  useEffect(() => {
    if (!selectedUser) {
      return undefined;
    }

    function handleCancel(event: KeyboardEvent) {
      if (event.key !== "Escape" || pending) {
        return;
      }

      event.preventDefault();
      closePasswordDialog();
    }

    window.addEventListener("keydown", handleCancel);
    return () => window.removeEventListener("keydown", handleCancel);
  }, [closePasswordDialog, pending, selectedUser]);

  // `loadProfile()` can publish the authenticated user/profile before
  // `loginRosterUser()` finishes decrypting and installing the private key.
  // Keep the submitting login route mounted until that promise settles so its
  // later redirect cannot race a user or E2E navigation that already opened a
  // protected workspace.
  if (firebaseUser && profile?.isActive && profile.uid === firebaseUser.uid && !pending && !selectedUser) {
    return <Navigate to={redirectTarget} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedUser || pending) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      await loginRosterUser(selectedUser, password);
      navigate(redirectTarget, { replace: true });
    } catch (loginError) {
      setError(firebaseAuthErrorMessage(loginError, "비밀번호를 확인해주세요."));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-page login-layout">
      <div className="login-content">
        <section className="login-copy" aria-labelledby="login-title">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">Q</span>
            <span>QuickMemo</span>
          </div>
          <p className="login-eyebrow">메모 · 일정 · 자료실</p>
          <h1 id="login-title">가볍게 기록하고,<br />깔끔하게 정리하세요.</h1>
          <p>필요한 순간, 나의 기록을 한곳에서.</p>
        </section>
        <section className="auth-panel roster-panel" aria-labelledby="login-panel-title">
          <header className="login-panel-heading">
            <h2 id="login-panel-title">로그인</h2>
            <p>사용자를 선택해 계속하세요.</p>
          </header>
          {error && !selectedUser && <p className="form-error login-error" role="alert">{error}</p>}
          {rosterLoading ? (
            <div className="empty-state" role="status" aria-live="polite">
              <p>사용자 목록을 불러오는 중...</p>
            </div>
          ) : sortedRoster.length === 0 ? (
            <div className="empty-state">
              <p>아직 로그인 가능한 사용자가 없습니다.</p>
            </div>
          ) : (
            <div className="roster-grid">
              {sortedRoster.map((user) => (
                <AvatarButton
                  key={user.uid}
                  user={user}
                  selected={selectedUser?.uid === user.uid}
                  showRole={false}
                  onClick={() => openPasswordDialog(user, rosterButtonFor(user))}
                />
              ))}
            </div>
          )}
          {sortedRoster.length > 0 && <p className="login-shortcut-hint">숫자 키로도 사용자를 선택할 수 있어요.</p>}
        </section>
        <p className="login-security-note"><LockKeyhole size={14} aria-hidden="true" />메모와 일정은 암호화해 보관합니다.</p>
      </div>
      {selectedUser && (
        <div className="modal-backdrop login-modal-backdrop" role="presentation" onMouseDown={closePasswordDialog}>
          <section
            className="password-modal login-password-modal"
            role="dialog"
            aria-labelledby="password-modal-title"
            aria-modal="true"
            aria-describedby="password-modal-description"
            onMouseDown={(event) => event.stopPropagation()}
            ref={passwordDialogRef}
            tabIndex={-1}
          >
            <span className="avatar-circle modal-avatar" style={{ background: selectedUser.color }}>
              {selectedUser.avatarText}
            </span>
            <h2 id="password-modal-title">{selectedUser.displayName}</h2>
            <p id="password-modal-description">비밀번호를 입력해 내 기록을 여세요.</p>
            <form onSubmit={handleSubmit} className="form-grid compact" aria-busy={pending}>
              <input
                autoComplete="username"
                className="sr-only"
                name="username"
                readOnly
                tabIndex={-1}
                type="email"
                value={selectedUser.loginEmail}
              />
              <label>
                비밀번호
                <input
                  autoFocus
                  autoComplete="current-password"
                  data-dialog-initial-focus
                  disabled={pending}
                  minLength={6}
                  name="password"
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError(null);
                  }}
                  required
                  type="password"
                  value={password}
                />
              </label>
              {error && <p className="form-error" role="alert">{error}</p>}
              {pending && <span className="sr-only" role="status">안전하게 로그인하는 중입니다.</span>}
              <button disabled={pending} type="submit">
                {pending ? "로그인 중" : "로그인"}
              </button>
              <button className="secondary-button" disabled={pending} type="button" onClick={closePasswordDialog}>
                취소
              </button>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}
