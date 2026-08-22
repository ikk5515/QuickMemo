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
    const activeUserIndex = roster.filter((candidate) => candidate.isActive).findIndex((candidate) => candidate.uid === user.uid);
    return activeUserIndex >= 0
      ? document.querySelectorAll<HTMLElement>(".roster-grid .avatar-button").item(activeUserIndex)
      : null;
  }, [roster]);

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

  useEffect(() => {
    if (!selectedUser) {
      return undefined;
    }

    function handleCancel(event: KeyboardEvent) {
      if (event.key !== "Escape" || pending) {
        return;
      }

      event.preventDefault();
      setSelectedUser(null);
      setPassword("");
      setError(null);
    }

    window.addEventListener("keydown", handleCancel);
    return () => window.removeEventListener("keydown", handleCancel);
  }, [pending, selectedUser]);

  const sortedRoster = useMemo(() => roster.filter((user) => user.isActive), [roster]);

  // `loadProfile()` can publish the authenticated user/profile before
  // `loginRosterUser()` finishes decrypting and installing the private key.
  // Keep the submitting login route mounted until that promise settles so its
  // later redirect cannot race a user or E2E navigation that already opened a
  // protected workspace.
  if (firebaseUser && profile && !pending && !selectedUser) {
    return <Navigate to={redirectTarget} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedUser) {
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
      <section className="login-copy">
        <div className="brand large">
          <span className="brand-mark">Q</span>
          <span>QuickMemo</span>
        </div>
        <h1>
          <span>사용자를 선택하고</span> <span>바로 메모하세요</span>
        </h1>
        <p>원형 사용자 버튼을 클릭하거나 숫자 키를 눌러 비밀번호 창을 열 수 있습니다.</p>
      </section>
      <section className="auth-panel roster-panel">
        <div className="section-kicker">
          <LockKeyhole size={18} />
          빠른 로그인
        </div>
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
      </section>
      {selectedUser && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSelectedUser(null)}>
          <section
            className="password-modal"
            role="dialog"
            aria-labelledby="password-modal-title"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
            ref={passwordDialogRef}
            tabIndex={-1}
          >
            <span className="avatar-circle modal-avatar" style={{ background: selectedUser.color }}>
              {selectedUser.avatarText}
            </span>
            <h2 id="password-modal-title">{selectedUser.displayName}</h2>
            <form onSubmit={handleSubmit} className="form-grid compact">
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
              <button disabled={pending} type="submit">
                {pending ? "로그인 중" : "로그인"}
              </button>
              <button className="secondary-button" type="button" onClick={() => setSelectedUser(null)}>
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
