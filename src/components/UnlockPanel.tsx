import { KeyRound } from "lucide-react";
import { FormEvent, useState } from "react";
import { useAuth } from "../context/AuthContext";

export function UnlockPanel() {
  const { profile, unlockPrivateKey, keyError } = useAuth();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      await unlockPrivateKey(password);
      setPassword("");
    } catch {
      setError("비밀번호를 확인해주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="unlock-panel">
      <KeyRound size={34} />
      <h1>{profile?.displayName}님의 암호화 키를 열어주세요</h1>
      <p>탭 세션이 만료되었거나 1시간 동안 활동이 없으면 노트와 일정 복호화를 위해 비밀번호가 한 번 더 필요합니다.</p>
      <form onSubmit={handleSubmit} className="inline-form">
        {profile && (
          <input
            autoComplete="username"
            className="sr-only"
            name="username"
            readOnly
            tabIndex={-1}
            type="email"
            value={profile.loginEmail}
          />
        )}
        <input
          aria-label="비밀번호"
          autoComplete="current-password"
          minLength={6}
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="비밀번호"
          required
          type="password"
          value={password}
        />
        <button disabled={pending} type="submit">
          {pending ? "확인 중" : "열기"}
        </button>
      </form>
      {(error || keyError) && <p className="form-error">{error || keyError}</p>}
    </section>
  );
}
