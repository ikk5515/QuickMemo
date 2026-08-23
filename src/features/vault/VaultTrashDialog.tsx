import { Folder, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "./vaultData";

export interface VaultTrashFolderItem {
  entryCount: number;
  folder: DecryptedVaultFolder;
  folderCount: number;
}

export interface VaultTrashDialogProps {
  busyEntryIds: ReadonlySet<string>;
  busyFolderIds: ReadonlySet<string>;
  folders: readonly VaultTrashFolderItem[];
  loading: boolean;
  notes: readonly DecryptedVaultNote[];
  onClose: () => void;
  onRestore: (entryId: string) => void;
  onRestoreFolder: (folderId: string) => void;
  returnFocusTo?: HTMLElement | null;
  serverReady: boolean;
}

function updatedMillis(item: { updatedAt?: { toMillis: () => number } }) {
  return item.updatedAt && typeof item.updatedAt.toMillis === "function"
    ? item.updatedAt.toMillis()
    : 0;
}

export function VaultTrashDialog({
  busyEntryIds,
  busyFolderIds,
  folders,
  loading,
  notes,
  onClose,
  onRestore,
  onRestoreFolder,
  returnFocusTo,
  serverReady
}: VaultTrashDialogProps) {
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const normalizedQuery = query.trim().normalize("NFC").toLocaleLowerCase();
  const visibleNotes = useMemo(() => notes
    .filter((note) => !normalizedQuery || note.title.normalize("NFC").toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => updatedMillis(right) - updatedMillis(left)), [normalizedQuery, notes]);
  const visibleFolders = useMemo(() => folders
    .filter(({ folder }) => !normalizedQuery
      || folder.displayName.normalize("NFC").toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => updatedMillis(right.folder) - updatedMillis(left.folder)), [folders, normalizedQuery]);

  useEffect(() => {
    searchRef.current?.focus();
    return () => {
      window.requestAnimationFrame(() => {
        if (returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
      });
    };
  }, [returnFocusTo]);

  return (
    <div
      className="vault-trash-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <section
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="vault-trash-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
          ) ?? []);
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        role="dialog"
      >
        <header>
          <div>
            <Trash2 aria-hidden="true" size={18} />
            <h2 id={titleId}>Vault 휴지통</h2>
          </div>
          <button aria-label="Vault 휴지통 닫기" onClick={onClose} type="button"><X size={17} /></button>
        </header>
        <p className="vault-trash-description">
          삭제 노트는 최대 500개까지 표시합니다. 폴더는 하나의 암호화 tombstone으로 하위 트리 전체를 보존하며, 같은 위치에 같은 이름이 있으면 복원하지 않습니다.
        </p>
        <label className="vault-trash-search">
          <span className="sr-only">삭제된 항목 검색</span>
          <input
            ref={searchRef}
            autoComplete="off"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="삭제된 항목 검색"
            type="search"
            value={query}
          />
        </label>
        {!serverReady ? (
          <p aria-live="polite" className="vault-trash-status" role="status">
            {loading ? "서버의 암호화 휴지통을 확인하는 중…" : "서버 확인을 완료하지 못해 복원을 잠갔습니다."}
          </p>
        ) : visibleFolders.length || visibleNotes.length ? (
          <ul aria-label="삭제된 Vault 항목" className="vault-trash-list">
            {visibleFolders.map(({ entryCount, folder, folderCount }) => {
              const busy = busyFolderIds.has(folder.id);
              return (
                <li key={`folder:${folder.id}`}>
                  <div>
                    <strong><Folder aria-hidden="true" size={15} /> {folder.displayName}</strong>
                    <small>폴더 · 하위 폴더 {folderCount}개 · 항목 {entryCount}개 · revision {folder.revision ?? 0}</small>
                  </div>
                  <button
                    aria-label={`${folder.displayName} 폴더 복원`}
                    disabled={busy || !serverReady}
                    onClick={() => onRestoreFolder(folder.id)}
                    type="button"
                  >
                    <RotateCcw size={15} /> {busy ? "복원 중…" : "복원"}
                  </button>
                </li>
              );
            })}
            {visibleNotes.map((note) => {
              const busy = busyEntryIds.has(note.id);
              return (
                <li key={note.id}>
                  <div>
                    <strong>{note.title}</strong>
                    <small>{note.entryKind} · revision {note.revision ?? 0}</small>
                  </div>
                  <button
                    aria-label={`${note.title} 복원`}
                    disabled={busy || !serverReady}
                    onClick={() => onRestore(note.id)}
                    type="button"
                  >
                    <RotateCcw size={15} /> {busy ? "복원 중…" : "복원"}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="vault-trash-empty">{normalizedQuery ? "검색 결과가 없습니다." : "휴지통이 비어 있습니다."}</p>
        )}
      </section>
    </div>
  );
}
