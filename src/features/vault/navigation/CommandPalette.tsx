import { useCallback } from "react";
import type { NavigationActivationMetadata, CommandPaletteItem } from "./types";
import { VaultNavigationDialog } from "./VaultNavigationDialog";

export interface CommandPaletteProps {
  commands: readonly CommandPaletteItem[];
  initialQuery?: string;
  onExecute: (command: CommandPaletteItem, metadata: NavigationActivationMetadata) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

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
      items={commands}
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
