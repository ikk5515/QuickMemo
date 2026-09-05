import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { Annotation, Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { openSearchPanel, searchKeymap } from "@codemirror/search";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection
} from "@codemirror/view";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import type { MarkdownEditorSessionStore } from "./markdownEditorSession";
import type { LivePreviewUpdates } from "./livePreviewUpdates";
import type {
  MarkdownLinkPreviewHandler,
  MarkdownLinkReference,
  MarkdownRendererProps,
  MarkdownTagClickHandler
} from "../markdown";
import { constructWithFrameDeferredResizeObserver } from "./frameDeferredResizeObserver";
import { afterCompositionDomSync } from "./afterCompositionDomSync";
import {
  inlineLivePreview,
  LIVE_PREVIEW_LINK_OPEN_EVENT,
  livePreviewReferenceFromElement
} from "./inlineLivePreview";
import {
  MAX_VAULT_CLIPBOARD_BATCH_SOURCE_BYTES,
  MAX_VAULT_CLIPBOARD_IMAGES,
  MAX_VAULT_CLIPBOARD_SOURCE_BYTES,
  VAULT_MARKDOWN_IMAGE_ACCEPT,
  vaultClipboardImageFiles,
  vaultSelectedImageFiles
} from "./clipboardImagePaste";
import { completeObsidianMarkdown, type ObsidianMarkdownCompletionData } from "./obsidianCompletion";

const externalValueSync = Annotation.define<boolean>();

export interface CodeMirrorLinkActivation {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type CodeMirrorLinkClickHandler = (
  reference: MarkdownLinkReference,
  activation: CodeMirrorLinkActivation
) => void;

export type MarkdownImagePasteHandler = (
  files: readonly File[],
  context: MarkdownImagePasteContext
) => Promise<MarkdownImagePasteResult | string | null> | MarkdownImagePasteResult | string | null;

export interface MarkdownImagePasteContext {
  signal: AbortSignal;
}

export interface MarkdownImagePasteResult {
  onCommit?: () => Promise<boolean | void> | boolean | void;
  onDiscard?: () => Promise<void> | void;
  onRollback?: (input: {
    replacementText: string;
    source: string;
  }) => Promise<boolean> | boolean;
  onSettled?: (
    outcome: "committed" | "discarded" | "rollback-blocked" | "rolled-back"
  ) => Promise<void> | void;
  source: string;
}

// React acknowledgements normally arrive in the next commit. Four snapshots
// cover batched renders without retaining a large Markdown document per keypress.
const maximumControlledValueHistory = 4;
const vaultMarkdownImageLimitLabel = [
  "PNG · JPG · WebP",
  `최대 ${MAX_VAULT_CLIPBOARD_IMAGES}개`,
  `파일당 ${MAX_VAULT_CLIPBOARD_SOURCE_BYTES / (1024 * 1024)}MB`,
  `합계 ${MAX_VAULT_CLIPBOARD_BATCH_SOURCE_BYTES / (1024 * 1024)}MB`
].join(" · ");

function appendBoundedValue(values: string[], value: string) {
  if (values.at(-1) === value) return null;
  values.push(value);
  return values.length > maximumControlledValueHistory ? values.shift() ?? null : null;
}

function imagePasteResult(
  value: MarkdownImagePasteResult | string | null
): MarkdownImagePasteResult | null {
  if (typeof value === "string") return { source: value };
  return value;
}

function discardImagePasteResult(result: MarkdownImagePasteResult | null | undefined) {
  if (!result) return;
  void (async () => {
    try {
      await result.onDiscard?.();
    } catch {
      // Cleanup failures are reported by the Vault flow itself.
    }
    try {
      await result.onSettled?.("discarded");
    } catch {
      // Settlement bookkeeping must not break the editor transaction.
    }
  })();
}

function settleImagePasteResult(
  result: MarkdownImagePasteResult,
  outcome: "committed" | "rollback-blocked" | "rolled-back"
) {
  try {
    void Promise.resolve(result.onSettled?.(outcome)).catch(() => undefined);
  } catch {
    // Settlement bookkeeping must not break the editor transaction.
  }
}

function livePreviewAnchorFromEvent(event: Event, view: EditorView) {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>("[data-live-preview-target]")
    : null;
  return target && view.dom.contains(target) ? target : null;
}

function eventMovedInsideAnchor(event: FocusEvent | MouseEvent, anchor: HTMLElement) {
  return event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget);
}

export interface CodeMirrorMarkdownEditorProps {
  ariaLabel?: string;
  autoFocus?: boolean;
  completionData?: ObsidianMarkdownCompletionData;
  documentKey?: string;
  insertRequest?: { cursorOffset?: number; id: number; text: string } | null;
  livePreview?: boolean;
  previewUpdates?: LivePreviewUpdates;
  onChange: (value: string) => void;
  onCompositionChange?: (composing: boolean) => void;
  sessionStore?: MarkdownEditorSessionStore;
  sessionScopeKey?: string;
  searchRequest?: { id: number } | null;
  onSearchHandled?: (id: number) => void;
  onInsertHandled?: (id: number) => void;
  onLinkClick?: CodeMirrorLinkClickHandler;
  onLinkPreviewInteraction?: MarkdownLinkPreviewHandler;
  onPasteImages?: MarkdownImagePasteHandler;
  onTagClick?: MarkdownTagClickHandler;
  onRevealHandled?: (id: number) => void;
  onSave?: () => void;
  onSelectionChange?: (selection: { end: number; start: number } | null) => void;
  readOnly?: boolean;
  renderCodeBlock?: MarkdownRendererProps["renderCodeBlock"];
  renderEmbed?: MarkdownRendererProps["renderEmbed"];
  revealRequest?: { id: number; line: number } | null;
  value: string;
  /** Monotonic persisted revision that makes a same-document remote value authoritative. */
  valueRevision?: number;
}

export function CodeMirrorMarkdownEditor({
  ariaLabel = "Markdown 편집기",
  autoFocus = false,
  completionData,
  documentKey,
  insertRequest,
  livePreview = false,
  previewUpdates,
  onChange,
  onCompositionChange,
  sessionStore,
  sessionScopeKey,
  searchRequest,
  onSearchHandled,
  onInsertHandled,
  onLinkClick,
  onLinkPreviewInteraction,
  onPasteImages,
  onTagClick,
  onRevealHandled,
  onSave,
  onSelectionChange,
  readOnly = false,
  renderCodeBlock,
  renderEmbed,
  revealRequest,
  value,
  valueRevision
}: CodeMirrorMarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const completionDataRef = useRef(completionData);
  const onChangeRef = useRef(onChange);
  const onCompositionChangeRef = useRef(onCompositionChange);
  const composingRef = useRef(false);
  const composedValueRef = useRef<string | null>(null);
  const saveAfterCompositionRef = useRef(false);
  const [compositionVersion, setCompositionVersion] = useState(0);
  const onInsertHandledRef = useRef(onInsertHandled);
  const onLinkClickRef = useRef(onLinkClick);
  const onLinkPreviewInteractionRef = useRef(onLinkPreviewInteraction);
  const onPasteImagesRef = useRef(onPasteImages);
  const onRevealHandledRef = useRef(onRevealHandled);
  const onSaveRef = useRef(onSave);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onTagClickRef = useRef(onTagClick);
  const renderCodeBlockRef = useRef(renderCodeBlock);
  const renderEmbedRef = useRef(renderEmbed);
  const acceptedControlledValueRef = useRef(value);
  const controlledValueRevisionRef = useRef(valueRevision);
  const ignoredControlledValuesRef = useRef<string[]>([]);
  const pendingLocalValuesRef = useRef<string[]>([]);
  const pendingImagePasteIdRef = useRef(0);
  const pendingImagePasteRangesRef = useRef(new Map<number, {
    controller: AbortController;
    collapsed: boolean;
    expectedText: string;
    from: number;
    to: number;
  }>());
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const imagePickerTargetViewRef = useRef<EditorView | null>(null);
  const queueSelectedImagesRef = useRef<(files: readonly File[]) => void>(() => undefined);
  const livePreviewCompartmentRef = useRef(new Compartment());
  const lineNumberCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());
  const viewRef = useRef<EditorView | null>(null);

  useLayoutEffect(() => {
    completionDataRef.current = completionData;
    onChangeRef.current = onChange;
    onCompositionChangeRef.current = onCompositionChange;
    onInsertHandledRef.current = onInsertHandled;
    onLinkClickRef.current = onLinkClick;
    onLinkPreviewInteractionRef.current = onLinkPreviewInteraction;
    onPasteImagesRef.current = onPasteImages;
    onRevealHandledRef.current = onRevealHandled;
    onSaveRef.current = onSave;
    onSelectionChangeRef.current = onSelectionChange;
    onTagClickRef.current = onTagClick;
    renderCodeBlockRef.current = renderCodeBlock;
    renderEmbedRef.current = renderEmbed;
  }, [completionData, onChange, onCompositionChange, onInsertHandled, onLinkClick, onLinkPreviewInteraction, onPasteImages, onRevealHandled, onSave, onSelectionChange, onTagClick, renderCodeBlock, renderEmbed]);

  const createLivePreviewExtension = useCallback(() => inlineLivePreview({
    updates: previewUpdates,
    onLinkClick: (reference, event) => onLinkClickRef.current?.(reference, event),
    onLinkPreviewInteraction: (reference, interaction) => (
      onLinkPreviewInteractionRef.current?.(reference, interaction)
    ),
    onTagClick: (tag, event) => onTagClickRef.current?.(tag, event),
    renderCodeBlock: (language, source) => renderCodeBlockRef.current?.(language, source),
    renderEmbed: (reference) => renderEmbedRef.current?.(reference)
  }), [previewUpdates]);

  useLayoutEffect(() => {
    const parent = hostRef.current;
    if (!parent) {
      return undefined;
    }

    const sessionGeneration = sessionStore?.generation;
    const storedSession = documentKey && sessionScopeKey
      ? sessionStore?.read(sessionScopeKey, documentKey, value)
      : null;
    const sessionIsCurrent = () => !sessionStore || sessionStore.generation === sessionGeneration;
    let cancelCompositionFinish: (() => void) | null = null;
    composingRef.current = false;
    composedValueRef.current = null;
    saveAfterCompositionRef.current = false;
    const pendingImagePasteRanges = pendingImagePasteRangesRef.current;
    acceptedControlledValueRef.current = value;
    controlledValueRevisionRef.current = valueRevision;
    ignoredControlledValuesRef.current = [];
    pendingLocalValuesRef.current = [];
    pendingImagePasteRanges.forEach(({ controller }) => controller.abort());
    pendingImagePasteRanges.clear();

    const queueImages = (
      files: readonly File[],
      editorView: EditorView,
      insertionRange = editorView.state.selection.main
    ) => {
      const handler = onPasteImagesRef.current;
      if (!handler || !files.length || editorView.state.readOnly) return false;

      const requestId = pendingImagePasteIdRef.current + 1;
      pendingImagePasteIdRef.current = requestId;
      const controller = new AbortController();
      pendingImagePasteRangesRef.current.set(requestId, {
        controller,
        collapsed: insertionRange.empty,
        expectedText: editorView.state.sliceDoc(insertionRange.from, insertionRange.to),
        from: insertionRange.from,
        to: insertionRange.to
      });

      void Promise.resolve(handler(files, { signal: controller.signal })).then((value) => {
        const result = imagePasteResult(value);
        const range = pendingImagePasteRangesRef.current.get(requestId);
        pendingImagePasteRangesRef.current.delete(requestId);
        if (
          !range
          || !result?.source
          || controller.signal.aborted
          || viewRef.current !== editorView
          || editorView.state.readOnly
        ) {
          discardImagePasteResult(result);
          return;
        }
        const documentLength = editorView.state.doc.length;
        const from = Math.max(0, Math.min(documentLength, range.from));
        const to = Math.max(from, Math.min(documentLength, range.to));
        if (!range.collapsed && editorView.state.sliceDoc(from, to) !== range.expectedText) {
          controller.abort();
          discardImagePasteResult(result);
          return;
        }
        try {
          editorView.dispatch({
            changes: { from, to, insert: result.source },
            selection: { anchor: from + result.source.length },
            effects: EditorView.scrollIntoView(from + result.source.length, { y: "center" })
          });
          editorView.focus();
          if (result.onCommit) {
            const rollbackInsertedSource = async () => {
              if (viewRef.current === editorView && !editorView.state.readOnly) {
                const currentSource = editorView.state.doc.toString();
                const rollbackFrom = currentSource.indexOf(result.source);
                if (
                  rollbackFrom >= 0
                  && currentSource.indexOf(result.source, rollbackFrom + result.source.length) < 0
                ) {
                  editorView.dispatch({
                    changes: {
                      from: rollbackFrom,
                      insert: range.expectedText,
                      to: rollbackFrom + result.source.length
                    },
                    selection: { anchor: rollbackFrom + range.expectedText.length }
                  });
                  editorView.focus();
                  return true;
                }
              }
              try {
                return await result.onRollback?.({
                  replacementText: range.expectedText,
                  source: result.source
                }) ?? false;
              } catch {
                return false;
              }
            };
            try {
              void Promise.resolve(result.onCommit()).then(async (accepted) => {
                if (accepted === false) {
                  const rolledBack = await rollbackInsertedSource();
                  settleImagePasteResult(result, rolledBack ? "rolled-back" : "rollback-blocked");
                  return;
                }
                settleImagePasteResult(result, "committed");
              }).catch(async () => {
                const rolledBack = await rollbackInsertedSource();
                settleImagePasteResult(result, rolledBack ? "rolled-back" : "rollback-blocked");
              });
            } catch {
              void rollbackInsertedSource().then((rolledBack) => {
                settleImagePasteResult(result, rolledBack ? "rolled-back" : "rollback-blocked");
              });
            }
          } else {
            settleImagePasteResult(result, "committed");
          }
        } catch {
          controller.abort();
          discardImagePasteResult(result);
        }
      }).catch(() => {
        pendingImagePasteRangesRef.current.delete(requestId);
      });
      return true;
    };

    let activatedLinkOnMouseDown: HTMLElement | null = null;
    const extensions = [
          lineNumberCompartmentRef.current.of(livePreview ? [] : [lineNumbers(), highlightActiveLineGutter()]),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({
            activateOnTyping: true,
            override: [(context) => completeObsidianMarkdown(context, completionDataRef.current)]
          }),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          markdown(),
          EditorView.lineWrapping,
          livePreviewCompartmentRef.current.of(livePreview ? createLivePreviewExtension() : []),
          readOnlyCompartmentRef.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly)
          ]),
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel,
            "aria-multiline": "true",
            "aria-autocomplete": "list",
            "aria-keyshortcuts": "Control+Space"
          }),
          EditorView.domEventHandlers({
            compositionstart: () => {
              cancelCompositionFinish?.();
              cancelCompositionFinish = null;
              composingRef.current = true;
              onCompositionChangeRef.current?.(true);
              return false;
            },
            compositionend: (_event, editorView) => {
              cancelCompositionFinish?.();
              cancelCompositionFinish = afterCompositionDomSync(editorView, () => {
                if (viewRef.current !== editorView || !sessionIsCurrent()) return;
                composingRef.current = false;
                if (composedValueRef.current !== null) {
                  composedValueRef.current = null;
                  onChangeRef.current(editorView.state.doc.toString());
                }
                onCompositionChangeRef.current?.(false);
                setCompositionVersion((version) => version + 1);
                if (saveAfterCompositionRef.current) {
                  saveAfterCompositionRef.current = false;
                  onSaveRef.current?.();
                }
              });
              return false;
            },
            mouseover: (event, editorView) => {
              const anchor = livePreviewAnchorFromEvent(event, editorView);
              const reference = livePreviewReferenceFromElement(anchor);
              if (!anchor || !reference || eventMovedInsideAnchor(event, anchor)) return false;
              onLinkPreviewInteractionRef.current?.(reference, { active: true, anchor, source: "pointer" });
              return false;
            },
            mouseout: (event, editorView) => {
              const anchor = livePreviewAnchorFromEvent(event, editorView);
              const reference = livePreviewReferenceFromElement(anchor);
              if (!anchor || !reference || eventMovedInsideAnchor(event, anchor)) return false;
              onLinkPreviewInteractionRef.current?.(reference, { active: false, anchor, source: "pointer" });
              return false;
            },
            focusin: (event, editorView) => {
              const anchor = livePreviewAnchorFromEvent(event, editorView);
              const reference = livePreviewReferenceFromElement(anchor);
              if (!anchor || !reference || eventMovedInsideAnchor(event, anchor)) return false;
              onLinkPreviewInteractionRef.current?.(reference, { active: true, anchor, source: "focus" });
              return false;
            },
            focusout: (event, editorView) => {
              const anchor = livePreviewAnchorFromEvent(event, editorView);
              const reference = livePreviewReferenceFromElement(anchor);
              if (!anchor || !reference || eventMovedInsideAnchor(event, anchor)) return false;
              onLinkPreviewInteractionRef.current?.(reference, { active: false, anchor, source: "focus" });
              return false;
            },
            mousedown: (event, editorView) => {
              activatedLinkOnMouseDown = null;
              if (event.button !== 0 || (!event.metaKey && !event.ctrlKey) || !onLinkClickRef.current) return false;
              const anchor = livePreviewAnchorFromEvent(event, editorView);
              const reference = livePreviewReferenceFromElement(anchor);
              if (!anchor || !reference || reference.kind === "external") return false;
              // CM's default mousedown moves the caret into this line and
              // removes its preview widget before click can inspect it.
              event.preventDefault();
              event.stopPropagation();
              activatedLinkOnMouseDown = anchor;
              onLinkClickRef.current(reference, event);
              return true;
            },
            click: (event, editorView) => {
              const anchor = livePreviewAnchorFromEvent(event, editorView);
              const alreadyActivated = anchor !== null && anchor === activatedLinkOnMouseDown;
              activatedLinkOnMouseDown = null;
              if (alreadyActivated) {
                event.preventDefault();
                event.stopPropagation();
                return true;
              }
              const reference = livePreviewReferenceFromElement(anchor);
              if (!anchor || !reference || reference.kind === "external" || (!event.metaKey && !event.ctrlKey)) {
                return false;
              }
              event.preventDefault();
              event.stopPropagation();
              onLinkClickRef.current?.(reference, event);
              return true;
            },
            paste: (event, editorView) => {
              const handler = onPasteImagesRef.current;
              const files = vaultClipboardImageFiles(event.clipboardData);
              if (!handler || !files.length) {
                return false;
              }
              event.preventDefault();
              if (editorView.state.readOnly) {
                return true;
              }
              return queueImages(files, editorView);
            },
            dragover: (event, editorView) => {
              const handler = onPasteImagesRef.current;
              const items = Array.from(event.dataTransfer?.items ?? []);
              const hasImageItem = items.some((item) => (
                item.kind === "file"
                && (!item.type || item.type.toLocaleLowerCase("en-US").startsWith("image/"))
              ));
              const hasOpaqueFiles = items.length === 0
                && Array.from(event.dataTransfer?.types ?? []).includes("Files");
              if (!handler || editorView.state.readOnly || (!hasImageItem && !hasOpaqueFiles)) {
                return false;
              }
              event.preventDefault();
              if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
              return true;
            },
            drop: (event, editorView) => {
              const handler = onPasteImagesRef.current;
              const files = vaultClipboardImageFiles(event.dataTransfer);
              if (!handler || !files.length) return false;
              event.preventDefault();
              if (editorView.state.readOnly) return true;
              const position = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
              return queueImages(
                files,
                editorView,
                position === null
                  ? editorView.state.selection.main
                  : EditorSelection.cursor(position)
              );
            }
          }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                if (composingRef.current) saveAfterCompositionRef.current = true;
                else onSaveRef.current?.();
                return true;
              }
            },
            ...completionKeymap,
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...searchKeymap
          ]),
          EditorView.updateListener.of((update) => {
            const isExternalSync = update.transactions.some((transaction) => (
              transaction.annotation(externalValueSync) === true
            ));
            if (update.docChanged) {
              if (isExternalSync) {
                pendingImagePasteRangesRef.current.forEach(({ controller }) => controller.abort());
                pendingImagePasteRangesRef.current.clear();
              } else {
                for (const transaction of update.transactions) {
                  if (!transaction.docChanged) continue;
                  for (const [requestId, range] of [...pendingImagePasteRangesRef.current]) {
                    if (range.collapsed) {
                      const mapped = transaction.changes.mapPos(range.from, -1);
                      range.from = mapped;
                      range.to = mapped;
                    } else {
                      let touchesSelection = false;
                      transaction.changes.iterChangedRanges((changeFrom, changeTo) => {
                        if (
                          (changeFrom === changeTo
                            && changeFrom >= range.from
                            && changeFrom <= range.to)
                          || (changeFrom < range.to && changeTo > range.from)
                        ) {
                          touchesSelection = true;
                        }
                      });
                      if (touchesSelection) {
                        pendingImagePasteRangesRef.current.delete(requestId);
                        range.controller.abort();
                        continue;
                      }
                      const mappedFrom = transaction.changes.mapPos(range.from, 1);
                      const mappedTo = transaction.changes.mapPos(range.to, -1);
                      range.from = Math.min(mappedFrom, mappedTo);
                      range.to = Math.max(mappedFrom, mappedTo);
                    }
                  }
                }
              }
            }
            if (update.docChanged && !isExternalSync) {
              const nextValue = update.state.doc.toString();
              const droppedValue = appendBoundedValue(pendingLocalValuesRef.current, nextValue);
              if (droppedValue !== null) {
                appendBoundedValue(ignoredControlledValuesRef.current, droppedValue);
              }
              if (composingRef.current) composedValueRef.current = nextValue;
              else onChangeRef.current(nextValue);
            }
            if (update.selectionSet || update.docChanged) {
              const selection = update.state.selection.main;
              onSelectionChangeRef.current?.(selection.empty
                ? null
                : { start: selection.from, end: selection.to });
            }
          })
        ];
    let state: EditorState;
    if (storedSession) {
      try {
        state = EditorState.fromJSON(storedSession.state, { extensions }, { history: historyField });
      } catch {
        // A remote edit or incompatible history snapshot starts a clean session.
        state = EditorState.create({ doc: value, extensions });
      }
    } else {
      state = EditorState.create({ doc: value, extensions });
    }
    const view = constructWithFrameDeferredResizeObserver(window, () => new EditorView({ parent, state }));

    const handleLivePreviewKeyboardOpen = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const anchor = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-live-preview-target]")
        : null;
      const reference = livePreviewReferenceFromElement(anchor);
      if (!anchor || !view.dom.contains(anchor) || !reference || reference.kind === "external") return;
      const detail = event.detail as Partial<CodeMirrorLinkActivation> | null;
      onLinkClickRef.current?.(reference, {
        altKey: detail?.altKey === true,
        ctrlKey: detail?.ctrlKey === true,
        metaKey: detail?.metaKey === true,
        shiftKey: detail?.shiftKey === true
      });
    };
    view.dom.addEventListener(LIVE_PREVIEW_LINK_OPEN_EVENT, handleLivePreviewKeyboardOpen);

    viewRef.current = view;
    if (storedSession) {
      view.scrollDOM.scrollTop = storedSession.scrollTop;
      view.scrollDOM.scrollLeft = storedSession.scrollLeft;
      view.requestMeasure({
        read: () => undefined,
        write: () => {
          if (viewRef.current !== view) return;
          view.scrollDOM.scrollTop = storedSession.scrollTop;
          view.scrollDOM.scrollLeft = storedSession.scrollLeft;
        }
      });
    }
    queueSelectedImagesRef.current = (files) => {
      if (viewRef.current === view) queueImages(files, view);
    };
    const initialSelection = view.state.selection.main;
    onSelectionChangeRef.current?.(initialSelection.empty
      ? null
      : { start: initialSelection.from, end: initialSelection.to });
    return () => {
      cancelCompositionFinish?.();
      if (sessionIsCurrent()) {
        if (composedValueRef.current !== null) onChangeRef.current(view.state.doc.toString());
        if (composingRef.current) onCompositionChangeRef.current?.(false);
        if (documentKey && sessionScopeKey && sessionGeneration !== undefined) {
          sessionStore?.write(sessionScopeKey, documentKey, sessionGeneration, {
            state: view.state.toJSON({ history: historyField }),
            scrollTop: view.scrollDOM.scrollTop,
            scrollLeft: view.scrollDOM.scrollLeft
          });
        }
      }
      composingRef.current = false;
      composedValueRef.current = null;
      saveAfterCompositionRef.current = false;
      view.dom.removeEventListener(LIVE_PREVIEW_LINK_OPEN_EVENT, handleLivePreviewKeyboardOpen);
      viewRef.current = null;
      imagePickerTargetViewRef.current = null;
      queueSelectedImagesRef.current = () => undefined;
      pendingLocalValuesRef.current = [];
      ignoredControlledValuesRef.current = [];
      pendingImagePasteRanges.forEach(({ controller }) => controller.abort());
      pendingImagePasteRanges.clear();
      onSelectionChangeRef.current?.(null);
      view.destroy();
    };
    // The editor instance must survive callback/value changes for one note,
    // but another document restores only its own bounded, authorized session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ariaLabel, documentKey, sessionStore, sessionScopeKey]);

  useEffect(() => {
    // Focus changes never recreate the editor or interrupt a pending paste.
    const view = viewRef.current;
    if (!autoFocus || !view) return;
    const activeElement = view.dom.ownerDocument.activeElement;
    // A lazy first mount can finish after the user has focused the note title
    // or another field. Never redirect that field's next keystrokes into CM.
    const externalInput = activeElement?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    const focusedEditor = externalInput instanceof HTMLElement ? EditorView.findFromDOM(externalInput) : null;
    // Activating another document intentionally moves its caret. A CM search
    // field is still a form input and must keep its explicitly chosen focus.
    const isEditorContent = focusedEditor?.contentDOM === externalInput;
    if (externalInput && !isEditorContent && !view.dom.contains(externalInput) && !externalInput.closest("[inert]")) return;
    view.focus();
  }, [ariaLabel, autoFocus, documentKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || composingRef.current) {
      return;
    }

    const previousRevision = controlledValueRevisionRef.current;
    const revisionAdvanced = valueRevision !== undefined
      && (previousRevision === undefined || valueRevision > previousRevision);
    if (
      valueRevision !== undefined
      && (previousRevision === undefined || valueRevision > previousRevision)
    ) {
      controlledValueRevisionRef.current = valueRevision;
    }
    const rememberIgnoredValue = (ignoredValue: string) => {
      appendBoundedValue(ignoredControlledValuesRef.current, ignoredValue);
    };
    const acceptControlledValue = (nextValue: string) => {
      const previousValue = acceptedControlledValueRef.current;
      if (previousValue !== nextValue) rememberIgnoredValue(previousValue);
      acceptedControlledValueRef.current = nextValue;
      ignoredControlledValuesRef.current = ignoredControlledValuesRef.current.filter(
        (ignoredValue) => ignoredValue !== nextValue
      );
    };
    const editorValue = view.state.doc.toString();
    if (editorValue === value) {
      pendingLocalValuesRef.current
        .filter((pendingValue) => pendingValue !== value)
        .forEach(rememberIgnoredValue);
      pendingLocalValuesRef.current = [];
      acceptControlledValue(value);
      return;
    }

    const acknowledgedLocalIndex = pendingLocalValuesRef.current.lastIndexOf(value);
    if (acknowledgedLocalIndex >= 0) {
      const acknowledgedValues = pendingLocalValuesRef.current.splice(
        0,
        acknowledgedLocalIndex + 1
      );
      acknowledgedValues
        .filter((acknowledgedValue) => acknowledgedValue !== value)
        .forEach(rememberIgnoredValue);
      acceptControlledValue(value);
      return;
    }

    // A status/autosave render may still carry the last acknowledged prop, and
    // React may acknowledge an earlier local edit after CodeMirror has already
    // emitted a newer one. Ignore only those known stale values. Any new value
    // is an external update and must not be blocked indefinitely by local state.
    if (
      !revisionAdvanced
      && (
        value === acceptedControlledValueRef.current
        || ignoredControlledValuesRef.current.includes(value)
      )
    ) return;

    pendingLocalValuesRef.current.forEach(rememberIgnoredValue);
    pendingLocalValuesRef.current = [];
    acceptControlledValue(value);
    // A revision-only acknowledgement of the same/local body must not cancel
    // an upload. Abort only on the branch that will actually replace the
    // editor document with an external value.
    pendingImagePasteRangesRef.current.forEach(({ controller }) => controller.abort());
    pendingImagePasteRangesRef.current.clear();

    view.dispatch({
      annotations: externalValueSync.of(true),
      changes: { from: 0, to: view.state.doc.length, insert: value }
    });
  }, [value, valueRevision, compositionVersion]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        livePreviewCompartmentRef.current.reconfigure(livePreview ? createLivePreviewExtension() : []),
        lineNumberCompartmentRef.current.reconfigure(livePreview ? [] : [lineNumbers(), highlightActiveLineGutter()])
      ]
    });
  }, [livePreview, createLivePreviewExtension]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (readOnly) {
      pendingImagePasteRangesRef.current.forEach(({ controller }) => controller.abort());
      pendingImagePasteRangesRef.current.clear();
    }
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly)
      ])
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !insertRequest || view.state.readOnly || composingRef.current) {
      return;
    }
    const selection = view.state.selection.main;
    const relativeCursor = insertRequest.cursorOffset === undefined
      ? insertRequest.text.length
      : Math.max(0, Math.min(insertRequest.text.length, Math.trunc(insertRequest.cursorOffset)));
    const anchor = selection.from + relativeCursor;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: insertRequest.text },
      selection: { anchor },
      effects: EditorView.scrollIntoView(anchor, { y: "center" })
    });
    view.focus();
    onInsertHandledRef.current?.(insertRequest.id);
  }, [insertRequest, compositionVersion]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealRequest) {
      return;
    }
    const lineNumber = Math.max(1, Math.min(revealRequest.line, view.state.doc.lines));
    const position = view.state.doc.line(lineNumber).from;
    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" })
    });
    view.focus();
    onRevealHandledRef.current?.(revealRequest.id);
  }, [revealRequest]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !searchRequest || composingRef.current) return;
    openSearchPanel(view);
    onSearchHandled?.(searchRequest.id);
  }, [searchRequest, onSearchHandled, compositionVersion]);

  return (
    <div
      aria-readonly={readOnly}
      className={`vault-codemirror${livePreview ? " vault-codemirror--live-preview" : ""}${onPasteImages ? " vault-codemirror--with-image-tools" : ""}`}
    >
      {onPasteImages ? (
        <div className="vault-codemirror-image-tools">
          <input
            accept={VAULT_MARKDOWN_IMAGE_ACCEPT}
            disabled={readOnly}
            hidden
            multiple
            onChange={(event) => {
              const targetView = imagePickerTargetViewRef.current;
              imagePickerTargetViewRef.current = null;
              const files = vaultSelectedImageFiles(event.currentTarget.files);
              event.currentTarget.value = "";
              if (targetView && targetView === viewRef.current && files.length) {
                queueSelectedImagesRef.current(files);
              }
            }}
            ref={imageFileInputRef}
            type="file"
          />
          <button
            aria-label="이미지 파일 추가"
            disabled={readOnly}
            onClick={() => {
              const editorView = viewRef.current;
              if (!editorView || editorView.state.readOnly) return;
              imagePickerTargetViewRef.current = editorView;
              imageFileInputRef.current?.click();
            }}
            title={`이미지 파일 추가 · ${vaultMarkdownImageLimitLabel}`}
            type="button"
          ><ImagePlus aria-hidden="true" size={17} /></button>
          <span className="vault-image-limit-description">{vaultMarkdownImageLimitLabel}</span>
        </div>
      ) : null}
      <div className="vault-codemirror-editor" ref={hostRef} />
    </div>
  );
}
