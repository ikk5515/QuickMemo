import { CheckCircle2 } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { AvatarButton } from "../components/AvatarButton";
import { useAuth } from "../context/AuthContext";
import { generateUserKeyBundle } from "../lib/crypto";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { createFirstAdmin, getBootstrapState } from "../services/adminFunctions";
import type { PublicRosterUser } from "../types";

const defaultAdmin: PublicRosterUser = {
  uid: "preview",
  displayName: "관리자",
  avatarText: "AD",
  color: "#2f7d70",
  order: 1,
  quickKey: 1,
  loginEmail: "preview@quickmemo.local",
  isActive: true,
  isAdmin: true
};

export default function SetupPage() {
  const navigate = useNavigate();
  const { firebaseUser, loginRosterUser } = useAuth();
  const [adminExists, setAdminExists] = useState<boolean | null>(null);
  const [displayName, setDisplayName] = useState(defaultAdmin.displayName);
  const [avatarText, setAvatarText] = useState(defaultAdmin.avatarText);
  const [color, setColor] = useState(defaultAdmin.color);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getBootstrapState()
      .then((state) => setAdminExists(state.adminExists))
      .catch(() => setAdminExists(false));
  }, []);

  if (firebaseUser) {
    return <Navigate to="/app" replace />;
  }

  if (adminExists) {
    return <Navigate to="/login" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const keyBundle = await generateUserKeyBundle(password);
      const created = await createFirstAdmin({
        displayName,
        avatarText,
        color,
        quickKey: 1,
        password,
        isAdmin: true,
        keyBundle
      });
      await loginRosterUser(
        {
          uid: created.uid,
          displayName,
          avatarText,
          color,
          order: 1,
          quickKey: 1,
          loginEmail: created.loginEmail,
          isActive: true,
          isAdmin: true
        },
        password
      );
      navigate("/admin", { replace: true });
    } catch (setupError) {
      setError(firebaseAuthErrorMessage(setupError, "첫 관리자를 만들지 못했습니다."));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel setup-panel">
        <div className="section-kicker">
          <CheckCircle2 size={18} />
          초기 설정
        </div>
        <h1>QuickMemo 첫 관리자를 만듭니다</h1>
        <p>관리자는 사용자 원형 버튼, 빠른 로그인 번호, 권한, 표시 순서를 관리합니다.</p>
        <div className="preview-row">
          <AvatarButton
            user={{ ...defaultAdmin, displayName, avatarText, color }}
            selected
            onClick={() => undefined}
          />
        </div>
        <form className="form-grid" onSubmit={handleSubmit}>
          <label>
            관리자 이름
            <input
              maxLength={24}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              value={displayName}
            />
          </label>
          <label>
            원 안 글자
            <input
              maxLength={3}
              onChange={(event) => setAvatarText(event.target.value.toUpperCase())}
              required
              value={avatarText}
            />
          </label>
          <label>
            색상
            <input onChange={(event) => setColor(event.target.value)} type="color" value={color} />
          </label>
          <label>
            비밀번호
            <input
              autoComplete="new-password"
              minLength={6}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button disabled={pending} type="submit">
            {pending ? "생성 중" : "첫 관리자 생성"}
          </button>
        </form>
      </section>
    </main>
  );
}
