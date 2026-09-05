import { useCallback } from "react";
import type { NavigationActivationMetadata, CommandPaletteItem } from "./types";
import { VaultNavigationDialog } from "./VaultNavigationDialog";

export interface CommandPaletteProps {
  commands: readonly CommandPaletteItem[];
  includeVaultCommands?: boolean;
  initialQuery?: string;
  onExecute: (command: CommandPaletteItem, metadata: NavigationActivationMetadata) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const VAULT_COMMANDS: readonly CommandPaletteItem[] = [
  { id: "new-note", label: "새 노트 만들기", section: "파일", shortcut: "Cmd/Ctrl+N", keywords: ["markdown"] },
  { id: "new-drawing", label: "새 드로잉 만들기", section: "파일", keywords: ["drawing", "sketch", "드로잉"] },
  { id: "daily-note", label: "오늘의 메모 열기", section: "노트", keywords: ["daily", "오늘"] },
  { id: "unique-note", label: "고유 노트 만들기", section: "노트", keywords: ["unique", "timestamp", "고유"] },
  { id: "random-note", label: "무작위 노트 열기", section: "노트", keywords: ["random"] },
  { id: "create-search-index", label: "현재 검색 결과 인덱스 만들기", section: "노트", keywords: ["index", "색인", "검색", "연결"] },
  { id: "insert-template", label: "현재 노트에 템플릿 삽입", section: "템플릿", keywords: ["template", "템플릿"] },
  { id: "new-from-template", label: "템플릿에서 새 노트 만들기", section: "템플릿", keywords: ["template", "템플릿"] },
  { id: "global-graph", label: "전체 그래프 열기", section: "보기", keywords: ["graph", "그래프"] },
  { id: "outline", label: "현재 노트 목차 열기", section: "보기", keywords: ["outline", "목차"] },
  { id: "search", label: "전체 검색 열기", section: "보기", keywords: ["search", "검색"] },
  { id: "bookmarks", label: "북마크와 워크스페이스 열기", section: "보기", keywords: ["bookmark", "workspace", "북마크", "워크스페이스"] },
  { id: "toggle-tab-pin", label: "현재 탭 고정 전환", section: "보기", keywords: ["pin", "tab", "고정", "탭"] },
  { id: "toggle-calendar", label: "날짜별 메모 달력 전환", section: "보기", keywords: ["calendar", "달력", "daily"] },
  { id: "toggle-left", label: "왼쪽 사이드바 전환", section: "보기" },
  { id: "toggle-right", label: "오른쪽 사이드바 전환", section: "보기" },
  { id: "audio-recorder", label: "음성 녹음", section: "추가 도구", keywords: ["audio", "record", "녹음"] },
  { id: "footnotes-view", label: "각주 모아 보기", section: "추가 도구", keywords: ["footnote", "각주"] },
  { id: "format-converter", label: "이전 메모 형식 변환", section: "추가 도구", keywords: ["html", "markdown", "변환"] },
  { id: "note-composer", label: "메모 나누기·합치기", section: "추가 도구", keywords: ["split", "merge", "분리", "합치기"] },
  { id: "slides", label: "현재 메모로 발표하기", section: "추가 도구", keywords: ["slide", "presentation", "발표"] },
  { id: "web-viewer", label: "웹페이지 보기", section: "추가 도구", keywords: ["web", "browser", "웹"] },
  { id: "import-obsidian", label: "Obsidian ZIP 가져오기", section: "가져오기·내보내기", keywords: ["zip", "import"] },
  { id: "export-obsidian", label: "Obsidian ZIP 내보내기", section: "가져오기·내보내기", keywords: ["zip", "export"] },
  { id: "open-library", label: "자료실 열기", section: "QuickMemo" },
  { id: "open-schedule", label: "일정 열기", section: "QuickMemo" },
  { id: "open-legacy", label: "기존 노트 관리 열기", section: "QuickMemo" }
];

function commandSearchText(command: CommandPaletteItem): string {
  return [
    command.label,
    command.description,
    command.section,
    ...(command.keywords ?? [])
  ].filter(Boolean).join(" ");
}

export function CommandPalette({
  commands,
  includeVaultCommands = false,
  initialQuery,
  onExecute,
  onOpenChange,
  open
}: CommandPaletteProps) {
  const renderCommand = useCallback((command: CommandPaletteItem) => (
    <>
      <span className="qm-vault-navigation-option__main">
        <span className="qm-vault-navigation-option__title">{command.label}</span>
        {command.description ? (
          <span className="qm-vault-navigation-option__description">{command.description}</span>
        ) : null}
      </span>
      <span className="qm-vault-navigation-option__meta">
        {command.section ? <span>{command.section}</span> : null}
        {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
      </span>
    </>
  ), []);

  return (
    <VaultNavigationDialog
      emptyLabel="일치하는 명령이 없습니다."
      getItemKey={(command) => command.id}
      getSearchText={commandSearchText}
      initialQuery={initialQuery}
      inputLabel="명령 검색"
      isItemDisabled={(command) => command.disabled ?? false}
      items={includeVaultCommands ? [...VAULT_COMMANDS, ...commands] : commands}
      listLabel="사용 가능한 명령"
      onActivate={onExecute}
      onOpenChange={onOpenChange}
      open={open}
      placeholder="명령 입력…"
      renderItem={renderCommand}
      title="명령 팔레트"
    />
  );
}
