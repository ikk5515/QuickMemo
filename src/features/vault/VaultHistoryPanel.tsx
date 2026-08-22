import { History, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { decryptText, unwrapNoteKey } from "../../lib/crypto";
import { mapWithConcurrency } from "../../lib/mapWithConcurrency";
import {
  subscribeNoteHistory,
  type NoteHistorySnapshot
} from "../../services/notes";
import type { VaultContentFormat, VaultEntryKind, WrappedNoteKey } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import { assertVaultPayloadFitsPersistence } from "./vaultPayloadLimits";
import "./vaultHistory.css";

const MAX_RENDERED_HISTORY = 80;
const MAX_HISTORY_PREVIEW_CHARACTERS = 4_000;

export interface VaultHistoryDraft {
  body: string;
  contentFormat: VaultContentFormat;
  entryKind: VaultEntryKind;
  folderId: string | null;
  title: string;
}

interface DecryptedHistoryEntry {
  entry: NoteHistorySnapshot;
  snapshot: VaultHistoryDraft | null;
  summary: string;
}

interface DecryptedHistoryState {
  entries: DecryptedHistoryEntry[];
  scope: {
    contentFormat: VaultContentFormat;
    entryId: string;
    entryKind: VaultEntryKind;
    ownerUid: string;
    privateKey: CryptoKey;
    uid: string;
    wrappedKey: WrappedNoteKey;
  };
}

export interface VaultHistoryPanelProps {
  note: DecryptedVaultNote;
  onRestore: (snapshot: VaultHistoryDraft) => Promise<void> | void;
  privateKey: CryptoKey;
  readOnly?: boolean;
  uid: string;
}

function timestampMillis(value: NoteHistorySnapshot["createdAt"]) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : 0;
}

function historyDate(value: NoteHistorySnapshot["createdAt"]) {
  const millis = timestampMillis(value);
  return millis
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(new Date(millis))
    : "시간 확인 불가";
}

export function parseVaultHistorySnapshot(value: string, note: DecryptedVaultNote): VaultHistoryDraft | null {
  try {
    const parsed = JSON.parse(value) as Partial<VaultHistoryDraft>;
    if (
      typeof parsed.title !== "string"
      || typeof parsed.body !== "string"
      || (parsed.folderId !== null && typeof parsed.folderId !== "string")
      || parsed.contentFormat !== note.contentFormat
      || parsed.entryKind !== note.entryKind
    ) {
      return null;
    }
    const snapshot: VaultHistoryDraft = {
      body: parsed.body,
      contentFormat: parsed.contentFormat,
      entryKind: parsed.entryKind,
      folderId: parsed.folderId,
      title: parsed.title
    };
    assertVaultPayloadFitsPersistence(snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

export function VaultHistoryPanel({ note, onRestore, privateKey, readOnly = false, uid }: VaultHistoryPanelProps) {
  const [history, setHistory] = useState<NoteHistorySnapshot[]>([]);
  const [decryptedState, setDecryptedState] = useState<DecryptedHistoryState | null>(null);
  const [error, setError] = useState("");
  const [restoringId, setRestoringId] = useState("");
  const plaintextGenerationRef = useRef(0);
  const subscriptionGenerationRef = useRef(0);
  const wrappedKey = note.wrappedKeys[uid];
  const decrypted = decryptedState
    && decryptedState.scope.entryId === note.id
    && decryptedState.scope.ownerUid === note.ownerUid
    && decryptedState.scope.uid === uid
    && decryptedState.scope.privateKey === privateKey
    && decryptedState.scope.wrappedKey === wrappedKey
    && decryptedState.scope.contentFormat === note.contentFormat
    && decryptedState.scope.entryKind === note.entryKind
    ? decryptedState.entries
    : [];

  useEffect(() => {
    let active = true;
    const subscriptionGeneration = subscriptionGenerationRef.current + 1;
    subscriptionGenerationRef.current = subscriptionGeneration;
    plaintextGenerationRef.current += 1;
    setHistory([]);
    setDecryptedState(null);
    setError("");
    setRestoringId("");
    const unsubscribe = subscribeNoteHistory(
      note.id,
      uid,
      note.ownerUid === uid,
      (entries) => {
        if (!active || subscriptionGenerationRef.current !== subscriptionGeneration) return;
        plaintextGenerationRef.current += 1;
        setDecryptedState(null);
        setHistory(entries.slice(0, MAX_RENDERED_HISTORY));
        setError("");
      },
      () => {
        if (!active || subscriptionGenerationRef.current !== subscriptionGeneration) return;
        // An authorization/listener failure is a plaintext boundary. Invalidate
        // in-flight decryption before clearing both encrypted rows and rendered
        // summaries/previews, while retaining an actionable error message.
        plaintextGenerationRef.current += 1;
        setHistory([]);
        setDecryptedState(null);
        setRestoringId("");
        setError("수정 이력을 불러오지 못했습니다. 접근 권한과 연결 상태를 확인한 뒤 다시 열어주세요.");
      }
    );
    return () => {
      active = false;
      if (subscriptionGenerationRef.current === subscriptionGeneration) {
        subscriptionGenerationRef.current += 1;
      }
      unsubscribe();
    };
  }, [note.id, note.ownerUid, uid]);

  useEffect(() => {
    let active = true;
    const generation = plaintextGenerationRef.current + 1;
    plaintextGenerationRef.current = generation;
    setDecryptedState(null);
    if (!wrappedKey || !history.length) {
      return () => {
        active = false;
        if (plaintextGenerationRef.current === generation) plaintextGenerationRef.current += 1;
      };
    }
    const scope: DecryptedHistoryState["scope"] = {
      contentFormat: note.contentFormat,
      entryId: note.id,
      entryKind: note.entryKind,
      ownerUid: note.ownerUid,
      privateKey,
      uid,
      wrappedKey
    };
    void unwrapNoteKey(wrappedKey, privateKey)
      .then((noteKey) => mapWithConcurrency(history, 4, async (entry): Promise<DecryptedHistoryEntry> => {
        const [summary, snapshotText] = await Promise.all([
          entry.encryptedSummary
            ? decryptText(entry.encryptedSummary, noteKey).catch(() => "내용 요약을 열 수 없습니다.")
            : Promise.resolve(entry.changedFields.join(", ") || "저장됨"),
          entry.encryptedSnapshot
            ? decryptText(entry.encryptedSnapshot, noteKey).catch(() => "")
            : Promise.resolve("")
        ]);
        return {
          entry,
          snapshot: snapshotText ? parseVaultHistorySnapshot(snapshotText, note) : null,
          summary
        };
      }))
      .then((entries) => {
        if (active && plaintextGenerationRef.current === generation) {
          setDecryptedState({ entries, scope });
          setError("");
        }
      })
      .catch(() => {
        if (active && plaintextGenerationRef.current === generation) {
          setDecryptedState(null);
          setError("암호화 수정 이력을 열 수 없습니다.");
        }
      });
    return () => {
      active = false;
      if (plaintextGenerationRef.current === generation) plaintextGenerationRef.current += 1;
    };
  }, [history, note, privateKey, uid, wrappedKey]);

  return (
    <section aria-label="File Recovery" className="vault-history-panel">
      <header><History aria-hidden="true" size={16} /><strong>File Recovery</strong></header>
      <p>
        동기화 데이터와 같은 저장 계층에 있는 암호화 revision이며 독립 백업은 아닙니다.
        복원하면 현재 위치에 새 revision으로 기록됩니다.
      </p>
      {error ? <div role="alert">{error}</div> : null}
      {!error && !history.length ? <p role="status">아직 저장된 수정 이력이 없습니다.</p> : null}
      {!error && history.length && !decrypted.length ? <p role="status">수정 이력을 복호화하는 중입니다…</p> : null}
      <div className="vault-history-list">
        {decrypted.map(({ entry, snapshot, summary }) => (
          <article key={entry.id}>
            <div>
              <strong>{summary.slice(0, 240)}</strong>
              <span>revision {entry.revision} · {historyDate(entry.createdAt)}</span>
            </div>
            {snapshot ? (
              <details>
                <summary>{snapshot.title} 미리보기</summary>
                <pre>{snapshot.body.slice(0, MAX_HISTORY_PREVIEW_CHARACTERS)}</pre>
                {snapshot.body.length > MAX_HISTORY_PREVIEW_CHARACTERS ? <small>미리보기는 4,000자까지만 표시합니다.</small> : null}
              </details>
            ) : <small>이 형식의 이력은 미리보기·복원을 지원하지 않습니다.</small>}
            <button
              disabled={readOnly || !snapshot || restoringId === entry.id}
              onClick={async () => {
                if (readOnly || !snapshot || !window.confirm("선택한 수정 이력을 새 revision으로 복원할까요?")) return;
                setRestoringId(entry.id);
                try {
                  await onRestore(snapshot);
                } finally {
                  setRestoringId("");
                }
              }}
              title={readOnly ? "휴지통 이동이 끝난 뒤 이력을 복원할 수 있습니다." : undefined}
              type="button"
            >
              <RotateCcw aria-hidden="true" size={14} />
              {restoringId === entry.id ? "복원 중…" : "이 버전으로 복원"}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
