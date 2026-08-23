import { KeyRound } from "lucide-react";
import { FormEvent, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";

const retryableUnlockErrorCodes = new Set([
  "aborted",
  "cancelled",
  "deadline-exceeded",
  "internal",
  "network-request-failed",
  "resource-exhausted",
  "unavailable",
  "unknown"
]);

export function vaultUnlockErrorMessage(error: unknown) {
  const rawCode = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const normalizedCode = rawCode.toLowerCase().split("/").at(-1) ?? "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (
    retryableUnlockErrorCodes.has(normalizedCode)
    || /network|connection|offline|transport/u.test(message)
  ) {
    return "네트워크 연결이 불안정합니다. 연결을 확인한 뒤 다시 열어주세요.";
  }

  if (error instanceof DOMException && error.name === "OperationError") {
    return "비밀번호가 올바르지 않거나 암호화 키를 열 수 없습니다.";
  }

  return firebaseAuthErrorMessage(
    error,
    "암호화 키를 열지 못했습니다. 잠시 후 다시 시도해주세요."
  );
}

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
    } catch (caught) {
      setError(vaultUnlockErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="unlock-panel">
      <KeyRound size={34} />
      <h1>{profile?.displayName}님의 암호화 키를 열어주세요</h1>
      <p>새로고침했거나 암호화 키가 잠긴 경우 노트와 일정 복호화를 위해 비밀번호가 한 번 더 필요합니다.</p>
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
