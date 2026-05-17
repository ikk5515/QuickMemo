import { ArrowDown, ArrowUp, Plus, Save, ShieldCheck, UserRoundCog } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import { generateUserKeyBundle } from "../lib/crypto";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { initialsFromName } from "../lib/roster";
import { createUser, updateUser } from "../services/adminFunctions";
import { subscribeUsers } from "../services/users";
import type { UserProfile } from "../types";

const palette = ["#2f7d70", "#c75146", "#7c5b9e", "#b9822f", "#3f6fb5", "#65707a"];

interface DraftUser {
  displayName: string;
  avatarText: string;
  color: string;
  quickKey: number;
  password: string;
  isAdmin: boolean;
}

const initialDraft: DraftUser = {
  displayName: "",
  avatarText: "",
  color: palette[0],
  quickKey: 0,
  password: "",
  isAdmin: false
};

export default function AdminPage() {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [draft, setDraft] = useState<DraftUser>(initialDraft);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return subscribeUsers(setUsers, () => setError("사용자 목록을 불러오지 못했습니다."));
  }, []);

  const nextQuickKey = useMemo(() => {
    const used = new Set(users.map((user) => user.quickKey));
    for (let key = 1; key <= 99; key += 1) {
      if (!used.has(key)) {
        return key;
      }
    }
    return users.length + 1;
  }, [users]);

  useEffect(() => {
    if (!draft.quickKey && nextQuickKey) {
      setDraft((current) => ({ ...current, quickKey: nextQuickKey }));
    }
  }, [draft.quickKey, nextQuickKey]);

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);

    try {
      const keyBundle = await generateUserKeyBundle(draft.password);
      await createUser({
        displayName: draft.displayName,
        avatarText: draft.avatarText || initialsFromName(draft.displayName),
        color: draft.color,
        quickKey: Number(draft.quickKey || nextQuickKey),
        password: draft.password,
        isAdmin: draft.isAdmin,
        keyBundle
      });
      setDraft({ ...initialDraft, quickKey: nextQuickKey + 1, color: palette[users.length % palette.length] });
      setNotice("사용자를 만들었습니다.");
    } catch (createError) {
      setError(firebaseAuthErrorMessage(createError, "사용자를 만들지 못했습니다."));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppShell>
      <section className="workspace admin-workspace">
        <div className="workspace-heading">
          <div>
            <div className="section-kicker">
              <ShieldCheck size={18} />
              관리자 페이지
            </div>
            <h1>사용자와 로그인 순서를 관리합니다</h1>
          </div>
        </div>
        <div className="admin-grid">
          <section className="panel">
            <h2>
              <Plus size={20} />
              사용자 추가
            </h2>
            <form className="form-grid" onSubmit={handleCreateUser}>
              <label>
                이름
                <input
                  maxLength={24}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      displayName: event.target.value,
                      avatarText: current.avatarText || initialsFromName(event.target.value)
                    }))
                  }
                  required
                  value={draft.displayName}
                />
              </label>
              <label>
                원 안 글자
                <input
                  maxLength={3}
                  onChange={(event) => setDraft((current) => ({ ...current, avatarText: event.target.value.toUpperCase() }))}
                  required
                  value={draft.avatarText}
                />
              </label>
              <label>
                빠른 로그인 번호
                <input
                  min={1}
                  onChange={(event) => setDraft((current) => ({ ...current, quickKey: Number(event.target.value) }))}
                  required
                  type="number"
                  value={draft.quickKey || nextQuickKey}
                />
              </label>
              <label>
                색상
                <input
                  onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value }))}
                  type="color"
                  value={draft.color}
                />
              </label>
              <label>
                초기 비밀번호
                <input
                  autoComplete="new-password"
                  minLength={6}
                  onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))}
                  required
                  type="password"
                  value={draft.password}
                />
              </label>
              <label className="checkbox-row">
                <input
                  checked={draft.isAdmin}
                  onChange={(event) => setDraft((current) => ({ ...current, isAdmin: event.target.checked }))}
                  type="checkbox"
                />
                관리자 권한 부여
              </label>
              {notice && <p className="form-success">{notice}</p>}
              {error && <p className="form-error">{error}</p>}
              <button disabled={pending} type="submit">
                {pending ? "생성 중" : "사용자 생성"}
              </button>
            </form>
          </section>
          <section className="panel wide-panel">
            <h2>
              <UserRoundCog size={20} />
              사용자 목록
            </h2>
            <div className="user-table">
              {users.map((user, index) => (
                <EditableUserRow key={user.uid} index={index} total={users.length} user={user} users={users} />
              ))}
            </div>
          </section>
        </div>
      </section>
    </AppShell>
  );
}

function EditableUserRow({
  user,
  users,
  index,
  total
}: {
  user: UserProfile;
  users: UserProfile[];
  index: number;
  total: number;
}) {
  const [draft, setDraft] = useState(user);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(user);
  }, [user]);

  async function handleSave() {
    setPending(true);
    setMessage(null);

    try {
      await updateUser({
        uid: user.uid,
        displayName: draft.displayName,
        avatarText: draft.avatarText,
        color: draft.color,
        quickKey: Number(draft.quickKey),
        order: Number(draft.order),
        isActive: draft.isActive,
        isAdmin: draft.isAdmin
      });
      setMessage("저장됨");
    } catch {
      setMessage("저장 실패");
    } finally {
      setPending(false);
    }
  }

  async function move(direction: -1 | 1) {
    const nextIndex = index + direction;

    if (nextIndex < 0 || nextIndex >= total) {
      return;
    }

    const ordered = [...users];
    const [picked] = ordered.splice(index, 1);
    ordered.splice(nextIndex, 0, picked);

    setPending(true);
    setMessage(null);

    try {
      await Promise.all(
        ordered.map((orderedUser, orderIndex) =>
          updateUser({
            uid: orderedUser.uid,
            displayName: orderedUser.displayName,
            avatarText: orderedUser.avatarText,
            color: orderedUser.color,
            quickKey: orderedUser.quickKey,
            order: orderIndex + 1,
            isActive: orderedUser.isActive,
            isAdmin: orderedUser.isAdmin
          })
        )
      );
      setMessage("순서 저장됨");
    } catch {
      setMessage("순서 변경 실패");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="user-row">
      <div className="user-row-avatar" style={{ background: draft.color }}>
        {draft.avatarText}
      </div>
      <div className="user-row-fields">
        <input
          aria-label="사용자 이름"
          maxLength={24}
          onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
          value={draft.displayName}
        />
        <input
          aria-label="원 안 글자"
          maxLength={3}
          onChange={(event) => setDraft((current) => ({ ...current, avatarText: event.target.value.toUpperCase() }))}
          value={draft.avatarText}
        />
        <input
          aria-label="빠른 로그인 번호"
          min={1}
          onChange={(event) => setDraft((current) => ({ ...current, quickKey: Number(event.target.value) }))}
          type="number"
          value={draft.quickKey}
        />
        <input
          aria-label="원 색상"
          onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value }))}
          type="color"
          value={draft.color}
        />
      </div>
      <div className="user-row-toggles">
        <label className="checkbox-row">
          <input
            checked={draft.isAdmin}
            onChange={(event) => setDraft((current) => ({ ...current, isAdmin: event.target.checked }))}
            type="checkbox"
          />
          관리자
        </label>
        <label className="checkbox-row">
          <input
            checked={draft.isActive}
            onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))}
            type="checkbox"
          />
          활성
        </label>
      </div>
      <div className="row-actions">
        <button className="icon-button" disabled={pending || index === 0} onClick={() => void move(-1)} type="button" aria-label="위로">
          <ArrowUp size={16} />
        </button>
        <button
          className="icon-button"
          disabled={pending || index === total - 1}
          onClick={() => void move(1)}
          type="button"
          aria-label="아래로"
        >
          <ArrowDown size={16} />
        </button>
        <button className="icon-button" disabled={pending} onClick={() => void handleSave()} type="button" aria-label="저장">
          <Save size={16} />
        </button>
      </div>
      <p className="reset-hint">
        비밀번호 강제 변경은 Admin SDK가 있는 서버를 연결하면 다시 활성화할 수 있습니다.
      </p>
      {message && <p className="row-message">{message}</p>}
    </article>
  );
}
