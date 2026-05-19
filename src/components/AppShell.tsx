import { Fingerprint, KeyRound, LogOut, NotebookPen, Shield, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { hasFirebaseConfig } from "../lib/firebase";

export function AppShell({ children, onNavigateHome }: { children: ReactNode; onNavigateHome?: () => void }) {
  const {
    changePassword,
    passkeySupported,
    passkeyUnlockAvailable,
    privateKey,
    profile,
    registerPasskeyUnlock,
    removePasskeyUnlock,
    signOut
  } = useAuth();
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passkeyModalOpen, setPasskeyModalOpen] = useState(false);

  return (
    <div className="app-frame">
      {!hasFirebaseConfig && (
        <div className="config-banner">
          `.env.local`에 Firebase 설정을 넣거나 `VITE_USE_FIREBASE_EMULATORS=true`로 에뮬레이터를 사용하세요.
        </div>
      )}
      <header className="topbar">
        <Link className="brand" to="/app" onClick={onNavigateHome}>
          <span className="brand-mark">Q</span>
          <span>QuickMemo</span>
        </Link>
        <nav className="nav-links" aria-label="주요 메뉴">
          <NavLink to="/app" onClick={onNavigateHome}>
            <NotebookPen size={18} />
            노트
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
          {profile && privateKey && passkeySupported && (
            <button
              className="secondary-button topbar-password-button"
              type="button"
              onClick={() => setPasskeyModalOpen(true)}
            >
              <Fingerprint size={16} />
              <span>Passkey</span>
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
      {passkeyModalOpen && (
        <PasskeyUnlockModal
          passkeyUnlockAvailable={passkeyUnlockAvailable}
          onClose={() => setPasskeyModalOpen(false)}
          onRegister={registerPasskeyUnlock}
          onRemove={removePasskeyUnlock}
        />
      )}
    </div>
  );
}

function PasskeyUnlockModal({
  passkeyUnlockAvailable,
  onClose,
  onRegister,
  onRemove
}: {
  passkeyUnlockAvailable: boolean;
  onClose: () => void;
  onRegister: (password: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
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

  async function submitPasskeyRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);

    try {
      await onRegister(password);
      setPassword("");
      setMessage("Passkey 잠금 해제를 등록했습니다.");
    } catch (registerError) {
      setError(firebaseAuthErrorMessage(registerError, "Passkey 잠금 해제를 등록하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function removePasskey() {
    setError(null);
    setMessage(null);
    setBusy(true);

    try {
      await onRemove();
      setMessage("Passkey 잠금 해제를 해제했습니다.");
    } catch (removeError) {
      setError(firebaseAuthErrorMessage(removeError, "Passkey 잠금 해제를 해제하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="password-modal passkey-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <button className="icon-button password-change-close" type="button" onClick={onClose} aria-label="Passkey 설정 닫기">
          <X size={16} />
        </button>
        <h2>Passkey 잠금 해제</h2>
        {passkeyUnlockAvailable ? (
          <div className="form-grid compact">
            <p className="modal-help-text">현재 Passkey로 노트 잠금 해제가 가능합니다.</p>
            {error && <p className="form-error">{error}</p>}
            {message && <p className="form-success">{message}</p>}
            <button className="secondary-button danger" disabled={busy} type="button" onClick={() => void removePasskey()}>
              {busy ? "해제 중..." : "Passkey 해제"}
            </button>
          </div>
        ) : (
          <form className="form-grid compact" onSubmit={(event) => void submitPasskeyRegister(event)}>
            <label>
              현재 비밀번호
              <input
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            {message && <p className="form-success">{message}</p>}
            <button disabled={busy} type="submit">
              {busy ? "등록 중..." : "Passkey 등록"}
            </button>
          </form>
        )}
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
