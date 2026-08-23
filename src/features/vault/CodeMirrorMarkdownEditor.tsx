import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { searchKeymap } from "@codemirror/search";
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
import { useEffect, useRef } from "react";
import type {
  MarkdownLinkPreviewHandler,
  MarkdownLinkReference,
  MarkdownRendererProps,
  MarkdownTagClickHandler
} from "../markdown";
import { constructWithFrameDeferredResizeObserver } from "./frameDeferredResizeObserver";
import {
  inlineLivePreview,
  LIVE_PREVIEW_LINK_OPEN_EVENT,
  livePreviewReferenceFromElement
} from "./inlineLivePreview";
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
  onChange: (value: string) => void;
  onInsertHandled?: (id: number) => void;
  onLinkClick?: CodeMirrorLinkClickHandler;
  onLinkPreviewInteraction?: MarkdownLinkPreviewHandler;
  onTagClick?: MarkdownTagClickHandler;
  onRevealHandled?: (id: number) => void;
  onSave?: () => void;
  onSelectionChange?: (selection: { end: number; start: number } | null) => void;
  readOnly?: boolean;
  renderCodeBlock?: MarkdownRendererProps["renderCodeBlock"];
  renderEmbed?: MarkdownRendererProps["renderEmbed"];
  revealRequest?: { id: number; line: number } | null;
  value: string;
}

export function CodeMirrorMarkdownEditor({
  ariaLabel = "Markdown 편집기",
  autoFocus = false,
  completionData,
  documentKey,
  insertRequest,
  livePreview = false,
  onChange,
  onInsertHandled,
  onLinkClick,
  onLinkPreviewInteraction,
  onTagClick,
  onRevealHandled,
  onSave,
  onSelectionChange,
  readOnly = false,
  renderCodeBlock,
  renderEmbed,
  revealRequest,
  value
}: CodeMirrorMarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const completionDataRef = useRef(completionData);
  const onChangeRef = useRef(onChange);
  const onInsertHandledRef = useRef(onInsertHandled);
  const onLinkClickRef = useRef(onLinkClick);
  const onLinkPreviewInteractionRef = useRef(onLinkPreviewInteraction);
  const onRevealHandledRef = useRef(onRevealHandled);
  const onSaveRef = useRef(onSave);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onTagClickRef = useRef(onTagClick);
  const renderCodeBlockRef = useRef(renderCodeBlock);
  const renderEmbedRef = useRef(renderEmbed);
  const livePreviewCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    completionDataRef.current = completionData;
    onChangeRef.current = onChange;
    onInsertHandledRef.current = onInsertHandled;
    onLinkClickRef.current = onLinkClick;
    onLinkPreviewInteractionRef.current = onLinkPreviewInteraction;
    onRevealHandledRef.current = onRevealHandled;
    onSaveRef.current = onSave;
    onSelectionChangeRef.current = onSelectionChange;
    onTagClickRef.current = onTagClick;
    renderCodeBlockRef.current = renderCodeBlock;
    renderEmbedRef.current = renderEmbed;
  }, [completionData, onChange, onInsertHandled, onLinkClick, onLinkPreviewInteraction, onRevealHandled, onSave, onSelectionChange, onTagClick, renderCodeBlock, renderEmbed]);

  const createLivePreviewExtension = () => inlineLivePreview({
    onLinkClick: (reference, event) => onLinkClickRef.current?.(reference, event),
    onLinkPreviewInteraction: (reference, interaction) => (
      onLinkPreviewInteractionRef.current?.(reference, interaction)
    ),
    onTagClick: (tag, event) => onTagClickRef.current?.(tag, event),
    renderCodeBlock: (language, source) => renderCodeBlockRef.current?.(language, source),
    renderEmbed: (reference) => renderEmbedRef.current?.(reference)
  });

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) {
      return undefined;
    }

    const view = constructWithFrameDeferredResizeObserver(window, () => new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
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
            click: (event, editorView) => {
              const anchor = livePreviewAnchorFromEvent(event, editorView);
              const reference = livePreviewReferenceFromElement(anchor);
              if (!anchor || !reference || reference.kind === "external" || (!event.metaKey && !event.ctrlKey)) {
                return false;
              }
              event.preventDefault();
              event.stopPropagation();
              onLinkClickRef.current?.(reference, event);
              return true;
            }
          }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
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
            if (update.docChanged && !isExternalSync) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const selection = update.state.selection.main;
              onSelectionChangeRef.current?.(selection.empty
                ? null
                : { start: selection.from, end: selection.to });
            }
          })
        ]
      })
    }));

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
    const initialSelection = view.state.selection.main;
    onSelectionChangeRef.current?.(initialSelection.empty
      ? null
      : { start: initialSelection.from, end: initialSelection.to });
    if (autoFocus) {
      view.focus();
    }

    return () => {
      view.dom.removeEventListener(LIVE_PREVIEW_LINK_OPEN_EVENT, handleLivePreviewKeyboardOpen);
      viewRef.current = null;
      onSelectionChangeRef.current?.(null);
      view.destroy();
    };
    // The editor instance must survive callback/value changes for one note,
    // but a different document gets a fresh undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ariaLabel, autoFocus, documentKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) {
      return;
    }

    view.dispatch({
      annotations: externalValueSync.of(true),
      changes: { from: 0, to: view.state.doc.length, insert: value }
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: livePreviewCompartmentRef.current.reconfigure(
        livePreview ? createLivePreviewExtension() : []
      )
    });
  }, [livePreview]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly)
      ])
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !insertRequest) {
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
  }, [insertRequest]);

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

  return (
    <div
      aria-readonly={readOnly}
      className={`vault-codemirror${livePreview ? " vault-codemirror--live-preview" : ""}`}
      ref={hostRef}
    />
  );
}
