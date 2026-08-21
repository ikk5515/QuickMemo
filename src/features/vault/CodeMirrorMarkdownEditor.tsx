import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { Annotation, EditorState } from "@codemirror/state";
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
import { completeObsidianMarkdown, type ObsidianMarkdownCompletionData } from "./obsidianCompletion";

const externalValueSync = Annotation.define<boolean>();

export interface CodeMirrorMarkdownEditorProps {
  ariaLabel?: string;
  autoFocus?: boolean;
  completionData?: ObsidianMarkdownCompletionData;
  onChange: (value: string) => void;
  onSave?: () => void;
  value: string;
}

export function CodeMirrorMarkdownEditor({
  ariaLabel = "Markdown 편집기",
  autoFocus = false,
  completionData,
  onChange,
  onSave,
  value
}: CodeMirrorMarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const completionDataRef = useRef(completionData);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    completionDataRef.current = completionData;
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  }, [completionData, onChange, onSave]);

  useEffect(() => {
    if (!hostRef.current) {
      return undefined;
    }

    const view = new EditorView({
      parent: hostRef.current,
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
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel,
            "aria-multiline": "true",
            "aria-autocomplete": "list",
            "aria-keyshortcuts": "Control+Space"
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
          })
        ]
      })
    });

    viewRef.current = view;
    if (autoFocus) {
      view.focus();
    }

    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // The editor instance must survive callback/value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ariaLabel, autoFocus]);

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

  return <div className="vault-codemirror" ref={hostRef} />;
}
