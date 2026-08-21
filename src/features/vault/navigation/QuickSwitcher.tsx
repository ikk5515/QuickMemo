import { useCallback } from "react";
import type { NavigationActivationMetadata, QuickSwitcherItem } from "./types";
import { VaultNavigationDialog } from "./VaultNavigationDialog";

export interface QuickSwitcherProps {
  entries: readonly QuickSwitcherItem[];
  initialQuery?: string;
  onOpen: (entry: QuickSwitcherItem, metadata: NavigationActivationMetadata) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const KIND_LABELS: Record<NonNullable<QuickSwitcherItem["kind"]>, string> = {
  markdown: "MD",
  "legacy-html": "HTML",
  canvas: "Canvas",
  base: "Base",
  asset: "첨부",
  folder: "폴더"
};

function quickSwitcherSearchText(entry: QuickSwitcherItem): string {
  return [entry.title, entry.path, ...(entry.aliases ?? [])].filter(Boolean).join(" ");
}

export function QuickSwitcher({
  entries,
  initialQuery,
  onOpen,
  onOpenChange,
  open
}: QuickSwitcherProps) {
  const renderEntry = useCallback((entry: QuickSwitcherItem) => (
    <>
      <span className="qm-vault-navigation-kind" aria-hidden="true">
        {entry.kind ? KIND_LABELS[entry.kind] : "MD"}
      </span>
      <span className="qm-vault-navigation-option__main">
        <span className="qm-vault-navigation-option__title">{entry.title}</span>
        {entry.path && entry.path !== entry.title ? (
          <span className="qm-vault-navigation-option__description">{entry.path}</span>
        ) : null}
      </span>
      {entry.aliases && entry.aliases.length > 0 ? (
        <span className="qm-vault-navigation-option__aliases" aria-label="별칭">
          {entry.aliases.join(", ")}
        </span>
      ) : null}
    </>
  ), []);

  return (
    <VaultNavigationDialog
      emptyLabel="일치하는 노트나 파일이 없습니다."
      getItemKey={(entry) => entry.id}
      getSearchText={quickSwitcherSearchText}
      initialQuery={initialQuery}
      inputLabel="퀵 스위처 검색"
      items={entries}
      listLabel="열 수 있는 노트와 파일"
      onActivate={onOpen}
      onOpenChange={onOpenChange}
      open={open}
      placeholder="노트 또는 파일 찾기…"
      renderItem={renderEntry}
      title="퀵 스위처"
    />
  );
}
