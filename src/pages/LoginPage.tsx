import { LockKeyhole, Settings } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { AvatarButton } from "../components/AvatarButton";
import { useAuth } from "../context/AuthContext";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { findRosterByShortcut } from "../lib/roster";
import { subscribeRoster } from "../services/users";
import type { PublicRosterUser } from "../types";

export default function LoginPage() {
  const navigate = useNavigate();
  const { firebaseUser, profile, loginRosterUser } = useAuth();
  const [roster, setRoster] = useState<PublicRosterUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<PublicRosterUser | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return subscribeRoster(setRoster, () => setError("로그인 사용자 목록을 불러오지 못했습니다."));
  }, []);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const shortcutUser = findRosterByShortcut(roster, event.key);

      if (shortcutUser) {
        setSelectedUser(shortcutUser);
        setPassword("");
        setError(null);
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [roster]);

  const sortedRoster = useMemo(() => roster.filter((user) => user.isActive), [roster]);

  if (firebaseUser && profile) {
    return <Navigate to={profile.isAdmin ? "/admin" : "/app"} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedUser) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const nextProfile = await loginRosterUser(selectedUser, password);
      navigate(nextProfile.isAdmin ? "/admin" : "/app", { replace: true });
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
        <h1>사용자를 선택하고 바로 메모하세요</h1>
        <p>원형 사용자 버튼을 클릭하거나 숫자 키를 눌러 비밀번호 창을 열 수 있습니다.</p>
        <Link className="text-link" to="/setup">
          <Settings size={16} />
          첫 관리자 설정
        </Link>
      </section>
      <section className="auth-panel roster-panel">
        <div className="section-kicker">
          <LockKeyhole size={18} />
          빠른 로그인
        </div>
        {sortedRoster.length === 0 ? (
          <div className="empty-state">
            <p>{error || "아직 로그인 가능한 사용자가 없습니다."}</p>
            <Link to="/setup">초기 설정으로 이동</Link>
          </div>
        ) : (
          <div className="roster-grid">
            {sortedRoster.map((user) => (
              <AvatarButton
                key={user.uid}
                user={user}
                selected={selectedUser?.uid === user.uid}
                onClick={() => {
                  setSelectedUser(user);
                  setPassword("");
                  setError(null);
                }}
              />
            ))}
          </div>
        )}
      </section>
      {selectedUser && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSelectedUser(null)}>
          <section className="password-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <span className="avatar-circle modal-avatar" style={{ background: selectedUser.color }}>
              {selectedUser.avatarText}
            </span>
            <h2>{selectedUser.displayName}</h2>
            <form onSubmit={handleSubmit} className="form-grid compact">
              <label>
                비밀번호
                <input
                  autoFocus
                  autoComplete="current-password"
                  minLength={6}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </label>
              {error && <p className="form-error">{error}</p>}
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
