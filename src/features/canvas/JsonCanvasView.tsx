import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  reconnectEdge,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeMouseHandler,
  type OnNodeDrag,
  type NodeProps,
  type OnSelectionChangeParams,
  type ReactFlowInstance
} from "@xyflow/react";
import {
  BringToFront,
  Columns3,
  Copy,
  FilePlus2,
  Grid3X3,
  Group,
  Link2,
  Rows3,
  SendToBack,
  StickyNote,
  Trash2
} from "lucide-react";
import { createPortal } from "react-dom";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { VaultAssetPreview } from "../vault/VaultAssetPreview";
import { safeVaultAssetPreviewKind, type DecodedVaultAsset } from "../vault/vaultAsset";
import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import "@xyflow/react/dist/style.css";
import {
  alignJsonCanvasNodes,
  canvasDocumentFromFlow,
  distributeJsonCanvasNodes,
  duplicateJsonCanvasSelection,
  effectiveJsonCanvasEdgeEnds,
  emptyJsonCanvas,
  expandJsonCanvasGroupSelection,
  containedJsonCanvasNodeIds,
  containingJsonCanvasGroupId,
  jsonCanvasEdgeEndsForDirection,
  jsonCanvasEdgeNavigationNodeId,
  parseCanvasDocument,
  reorderJsonCanvasNodes,
  safeCanvasColor,
  safeCanvasDocument,
  safeHttpUrl,
  safeVaultPath,
  serializeCanvas,
  translateJsonCanvasNodes,
  type CanvasAlignment,
  type CanvasDistribution,
  type CanvasFlowEdge,
  type CanvasFlowNode,
  type CanvasStackOrder,
  type JsonCanvasDocument,
  type JsonCanvasEdge,
  type JsonCanvasNode,
  type JsonCanvasSide
} from "./canvasModel";
import {
  createCanvasNodeDragCommitState,
  recordCanvasNodeDragCommitSignal,
  type CanvasNodeDragCommitDecision,
  type CanvasNodeDragCommitSignal,
  type CanvasNodeDragCommitState
} from "./canvasDragCommit";
import {
  JSON_CANVAS_VAULT_ENTRY_MIME,
  containsJsonCanvasVaultEntryDragType,
  parseJsonCanvasVaultEntryDragPayload
} from "./vaultEntryDrag";
export {
  JSON_CANVAS_VAULT_ENTRY_MIME,
  parseJsonCanvasVaultEntryDragPayload,
  serializeJsonCanvasVaultEntryDragPayload,
  setJsonCanvasVaultEntryDragData,
  type JsonCanvasVaultEntryDragPayload
} from "./vaultEntryDrag";
import "./canvas.css";

export interface JsonCanvasFileOption {
  asset?: DecodedVaultAsset;
  content?: string;
  kind?: "markdown" | "canvas" | "base" | "asset";
  label: string;
  path: string;
}

export type ResolveJsonCanvasVaultEntryDrop = (
  entryId: string
) => string | null | undefined;

export type ImportJsonCanvasExternalFiles = (
  files: readonly File[]
) => Promise<{ paths: readonly string[]; rejected: number }>;

export interface JsonCanvasViewProps {
  fileOptions: readonly JsonCanvasFileOption[];
  onChange: (source: string) => void;
  onImportExternalFiles?: ImportJsonCanvasExternalFiles;
  onOpenFile: (path: string) => void;
  readOnly?: boolean;
  resolveVaultEntryDrop?: ResolveJsonCanvasVaultEntryDrop;
  source: string;
}

interface CanvasRuntime {
  editTextNode: (nodeId: string) => void;
  editingTextNodeId: string | null;
  fileOptionsByPath: ReadonlyMap<string, JsonCanvasFileOption>;
  fileOptions: readonly JsonCanvasFileOption[];
  onOpenFile: (path: string) => void;
  patchNode: (nodeId: string, patch: Partial<JsonCanvasNode>) => void;
  readOnly: boolean;
  stopTextNodeEditing: (nodeId?: string) => void;
}

interface CanvasContextMenuState {
  clientX: number;
  clientY: number;
  kind: "node" | "edge" | "pane";
  targetId?: string;
  flowPosition?: { x: number; y: number };
}

interface CanvasGroupDragState {
  groupId: string;
  memberIds: ReadonlySet<string>;
}

interface CanvasLongPressState {
  clientX: number;
  clientY: number;
  nodeId: string;
  pointerId: number;
  timer: ReturnType<typeof setTimeout>;
}

const CanvasRuntimeContext = createContext<CanvasRuntime | null>(null);
const JSON_CANVAS_SIDES: readonly JsonCanvasSide[] = ["top", "right", "bottom", "left"];
const CANVAS_COLORS = ["1", "2", "3", "4", "5", "6"] as const;
const CANVAS_FILE_RESULT_LIMIT = 50;
export const CANVAS_NODE_INTERACTION_THRESHOLD_PX = 6;
const CANVAS_NO_DRAG_CLASS_NAME = "nodrag";
const CANVAS_NO_PAN_CLASS_NAME = "nopan";
const CANVAS_DROP_GRID: readonly [number, number] = [20, 20];
const MAX_CANVAS_DROP_COORDINATE = 100_000_000;
const MAX_CANVAS_DROP_NODES = 10_000;
const MAX_CANVAS_EXTERNAL_DROP_FILES = 16;
const CANVAS_VISIBLE_ELEMENT_LOD_THRESHOLD = 500;
const CANVAS_LONG_PRESS_MS = 560;
const CANVAS_LONG_PRESS_MOVE_TOLERANCE_PX = 8;
const MAX_CANVAS_MARKDOWN_PREVIEW_CHARACTERS = 100_000;
const ALIGNMENTS: ReadonlyArray<{ label: string; value: CanvasAlignment }> = [
  { label: "왼쪽 맞춤", value: "left" },
  { label: "가로 가운데", value: "center" },
  { label: "오른쪽 맞춤", value: "right" },
  { label: "위쪽 맞춤", value: "top" },
  { label: "세로 가운데", value: "middle" },
  { label: "아래쪽 맞춤", value: "bottom" }
];

function stopCanvasControlEvent(event: React.SyntheticEvent) {
  event.stopPropagation();
}

function boundedDropCoordinate(value: number, gridSize: number, snapToGrid: boolean): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const rounded = snapToGrid
    ? Math.round(value / gridSize) * gridSize
    : Math.round(value);
  return Math.abs(rounded) <= MAX_CANVAS_DROP_COORDINATE ? rounded : null;
}

export interface CreateDroppedJsonCanvasFileNodeInput {
  createId?: () => string;
  existingNodeIds: ReadonlySet<string>;
  path: string;
  position: { x: number; y: number };
  snapToGrid: boolean;
}

export function createDroppedJsonCanvasFileNode({
  createId = () => createCanvasId("node"),
  existingNodeIds,
  path,
  position,
  snapToGrid
}: CreateDroppedJsonCanvasFileNodeInput): JsonCanvasNode | null {
  const file = safeVaultPath(path);
  const x = boundedDropCoordinate(position.x, CANVAS_DROP_GRID[0], snapToGrid);
  const y = boundedDropCoordinate(position.y, CANVAS_DROP_GRID[1], snapToGrid);
  if (!file || x === null || y === null) {
    return null;
  }

  let id: string | null = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = createId();
    if (
      candidate.length > 0
      && candidate.length <= 256
      && !existingNodeIds.has(candidate)
    ) {
      id = candidate;
      break;
    }
  }
  if (!id) {
    return null;
  }

  return {
    id,
    type: "file",
    x,
    y,
    width: 300,
    height: 180,
    file
  };
}

interface CanvasFileChooserProps {
  accessibleLabel: string;
  buttonText: string;
  disabled?: boolean;
  onSelect: (path: string) => void;
  options: readonly JsonCanvasFileOption[];
  value: string;
}

function CanvasFileChooser({
  accessibleLabel,
  buttonText,
  disabled = false,
  onSelect,
  options,
  value
}: CanvasFileChooserProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogTitleId = useId();
  const resultListId = useId();
  const normalizedQuery = query.trim().normalize("NFC").toLocaleLowerCase();
  const searchResult = useMemo(() => {
    if (!open) {
      return { count: 0, matches: [] as JsonCanvasFileOption[] };
    }
    const matches: JsonCanvasFileOption[] = [];
    let count = 0;
    const selected = options.find((option) => option.path === value);
    if (!normalizedQuery && selected) {
      matches.push(selected);
      count = 1;
    }
    for (const option of options) {
      if (!normalizedQuery && option.path === selected?.path) {
        continue;
      }
      const searchable = `${option.label}\n${option.path}`.normalize("NFC").toLocaleLowerCase();
      if (normalizedQuery && !searchable.includes(normalizedQuery)) {
        continue;
      }
      count += 1;
      if (matches.length < CANVAS_FILE_RESULT_LIMIT) {
        matches.push(option);
      }
    }
    return { count, matches };
  }, [normalizedQuery, open, options, value]);

  useEffect(() => {
    if (open) {
      searchRef.current?.focus();
    }
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  const chooser = open && typeof document !== "undefined" ? createPortal(
    <div
      className="vault-canvas-file-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
      onPointerDown={stopCanvasControlEvent}
      role="presentation"
    >
      <section
        ref={dialogRef}
        aria-labelledby={dialogTitleId}
        aria-modal="true"
        className="vault-canvas-file-dialog"
        onClick={stopCanvasControlEvent}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          } else if (event.key === "Tab") {
            const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
            ) ?? []);
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
        role="dialog"
      >
        <header>
          <h2 id={dialogTitleId}>Canvas 파일 선택</h2>
          <button aria-label="파일 선택 닫기" onClick={close} type="button">×</button>
        </header>
        <label className="vault-canvas-file-search">
          <span>파일 이름 또는 경로 검색</span>
          <input
            ref={searchRef}
            aria-controls={resultListId}
            autoComplete="off"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="검색어 입력"
            type="search"
            value={query}
          />
        </label>
        <p aria-live="polite" className="vault-canvas-file-result-status">
          {searchResult.count === 0
            ? "일치하는 파일이 없습니다."
            : searchResult.count > CANVAS_FILE_RESULT_LIMIT
              ? `${searchResult.count.toLocaleString("ko-KR")}개 중 ${CANVAS_FILE_RESULT_LIMIT}개를 표시합니다. 더 구체적으로 검색하세요.`
              : `${searchResult.count.toLocaleString("ko-KR")}개 파일`}
        </p>
        <ul
          aria-label="Canvas 파일 검색 결과"
          className="vault-canvas-file-results"
          id={resultListId}
        >
          {searchResult.matches.map((option) => (
            <li key={option.path}>
              <button
                aria-current={option.path === value ? "true" : undefined}
                onClick={() => {
                  if (option.path !== value) {
                    onSelect(option.path);
                  }
                  close();
                }}
                type="button"
              >
                <span>{option.label}</span>
                <small>{option.path}</small>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>,
    document.body
  ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        aria-haspopup="dialog"
        aria-label={accessibleLabel}
        className="nodrag nowheel vault-canvas-file-picker-button"
        disabled={disabled || options.length === 0}
        onClick={(event) => {
          event.stopPropagation();
          setQuery("");
          setOpen(true);
        }}
        onPointerDown={stopCanvasControlEvent}
        title={value || undefined}
        type="button"
      >
        {buttonText}
      </button>
      {chooser}
    </>
  );
}

function accessibleNodeLabel(node: JsonCanvasNode) {
  const kind = node.type === "group" ? "그룹" : "Canvas 카드";
  const value = node.label ?? node.file ?? node.url ?? node.text ?? node.id;
  const summary = value.replace(/\s+/g, " ").trim().slice(0, 160);
  return summary ? `${kind}: ${summary}` : kind;
}

export function canvasPdfPageFromSubpath(subpath: string | undefined): number {
  const match = /^#page=([1-9]\d{0,4})$/u.exec(subpath ?? "");
  return match ? Number(match[1]) : 1;
}

function renderCanvasPreviewCode(language: string, source: string) {
  return (
    <pre className="qm-markdown-code-block">
      <code data-language={language || undefined}>{source}</code>
    </pre>
  );
}

function CanvasMarkdownPreview({ label, source }: { label: string; source: string }) {
  const truncated = source.length > MAX_CANVAS_MARKDOWN_PREVIEW_CHARACTERS;
  return (
    <div
      aria-label={label}
      className="nodrag nowheel vault-canvas-markdown-preview"
      inert
    >
      <MarkdownRenderer
        emptyText="빈 노트"
        renderCodeBlock={renderCanvasPreviewCode}
        source={truncated ? source.slice(0, MAX_CANVAS_MARKDOWN_PREVIEW_CHARACTERS) : source}
      />
      {truncated ? <small>미리보기는 앞부분만 표시합니다.</small> : null}
    </div>
  );
}

function CanvasHandles({ readOnly }: { readOnly: boolean }) {
  if (readOnly) {
    return null;
  }
  return JSON_CANVAS_SIDES.map((side) => {
    const position = Position[`${side.charAt(0).toUpperCase()}${side.slice(1)}` as keyof typeof Position];
    return (
      <span key={side}>
        <Handle
          className={`vault-canvas-handle vault-canvas-handle--source vault-canvas-handle--${side}`}
          id={`source-${side}`}
          position={position}
          type="source"
        />
        <Handle
          className={`vault-canvas-handle vault-canvas-handle--target vault-canvas-handle--${side}`}
          id={`target-${side}`}
          position={position}
          type="target"
        />
      </span>
    );
  });
}

function CanvasCardNode({ data, id, selected }: NodeProps<CanvasFlowNode>) {
  const runtime = useContext(CanvasRuntimeContext);
  const node = data.canvas;
  const readOnly = runtime?.readOnly ?? true;
  const editingText = node.type === "text"
    && !readOnly
    && runtime?.editingTextNodeId === id;
  const resolvedLink = node.type === "link" ? safeHttpUrl(node.url) : null;
  const fileOption = node.type === "file"
    ? runtime?.fileOptionsByPath.get(node.file ?? "")
    : undefined;
  const fileAssetPreviewKind = fileOption?.asset ? safeVaultAssetPreviewKind(fileOption.asset) : null;
  const persistedPdfPage = canvasPdfPageFromSubpath(node.subpath);
  const [pdfPage, setPdfPage] = useState(persistedPdfPage);
  const [pdfZoom, setPdfZoom] = useState(100);
  useEffect(() => setPdfPage(persistedPdfPage), [persistedPdfPage]);
  const groupBackgroundOption = node.type === "group" && safeVaultPath(node.background)
    ? runtime?.fileOptionsByPath.get(node.background ?? "")
    : undefined;
  const groupBackgroundAsset = groupBackgroundOption?.asset
    && safeVaultAssetPreviewKind(groupBackgroundOption.asset) === "image"
    ? groupBackgroundOption.asset
    : undefined;
  const accent = safeCanvasColor(node.color, node.type === "group" ? "#5b5664" : "#8b82f6");
  const style = { "--canvas-node-accent": accent } as CSSProperties;

  return (
    <article
      aria-label={accessibleNodeLabel(node)}
      className={`${CANVAS_NO_PAN_CLASS_NAME} vault-canvas-card vault-canvas-card--${node.type}`}
      onDoubleClick={node.type === "text" && !readOnly ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        runtime?.editTextNode(id);
      } : undefined}
      style={style}
    >
      <NodeResizer
        color={accent}
        isVisible={selected && !readOnly}
        keepAspectRatio={false}
        minHeight={node.type === "group" ? 120 : 96}
        minWidth={node.type === "group" ? 220 : 180}
      />
      <CanvasHandles readOnly={readOnly} />

      {editingText ? (
        <textarea
          aria-label="Canvas 텍스트"
          autoFocus
          className="nodrag nowheel vault-canvas-text-editor"
          onChange={(event) => runtime?.patchNode(id, { text: event.target.value })}
          onDoubleClick={stopCanvasControlEvent}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              runtime?.stopTextNodeEditing(id);
            }
          }}
          onPointerDown={stopCanvasControlEvent}
          readOnly={readOnly}
          value={node.text ?? ""}
        />
      ) : null}

      {node.type === "text" && !editingText ? (
        <CanvasMarkdownPreview label="Canvas 텍스트 Markdown 미리보기" source={node.text ?? ""} />
      ) : null}

      {node.type === "group" ? (
        <div className="vault-canvas-group-content">
          {groupBackgroundAsset ? (
            <VaultAssetPreview
              asset={groupBackgroundAsset}
              className={`vault-canvas-group-background-preview vault-canvas-group-background-preview--${node.backgroundStyle ?? "cover"}`}
              compact
              fileName={groupBackgroundOption?.label ?? node.background ?? "Canvas 그룹 배경"}
              imageMode={node.backgroundStyle === "ratio" ? "contain" : node.backgroundStyle ?? "cover"}
            />
          ) : null}
          <input
            aria-label="Canvas 그룹 이름"
            className="nodrag nowheel vault-canvas-group-label"
            onChange={(event) => runtime?.patchNode(id, { label: event.target.value })}
            onDoubleClick={stopCanvasControlEvent}
            onPointerDown={stopCanvasControlEvent}
            readOnly={readOnly}
            value={node.label ?? ""}
          />
          {node.background ? <span className="vault-canvas-group-background">배경: {node.background}</span> : null}
        </div>
      ) : null}

      {node.type === "file" ? (
        <div className="vault-canvas-file-card">
          {fileOption?.asset ? (
            <>
              <VaultAssetPreview
                asset={fileOption.asset}
                className="nodrag nowheel"
                compact
                fileName={fileOption.label}
                pdfFragment={fileAssetPreviewKind === "pdf" ? `#page=${pdfPage}&zoom=${pdfZoom}` : undefined}
              />
              {fileAssetPreviewKind === "pdf" ? (
                <div aria-label="PDF 페이지 도구" className="nodrag nowheel vault-canvas-pdf-controls" role="group">
                  <button
                    aria-label="이전 PDF 페이지"
                    disabled={pdfPage <= 1}
                    onClick={(event) => {
                      event.stopPropagation();
                      const nextPage = Math.max(1, pdfPage - 1);
                      setPdfPage(nextPage);
                      if (!readOnly) runtime?.patchNode(id, { subpath: `#page=${nextPage}` });
                    }}
                    onPointerDown={stopCanvasControlEvent}
                    type="button"
                  >‹</button>
                  <label>
                    <span className="sr-only">PDF 페이지</span>
                    <input
                      aria-label="PDF 페이지"
                      max={99_999}
                      min={1}
                      onChange={(event) => {
                        const nextPage = Math.max(1, Math.min(99_999, Number(event.target.value) || 1));
                        setPdfPage(nextPage);
                        if (!readOnly) runtime?.patchNode(id, { subpath: `#page=${nextPage}` });
                      }}
                      onPointerDown={stopCanvasControlEvent}
                      type="number"
                      value={pdfPage}
                    />
                  </label>
                  <button
                    aria-label="다음 PDF 페이지"
                    disabled={pdfPage >= 99_999}
                    onClick={(event) => {
                      event.stopPropagation();
                      const nextPage = Math.min(99_999, pdfPage + 1);
                      setPdfPage(nextPage);
                      if (!readOnly) runtime?.patchNode(id, { subpath: `#page=${nextPage}` });
                    }}
                    onPointerDown={stopCanvasControlEvent}
                    type="button"
                  >›</button>
                  <button
                    aria-label="PDF 축소"
                    disabled={pdfZoom <= 50}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPdfZoom((current) => Math.max(50, current - 25));
                    }}
                    onPointerDown={stopCanvasControlEvent}
                    type="button"
                  >−</button>
                  <output aria-label="PDF 확대 비율">{pdfZoom}%</output>
                  <button
                    aria-label="PDF 확대"
                    disabled={pdfZoom >= 400}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPdfZoom((current) => Math.min(400, current + 25));
                    }}
                    onPointerDown={stopCanvasControlEvent}
                    type="button"
                  >+</button>
                </div>
              ) : null}
            </>
          ) : fileOption?.kind === "markdown" && typeof fileOption.content === "string" ? (
            <CanvasMarkdownPreview label="Markdown 노트 미리보기" source={fileOption.content} />
          ) : <span aria-hidden="true" className="vault-canvas-card-icon">📄</span>}
          {selected && !readOnly ? (
            <>
              <span className="vault-canvas-file-label" title={node.file}>
                {fileOption?.label ?? node.file}
              </span>
              <CanvasFileChooser
                accessibleLabel="Canvas 파일 선택"
                buttonText="파일 변경"
                onSelect={(path) => runtime?.patchNode(id, { file: path })}
                options={runtime?.fileOptions ?? []}
                value={node.file ?? ""}
              />
            </>
          ) : (
            <span className="vault-canvas-file-label" title={node.file}>
              {fileOption?.label ?? node.file}
            </span>
          )}
          {node.subpath ? <span className="vault-canvas-file-subpath">{node.subpath}</span> : null}
          <button
            className="nodrag"
            disabled={!safeVaultPath(node.file)}
            onClick={(event) => {
              event.stopPropagation();
              const file = safeVaultPath(node.file);
              if (file) {
                runtime?.onOpenFile(file);
              }
            }}
            onPointerDown={stopCanvasControlEvent}
            type="button"
          >
            원본 열기
          </button>
        </div>
      ) : null}

      {node.type === "link" ? (
        <div className="vault-canvas-link-card">
          <label>
            <span>웹 링크</span>
            <input
              aria-invalid={node.url && !resolvedLink ? "true" : undefined}
              className="nodrag nowheel"
              onChange={(event) => runtime?.patchNode(id, { url: event.target.value })}
              onDoubleClick={stopCanvasControlEvent}
              onPointerDown={stopCanvasControlEvent}
              readOnly={readOnly}
              type="url"
              value={node.url ?? ""}
            />
          </label>
          {resolvedLink ? (
            <>
              <span className="vault-canvas-web-host">
                {new URL(resolvedLink).hostname}
                <small>외부 콘텐츠는 개인정보 보호를 위해 자동으로 불러오지 않습니다.</small>
              </span>
              <a
                className="nodrag vault-canvas-safe-link"
                href={resolvedLink}
                onPointerDown={stopCanvasControlEvent}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer"
                target="_blank"
              >
                안전하게 열기
              </a>
            </>
          ) : (
            <span className="vault-canvas-blocked-link" role="status">http/https 링크만 열 수 있습니다.</span>
          )}
        </div>
      ) : null}
    </article>
  );
}

const CANVAS_NODE_TYPES = { canvasCard: CanvasCardNode };

function flowNode(node: JsonCanvasNode, selected = false): CanvasFlowNode {
  return {
    ariaLabel: accessibleNodeLabel(node),
    className: `vault-canvas-flow-node vault-canvas-flow-node--${node.type}`,
    data: { canvas: { ...node } },
    id: node.id,
    position: { x: node.x, y: node.y },
    selected,
    style: {
      height: node.height,
      width: node.width
    },
    type: "canvasCard"
  };
}

function flowEdge(edge: JsonCanvasEdge, selected = false): CanvasFlowEdge {
  const color = safeCanvasColor(edge.color);
  const ends = effectiveJsonCanvasEdgeEnds(edge);
  return {
    data: { ...edge },
    id: edge.id,
    label: edge.label,
    labelBgBorderRadius: 4,
    labelBgPadding: [5, 3],
    labelBgStyle: { fill: "var(--vault-canvas-card)", fillOpacity: 0.96 },
    labelStyle: { fill: "var(--vault-text)", fontSize: 12 },
    markerEnd: ends.toEnd === "arrow" ? { color, type: MarkerType.ArrowClosed } : undefined,
    markerStart: ends.fromEnd === "arrow" ? { color, type: MarkerType.ArrowClosed } : undefined,
    selected,
    source: edge.fromNode,
    sourceHandle: `source-${edge.fromSide ?? "right"}`,
    style: { stroke: color, strokeWidth: selected ? 2.5 : 1.5 },
    target: edge.toNode,
    targetHandle: `target-${edge.toSide ?? "left"}`
  };
}

function handleSide(value: string | null | undefined, prefix: "source" | "target") {
  const side = value?.startsWith(`${prefix}-`) ? value.slice(prefix.length + 1) : undefined;
  return JSON_CANVAS_SIDES.includes(side as JsonCanvasSide) ? side as JsonCanvasSide : undefined;
}

function createCanvasId(prefix: "node" | "edge") {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function isFormControl(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, button, a, [contenteditable='true']"));
}

interface CanvasContextMenuAction {
  disabled?: boolean;
  destructive?: boolean;
  id: string;
  label: string;
}

function CanvasContextMenu({
  actions,
  clientX,
  clientY,
  onClose,
  onSelect
}: CanvasContextMenuState & {
  actions: readonly CanvasContextMenuAction[];
  onClose: () => void;
  onSelect: (actionId: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const viewportWidth = typeof window === "undefined" ? clientX + 232 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? clientY + 360 : window.innerHeight;
  const position = {
    left: Math.max(8, Math.min(clientX, viewportWidth - 232)),
    top: Math.max(8, Math.min(clientY, viewportHeight - Math.min(360, actions.length * 42 + 16)))
  };

  useEffect(() => {
    const menu = menuRef.current;
    (menu?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu)?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const dismissForViewportChange = () => onClose();
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", dismissForViewportChange);
    window.addEventListener("blur", dismissForViewportChange);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", dismissForViewportChange);
      window.removeEventListener("blur", dismissForViewportChange);
    };
  }, [onClose]);

  if (typeof document === "undefined") {
    return null;
  }
  return createPortal(
    <div
      ref={menuRef}
      aria-label="Canvas 항목 메뉴"
      className="vault-canvas-context-menu"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape" || event.key === "Tab") {
          onClose();
          return;
        }
        let nextIndex: number | null = null;
        if (event.key === "ArrowDown") {
          nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length;
        } else if (event.key === "ArrowUp") {
          nextIndex = activeIndex < 0 ? items.length - 1 : (activeIndex - 1 + items.length) % items.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = items.length - 1;
        }
        if (nextIndex !== null && items.length > 0 && items[nextIndex]) {
          event.preventDefault();
          items[nextIndex].focus();
        }
      }}
      onPointerDown={stopCanvasControlEvent}
      role="menu"
      style={position}
      tabIndex={-1}
    >
      {actions.map((action) => (
        <button
          className={action.destructive ? "vault-canvas-context-menu-danger" : undefined}
          disabled={action.disabled}
          key={action.id}
          onClick={() => {
            onSelect(action.id);
            onClose();
          }}
          role="menuitem"
          type="button"
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body
  );
}

function documentToFlow(
  document: JsonCanvasDocument,
  selectedNodeIds: ReadonlySet<string> = new Set(),
  selectedEdgeIds: ReadonlySet<string> = new Set()
) {
  return {
    nodes: document.nodes.map((node) => flowNode(node, selectedNodeIds.has(node.id))),
    edges: document.edges.map((edge) => flowEdge(edge, selectedEdgeIds.has(edge.id)))
  };
}

export function JsonCanvasView({
  fileOptions,
  onChange,
  onImportExternalFiles,
  onOpenFile,
  readOnly = false,
  resolveVaultEntryDrop,
  source
}: JsonCanvasViewProps) {
  const parseResult = useMemo(() => parseCanvasDocument(source), [source]);
  const parsed = parseResult.document;
  const canvasReadOnly = readOnly || !parseResult.editable;
  const initialFlow = useMemo(() => documentToFlow(parsed), [parsed]);
  const [nodes, setNodes] = useState<CanvasFlowNode[]>(() => initialFlow.nodes);
  const [edges, setEdges] = useState<CanvasFlowEdge[]>(() => initialFlow.edges);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [fileDraft, setFileDraft] = useState("");
  const [linkDraft, setLinkDraft] = useState("https://");
  const [status, setStatus] = useState("");
  const [externalDropActive, setExternalDropActive] = useState(false);
  const [flowReady, setFlowReady] = useState(false);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [edgeLabelEditRequest, setEdgeLabelEditRequest] = useState<string | null>(null);
  const [editingTextNodeId, setEditingTextNodeId] = useState<string | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const groupDragRef = useRef<CanvasGroupDragState | null>(null);
  const nodeDragCommitRef = useRef<CanvasNodeDragCommitState | null>(null);
  const longPressRef = useRef<CanvasLongPressState | null>(null);
  const documentRef = useRef(parsed);
  const sourceRef = useRef(source);
  const canonicalSourceRef = useRef(`${JSON.stringify(parsed, null, 2)}\n`);
  const flowInstanceRef = useRef<ReactFlowInstance<CanvasFlowNode, CanvasFlowEdge> | null>(null);
  const canvasSectionRef = useRef<HTMLElement | null>(null);
  const edgeLabelInputRef = useRef<HTMLInputElement | null>(null);
  const dropHelpId = useId();

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const cancelLongPress = useCallback((pointerId?: number) => {
    const pending = longPressRef.current;
    if (!pending || (pointerId !== undefined && pending.pointerId !== pointerId)) {
      return;
    }
    clearTimeout(pending.timer);
    longPressRef.current = null;
  }, []);

  useEffect(() => () => {
    cancelLongPress();
    groupDragRef.current = null;
    nodeDragCommitRef.current = null;
  }, [cancelLongPress]);

  useEffect(() => {
    if (canvasReadOnly || (!resolveVaultEntryDrop && !onImportExternalFiles)) {
      setExternalDropActive(false);
    }
  }, [canvasReadOnly, onImportExternalFiles, resolveVaultEntryDrop]);

  const commit = useCallback((nextNodes: CanvasFlowNode[], nextEdges: CanvasFlowEdge[]) => {
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
    const nextDocument = canvasDocumentFromFlow(nextNodes, nextEdges, documentRef.current);
    documentRef.current = nextDocument;
    const serialized = `${JSON.stringify(nextDocument, null, 2)}\n`;
    if (serialized === canonicalSourceRef.current) {
      return;
    }
    canonicalSourceRef.current = serialized;
    sourceRef.current = serialized;
    onChange(serialized);
  }, [onChange]);

  const settleNodeDragCommit = useCallback((
    drag: CanvasNodeDragCommitState,
    signal: CanvasNodeDragCommitSignal,
    positionChanged = false
  ) => {
    if (nodeDragCommitRef.current !== drag) {
      return;
    }
    const applyDecision = (decision: CanvasNodeDragCommitDecision) => {
      if (decision === "clear") {
        nodeDragCommitRef.current = null;
        return true;
      }
      if (decision === "flush" || decision === "flush-and-clear") {
        commit(nodesRef.current, edgesRef.current);
        if (decision === "flush-and-clear") {
          nodeDragCommitRef.current = null;
        }
        return true;
      }
      return false;
    };
    if (applyDecision(recordCanvasNodeDragCommitSignal(drag, signal, positionChanged))) {
      return;
    }
    if (!drag.positionChanged || signal === "fallback") {
      return;
    }
    if (drag.flushScheduled) {
      return;
    }

    // React Flow currently emits its final `dragging: false` change and drag
    // stop callback in one event turn. Deferring the single-signal fallback to
    // a microtask makes the order irrelevant while still persisting a final
    // coordinate if one of those callbacks is omitted by an interrupted input.
    drag.flushScheduled = true;
    queueMicrotask(() => {
      drag.flushScheduled = false;
      if (
        nodeDragCommitRef.current !== drag
      ) {
        return;
      }
      applyDecision(recordCanvasNodeDragCommitSignal(drag, "fallback"));
    });
  }, [commit]);

  useEffect(() => {
    if (source === sourceRef.current) {
      return;
    }
    sourceRef.current = source;
    const nextDocument = safeCanvasDocument(source);
    const nextFlow = documentToFlow(nextDocument);
    documentRef.current = nextDocument;
    canonicalSourceRef.current = `${JSON.stringify(nextDocument, null, 2)}\n`;
    groupDragRef.current = null;
    nodeDragCommitRef.current = null;
    nodesRef.current = nextFlow.nodes;
    edgesRef.current = nextFlow.edges;
    setNodes(nextFlow.nodes);
    setEdges(nextFlow.edges);
    setEditingTextNodeId(null);
  }, [source]);

  const patchNode = useCallback((nodeId: string, patch: Partial<JsonCanvasNode>) => {
    if (canvasReadOnly) {
      return;
    }
    const measuredDocument = canvasDocumentFromFlow(nodesRef.current, edgesRef.current, documentRef.current);
    const nextDocument: JsonCanvasDocument = {
      ...measuredDocument,
      nodes: measuredDocument.nodes.map((node) => node.id === nodeId ? { ...node, ...patch, id: node.id, type: node.type } : node)
    };
    const selectedNodes = new Set(nodesRef.current.filter((node) => node.selected).map((node) => node.id));
    const selectedEdges = new Set(edgesRef.current.filter((edge) => edge.selected).map((edge) => edge.id));
    const nextFlow = documentToFlow(nextDocument, selectedNodes, selectedEdges);
    commit(nextFlow.nodes, nextFlow.edges);
  }, [canvasReadOnly, commit]);

  const safeFileOptions = useMemo(() => fileOptions.filter((option) => Boolean(safeVaultPath(option.path))), [fileOptions]);
  const fileOptionsByPath = useMemo(() => {
    const index = new Map<string, JsonCanvasFileOption>();
    for (const option of safeFileOptions) {
      const path = option.path;
      if (!index.has(path)) {
        index.set(path, option);
      }
    }
    return index;
  }, [safeFileOptions]);
  const editTextNode = useCallback((nodeId: string) => {
    if (
      canvasReadOnly
      || !nodesRef.current.some((node) => node.id === nodeId && node.data.canvas.type === "text")
    ) {
      return;
    }
    const nextNodes = nodesRef.current.map((node) => ({ ...node, selected: node.id === nodeId }));
    const nextEdges = edgesRef.current.map((edge) => edge.selected ? { ...edge, selected: false } : edge);
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
    setEditingTextNodeId(nodeId);
    setStatus("텍스트 카드를 편집합니다.");
  }, [canvasReadOnly]);
  const stopTextNodeEditing = useCallback((nodeId?: string) => {
    setEditingTextNodeId((current) => !nodeId || current === nodeId ? null : current);
  }, []);
  const runtime = useMemo<CanvasRuntime>(() => ({
    editTextNode,
    editingTextNodeId,
    fileOptions: safeFileOptions,
    fileOptionsByPath,
    onOpenFile,
    patchNode,
    readOnly: canvasReadOnly,
    stopTextNodeEditing
  }), [canvasReadOnly, editTextNode, editingTextNodeId, fileOptionsByPath, onOpenFile, patchNode, safeFileOptions, stopTextNodeEditing]);

  const changeNodes = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    if (canvasReadOnly && changes.some((change) => change.type !== "select")) {
      return;
    }
    const previousNodes = nodesRef.current;
    let nextNodes = applyNodeChanges(changes, previousNodes);
    const groupDrag = groupDragRef.current;
    if (groupDrag) {
      const previousGroup = previousNodes.find((node) => node.id === groupDrag.groupId);
      const nextGroup = nextNodes.find((node) => node.id === groupDrag.groupId);
      const explicitPositionChanges = new Set(changes.flatMap((change) => (
        change.type === "position" ? [change.id] : []
      )));
      const deltaX = (nextGroup?.position.x ?? 0) - (previousGroup?.position.x ?? 0);
      const deltaY = (nextGroup?.position.y ?? 0) - (previousGroup?.position.y ?? 0);
      if ((deltaX || deltaY) && Number.isFinite(deltaX) && Number.isFinite(deltaY)) {
        nextNodes = nextNodes.map((node) => (
          groupDrag.memberIds.has(node.id) && !explicitPositionChanges.has(node.id)
            ? { ...node, position: { x: node.position.x + deltaX, y: node.position.y + deltaY } }
            : node
        ));
      }
    }
    const nodeDragCommit = nodeDragCommitRef.current;
    const hasActiveNodeDragPositionChange = Boolean(nodeDragCommit && changes.some((change) => (
      change.type === "position" && change.id === nodeDragCommit.nodeId
    )));
    const hasNodeDragFinalChange = Boolean(nodeDragCommit && changes.some((change) => (
      change.type === "position"
      && change.id === nodeDragCommit.nodeId
      && change.dragging === false
    )));
    if (nodeDragCommit && hasActiveNodeDragPositionChange && !hasNodeDragFinalChange) {
      nodeDragCommit.positionChanged = true;
    }
    if (changes.every((change) => change.type === "select")) {
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      return;
    }
    const survivingIds = new Set(nextNodes.map((node) => node.id));
    const nextEdges = edgesRef.current.filter((edge) => survivingIds.has(edge.source) && survivingIds.has(edge.target));
    const isTransientInteraction = changes.some((change) => (
      (change.type === "position" && change.dragging === true)
      || (change.type === "dimensions" && change.resizing === true)
    )) || hasActiveNodeDragPositionChange;
    if (isTransientInteraction) {
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setNodes(nextNodes);
      setEdges(nextEdges);
      if (nodeDragCommit && hasNodeDragFinalChange) {
        settleNodeDragCommit(nodeDragCommit, "final-change", true);
      }
      return;
    }
    commit(nextNodes, nextEdges);
  }, [canvasReadOnly, commit, settleNodeDragCommit]);

  const startNodeDrag = useCallback<OnNodeDrag<CanvasFlowNode>>((_event, node) => {
    if (canvasReadOnly) {
      groupDragRef.current = null;
      nodeDragCommitRef.current = null;
      return;
    }
    nodeDragCommitRef.current = createCanvasNodeDragCommitState(node.id);
    if (node.data.canvas.type !== "group") {
      groupDragRef.current = null;
      return;
    }
    const document = canvasDocumentFromFlow(nodesRef.current, edgesRef.current, documentRef.current);
    groupDragRef.current = {
      groupId: node.id,
      memberIds: containedJsonCanvasNodeIds(document, new Set([node.id]))
    };
  }, [canvasReadOnly]);

  const stopNodeDrag = useCallback<OnNodeDrag<CanvasFlowNode>>((_event, node, draggedNodes) => {
    const draggedGroup = groupDragRef.current;
    groupDragRef.current = null;
    if (canvasReadOnly) {
      nodeDragCommitRef.current = null;
      return;
    }
    const nodeDragCommit = nodeDragCommitRef.current?.nodeId === node.id
      ? nodeDragCommitRef.current
      : null;
    if (!nodeDragCommit) {
      commit(nodesRef.current, edgesRef.current);
    } else {
      let terminalPositionChanged = false;
      if (!nodeDragCommit.finalChangeSeen) {
        const finalPositions = new Map((draggedNodes?.length ? draggedNodes : [node]).map((draggedNode) => (
          [draggedNode.id, draggedNode.position] as const
        )));
        const nextNodes = nodesRef.current.map((current) => {
          const position = finalPositions.get(current.id);
          if (
            !position
            || (position.x === current.position.x && position.y === current.position.y)
          ) {
            return current;
          }
          terminalPositionChanged = true;
          return { ...current, position: { ...position } };
        });
        if (terminalPositionChanged) {
          nodesRef.current = nextNodes;
          setNodes(nextNodes);
        }
      }
      settleNodeDragCommit(nodeDragCommit, "stop", terminalPositionChanged);
    }
    if (draggedGroup?.groupId === node.id && draggedGroup.memberIds.size > 0) {
      setStatus(`그룹과 안의 카드 ${draggedGroup.memberIds.size}개를 함께 옮겼습니다.`);
    }
  }, [canvasReadOnly, commit, settleNodeDragCommit]);

  const changeEdges = useCallback((changes: EdgeChange<CanvasFlowEdge>[]) => {
    if (canvasReadOnly && changes.some((change) => change.type !== "select")) {
      return;
    }
    const nextEdges = applyEdgeChanges(changes, edgesRef.current);
    if (changes.every((change) => change.type === "select")) {
      edgesRef.current = nextEdges;
      setEdges(nextEdges);
      return;
    }
    commit(nodesRef.current, nextEdges);
  }, [canvasReadOnly, commit]);

  const connect = useCallback((connection: Connection) => {
    if (canvasReadOnly || !connection.source || !connection.target) {
      return;
    }
    const id = createCanvasId("edge");
    const edge: JsonCanvasEdge = {
      id,
      fromNode: connection.source,
      fromSide: handleSide(connection.sourceHandle, "source"),
      fromEnd: "none",
      toNode: connection.target,
      toSide: handleSide(connection.targetHandle, "target"),
      toEnd: "arrow"
    };
    commit(nodesRef.current, [...edgesRef.current, flowEdge(edge)]);
    setStatus("연결선을 만들었습니다.");
  }, [canvasReadOnly, commit]);

  const reconnect = useCallback((oldEdge: CanvasFlowEdge, connection: Connection) => {
    if (canvasReadOnly || !connection.source || !connection.target) {
      return;
    }
    const reconnected = reconnectEdge(oldEdge, connection, edgesRef.current).map((edge) => {
      if (edge.id !== oldEdge.id) {
        return edge;
      }
      return flowEdge({
        ...(edge.data ?? oldEdge.data ?? {}),
        id: edge.id,
        fromNode: connection.source!,
        fromSide: handleSide(connection.sourceHandle, "source"),
        toNode: connection.target!,
        toSide: handleSide(connection.targetHandle, "target")
      }, edge.selected);
    });
    commit(nodesRef.current, reconnected);
    setStatus("연결선 끝점을 옮겼습니다.");
  }, [canvasReadOnly, commit]);

  const addNode = useCallback((node: JsonCanvasNode) => {
    const unselected = nodesRef.current.map((current) => ({ ...current, selected: false }));
    commit([...unselected, flowNode(node, true)], edgesRef.current.map((edge) => ({ ...edge, selected: false })));
  }, [commit]);

  const hasVaultEntryDragType = useCallback((event: ReactDragEvent<HTMLElement>) =>
    containsJsonCanvasVaultEntryDragType(Array.from(event.dataTransfer.types)), []);

  const hasExternalFileDragType = useCallback((event: ReactDragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes("Files"), []);

  const dropFlowPosition = useCallback((clientX: number, clientY: number) => {
    const flowInstance = flowInstanceRef.current;
    if (!flowInstance) {
      return null;
    }
    let position = flowInstance.screenToFlowPosition({ x: clientX, y: clientY });
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      const viewport = flowInstance.getViewport();
      const bounds = canvasSectionRef.current?.getBoundingClientRect();
      if (
        bounds
        && Number.isFinite(clientX)
        && Number.isFinite(clientY)
        && Number.isFinite(viewport.x)
        && Number.isFinite(viewport.y)
        && Number.isFinite(viewport.zoom)
        && viewport.zoom > 0
      ) {
        position = {
          x: (clientX - bounds.left - viewport.x) / viewport.zoom,
          y: (clientY - bounds.top - viewport.y) / viewport.zoom
        };
      }
    }
    return Number.isFinite(position.x) && Number.isFinite(position.y) ? position : null;
  }, []);

  const handleExternalDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    const vaultEntryDrag = hasVaultEntryDragType(event);
    const externalFileDrag = !vaultEntryDrag && hasExternalFileDragType(event);
    if (!vaultEntryDrag && !externalFileDrag) {
      return;
    }
    event.preventDefault();
    if (
      canvasReadOnly
      || (vaultEntryDrag && !resolveVaultEntryDrop)
      || (externalFileDrag && !onImportExternalFiles)
    ) {
      event.dataTransfer.dropEffect = "none";
      setExternalDropActive(false);
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    setExternalDropActive(true);
  }, [
    canvasReadOnly,
    hasExternalFileDragType,
    hasVaultEntryDragType,
    onImportExternalFiles,
    resolveVaultEntryDrop
  ]);

  const handleExternalDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    const relatedTarget = event.relatedTarget;
    if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
      setExternalDropActive(false);
    }
  }, []);

  const handleExternalDrop = useCallback(async (event: ReactDragEvent<HTMLElement>) => {
    const vaultEntryDrag = hasVaultEntryDragType(event);
    const externalFileDrag = !vaultEntryDrag && hasExternalFileDragType(event);
    if (!vaultEntryDrag && !externalFileDrag) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setExternalDropActive(false);
    const clientX = event.clientX;
    const clientY = event.clientY;

    if (canvasReadOnly) {
      setStatus("읽기 전용 Canvas에는 파일을 놓을 수 없습니다.");
      return;
    }
    if (externalFileDrag) {
      if (!onImportExternalFiles) {
        setStatus("외부 파일을 암호화해 저장하는 연결이 준비되지 않았습니다.");
        return;
      }
      const files = Array.from(event.dataTransfer.files).slice(0, MAX_CANVAS_EXTERNAL_DROP_FILES);
      const available = MAX_CANVAS_DROP_NODES - nodesRef.current.length;
      const position = dropFlowPosition(clientX, clientY);
      if (!files.length || available <= 0 || !position) {
        setStatus(!files.length
          ? "드래그한 외부 파일을 확인하지 못했습니다."
          : !position
            ? "Canvas가 준비된 뒤 다시 놓아 주세요."
            : "Canvas 카드 수가 안전한 편집 제한에 도달했습니다.");
        return;
      }
      setStatus(`${files.length}개 외부 파일을 E2EE asset-v1로 저장하는 중입니다…`);
      let importResult: { paths: readonly string[]; rejected: number };
      try {
        importResult = await onImportExternalFiles(files);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "외부 파일을 암호화해 저장하지 못했습니다.");
        return;
      }
      const rejectedCount = Number.isSafeInteger(importResult.rejected) && importResult.rejected > 0
        ? Math.min(files.length, importResult.rejected)
        : 0;
      const existingNodeIds = new Set(nodesRef.current.map((candidate) => candidate.id));
      const created: CanvasFlowNode[] = [];
      for (const [index, importedPath] of importResult.paths.slice(0, available).entries()) {
        const node = createDroppedJsonCanvasFileNode({
          existingNodeIds,
          path: importedPath,
          position: { x: position.x + index * 24, y: position.y + index * 24 },
          snapToGrid
        });
        if (node) {
          existingNodeIds.add(node.id);
          created.push(flowNode(node, true));
        }
      }
      if (!created.length) {
        setStatus(rejectedCount >= files.length
          ? "외부 파일을 안전 제한 또는 저장 오류로 추가하지 못했습니다."
          : "암호화 저장 결과에서 안전한 Vault 경로를 확인하지 못했습니다.");
        return;
      }
      commit(
        [...nodesRef.current.map((node) => ({ ...node, selected: false })), ...created],
        edgesRef.current.map((edge) => ({ ...edge, selected: false }))
      );
      setStatus(`${created.length}개 외부 파일을 암호화해 Canvas에 추가했습니다.${rejectedCount ? ` ${rejectedCount}개는 안전 제한 또는 저장 오류로 제외했습니다.` : ""}`);
      return;
    }
    if (!resolveVaultEntryDrop) {
      setStatus("파일 탐색기 드래그 연결이 준비되지 않았습니다. 노트 추가 도구를 사용하세요.");
      return;
    }
    if (nodesRef.current.length >= MAX_CANVAS_DROP_NODES) {
      setStatus("Canvas 카드 수가 안전한 편집 제한에 도달했습니다.");
      return;
    }

    let rawPayload = "";
    try {
      rawPayload = event.dataTransfer.getData(JSON_CANVAS_VAULT_ENTRY_MIME);
    } catch {
      setStatus("드래그한 노트를 확인할 수 없습니다.");
      return;
    }
    const payload = parseJsonCanvasVaultEntryDragPayload(rawPayload);
    if (!payload) {
      setStatus("안전하지 않거나 만료된 노트 드래그를 거부했습니다.");
      return;
    }

    let resolvedPath: string | null | undefined;
    try {
      resolvedPath = resolveVaultEntryDrop(payload.entryId);
    } catch {
      setStatus("드래그한 노트에 접근할 수 없습니다.");
      return;
    }
    const safePath = safeVaultPath(resolvedPath ?? undefined);
    if (!safePath || !fileOptionsByPath.has(safePath)) {
      setStatus("현재 Vault에서 열 수 없는 노트는 추가하지 않았습니다.");
      return;
    }

    const position = dropFlowPosition(clientX, clientY);
    if (!position) {
      setStatus("Canvas가 준비된 뒤 다시 놓아 주세요.");
      return;
    }
    const node = createDroppedJsonCanvasFileNode({
      existingNodeIds: new Set(nodesRef.current.map((candidate) => candidate.id)),
      path: safePath,
      position,
      snapToGrid
    });
    if (!node) {
      setStatus("노트를 안전한 Canvas 위치에 추가할 수 없습니다.");
      return;
    }
    addNode(node);
    setStatus("노트 카드를 놓은 위치에 추가했습니다.");
  }, [
    addNode,
    canvasReadOnly,
    commit,
    dropFlowPosition,
    fileOptionsByPath,
    hasExternalFileDragType,
    hasVaultEntryDragType,
    onImportExternalFiles,
    resolveVaultEntryDrop,
    snapToGrid
  ]);

  const addTextNode = useCallback(() => {
    const offset = (nodesRef.current.length % 8) * 28;
    addNode({ id: createCanvasId("node"), type: "text", x: 80 + offset, y: 80 + offset, width: 280, height: 160, text: "새 메모" });
  }, [addNode]);

  const addGroupNode = useCallback(() => {
    const offset = (nodesRef.current.length % 5) * 24;
    addNode({ id: createCanvasId("node"), type: "group", x: 40 + offset, y: 40 + offset, width: 640, height: 420, label: "새 그룹" });
  }, [addNode]);

  const selectedFilePath = fileOptionsByPath.has(fileDraft) ? fileDraft : safeFileOptions[0]?.path ?? "";

  const addFileNode = useCallback(() => {
    if (!selectedFilePath) {
      setStatus("추가할 수 있는 노트가 없습니다.");
      return;
    }
    const offset = (nodesRef.current.length % 8) * 28;
    addNode({ id: createCanvasId("node"), type: "file", x: 120 + offset, y: 120 + offset, width: 300, height: 180, file: selectedFilePath });
  }, [addNode, selectedFilePath]);

  const addLinkNode = useCallback(() => {
    const url = safeHttpUrl(linkDraft);
    if (!url) {
      setStatus("http 또는 https 주소만 추가할 수 있습니다.");
      return;
    }
    const offset = (nodesRef.current.length % 8) * 28;
    addNode({ id: createCanvasId("node"), type: "link", x: 160 + offset, y: 160 + offset, width: 320, height: 150, url });
    setStatus("웹 링크 카드를 추가했습니다.");
  }, [addNode, linkDraft]);

  const selectedNodeIds = useMemo(() => new Set(nodes.filter((node) => node.selected).map((node) => node.id)), [nodes]);
  const selectedEdges = useMemo(() => edges.filter((edge) => edge.selected), [edges]);
  const selectedCount = selectedNodeIds.size + selectedEdges.length;

  useEffect(() => {
    if (edgeLabelEditRequest && selectedEdges.some((edge) => edge.id === edgeLabelEditRequest)) {
      edgeLabelInputRef.current?.focus();
      edgeLabelInputRef.current?.select();
      setEdgeLabelEditRequest(null);
    }
  }, [edgeLabelEditRequest, selectedEdges]);

  const selectCanvasItems = useCallback((nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string> = new Set()) => {
    const nextNodes = nodesRef.current.map((node) => node.selected === nodeIds.has(node.id)
      ? node
      : { ...node, selected: nodeIds.has(node.id) });
    const nextEdges = edgesRef.current.map((edge) => edge.selected === edgeIds.has(edge.id)
      ? edge
      : flowEdge(edge.data ?? {
        id: edge.id,
        fromNode: edge.source,
        toNode: edge.target
      }, edgeIds.has(edge.id)));
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, []);

  const handleCanvasDoubleClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (
      event.button !== 0
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
      || !(event.target instanceof HTMLElement)
    ) {
      return;
    }
    const nodeElement = event.target.closest<HTMLElement>(".react-flow__node");
    const node = nodesRef.current.find((candidate) => candidate.id === nodeElement?.dataset.id);
    const file = node?.data.canvas.type === "file" ? safeVaultPath(node.data.canvas.file) : null;
    if (file) {
      event.preventDefault();
      event.stopPropagation();
      onOpenFile(file);
      setStatus("원본 노트를 열었습니다.");
      return;
    }
    if (canvasReadOnly) {
      return;
    }
    if (node?.data.canvas.type === "text") {
      event.preventDefault();
      editTextNode(node.id);
      return;
    }
    if (!event.target.classList.contains("react-flow__pane")) {
      return;
    }
    const position = dropFlowPosition(event.clientX, event.clientY);
    const x = boundedDropCoordinate(position?.x ?? Number.NaN, CANVAS_DROP_GRID[0], snapToGrid);
    const y = boundedDropCoordinate(position?.y ?? Number.NaN, CANVAS_DROP_GRID[1], snapToGrid);
    if (x === null || y === null) {
      return;
    }
    event.preventDefault();
    addNode({ id: createCanvasId("node"), type: "text", x, y, width: 280, height: 160, text: "" });
    setStatus("선택한 위치에 텍스트 카드를 추가했습니다.");
  }, [addNode, canvasReadOnly, dropFlowPosition, editTextNode, onOpenFile, snapToGrid]);

  const selectGroupContents = useCallback((groupId: string) => {
    const current = canvasDocumentFromFlow(nodesRef.current, edgesRef.current, documentRef.current);
    const expanded = expandJsonCanvasGroupSelection(current, new Set([groupId]));
    selectCanvasItems(expanded);
    setStatus(`그룹과 안의 카드 ${Math.max(0, expanded.size - 1)}개를 선택했습니다.`);
  }, [selectCanvasItems]);

  const nudgeSelection = useCallback((deltaX: number, deltaY: number) => {
    if (canvasReadOnly || selectedNodeIds.size === 0) {
      return;
    }
    const current = canvasDocumentFromFlow(nodesRef.current, edgesRef.current, documentRef.current);
    const effectiveSelection = expandJsonCanvasGroupSelection(current, selectedNodeIds);
    const translated = translateJsonCanvasNodes(current, effectiveSelection, deltaX, deltaY);
    const selectedEdgeIds = new Set(selectedEdges.map((edge) => edge.id));
    const nextFlow = documentToFlow(translated, selectedNodeIds, selectedEdgeIds);
    commit(nextFlow.nodes, nextFlow.edges);
    setStatus(`선택한 카드를 ${Math.abs(deltaX || deltaY)}px 옮겼습니다.`);
  }, [canvasReadOnly, commit, selectedEdges, selectedNodeIds]);

  const openNodeContextMenu = useCallback<NodeMouseHandler<CanvasFlowNode>>((event, node) => {
    event.preventDefault();
    if (!node.selected) {
      selectCanvasItems(new Set([node.id]));
    }
    setContextMenu({
      clientX: event.clientX,
      clientY: event.clientY,
      kind: "node",
      targetId: node.id
    });
  }, [selectCanvasItems]);

  const openEdgeContextMenu = useCallback((event: ReactMouseEvent, edge: CanvasFlowEdge) => {
    event.preventDefault();
    if (!edge.selected) {
      selectCanvasItems(new Set(), new Set([edge.id]));
    }
    setContextMenu({
      clientX: event.clientX,
      clientY: event.clientY,
      kind: "edge",
      targetId: edge.id
    });
  }, [selectCanvasItems]);

  const editEdgeLabel = useCallback((event: ReactMouseEvent, edge: CanvasFlowEdge) => {
    event.preventDefault();
    event.stopPropagation();
    if (!edge.selected) {
      selectCanvasItems(new Set(), new Set([edge.id]));
    }
    setEdgeLabelEditRequest(edge.id);
    setStatus("연결선 이름을 편집합니다.");
  }, [selectCanvasItems]);

  const openPaneContextMenu = useCallback((event: ReactMouseEvent | MouseEvent) => {
    event.preventDefault();
    const flowPosition = flowInstanceRef.current?.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY
    });
    setContextMenu({
      clientX: event.clientX,
      clientY: event.clientY,
      flowPosition: flowPosition && Number.isFinite(flowPosition.x) && Number.isFinite(flowPosition.y)
        ? flowPosition
        : undefined,
      kind: "pane"
    });
  }, []);

  const startLongPress = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    cancelLongPress();
    if (event.pointerType !== "touch" || isFormControl(event.target)) {
      return;
    }
    const nodeElement = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>(".react-flow__node")
      : null;
    const nodeId = nodeElement?.dataset.id;
    if (!nodeId || !nodesRef.current.some((node) => node.id === nodeId)) {
      return;
    }
    const pending: CanvasLongPressState = {
      clientX: event.clientX,
      clientY: event.clientY,
      nodeId,
      pointerId: event.pointerId,
      timer: setTimeout(() => {
        if (longPressRef.current !== pending) {
          return;
        }
        const target = nodesRef.current.find((node) => node.id === pending.nodeId);
        if (!target) {
          longPressRef.current = null;
          return;
        }
        if (!target.selected) {
          selectCanvasItems(new Set([target.id]));
        }
        setContextMenu({
          clientX: pending.clientX,
          clientY: pending.clientY,
          kind: "node",
          targetId: target.id
        });
        setStatus("길게 눌러 Canvas 항목 메뉴를 열었습니다.");
        longPressRef.current = null;
      }, CANVAS_LONG_PRESS_MS)
    };
    longPressRef.current = pending;
  }, [cancelLongPress, selectCanvasItems]);

  const moveLongPress = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pending = longPressRef.current;
    if (
      pending
      && pending.pointerId === event.pointerId
      && Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) > CANVAS_LONG_PRESS_MOVE_TOLERANCE_PX
    ) {
      cancelLongPress(event.pointerId);
    }
  }, [cancelLongPress]);

  const duplicateSelection = useCallback(() => {
    if (canvasReadOnly || selectedNodeIds.size === 0) {
      return;
    }
    const current = canvasDocumentFromFlow(nodesRef.current, edgesRef.current, documentRef.current);
    const result = duplicateJsonCanvasSelection(current, selectedNodeIds, (kind) => createCanvasId(kind));
    const nextFlow = documentToFlow(result.document, result.newNodeIds);
    commit(nextFlow.nodes, nextFlow.edges);
    setStatus(`${result.newNodeIds.size}개 카드를 복제했습니다.`);
  }, [canvasReadOnly, commit, selectedNodeIds]);

  const deleteSelection = useCallback(() => {
    if (canvasReadOnly || selectedCount === 0) {
      return;
    }
    const nextNodes = nodesRef.current.filter((node) => !node.selected);
    const survivingIds = new Set(nextNodes.map((node) => node.id));
    const nextEdges = edgesRef.current.filter((edge) => !edge.selected && survivingIds.has(edge.source) && survivingIds.has(edge.target));
    commit(nextNodes, nextEdges);
    setStatus("선택 항목을 삭제했습니다.");
  }, [canvasReadOnly, commit, selectedCount]);

  const alignSelection = useCallback((alignment: CanvasAlignment) => {
    if (selectedNodeIds.size < 2) {
      setStatus("정렬하려면 카드를 두 개 이상 선택하세요.");
      return;
    }
    const current = canvasDocumentFromFlow(nodesRef.current, edgesRef.current, documentRef.current);
    const aligned = alignJsonCanvasNodes(current, selectedNodeIds, alignment);
    const nextFlow = documentToFlow(aligned, selectedNodeIds, new Set(selectedEdges.map((edge) => edge.id)));
    commit(nextFlow.nodes, nextFlow.edges);
    setStatus("선택한 카드를 정렬했습니다.");
  }, [commit, selectedEdges, selectedNodeIds]);

  const distributeSelection = useCallback((distribution: CanvasDistribution) => {
    if (canvasReadOnly || selectedNodeIds.size < 3) {
      setStatus("배치하려면 카드를 세 개 이상 선택하세요.");
      return;
    }
    const selectedEdgeIds = new Set(selectedEdges.map((edge) => edge.id));
    const current = canvasDocumentFromFlow(nodesRef.current, edgesRef.current, documentRef.current);
    const distributed = distributeJsonCanvasNodes(current, selectedNodeIds, distribution);
    const nextFlow = documentToFlow(distributed, selectedNodeIds, selectedEdgeIds);
    commit(nextFlow.nodes, nextFlow.edges);
    setStatus(distribution === "horizontal"
      ? "선택한 카드의 가로 간격을 같게 배치했습니다."
      : "선택한 카드의 세로 간격을 같게 배치했습니다.");
  }, [canvasReadOnly, commit, selectedEdges, selectedNodeIds]);

  const reorderSelection = useCallback((stackOrder: CanvasStackOrder) => {
    if (
      canvasReadOnly
      || selectedNodeIds.size === 0
      || selectedNodeIds.size === nodesRef.current.length
    ) {
      return;
    }
    const selectedEdgeIds = new Set(selectedEdges.map((edge) => edge.id));
    const current = canvasDocumentFromFlow(nodesRef.current, edgesRef.current, documentRef.current);
    const reordered = reorderJsonCanvasNodes(current, selectedNodeIds, stackOrder);
    const nextFlow = documentToFlow(reordered, selectedNodeIds, selectedEdgeIds);
    commit(nextFlow.nodes, nextFlow.edges);
    setStatus(stackOrder === "front"
      ? "선택한 카드를 맨 앞으로 옮겼습니다."
      : "선택한 카드를 맨 뒤로 옮겼습니다.");
  }, [canvasReadOnly, commit, selectedEdges, selectedNodeIds]);

  const applyColor = useCallback((color: string | undefined) => {
    if (canvasReadOnly || selectedCount === 0) {
      return;
    }
    const current = canvasDocumentFromFlow(nodesRef.current, edgesRef.current, documentRef.current);
    const selectedEdgeIds = new Set(selectedEdges.map((edge) => edge.id));
    const nextDocument: JsonCanvasDocument = {
      ...current,
      nodes: current.nodes.map((node) => selectedNodeIds.has(node.id) ? { ...node, color } : node),
      edges: current.edges.map((edge) => selectedEdgeIds.has(edge.id) ? { ...edge, color } : edge)
    };
    const nextFlow = documentToFlow(nextDocument, selectedNodeIds, selectedEdgeIds);
    commit(nextFlow.nodes, nextFlow.edges);
  }, [canvasReadOnly, commit, selectedCount, selectedEdges, selectedNodeIds]);

  const patchSelectedEdge = useCallback((patch: Partial<JsonCanvasEdge>) => {
    const selected = selectedEdges[0];
    if (canvasReadOnly || !selected) {
      return;
    }
    const selectedEdgeIds = new Set(selectedEdges.map((edge) => edge.id));
    const current = canvasDocumentFromFlow(nodesRef.current, edgesRef.current, documentRef.current);
    const nextDocument: JsonCanvasDocument = {
      ...current,
      edges: current.edges.map((edge) => edge.id === selected.id ? { ...edge, ...patch, id: edge.id } : edge)
    };
    const nextFlow = documentToFlow(nextDocument, selectedNodeIds, selectedEdgeIds);
    commit(nextFlow.nodes, nextFlow.edges);
  }, [canvasReadOnly, commit, selectedEdges, selectedNodeIds]);

  const selectedEdgeEnds = effectiveJsonCanvasEdgeEnds(selectedEdges[0]?.data ?? {});
  const edgeDirection = selectedEdges.length === 1
    ? `${selectedEdgeEnds.fromEnd}-${selectedEdgeEnds.toEnd}`
    : "none-arrow";

  const changeEdgeDirection = useCallback((value: string) => {
    const ends = jsonCanvasEdgeEndsForDirection(value);
    if (ends) patchSelectedEdge(ends);
  }, [patchSelectedEdge]);

  const fitCanvasNodes = useCallback((nodeIds?: ReadonlySet<string>) => {
    const instance = flowInstanceRef.current;
    if (!instance) {
      return false;
    }
    const targetNodes = nodeIds
      ? nodesRef.current.filter((node) => nodeIds.has(node.id))
      : nodesRef.current;
    if (!targetNodes.length) {
      return false;
    }
    void instance.fitView({ nodes: targetNodes, padding: 0.16 });
    return true;
  }, []);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (isFormControl(event.target)) {
      return;
    }
    if (event.key === "Escape") {
      stopTextNodeEditing();
      if (contextMenu) {
        event.preventDefault();
        closeContextMenu();
      } else if (selectedCount > 0) {
        event.preventDefault();
        selectCanvasItems(new Set());
        setStatus("선택을 해제했습니다.");
      }
      return;
    }
    if (event.shiftKey && event.key === "F10") {
      const focusedNode = event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>(".react-flow__node")
        : null;
      const focusedNodeId = focusedNode?.dataset.id;
      const candidate = nodesRef.current.find((node) => node.id === focusedNodeId)
        ?? nodesRef.current.find((node) => node.selected);
      const bounds = focusedNode?.getBoundingClientRect() ?? canvasSectionRef.current?.getBoundingClientRect();
      if (candidate && bounds) {
        event.preventDefault();
        if (!candidate.selected) {
          selectCanvasItems(new Set([candidate.id]));
        }
        setContextMenu({
          clientX: bounds.left + Math.min(24, bounds.width / 2),
          clientY: bounds.top + Math.min(24, bounds.height / 2),
          kind: "node",
          targetId: candidate.id
        });
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "a") {
      event.preventDefault();
      selectCanvasItems(new Set(nodesRef.current.map((node) => node.id)));
      setStatus("Canvas 카드를 모두 선택했습니다.");
      return;
    }
    if (event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && event.code === "Digit1") {
      if (fitCanvasNodes()) {
        event.preventDefault();
        setStatus("Canvas 전체를 화면에 맞춰 표시했습니다.");
      }
      return;
    }
    if (event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && event.code === "Digit2") {
      if (selectedNodeIds.size > 0 && fitCanvasNodes(selectedNodeIds)) {
        event.preventDefault();
        setStatus("선택한 카드를 화면에 맞춰 표시했습니다.");
      }
      return;
    }
    if (event.key === "Enter") {
      const focusedNodeId = event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>(".react-flow__node")?.dataset.id
        : undefined;
      const candidate = nodesRef.current.find((node) => node.id === focusedNodeId)
        ?? nodesRef.current.find((node) => node.selected);
      const file = candidate?.data.canvas.type === "file" ? safeVaultPath(candidate.data.canvas.file) : null;
      if (file) {
        event.preventDefault();
        onOpenFile(file);
        setStatus("원본 노트를 열었습니다.");
        return;
      }
    }
    if (!event.altKey && !event.ctrlKey && !event.metaKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const step = (snapToGrid ? CANVAS_DROP_GRID[0] : 1) * (event.shiftKey ? 5 : 1);
      const deltaX = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const deltaY = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      if (selectedNodeIds.size > 0 && !canvasReadOnly) {
        event.preventDefault();
        nudgeSelection(deltaX, deltaY);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateSelection();
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      deleteSelection();
    }
  }, [
    canvasReadOnly,
    closeContextMenu,
    contextMenu,
    deleteSelection,
    duplicateSelection,
    fitCanvasNodes,
    nudgeSelection,
    onOpenFile,
    selectCanvasItems,
    selectedCount,
    selectedNodeIds,
    snapToGrid,
    stopTextNodeEditing
  ]);

  const handleNodeClick = useCallback<NodeMouseHandler<CanvasFlowNode>>((event) => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
    ) {
      return;
    }
    stopTextNodeEditing();
  }, [stopTextNodeEditing]);

  const handlePaneClick = useCallback(() => {
    closeContextMenu();
    stopTextNodeEditing();
  }, [closeContextMenu, stopTextNodeEditing]);

  const handleSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedFlowEdges }: OnSelectionChangeParams<CanvasFlowNode, CanvasFlowEdge>) => {
    const nodeIds = new Set(selectedNodes.map((node) => node.id));
    const edgeIds = new Set(selectedFlowEdges.map((edge) => edge.id));
    nodesRef.current = nodesRef.current.map((node) => node.selected === nodeIds.has(node.id) ? node : { ...node, selected: nodeIds.has(node.id) });
    edgesRef.current = edgesRef.current.map((edge) => edge.selected === edgeIds.has(edge.id) ? edge : flowEdge(edge.data ?? {
      id: edge.id,
      fromNode: edge.source,
      toNode: edge.target
    }, edgeIds.has(edge.id)));
  }, []);

  const contextMenuActions = useMemo<readonly CanvasContextMenuAction[]>(() => {
    if (!contextMenu) {
      return [];
    }
    if (contextMenu.kind === "node") {
      const target = nodes.find((node) => node.id === contextMenu.targetId);
      if (!target) {
        return [];
      }
      const canvas = target.data.canvas;
      const file = canvas.type === "file" ? safeVaultPath(canvas.file) : null;
      return [
        ...(file ? [{
          id: "open-file",
          label: "원본 열기"
        }] : []),
        ...(canvas.type === "group" ? [{
          id: "select-group",
          label: "그룹과 안의 카드 선택"
        }] : []),
        {
          disabled: canvasReadOnly,
          id: "duplicate",
          label: canvas.type === "group" ? "그룹과 안의 카드 복제" : "선택 카드 복제"
        },
        {
          disabled: canvasReadOnly || selectedNodeIds.size === nodes.length,
          id: "front",
          label: "맨 앞으로"
        },
        {
          disabled: canvasReadOnly || selectedNodeIds.size === nodes.length,
          id: "back",
          label: "맨 뒤로"
        },
        {
          destructive: true,
          disabled: canvasReadOnly,
          id: "delete",
          label: "선택 항목 삭제"
        }
      ];
    }
    if (contextMenu.kind === "edge") {
      const target = edges.find((edge) => edge.id === contextMenu.targetId);
      return [
        {
          disabled: !target || !nodes.some((node) => node.id === target.source),
          id: "edge-go-source",
          label: "시작 카드로 이동"
        },
        {
          disabled: !target || !nodes.some((node) => node.id === target.target),
          id: "edge-go-target",
          label: "대상 카드로 이동"
        },
        {
          disabled: canvasReadOnly,
          id: "edge-forward",
          label: "화살표 앞으로"
        },
        {
          disabled: canvasReadOnly,
          id: "edge-reverse",
          label: "화살표 뒤로"
        },
        {
          disabled: canvasReadOnly,
          id: "edge-bidirectional",
          label: "화살표 양방향"
        },
        {
          disabled: canvasReadOnly,
          id: "edge-none",
          label: "방향 없음"
        },
        {
          destructive: true,
          disabled: canvasReadOnly,
          id: "delete",
          label: "연결선 삭제"
        }
      ];
    }
    const position = contextMenu.flowPosition;
    const x = boundedDropCoordinate(position?.x ?? Number.NaN, CANVAS_DROP_GRID[0], snapToGrid);
    const y = boundedDropCoordinate(position?.y ?? Number.NaN, CANVAS_DROP_GRID[1], snapToGrid);
    return [
      {
        disabled: canvasReadOnly || x === null || y === null,
        id: "add-text",
        label: "여기에 텍스트 카드 추가"
      },
      {
        disabled: canvasReadOnly || x === null || y === null,
        id: "add-group",
        label: "여기에 그룹 추가"
      },
      {
        disabled: nodes.length === 0,
        id: "select-all",
        label: "모든 카드 선택"
      }
    ];
  }, [
    canvasReadOnly,
    contextMenu,
    edges,
    nodes,
    selectedNodeIds.size,
    snapToGrid
  ]);

  const handleContextMenuAction = useCallback((actionId: string) => {
    if (!contextMenu) {
      return;
    }
    if (actionId === "open-file" && contextMenu.targetId) {
      const target = nodesRef.current.find((node) => node.id === contextMenu.targetId);
      const file = target?.data.canvas.type === "file" ? safeVaultPath(target.data.canvas.file) : null;
      if (file) {
        onOpenFile(file);
        setStatus("원본 노트를 열었습니다.");
      }
      return;
    }
    if (actionId === "select-group" && contextMenu.targetId) {
      selectGroupContents(contextMenu.targetId);
      return;
    }
    if (actionId === "duplicate") {
      duplicateSelection();
      return;
    }
    if (actionId === "front" || actionId === "back") {
      reorderSelection(actionId);
      return;
    }
    if (actionId === "delete") {
      deleteSelection();
      return;
    }
    if ((actionId === "edge-go-source" || actionId === "edge-go-target") && contextMenu.targetId) {
      const edge = edgesRef.current.find((candidate) => candidate.id === contextMenu.targetId);
      const data = edge?.data ?? (edge ? { fromNode: edge.source, toNode: edge.target } : undefined);
      const nodeId = data
        ? jsonCanvasEdgeNavigationNodeId(data, actionId === "edge-go-source" ? "source" : "target")
        : undefined;
      if (nodeId && fitCanvasNodes(new Set([nodeId]))) {
        selectCanvasItems(new Set([nodeId]));
        setStatus(actionId === "edge-go-source"
          ? "연결선 시작 카드로 이동했습니다."
          : "연결선 대상 카드로 이동했습니다.");
      }
      return;
    }
    if (["edge-forward", "edge-reverse", "edge-bidirectional", "edge-none"].includes(actionId)) {
      const direction = actionId === "edge-forward"
        ? "none-arrow"
        : actionId === "edge-reverse"
          ? "arrow-none"
          : actionId === "edge-bidirectional"
            ? "arrow-arrow"
            : "none-none";
      const ends = jsonCanvasEdgeEndsForDirection(direction);
      if (ends) patchSelectedEdge(ends);
      return;
    }
    if (actionId === "select-all") {
      selectCanvasItems(new Set(nodesRef.current.map((node) => node.id)));
      return;
    }
    if (actionId === "add-text" || actionId === "add-group") {
      const position = contextMenu.flowPosition;
      const x = boundedDropCoordinate(position?.x ?? Number.NaN, CANVAS_DROP_GRID[0], snapToGrid);
      const y = boundedDropCoordinate(position?.y ?? Number.NaN, CANVAS_DROP_GRID[1], snapToGrid);
      if (x === null || y === null) {
        return;
      }
      addNode(actionId === "add-text"
        ? { id: createCanvasId("node"), type: "text", x, y, width: 280, height: 160, text: "새 메모" }
        : { id: createCanvasId("node"), type: "group", x, y, width: 640, height: 420, label: "새 그룹" });
      setStatus(actionId === "add-text"
        ? "선택한 위치에 텍스트 카드를 추가했습니다."
        : "선택한 위치에 그룹을 추가했습니다.");
    }
  }, [
    addNode,
    contextMenu,
    deleteSelection,
    duplicateSelection,
    fitCanvasNodes,
    onOpenFile,
    patchSelectedEdge,
    reorderSelection,
    selectCanvasItems,
    selectGroupContents,
    snapToGrid
  ]);

  return (
    <CanvasRuntimeContext.Provider value={runtime}>
      <section
        ref={canvasSectionRef}
        aria-busy={!flowReady}
        aria-describedby={dropHelpId}
        aria-label="Canvas"
        className={`vault-json-canvas${externalDropActive ? " vault-json-canvas--external-drop" : ""}`}
        onDragLeave={handleExternalDragLeave}
        onDragOver={handleExternalDragOver}
        onDrop={handleExternalDrop}
        onDoubleClick={handleCanvasDoubleClick}
        onKeyDownCapture={handleKeyDown}
        onPointerCancelCapture={(event) => cancelLongPress(event.pointerId)}
        onPointerDownCapture={startLongPress}
        onPointerMoveCapture={moveLongPress}
        onPointerUpCapture={(event) => cancelLongPress(event.pointerId)}
        tabIndex={0}
      >
        <p className="sr-only" id={dropHelpId}>
          {canvasReadOnly
            ? "이 Canvas는 읽기 전용입니다. 노트 카드와 연결을 탐색할 수 있습니다."
            : `${resolveVaultEntryDrop ? "파일 탐색기에서 노트를 끌어 Canvas에 놓을 수 있습니다. " : ""}${onImportExternalFiles ? "운영체제 파일은 E2EE asset-v1로 저장한 뒤 카드로 추가합니다. " : ""}키보드나 터치 환경에서는 아래 Canvas 편집 도구의 노트 추가 버튼을 사용하세요.`}
        </p>
        {externalDropActive ? (
          <div aria-hidden="true" className="vault-canvas-external-drop-indicator">
            여기에 놓아 Canvas 카드 추가
          </div>
        ) : null}
        {parseResult.warnings.length > 0 ? (
          <div className="vault-canvas-warning" role="alert">
            <strong>읽기 전용으로 열었습니다.</strong>
            <span>{parseResult.warnings.join(" ")}</span>
          </div>
        ) : null}
        {!canvasReadOnly ? (
          <div aria-label="Canvas 편집 도구" className="vault-canvas-toolbar" role="toolbar">
            <div className="vault-canvas-toolbar-group">
              <button aria-label="텍스트 카드 추가" onClick={addTextNode} type="button"><StickyNote size={16} /> 텍스트</button>
              <CanvasFileChooser
                accessibleLabel="추가할 노트 선택"
                buttonText={fileOptionsByPath.get(selectedFilePath)?.label ?? "노트 없음"}
                disabled={safeFileOptions.length === 0}
                onSelect={setFileDraft}
                options={safeFileOptions}
                value={selectedFilePath}
              />
              <button aria-label="선택한 노트 카드 추가" disabled={!selectedFilePath} onClick={addFileNode} type="button"><FilePlus2 size={16} /> 노트</button>
              <label className="vault-canvas-link-input">
                <span className="sr-only">추가할 웹 주소</span>
                <input onChange={(event) => setLinkDraft(event.target.value)} placeholder="https://" type="url" value={linkDraft} />
              </label>
              <button aria-label="웹 링크 카드 추가" onClick={addLinkNode} type="button"><Link2 size={16} /> 링크</button>
              <button aria-label="그룹 추가" onClick={addGroupNode} type="button"><Group size={16} /> 그룹</button>
            </div>

            <div aria-label="선택 항목 도구" className="vault-canvas-toolbar-group">
              <span className="vault-canvas-selection-count">{selectedCount}개 선택</span>
              <button aria-label="선택 카드 복제" disabled={selectedNodeIds.size === 0} onClick={duplicateSelection} title="복제 (⌘/Ctrl+D)" type="button"><Copy size={16} /></button>
              <button aria-label="선택 항목 삭제" disabled={selectedCount === 0} onClick={deleteSelection} title="삭제" type="button"><Trash2 size={16} /></button>
              <label className="vault-canvas-inline-select">
                <span className="sr-only">카드 정렬</span>
                <select
                  aria-label="카드 정렬"
                  defaultValue=""
                  disabled={selectedNodeIds.size < 2}
                  onChange={(event) => {
                    if (event.target.value) {
                      alignSelection(event.target.value as CanvasAlignment);
                      event.target.value = "";
                    }
                  }}
                >
                  <option value="">정렬</option>
                  {ALIGNMENTS.map((alignment) => <option key={alignment.value} value={alignment.value}>{alignment.label}</option>)}
                </select>
              </label>
              <div aria-label="카드 배치와 순서" className="vault-canvas-toolbar-subgroup" role="group">
                <button
                  aria-label="선택 카드 가로 간격 같게 배치"
                  disabled={selectedNodeIds.size < 3}
                  onClick={() => distributeSelection("horizontal")}
                  title="가로 간격 같게 배치"
                  type="button"
                >
                  <Columns3 aria-hidden="true" size={16} />
                </button>
                <button
                  aria-label="선택 카드 세로 간격 같게 배치"
                  disabled={selectedNodeIds.size < 3}
                  onClick={() => distributeSelection("vertical")}
                  title="세로 간격 같게 배치"
                  type="button"
                >
                  <Rows3 aria-hidden="true" size={16} />
                </button>
                <button
                  aria-label="선택 카드를 맨 앞으로"
                  disabled={selectedNodeIds.size === 0 || selectedNodeIds.size === nodes.length}
                  onClick={() => reorderSelection("front")}
                  title="맨 앞으로"
                  type="button"
                >
                  <BringToFront aria-hidden="true" size={16} />
                </button>
                <button
                  aria-label="선택 카드를 맨 뒤로"
                  disabled={selectedNodeIds.size === 0 || selectedNodeIds.size === nodes.length}
                  onClick={() => reorderSelection("back")}
                  title="맨 뒤로"
                  type="button"
                >
                  <SendToBack aria-hidden="true" size={16} />
                </button>
              </div>
              <label className="vault-canvas-snap-toggle">
                <input checked={snapToGrid} onChange={(event) => setSnapToGrid(event.target.checked)} type="checkbox" />
                <Grid3X3 aria-hidden="true" size={15} /> 스냅
              </label>
              <div aria-label="선택 항목 색상" className="vault-canvas-palette" role="group">
                <button aria-label="기본 색상" disabled={selectedCount === 0} onClick={() => applyColor(undefined)} type="button">
                  <span aria-hidden="true" className="vault-canvas-color-swatch vault-canvas-color-swatch--default" />
                </button>
                {CANVAS_COLORS.map((color) => (
                  <button
                    aria-label={`색상 ${color}`}
                    disabled={selectedCount === 0}
                    key={color}
                    onClick={() => applyColor(color)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="vault-canvas-color-swatch"
                      style={{ backgroundColor: safeCanvasColor(color) }}
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {!canvasReadOnly && selectedEdges.length === 1 ? (
          <aside aria-label="연결선 설정" className="vault-canvas-edge-editor">
            <label>
              <span>연결선 이름</span>
              <input ref={edgeLabelInputRef} onChange={(event) => patchSelectedEdge({ label: event.target.value })} placeholder="라벨" value={selectedEdges[0].data?.label ?? ""} />
            </label>
            <label>
              <span>방향</span>
              <select onChange={(event) => changeEdgeDirection(event.target.value)} value={edgeDirection}>
                <option value="none-none">방향 없음</option>
                <option value="none-arrow">앞으로</option>
                <option value="arrow-none">뒤로</option>
                <option value="arrow-arrow">양방향</option>
              </select>
            </label>
          </aside>
        ) : null}

        <ReactFlow<CanvasFlowNode, CanvasFlowEdge>
          colorMode="system"
          deleteKeyCode={null}
          edges={edges}
          edgesFocusable
          edgesReconnectable={!canvasReadOnly}
          elementsSelectable
          elevateNodesOnSelect
          fitView={nodes.length > 0}
          maxZoom={8}
          minZoom={1 / 128}
          multiSelectionKeyCode={["Meta", "Control", "Shift"]}
          nodeClickDistance={CANVAS_NODE_INTERACTION_THRESHOLD_PX}
          nodeDragThreshold={CANVAS_NODE_INTERACTION_THRESHOLD_PX}
          nodeTypes={CANVAS_NODE_TYPES}
          noDragClassName={CANVAS_NO_DRAG_CLASS_NAME}
          noPanClassName={CANVAS_NO_PAN_CLASS_NAME}
          nodes={nodes}
          nodesConnectable={!canvasReadOnly}
          nodesDraggable={!canvasReadOnly}
          nodesFocusable
          onlyRenderVisibleElements={nodes.length > CANVAS_VISIBLE_ELEMENT_LOD_THRESHOLD}
          onConnect={connect}
          onEdgeContextMenu={openEdgeContextMenu}
          onEdgeDoubleClick={editEdgeLabel}
          onEdgesChange={changeEdges}
          onInit={(instance) => {
            flowInstanceRef.current = instance;
            setFlowReady(true);
          }}
          onNodeClick={handleNodeClick}
          onNodeContextMenu={openNodeContextMenu}
          onNodeDragStart={startNodeDrag}
          onNodeDragStop={stopNodeDrag}
          onNodesChange={changeNodes}
          onPaneClick={handlePaneClick}
          onPaneContextMenu={openPaneContextMenu}
          onReconnect={reconnect}
          onSelectionChange={handleSelectionChange}
          panActivationKeyCode="Space"
          panOnDrag={[0, 1]}
          panOnScroll
          selectionKeyCode="Shift"
          selectionOnDrag={false}
          snapGrid={[20, 20]}
          snapToGrid={snapToGrid}
          zoomActivationKeyCode={["Meta", "Control", "Space"]}
          zoomOnDoubleClick={false}
          zoomOnScroll={false}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={!canvasReadOnly} />
          <MiniMap
            nodeColor={(node) => {
              const canvas = node.data.canvas as JsonCanvasNode;
              return safeCanvasColor(canvas.color, canvas.type === "group" ? "#494553" : "#8b82f6");
            }}
            pannable
            zoomable
          />
        </ReactFlow>
        {contextMenu && contextMenuActions.length > 0 ? (
          <CanvasContextMenu
            {...contextMenu}
            actions={contextMenuActions}
            onClose={closeContextMenu}
            onSelect={handleContextMenuAction}
          />
        ) : null}
        <p aria-live="polite" className="sr-only">{status}</p>
      </section>
    </CanvasRuntimeContext.Provider>
  );
}

export {
  alignJsonCanvasNodes,
  containedJsonCanvasNodeIds,
  containingJsonCanvasGroupId,
  distributeJsonCanvasNodes,
  duplicateJsonCanvasSelection,
  effectiveJsonCanvasEdgeEnds,
  emptyJsonCanvas,
  expandJsonCanvasGroupSelection,
  jsonCanvasEdgeEndsForDirection,
  jsonCanvasEdgeNavigationNodeId,
  parseCanvasDocument,
  reorderJsonCanvasNodes,
  safeCanvasColor,
  safeCanvasDocument,
  safeHttpUrl,
  safeVaultPath,
  serializeCanvas,
  translateJsonCanvasNodes
};
