import { Link2, LogOut, NotebookPen, Shield } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { hasFirebaseConfig } from "../lib/firebase";

export function AppShell({ children }: { children: ReactNode }) {
  const { googleLinked, linkGoogleLogin, profile, signOut } = useAuth();
  const [linkingGoogle, setLinkingGoogle] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function handleGoogleLink() {
    setLinkingGoogle(true);
    setLinkError(null);

    try {
      await linkGoogleLogin();
    } catch (error) {
      setLinkError(firebaseAuthErrorMessage(error, "Google 계정을 연결하지 못했습니다."));
    } finally {
      setLinkingGoogle(false);
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
        <Link className="brand" to="/app">
          <span className="brand-mark">Q</span>
          <span>QuickMemo</span>
        </Link>
        <nav className="nav-links" aria-label="주요 메뉴">
          <NavLink to="/app">
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
          {profile && !googleLinked && (
            <button
              className="secondary-button topbar-google-button"
              disabled={linkingGoogle}
              onClick={() => void handleGoogleLink()}
              type="button"
            >
              <Link2 size={16} />
              {linkingGoogle ? "연결 중" : "Google 연결"}
            </button>
          )}
          {profile && (
            <span className="mini-avatar" style={{ background: profile.color }}>
              {profile.avatarText}
            </span>
          )}
          <button className="icon-button" type="button" onClick={() => void signOut()} aria-label="로그아웃">
            <LogOut size={18} />
          </button>
        </div>
        {linkError && <p className="topbar-error">{linkError}</p>}
      </header>
      <main>{children}</main>
    </div>
  );
}
