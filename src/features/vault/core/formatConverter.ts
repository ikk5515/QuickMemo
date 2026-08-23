import {
  previewLegacyHtmlToMarkdown,
  type LegacyHtmlConversionPreview
} from "../../markdown";

export interface VaultMarkdownCopyDraft {
  body: string;
  folderId: string | null;
  sourceEntryId: string;
  sourceRevision: number;
  title: string;
}
export interface LegacyVaultEntryForConversion {
  body: string;
  contentFormat: "legacy-html-v1";
  folderId: string | null;
  id: string;
  revision: number;
  title: string;
}

export interface VaultFormatConversionPlan {
  copy: VaultMarkdownCopyDraft;
  preview: LegacyHtmlConversionPreview;
  source: LegacyVaultEntryForConversion;
}

export function markdownCopyTitle(sourceTitle: string) {
  const trimmed = sourceTitle.trim().normalize("NFC").replace(/\.md$/iu, "");
  const suffix = " Markdown";
  return `${trimmed.slice(0, Math.max(1, 180 - suffix.length))}${suffix}`;
}

/**
 * Produces a copy-only plan. The legacy source is retained verbatim and there
 * is intentionally no overwrite callback in this contract.
 */
export function planLegacyVaultFormatConversion(
  source: LegacyVaultEntryForConversion
): VaultFormatConversionPlan {
  if (!source.id || !Number.isSafeInteger(source.revision) || source.revision < 0) {
    throw new Error("변환할 원본 revision을 확인할 수 없습니다.");
  }
  const preview = previewLegacyHtmlToMarkdown(source.body);
  if (!preview.sourcePreserved) {
    throw new Error("원본을 보존할 수 없는 변환은 실행하지 않습니다.");
  }
  return {
    copy: {
      body: preview.markdown,
      folderId: source.folderId,
      sourceEntryId: source.id,
      sourceRevision: source.revision,
      title: markdownCopyTitle(source.title)
    },
    preview,
    source: { ...source }
  };
}

export function assertFormatConversionSourceUnchanged(
  plan: VaultFormatConversionPlan,
  latest: LegacyVaultEntryForConversion | null
) {
  if (
    !latest
    || latest.id !== plan.source.id
    || latest.revision !== plan.source.revision
    || latest.contentFormat !== "legacy-html-v1"
    || latest.body !== plan.source.body
    || latest.title !== plan.source.title
    || latest.folderId !== plan.source.folderId
  ) {
    throw new Error("원본 노트가 미리보기 후 변경되었습니다. 최신 원본으로 다시 미리보기해주세요.");
  }
}
