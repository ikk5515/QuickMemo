import { useCallback, useDeferredValue, useMemo } from "react";
import type { DecodedVaultAsset } from "../vault/vaultAsset";
import type { DecryptedVaultNote } from "../vault/vaultData";
import { safeCanvasDocument } from "./canvasModel";
import {
  JsonCanvasView,
  type ImportJsonCanvasExternalFiles
} from "./JsonCanvasView";

interface VaultJsonCanvasPaneProps {
  decodedAssetForEntry: (entryId: string) => DecodedVaultAsset | null;
  entryPaths: ReadonlyMap<string, string>;
  getDraftBody: (entryId: string, fallback: string) => string;
  markdownDraftRevision: number;
  notes: readonly DecryptedVaultNote[];
  onChange: (source: string) => void;
  onImportExternalFiles?: ImportJsonCanvasExternalFiles;
  onOpenFile: (path: string) => void;
  readOnly?: boolean;
  source: string;
}

function fallbackEntryPath(note: DecryptedVaultNote) {
  if (note.entryKind === "canvas") return `${note.title.replace(/\.canvas$/iu, "")}.canvas`;
  if (note.entryKind === "base") return `${note.title.replace(/\.base$/iu, "")}.base`;
  return note.title;
}

export function VaultJsonCanvasPane({
  decodedAssetForEntry,
  entryPaths,
  getDraftBody,
  markdownDraftRevision,
  notes,
  onChange,
  onImportExternalFiles,
  onOpenFile,
  readOnly,
  source
}: VaultJsonCanvasPaneProps) {
  const deferredSource = useDeferredValue(source);
  const assetPathSignature = useMemo(() => {
    const paths = new Set(safeCanvasDocument(deferredSource).nodes.flatMap((node) => {
      if (node.type === "file") return [node.file];
      if (node.type === "group" && node.background) return [node.background];
      return [];
    }));
    return JSON.stringify([...paths].sort());
  }, [deferredSource]);
  const activeAssetPaths = useMemo(
    () => new Set<string>(JSON.parse(assetPathSignature) as string[]),
    [assetPathSignature]
  );
  const fileOptions = useMemo(() => {
    void markdownDraftRevision;
    return notes.filter((note) => note.entryKind !== "legacy-html").map((note) => {
      const path = entryPaths.get(note.id) ?? fallbackEntryPath(note);
      return {
        ...(note.entryKind === "asset" && activeAssetPaths.has(path)
          ? { asset: decodedAssetForEntry(note.id) ?? undefined }
          : {}),
        ...(note.entryKind === "markdown"
          ? { content: getDraftBody(note.id, note.body) }
          : {}),
        kind: note.entryKind as "markdown" | "canvas" | "base" | "asset",
        label: path,
        path
      };
    });
  }, [activeAssetPaths, decodedAssetForEntry, entryPaths, getDraftBody, markdownDraftRevision, notes]);
  const filePathByEntryId = useMemo(() => new Map(notes
    .filter((note) => note.entryKind !== "legacy-html")
    .map((note) => [note.id, entryPaths.get(note.id) ?? fallbackEntryPath(note)] as const)), [entryPaths, notes]);
  const resolveVaultEntryDrop = useCallback(
    (entryId: string) => filePathByEntryId.get(entryId) ?? null,
    [filePathByEntryId]
  );

  return (
    <JsonCanvasView
      fileOptions={fileOptions}
      onChange={onChange}
      onImportExternalFiles={onImportExternalFiles}
      onOpenFile={onOpenFile}
      readOnly={readOnly}
      resolveVaultEntryDrop={resolveVaultEntryDrop}
      source={source}
    />
  );
}
