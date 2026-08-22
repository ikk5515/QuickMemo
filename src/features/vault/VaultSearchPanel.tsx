import { BookmarkPlus, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { PersistedSearchBookmark } from "./workspaceState";
import type { DecryptedVaultNote } from "./vaultData";

const SEARCH_RESULT_LIMIT = 500;
const CONTEXT_MAX_CHARACTERS = 220;

export interface VaultSearchPanelProps {
  bookmarks: readonly PersistedSearchBookmark[];
  notes: readonly DecryptedVaultNote[];
  onAddBookmark: (label: string) => void;
  onOpen: (entryId: string) => void;
  onQueryChange: (query: string) => void;
  onRemoveBookmark: (bookmarkId: string) => void;
  pathsByEntryId: ReadonlyMap<string, string>;
  query: string;
}

function queryContextTerms(query: string) {
  const phrases = [...query.matchAll(/"([^"\n]{2,120})"/gu)].map((match) => match[1]);
  const words = query
    .replace(/"[^"\n]*"/gu, " ")
    .split(/\s+/u)
    .map((word) => word.replace(/^[!()-]+|[()]+$/gu, ""))
    .filter((word) => (
      word.length >= 2
      && word.length <= 120
      && !word.includes(":")
      && !word.startsWith("/")
      && !["AND", "OR", "NOT"].includes(word.toLocaleUpperCase("en-US"))
    ));
  return [...new Set([...phrases, ...words].map((term) => term.normalize("NFC").toLocaleLowerCase()))].slice(0, 8);
}

function boundedContext(line: string, matchIndex = -1) {
  const compact = line.replace(/\s+/gu, " ").trim();
  if (compact.length <= CONTEXT_MAX_CHARACTERS) return compact;
  const start = matchIndex < 0
    ? 0
    : Math.max(0, Math.min(compact.length - CONTEXT_MAX_CHARACTERS, matchIndex - 60));
  const end = Math.min(compact.length, start + CONTEXT_MAX_CHARACTERS);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

export function vaultSearchResultContext(note: DecryptedVaultNote, query: string) {
  if (note.contentFormat !== "markdown-v1") {
    return "기존 형식 항목 — Markdown 복사본으로 변환하면 안전한 문맥 미리보기를 표시합니다.";
  }
  const terms = queryContextTerms(query);
  const lines = note.body.replace(/\r\n?/gu, "\n").split("\n");
  for (const line of lines) {
    const normalized = line.normalize("NFC").toLocaleLowerCase();
    const matchIndex = terms.reduce((found, term) => found >= 0 ? found : normalized.indexOf(term), -1);
    if (matchIndex >= 0) return boundedContext(line, matchIndex);
  }
  const fallback = lines.find((line) => line.trim() && line.trim() !== "---") ?? "본문 미리보기가 없습니다.";
  return boundedContext(fallback);
}

export function VaultSearchPanel({
  bookmarks,
  notes,
  onAddBookmark,
  onOpen,
  onQueryChange,
  onRemoveBookmark,
  pathsByEntryId,
  query
}: VaultSearchPanelProps) {
  const [addingBookmark, setAddingBookmark] = useState(false);
  const [bookmarkLabel, setBookmarkLabel] = useState("");
  const visibleNotes = useMemo(() => notes.slice(0, SEARCH_RESULT_LIMIT), [notes]);
  const truncated = notes.length > visibleNotes.length;

  function beginBookmark() {
    if (!query.trim()) return;
    setBookmarkLabel(query.trim().slice(0, 120));
    setAddingBookmark(true);
  }

  return (
    <div className="vault-search-panel">
      <label className="vault-search-input">
        <Search aria-hidden="true" size={14} />
        <span className="sr-only">Vault 검색식</span>
        <input
          autoFocus
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="경로, 내용, tag:…"
          type="search"
          value={query}
        />
      </label>
      <div className="vault-search-actions">
        <button disabled={!query.trim()} onClick={beginBookmark} type="button">
          <BookmarkPlus aria-hidden="true" size={14} /> 현재 검색 저장
        </button>
      </div>
      {addingBookmark ? (
        <form className="vault-search-bookmark-form" onSubmit={(event) => {
          event.preventDefault();
          const label = bookmarkLabel.trim();
          if (!label) return;
          onAddBookmark(label);
          setAddingBookmark(false);
        }}>
          <label>
            <span className="sr-only">검색 북마크 이름</span>
            <input
              aria-label="검색 북마크 이름"
              autoFocus
              maxLength={120}
              onChange={(event) => setBookmarkLabel(event.currentTarget.value)}
              value={bookmarkLabel}
            />
          </label>
          <button type="submit">저장</button>
          <button aria-label="검색 북마크 저장 취소" onClick={() => setAddingBookmark(false)} type="button"><X size={14} /></button>
        </form>
      ) : null}
      {bookmarks.length ? (
        <section aria-label="저장한 검색" className="vault-search-bookmarks">
          <strong>저장한 검색</strong>
          <ul>
            {bookmarks.map((bookmark) => (
              <li key={bookmark.id}>
                <button
                  aria-pressed={query === bookmark.query}
                  onClick={() => onQueryChange(bookmark.query)}
                  title={bookmark.query}
                  type="button"
                >{bookmark.label}</button>
                <button aria-label={`${bookmark.label} 검색 북마크 삭제`} onClick={() => onRemoveBookmark(bookmark.id)} type="button"><Trash2 size={13} /></button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p aria-live="polite" className="vault-search-count" role="status">
        {query.trim() ? `${notes.length.toLocaleString()}개 결과${truncated ? " · 상위 500개 표시" : ""}` : "검색식을 입력하세요."}
      </p>
      {visibleNotes.length ? (
        <ol aria-label="Vault 검색 결과" className="vault-search-results">
          {visibleNotes.map((note) => (
            <li key={note.id}>
              <button onClick={() => onOpen(note.id)} type="button">
                <strong>{note.title}</strong>
                <small>{pathsByEntryId.get(note.id) ?? note.title}</small>
                <span>{vaultSearchResultContext(note, query)}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : query.trim() ? <p className="vault-panel-empty">일치하는 항목이 없습니다.</p> : null}
    </div>
  );
}
