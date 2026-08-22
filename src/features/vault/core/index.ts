export {
  VAULT_AUDIO_DEFAULT_MAX_DURATION_MS,
  VAULT_AUDIO_MAX_BYTES,
  chooseVaultAudioRecorderMimeType,
  vaultAudioCaptureFromBlob,
  vaultAudioRecordingCapability,
  vaultAudioSuggestedName,
  type VaultAudioCapture,
  type VaultAudioCaptureHandler,
  type VaultAudioRecordingCapability
} from "./audioRecorder";
export { VaultAudioRecorder, type VaultAudioRecorderProps } from "./VaultAudioRecorder";
export {
  MAX_FOOTNOTES_VIEW_ITEMS,
  MAX_FOOTNOTE_PREVIEW_CHARACTERS,
  MAX_FOOTNOTES_SOURCE_CHARACTERS,
  buildVaultFootnoteView,
  type VaultFootnoteViewItem,
  type VaultFootnoteViewModel
} from "./footnotes";
export { VaultFootnotesView, type VaultFootnotesViewProps } from "./VaultFootnotesView";
export {
  assertFormatConversionSourceUnchanged,
  markdownCopyTitle,
  planLegacyVaultFormatConversion,
  type LegacyVaultEntryForConversion,
  type VaultFormatConversionPlan,
  type VaultMarkdownCopyDraft
} from "./formatConverter";
export { VaultFormatConverter, type VaultFormatConverterProps } from "./VaultFormatConverter";
export {
  MAX_NOTE_COMPOSER_BODY_CHARACTERS,
  executeNoteMerge,
  executeNoteSplit,
  planNoteMerge,
  planNoteSplit,
  type ComposerEntrySnapshot,
  type ComposerRevisionGuard,
  type NoteComposerAdapter,
  type NoteMergeExecutionResult,
  type NoteMergePlan,
  type NoteSplitExecutionResult,
  type NoteSplitPlan
} from "./noteComposer";
export { VaultNoteComposer, type VaultNoteComposerProps } from "./VaultNoteComposer";
export {
  MAX_SLIDES_PER_DECK,
  MAX_SLIDES_SOURCE_CHARACTERS,
  createMarkdownSlidesDeck,
  type MarkdownSlide,
  type MarkdownSlidesDeck
} from "./slides";
export { VaultSlides, type VaultSlidesProps } from "./VaultSlides";
export { MAX_WEB_VIEWER_URL_CHARACTERS, safeWebViewerUrl } from "./webViewer";
export { VaultWebViewer, type VaultWebViewerProps } from "./VaultWebViewer";
