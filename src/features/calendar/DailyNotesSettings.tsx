export interface DailyNotesSettingsProps {
  folderId: string | null;
  folderOptions: readonly { id: string; path: string }[];
  onFolderChange: (folderId: string | null) => void;
  onTemplatesFolderChange: (folderPath: string | null) => void;
  onTemplatesIncludeDescendantsChange: (include: boolean) => void;
  onTemplateChange: (entryId: string | null) => void;
  templateEntryId: string | null;
  templateOptions: readonly { id: string; path: string }[];
  templatesFolderPath: string | null;
  templatesIncludeDescendants: boolean;
}

export function DailyNotesSettings({
  folderId,
  folderOptions,
  onFolderChange,
  onTemplatesFolderChange,
  onTemplatesIncludeDescendantsChange,
  onTemplateChange,
  templateEntryId,
  templateOptions,
  templatesFolderPath,
  templatesIncludeDescendants
}: DailyNotesSettingsProps) {
  const folderMissing = folderId !== null && !folderOptions.some((option) => option.id === folderId);
  const templateMissing = templateEntryId !== null && !templateOptions.some((option) => option.id === templateEntryId);
  return (
    <details className="vault-daily-settings">
      <summary>Daily Notes 설정</summary>
      <label>
        <span>새 노트 폴더</span>
        <select onChange={(event) => onFolderChange(event.currentTarget.value || null)} value={folderMissing ? "" : folderId ?? ""}>
          <option value="">Vault 루트</option>
          {folderOptions.map((option) => <option key={option.id} value={option.id}>{option.path}</option>)}
        </select>
      </label>
      {folderMissing ? <small role="status">저장된 폴더를 찾을 수 없어 Vault 루트를 사용합니다.</small> : null}
      <label>
        <span>Daily Note 템플릿</span>
        <select onChange={(event) => onTemplateChange(event.currentTarget.value || null)} value={templateMissing ? "" : templateEntryId ?? ""}>
          <option value="">가이드형 기본 템플릿</option>
          {templateOptions.map((option) => <option key={option.id} value={option.id}>{option.path}</option>)}
        </select>
      </label>
      {templateMissing ? <small role="status">저장된 템플릿을 찾을 수 없어 기본 템플릿을 사용합니다.</small> : null}
      <label>
        <span>Templates 폴더</span>
        <select
          onChange={(event) => onTemplatesFolderChange(event.currentTarget.value || null)}
          value={templatesFolderPath ?? ""}
        >
          <option value="">Templates/템플릿 자동 감지</option>
          {folderOptions.map((option) => <option key={option.id} value={option.path}>{option.path}</option>)}
        </select>
      </label>
      <label className="vault-daily-settings-check">
        <input
          checked={templatesIncludeDescendants}
          disabled={templatesFolderPath === null}
          onChange={(event) => onTemplatesIncludeDescendantsChange(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>하위 폴더 템플릿 포함</span>
      </label>
      <p>일정 달력과 분리된 날짜별 Markdown 노트입니다. 설정은 암호화된 워크스페이스에 저장됩니다.</p>
    </details>
  );
}

export default DailyNotesSettings;
