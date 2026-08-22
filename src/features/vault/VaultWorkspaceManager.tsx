import {
  BookmarkPlus,
  FileText,
  Network,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  X
} from "lucide-react";
import { useMemo, useState } from "react";
import type { PersistedNamedWorkspace, PersistedVaultBookmark } from "./workspaceState";
import "./vaultWorkspaceManager.css";

export interface VaultBookmarkEntryOption {
  id: string;
  path: string;
  title: string;
}

export interface VaultWorkspaceManagerProps {
  activeEntryId: string | null;
  bookmarks: readonly PersistedVaultBookmark[];
  canBookmarkGraph: boolean;
  canBookmarkSearch: boolean;
  entries: readonly VaultBookmarkEntryOption[];
  namedWorkspaces: readonly PersistedNamedWorkspace[];
  onAddBookmark: (kind: PersistedVaultBookmark["kind"], label: string) => void;
  onCaptureWorkspace: (label: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onOpenBookmark: (bookmark: PersistedVaultBookmark) => void;
  onRemoveBookmark: (bookmark: PersistedVaultBookmark) => void;
  onRenameWorkspace: (workspaceId: string, label: string) => void;
  onRestoreWorkspace: (workspaceId: string) => void;
}

function BookmarkKindIcon({ kind }: { kind: PersistedVaultBookmark["kind"] }) {
  if (kind === "entry") return <FileText aria-hidden="true" size={14} />;
  if (kind === "graph") return <Network aria-hidden="true" size={14} />;
  return <Search aria-hidden="true" size={14} />;
}

export function VaultWorkspaceManager({
  activeEntryId,
  bookmarks,
  canBookmarkGraph,
  canBookmarkSearch,
  entries,
  namedWorkspaces,
  onAddBookmark,
  onCaptureWorkspace,
  onDeleteWorkspace,
  onOpenBookmark,
  onRemoveBookmark,
  onRenameWorkspace,
  onRestoreWorkspace
}: VaultWorkspaceManagerProps) {
  const [bookmarkLabel, setBookmarkLabel] = useState("");
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const normalizedBookmarkLabel = bookmarkLabel.trim();

  function addBookmark(kind: PersistedVaultBookmark["kind"]) {
    if (!normalizedBookmarkLabel) return;
    onAddBookmark(kind, normalizedBookmarkLabel);
    setBookmarkLabel("");
  }

  function beginRename(workspace: PersistedNamedWorkspace) {
    setRenamingWorkspaceId(workspace.id);
    setRenameLabel(workspace.label);
  }

  return (
    <div className="vault-workspace-manager">
      <section aria-labelledby="vault-bookmarks-heading">
        <h2 id="vault-bookmarks-heading">북마크</h2>
        <label className="vault-workspace-manager-label">
          <span>새 북마크 이름</span>
          <input
            maxLength={120}
            onChange={(event) => setBookmarkLabel(event.currentTarget.value)}
            placeholder="예: 이번 주 프로젝트"
            value={bookmarkLabel}
          />
        </label>
        <div aria-label="현재 보기 북마크 추가" className="vault-workspace-manager-add-actions" role="group">
          <button disabled={!normalizedBookmarkLabel || !activeEntryId} onClick={() => addBookmark("entry")} type="button">
            <FileText aria-hidden="true" size={14} /> 노트
          </button>
          <button disabled={!normalizedBookmarkLabel || !canBookmarkSearch} onClick={() => addBookmark("search")} type="button">
            <Search aria-hidden="true" size={14} /> 검색
          </button>
          <button disabled={!normalizedBookmarkLabel || !canBookmarkGraph} onClick={() => addBookmark("graph")} type="button">
            <Network aria-hidden="true" size={14} /> 그래프
          </button>
        </div>
        {bookmarks.length ? (
          <ul className="vault-workspace-manager-list">
            {bookmarks.map((bookmark) => {
              const accessibleEntry = bookmark.kind === "entry" ? entryById.get(bookmark.entryId) : undefined;
              const unavailable = bookmark.kind === "entry" && !accessibleEntry;
              // Never render persisted label/path for an ACL-revoked entry.
              const visibleLabel = unavailable ? "사용할 수 없는 항목" : bookmark.label;
              const visibleDetail = unavailable
                ? "권한이 없거나 삭제된 항목"
                : bookmark.kind === "entry"
                  ? accessibleEntry?.path
                  : bookmark.kind === "search"
                    ? bookmark.query
                    : "저장된 전체 그래프 설정";
              return (
                <li data-unavailable={unavailable || undefined} key={`${bookmark.kind}:${bookmark.id}`}>
                  <button
                    aria-disabled={unavailable || undefined}
                    aria-label={`${visibleLabel} 북마크 열기`}
                    className="vault-workspace-manager-primary"
                    disabled={unavailable}
                    onClick={() => onOpenBookmark(bookmark)}
                    type="button"
                  >
                    <BookmarkKindIcon kind={bookmark.kind} />
                    <span><strong>{visibleLabel}</strong><small>{visibleDetail}</small></span>
                  </button>
                  <button aria-label={`${visibleLabel} 북마크 삭제`} onClick={() => onRemoveBookmark(bookmark)} type="button">
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : <p className="vault-workspace-manager-empty">저장한 북마크가 없습니다.</p>}
      </section>

      <section aria-labelledby="vault-named-workspaces-heading">
        <h2 id="vault-named-workspaces-heading">워크스페이스</h2>
        <form onSubmit={(event) => {
          event.preventDefault();
          const label = workspaceLabel.trim();
          if (!label) return;
          onCaptureWorkspace(label);
          setWorkspaceLabel("");
        }}>
          <label className="vault-workspace-manager-label">
            <span>현재 배치 이름</span>
            <input
              maxLength={120}
              onChange={(event) => setWorkspaceLabel(event.currentTarget.value)}
              placeholder="예: 집필 작업"
              value={workspaceLabel}
            />
          </label>
          <button disabled={!workspaceLabel.trim()} type="submit"><BookmarkPlus aria-hidden="true" size={14} /> 현재 배치 저장</button>
        </form>
        {namedWorkspaces.length ? (
          <ul className="vault-workspace-manager-list">
            {namedWorkspaces.map((workspace) => (
              <li key={workspace.id}>
                {renamingWorkspaceId === workspace.id ? (
                  <form className="vault-workspace-manager-rename" onSubmit={(event) => {
                    event.preventDefault();
                    const label = renameLabel.trim();
                    if (!label) return;
                    onRenameWorkspace(workspace.id, label);
                    setRenamingWorkspaceId(null);
                  }}>
                    <label>
                      <span className="sr-only">워크스페이스 새 이름</span>
                      <input
                        aria-label="워크스페이스 새 이름"
                        autoFocus
                        maxLength={120}
                        onChange={(event) => setRenameLabel(event.currentTarget.value)}
                        value={renameLabel}
                      />
                    </label>
                    <button type="submit">저장</button>
                    <button aria-label="워크스페이스 이름 변경 취소" onClick={() => setRenamingWorkspaceId(null)} type="button"><X aria-hidden="true" size={14} /></button>
                  </form>
                ) : (
                  <>
                    <button aria-label={`${workspace.label} 워크스페이스 복원`} className="vault-workspace-manager-primary" onClick={() => onRestoreWorkspace(workspace.id)} type="button">
                      <RotateCcw aria-hidden="true" size={14} /><span><strong>{workspace.label}</strong><small>저장된 탭·패널 배치 복원</small></span>
                    </button>
                    <button aria-label={`${workspace.label} 워크스페이스 이름 변경`} onClick={() => beginRename(workspace)} type="button"><Pencil aria-hidden="true" size={14} /></button>
                    <button aria-label={`${workspace.label} 워크스페이스 삭제`} onClick={() => onDeleteWorkspace(workspace.id)} type="button"><Trash2 aria-hidden="true" size={14} /></button>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="vault-workspace-manager-empty">저장한 워크스페이스가 없습니다.</p>}
        <p className="vault-workspace-manager-note">탭·패널·그래프·달력·북마크와 분할 방향·비율을 암호화해 저장합니다.</p>
      </section>
    </div>
  );
}
