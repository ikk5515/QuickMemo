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
  type NodeProps,
  type OnSelectionChangeParams
} from "@xyflow/react";
import { Copy, FilePlus2, Grid3X3, Group, Link2, StickyNote, Trash2 } from "lucide-react";
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
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { VaultAssetPreview } from "../vault/VaultAssetPreview";
import type { DecodedVaultAsset } from "../vault/vaultAsset";
import "@xyflow/react/dist/style.css";
import {
  alignJsonCanvasNodes,
  canvasDocumentFromFlow,
  duplicateJsonCanvasSelection,
  effectiveJsonCanvasEdgeEnds,
  emptyJsonCanvas,
  parseCanvasDocument,
  safeCanvasColor,
  safeCanvasDocument,
  safeHttpUrl,
  safeVaultPath,
  serializeCanvas,
  type CanvasAlignment,
  type CanvasFlowEdge,
  type CanvasFlowNode,
  type JsonCanvasDocument,
  type JsonCanvasEdge,
  type JsonCanvasNode,
  type JsonCanvasSide
} from "./canvasModel";
import "./canvas.css";

export interface JsonCanvasFileOption {
  asset?: DecodedVaultAsset;
  kind?: "markdown" | "canvas" | "base" | "asset";
  label: string;
  path: string;
}

export interface JsonCanvasViewProps {
  fileOptions: readonly JsonCanvasFileOption[];
  onChange: (source: string) => void;
  onOpenFile: (path: string) => void;
  readOnly?: boolean;
  source: string;
}

interface CanvasRuntime {
  fileOptionsByPath: ReadonlyMap<string, JsonCanvasFileOption>;
  fileOptions: readonly JsonCanvasFileOption[];
  onOpenFile: (path: string) => void;
  patchNode: (nodeId: string, patch: Partial<JsonCanvasNode>) => void;
  readOnly: boolean;
}

const CanvasRuntimeContext = createContext<CanvasRuntime | null>(null);
const JSON_CANVAS_SIDES: readonly JsonCanvasSide[] = ["top", "right", "bottom", "left"];
const CANVAS_COLORS = ["1", "2", "3", "4", "5", "6"] as const;
const CANVAS_FILE_RESULT_LIMIT = 50;
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
  const resolvedLink = node.type === "link" ? safeHttpUrl(node.url) : null;
  const fileOption = node.type === "file"
    ? runtime?.fileOptionsByPath.get(node.file ?? "")
    : undefined;
  const accent = safeCanvasColor(node.color, node.type === "group" ? "#5b5664" : "#8b82f6");
  const style = { "--canvas-node-accent": accent } as CSSProperties;

  return (
    <article
      aria-label={accessibleNodeLabel(node)}
      className={`vault-canvas-card vault-canvas-card--${node.type}`}
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

      {node.type === "text" ? (
        <textarea
          aria-label="Canvas 텍스트"
          className="nodrag nowheel vault-canvas-text-editor"
          onChange={(event) => runtime?.patchNode(id, { text: event.target.value })}
          onDoubleClick={stopCanvasControlEvent}
          onPointerDown={stopCanvasControlEvent}
          readOnly={readOnly}
          value={node.text ?? ""}
        />
      ) : null}

      {node.type === "group" ? (
        <div className="vault-canvas-group-content">
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
            <VaultAssetPreview
              asset={fileOption.asset}
              className="nodrag nowheel"
              compact
              fileName={fileOption.label}
            />
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

export function JsonCanvasView({ fileOptions, onChange, onOpenFile, readOnly = false, source }: JsonCanvasViewProps) {
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
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const documentRef = useRef(parsed);
  const sourceRef = useRef(source);
  const canonicalSourceRef = useRef(`${JSON.stringify(parsed, null, 2)}\n`);

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

  useEffect(() => {
    if (source === sourceRef.current) {
      return;
    }
    sourceRef.current = source;
    const nextDocument = safeCanvasDocument(source);
    const nextFlow = documentToFlow(nextDocument);
    documentRef.current = nextDocument;
    canonicalSourceRef.current = `${JSON.stringify(nextDocument, null, 2)}\n`;
    nodesRef.current = nextFlow.nodes;
    edgesRef.current = nextFlow.edges;
    setNodes(nextFlow.nodes);
    setEdges(nextFlow.edges);
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
  const runtime = useMemo<CanvasRuntime>(() => ({
    fileOptions: safeFileOptions,
    fileOptionsByPath,
    onOpenFile,
    patchNode,
    readOnly: canvasReadOnly
  }), [canvasReadOnly, fileOptionsByPath, onOpenFile, patchNode, safeFileOptions]);

  const changeNodes = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    if (canvasReadOnly && changes.some((change) => change.type !== "select")) {
      return;
    }
    const nextNodes = applyNodeChanges(changes, nodesRef.current);
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
    ));
    if (isTransientInteraction) {
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setNodes(nextNodes);
      setEdges(nextEdges);
      return;
    }
    commit(nextNodes, nextEdges);
  }, [canvasReadOnly, commit]);

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
    const [fromEnd, toEnd] = value.split("-") as ["none" | "arrow", "none" | "arrow"];
    patchSelectedEdge({ fromEnd, toEnd });
  }, [patchSelectedEdge]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (isFormControl(event.target)) {
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
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateSelection();
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      deleteSelection();
    }
  }, [deleteSelection, duplicateSelection, onOpenFile]);

  const handleNodeDoubleClick: NodeMouseHandler<CanvasFlowNode> = (_event, node) => {
    const file = node.data.canvas.type === "file" ? safeVaultPath(node.data.canvas.file) : null;
    if (file) {
      onOpenFile(file);
    }
  };

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

  return (
    <CanvasRuntimeContext.Provider value={runtime}>
      <section aria-label="Canvas" className="vault-json-canvas" onKeyDown={handleKeyDown} tabIndex={0}>
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
              <label className="vault-canvas-snap-toggle">
                <input checked={snapToGrid} onChange={(event) => setSnapToGrid(event.target.checked)} type="checkbox" />
                <Grid3X3 aria-hidden="true" size={15} /> 스냅
              </label>
              <div aria-label="선택 항목 색상" className="vault-canvas-palette" role="group">
                <button aria-label="기본 색상" disabled={selectedCount === 0} onClick={() => applyColor(undefined)} type="button" />
                {CANVAS_COLORS.map((color) => (
                  <button
                    aria-label={`색상 ${color}`}
                    disabled={selectedCount === 0}
                    key={color}
                    onClick={() => applyColor(color)}
                    style={{ backgroundColor: safeCanvasColor(color) }}
                    type="button"
                  />
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {!canvasReadOnly && selectedEdges.length === 1 ? (
          <aside aria-label="연결선 설정" className="vault-canvas-edge-editor">
            <label>
              <span>연결선 이름</span>
              <input onChange={(event) => patchSelectedEdge({ label: event.target.value })} placeholder="라벨" value={selectedEdges[0].data?.label ?? ""} />
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
          fitView
          maxZoom={8}
          minZoom={1 / 128}
          nodeTypes={CANVAS_NODE_TYPES}
          nodes={nodes}
          nodesConnectable={!canvasReadOnly}
          nodesDraggable={!canvasReadOnly}
          nodesFocusable
          onlyRenderVisibleElements
          onConnect={connect}
          onEdgesChange={changeEdges}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodesChange={changeNodes}
          onReconnect={reconnect}
          onSelectionChange={handleSelectionChange}
          panOnDrag={canvasReadOnly ? true : [1, 2]}
          selectionOnDrag={!canvasReadOnly}
          snapGrid={[20, 20]}
          snapToGrid={snapToGrid}
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
        <p aria-live="polite" className="sr-only">{status}</p>
      </section>
    </CanvasRuntimeContext.Provider>
  );
}

export {
  alignJsonCanvasNodes,
  duplicateJsonCanvasSelection,
  effectiveJsonCanvasEdgeEnds,
  emptyJsonCanvas,
  parseCanvasDocument,
  safeCanvasColor,
  safeCanvasDocument,
  safeHttpUrl,
  safeVaultPath,
  serializeCanvas
};
