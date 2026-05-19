import { Fingerprint, KeyRound } from "lucide-react";
import { FormEvent, useState } from "react";
import { useAuth } from "../context/AuthContext";

export function UnlockPanel() {
  const {
    keyError,
    passkeySupported,
    passkeyUnlockAvailable,
    profile,
    unlockPrivateKey,
    unlockPrivateKeyWithPasskey
  } = useAuth();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showPasskeyUnlock = passkeySupported && passkeyUnlockAvailable;

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

  async function handlePasskeyUnlock() {
    setPasskeyPending(true);
    setError(null);

    try {
      await unlockPrivateKeyWithPasskey();
    } catch {
      setError("Passkey로 열지 못했습니다. 비밀번호로 열어주세요.");
    } finally {
      setPasskeyPending(false);
    }
  }

  return (
    <section className="unlock-panel">
      <KeyRound size={34} />
      <h1>{profile?.displayName}님의 암호화 키를 열어주세요</h1>
      <p>새로고침했거나 30분 동안 활동이 없으면 노트 복호화를 위해 한 번 더 열어야 합니다.</p>
      {showPasskeyUnlock && (
        <button
          className="secondary-button unlock-passkey-button"
          disabled={passkeyPending || pending}
          onClick={() => void handlePasskeyUnlock()}
          type="button"
        >
          <Fingerprint size={18} />
          <span>{passkeyPending ? "확인 중" : "Passkey로 열기"}</span>
        </button>
      )}
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
