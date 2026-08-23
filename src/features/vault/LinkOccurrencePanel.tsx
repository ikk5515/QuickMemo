import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ExternalLink, Link as LinkIcon } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState } from "react";
import { vaultBasename } from "../knowledge/path";
import type {
  ResolvedLinkOccurrence,
  UnlinkedMentionOccurrence,
  VaultIndexEntry
} from "../knowledge/types";
import "./linkOccurrencePanel.css";

export const MAX_RENDERED_LINK_OCCURRENCES = 500;

export type LinkOccurrencePanelDirection = "backlinks" | "outgoing";
export type LinkOccurrenceSortMode = "occurrence" | "file-name" | "path" | "updated";

export interface LinkOccurrencePanelProps {
  direction: LinkOccurrencePanelDirection;
  emptyLabel: string;
  entries: readonly VaultIndexEntry[];
  occurrences: readonly ResolvedLinkOccurrence[];
  unlinkedMentions?: readonly UnlinkedMentionOccurrence[];
  onOpenEntry: (entryId: string) => void;
  onCreateUnlinkedLink?: (occurrence: UnlinkedMentionOccurrence) => void;
}

interface DecoratedOccurrence {
  entryId?: string;
  entryLabel: string;
  entryPath: string;
  groupKey: string;
  occurrence: ResolvedLinkOccurrence;
  originalIndex: number;
  updatedAt: number;
}

interface OccurrenceGroup {
  entryId?: string;
  entryLabel: string;
  entryPath: string;
  key: string;
  matches: DecoratedOccurrence[];
  status: ResolvedLinkOccurrence["status"];
  totalMatchCount: number;
}

interface DecoratedMention {
  entryId: string;
  entryLabel: string;
  entryPath: string;
  groupKey: string;
  occurrence: UnlinkedMentionOccurrence;
  originalIndex: number;
  updatedAt: number;
}

interface MentionGroup {
  entryId: string;
  entryLabel: string;
  entryPath: string;
  key: string;
  matches: DecoratedMention[];
  totalMatchCount: number;
}

const LINK_SORT_OPTIONS: readonly { label: string; value: LinkOccurrenceSortMode }[] = [
  { label: "링크 발생 순서", value: "occurrence" },
  { label: "파일 이름", value: "file-name" },
  { label: "파일 경로", value: "path" },
  { label: "최근 업데이트", value: "updated" }
];

const pathCollator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

function caseFold(value: string) {
  return value.normalize("NFC").toLocaleLowerCase();
}

function entryDisplayLabel(entry: VaultIndexEntry | undefined, path: string) {
  if (entry?.kind === "markdown" || /\.md$/iu.test(path)) {
    return vaultBasename(path).replace(/\.md$/iu, "") || path;
  }
  return vaultBasename(path) || path;
}

function counterpart(
  direction: LinkOccurrencePanelDirection,
  occurrence: ResolvedLinkOccurrence,
  entryById: ReadonlyMap<string, VaultIndexEntry>,
  originalIndex: number
): DecoratedOccurrence {
  const entryId = direction === "backlinks" ? occurrence.sourceEntryId : occurrence.targetEntryId;
  const entry = entryId ? entryById.get(entryId) : undefined;
  const fallbackPath = direction === "backlinks"
    ? occurrence.sourcePath
    : occurrence.targetPath ?? occurrence.unresolvedKey ?? occurrence.target;
  const entryPath = (entry?.path ?? fallbackPath) || "대상을 확인할 수 없는 링크";
  const entryLabel = entryDisplayLabel(entry, entryPath);
  const unresolvedGroup = `${occurrence.status}:${caseFold(occurrence.unresolvedKey || occurrence.target)}`;
  return {
    entryId,
    entryLabel,
    entryPath,
    groupKey: entryId ? `entry:${entryId}` : unresolvedGroup,
    occurrence,
    originalIndex,
    updatedAt: Number.isFinite(entry?.updatedAt) ? entry?.updatedAt ?? 0 : 0
  };
}

function matchesSearch(item: DecoratedOccurrence, normalizedQuery: string) {
  if (!normalizedQuery) return true;
  const { occurrence } = item;
  return [
    item.entryLabel,
    item.entryPath,
    occurrence.context,
    occurrence.raw,
    occurrence.sourcePath,
    occurrence.target,
    occurrence.targetPath ?? "",
    occurrence.displayText ?? "",
    occurrence.fragment?.value ?? ""
  ].some((value) => caseFold(value).includes(normalizedQuery));
}

function compareOccurrences(
  left: DecoratedOccurrence,
  right: DecoratedOccurrence,
  mode: LinkOccurrenceSortMode
) {
  if (mode === "occurrence") {
    return left.originalIndex - right.originalIndex;
  }

  const primary = mode === "file-name"
    ? pathCollator.compare(left.entryLabel, right.entryLabel)
    : mode === "path"
      ? pathCollator.compare(left.entryPath, right.entryPath)
      : right.updatedAt - left.updatedAt;
  if (primary !== 0) return primary;

  const pathOrder = pathCollator.compare(left.entryPath, right.entryPath);
  if (pathOrder !== 0) return pathOrder;

  const groupOrder = pathCollator.compare(left.groupKey, right.groupKey);
  if (groupOrder !== 0) return groupOrder;
  return left.occurrence.line - right.occurrence.line
    || left.occurrence.column - right.occurrence.column
    || left.originalIndex - right.originalIndex;
}

function groupOccurrences(
  rendered: readonly DecoratedOccurrence[],
  totalCounts: ReadonlyMap<string, number>
) {
  const byKey = new Map<string, OccurrenceGroup>();
  const groups: OccurrenceGroup[] = [];
  for (const item of rendered) {
    const existing = byKey.get(item.groupKey);
    if (existing) {
      existing.matches.push(item);
      continue;
    }
    const group: OccurrenceGroup = {
      entryId: item.entryId,
      entryLabel: item.entryLabel,
      entryPath: item.entryPath,
      key: item.groupKey,
      matches: [item],
      status: item.occurrence.status,
      totalMatchCount: totalCounts.get(item.groupKey) ?? 1
    };
    byKey.set(item.groupKey, group);
    groups.push(group);
  }
  return groups;
}

function decorateMention(
  occurrence: UnlinkedMentionOccurrence,
  entryById: ReadonlyMap<string, VaultIndexEntry>,
  originalIndex: number
): DecoratedMention {
  const entry = entryById.get(occurrence.sourceEntryId);
  const entryPath = entry?.path ?? occurrence.sourcePath;
  return {
    entryId: occurrence.sourceEntryId,
    entryLabel: entryDisplayLabel(entry, entryPath),
    entryPath,
    groupKey: `entry:${occurrence.sourceEntryId}`,
    occurrence,
    originalIndex,
    updatedAt: Number.isFinite(entry?.updatedAt) ? entry?.updatedAt ?? 0 : 0
  };
}

function mentionMatchesSearch(item: DecoratedMention, normalizedQuery: string) {
  if (!normalizedQuery) return true;
  return [
    item.entryLabel,
    item.entryPath,
    item.occurrence.context,
    item.occurrence.matchedText,
    item.occurrence.matchedTerm,
    item.occurrence.sourcePath,
    item.occurrence.targetPath
  ].some((value) => caseFold(value).includes(normalizedQuery));
}

function compareMentions(
  left: DecoratedMention,
  right: DecoratedMention,
  mode: LinkOccurrenceSortMode
) {
  if (mode === "occurrence") {
    return left.originalIndex - right.originalIndex;
  }
  const primary = mode === "file-name"
    ? pathCollator.compare(left.entryLabel, right.entryLabel)
    : mode === "path"
      ? pathCollator.compare(left.entryPath, right.entryPath)
      : right.updatedAt - left.updatedAt;
  return primary
    || pathCollator.compare(left.entryPath, right.entryPath)
    || left.occurrence.line - right.occurrence.line
    || left.occurrence.column - right.occurrence.column
    || left.originalIndex - right.originalIndex;
}

function groupMentions(
  rendered: readonly DecoratedMention[],
  totalCounts: ReadonlyMap<string, number>
) {
  const byKey = new Map<string, MentionGroup>();
  const groups: MentionGroup[] = [];
  for (const item of rendered) {
    const existing = byKey.get(item.groupKey);
    if (existing) {
      existing.matches.push(item);
      continue;
    }
    const group: MentionGroup = {
      entryId: item.entryId,
      entryLabel: item.entryLabel,
      entryPath: item.entryPath,
      key: item.groupKey,
      matches: [item],
      totalMatchCount: totalCounts.get(item.groupKey) ?? 1
    };
    byKey.set(item.groupKey, group);
    groups.push(group);
  }
  return groups;
}

function collapsedKey(kind: "link" | "mention", groupKey: string) {
  return `${kind}:${groupKey}`;
}

export function LinkOccurrencePanel({
  direction,
  emptyLabel,
  entries,
  occurrences,
  unlinkedMentions = [],
  onOpenEntry,
  onCreateUnlinkedLink
}: LinkOccurrencePanelProps) {
  const panelId = useId();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sortMode, setSortMode] = useState<LinkOccurrenceSortMode>("occurrence");
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [unlinkedSectionCollapsed, setUnlinkedSectionCollapsed] = useState(false);
  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const decorated = useMemo(
    () => occurrences.map((occurrence, index) => counterpart(direction, occurrence, entryById, index)),
    [direction, entryById, occurrences]
  );
  const normalizedQuery = caseFold(deferredQuery.trim());
  const view = useMemo(() => {
    const filtered = decorated.filter((item) => matchesSearch(item, normalizedQuery));
    const totalCounts = new Map<string, number>();
    for (const item of filtered) {
      totalCounts.set(item.groupKey, (totalCounts.get(item.groupKey) ?? 0) + 1);
    }
    const rendered = [...filtered]
      .sort((left, right) => compareOccurrences(left, right, sortMode))
      .slice(0, MAX_RENDERED_LINK_OCCURRENCES);
    return {
      groups: groupOccurrences(rendered, totalCounts),
      renderedCount: rendered.length,
      totalCount: filtered.length
    };
  }, [decorated, normalizedQuery, sortMode]);
  const decoratedMentions = useMemo(
    () => direction === "backlinks"
      ? unlinkedMentions.map((occurrence, index) => decorateMention(occurrence, entryById, index))
      : [],
    [direction, entryById, unlinkedMentions]
  );
  const mentionView = useMemo(() => {
    const filtered = decoratedMentions.filter((item) => mentionMatchesSearch(item, normalizedQuery));
    const totalCounts = new Map<string, number>();
    for (const item of filtered) {
      totalCounts.set(item.groupKey, (totalCounts.get(item.groupKey) ?? 0) + 1);
    }
    const rendered = [...filtered]
      .sort((left, right) => compareMentions(left, right, sortMode))
      .slice(0, MAX_RENDERED_LINK_OCCURRENCES);
    return {
      groups: groupMentions(rendered, totalCounts),
      renderedCount: rendered.length,
      totalCount: filtered.length
    };
  }, [decoratedMentions, normalizedQuery, sortMode]);
  const visibleGroupKeys = [
    ...view.groups.map((group) => collapsedKey("link", group.key)),
    ...mentionView.groups.map((group) => collapsedKey("mention", group.key))
  ];
  const everyVisibleGroupCollapsed = visibleGroupKeys.length > 0
    && visibleGroupKeys.every((key) => collapsedGroupKeys.has(key));
  const groupKind = direction === "backlinks" ? "원본" : "대상";

  function toggleGroup(kind: "link" | "mention", groupKey: string) {
    const key = collapsedKey(kind, groupKey);
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllVisibleGroups() {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      for (const key of visibleGroupKeys) {
        if (everyVisibleGroupCollapsed) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  return (
    <section aria-label={direction === "backlinks" ? "백링크 실제 링크" : "나가는 실제 링크"} className="vault-link-panel">
      <div className="vault-link-panel-toolbar">
        <input
          aria-label="링크 문맥 검색"
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="링크 검색"
          type="search"
          value={query}
        />
        <select
          aria-label="링크 정렬"
          onChange={(event) => setSortMode(event.target.value as LinkOccurrenceSortMode)}
          value={sortMode}
        >
          {LINK_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <button
          aria-label={everyVisibleGroupCollapsed ? "모든 링크 그룹 펼치기" : "모든 링크 그룹 접기"}
          disabled={!visibleGroupKeys.length}
          onClick={toggleAllVisibleGroups}
          title={everyVisibleGroupCollapsed ? "모두 펼치기" : "모두 접기"}
          type="button"
        >
          {everyVisibleGroupCollapsed ? <ChevronsUpDown aria-hidden="true" size={15} /> : <ChevronsDownUp aria-hidden="true" size={15} />}
        </button>
      </div>

      <p aria-live="polite" className="vault-link-panel-count" role="status">
        실제 내부 링크 {view.renderedCount === view.totalCount
          ? `${view.totalCount}개`
          : `${view.renderedCount}개 표시 · ${normalizedQuery ? "검색 결과" : "전체"} ${view.totalCount}개`}
      </p>

      <div className="vault-link-panel-scroll">
        {!view.groups.length ? <p className="vault-panel-empty">{normalizedQuery ? "검색 조건에 맞는 실제 링크가 없습니다." : emptyLabel}</p> : (
          <ul className="vault-link-groups">
            {view.groups.map((group, groupIndex) => {
              const expanded = !collapsedGroupKeys.has(collapsedKey("link", group.key));
              const occurrencesId = `${panelId}-occurrences-${groupIndex}`;
              const resolutionLabel = group.status === "ambiguous"
                ? "대상 모호함"
                : group.status === "unresolved"
                  ? "해결되지 않음"
                  : "";
              const countLabel = group.matches.length === group.totalMatchCount
                ? `${group.totalMatchCount}`
                : `${group.matches.length}/${group.totalMatchCount}`;
              return (
                <li className="vault-link-group" key={group.key}>
                  <div className="vault-link-group-header">
                    <button
                      aria-controls={occurrencesId}
                      aria-expanded={expanded}
                      aria-label={`${group.entryLabel} 링크 그룹 ${expanded ? "접기" : "펼치기"}`}
                      className="vault-link-group-toggle"
                      onClick={() => toggleGroup("link", group.key)}
                      type="button"
                    >
                      {expanded ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
                      <span>
                        <strong aria-level={3} role="heading">{group.entryLabel}</strong>
                        <small title={group.entryPath}>{group.entryPath}{resolutionLabel ? ` · ${resolutionLabel}` : ""}</small>
                      </span>
                      <span aria-label={`${countLabel}개 occurrence`} className="vault-link-group-count">{countLabel}</span>
                    </button>
                    <button
                      aria-label={`${group.entryLabel} ${groupKind} 노트 열기`}
                      className="vault-link-group-open"
                      disabled={!group.entryId}
                      onClick={() => group.entryId && onOpenEntry(group.entryId)}
                      title={group.entryId
                        ? "노트 열기"
                        : group.status === "ambiguous"
                          ? "대상이 여러 개라 열 수 없는 링크"
                          : "아직 생성되지 않은 대상"}
                      type="button"
                    >
                      <ExternalLink aria-hidden="true" size={14} />
                    </button>
                  </div>
                  <ul className="vault-link-occurrences" hidden={!expanded} id={occurrencesId}>
                      {group.matches.map((item) => {
                        const { occurrence } = item;
                        const location = `${occurrence.sourcePath}:${occurrence.line}:${occurrence.column}`;
                        return (
                          <li key={`${item.originalIndex}:${occurrence.line}:${occurrence.column}`}>
                            <button
                              aria-label={`${group.entryLabel} ${occurrence.line}행 ${occurrence.column}열 실제 링크 열기`}
                              disabled={!item.entryId}
                              onClick={() => item.entryId && onOpenEntry(item.entryId)}
                              type="button"
                            >
                              <span>{occurrence.context || occurrence.raw}</span>
                              <small title={location}>{location}</small>
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}

        {direction === "backlinks" ? (
          <aside aria-label="연결되지 않은 언급" className="vault-unlinked-mentions-status">
            <button
              aria-expanded={!unlinkedSectionCollapsed}
              aria-label={`연결되지 않은 언급 섹션 ${unlinkedSectionCollapsed ? "펼치기" : "접기"}`}
              className="vault-unlinked-mentions-heading"
              onClick={() => setUnlinkedSectionCollapsed((current) => !current)}
              type="button"
            >
              {unlinkedSectionCollapsed ? <ChevronRight aria-hidden="true" size={15} /> : <ChevronDown aria-hidden="true" size={15} />}
              <span>
                <strong>연결되지 않은 언급</strong>
                <small aria-live="polite">{mentionView.renderedCount === mentionView.totalCount
                  ? `${mentionView.totalCount}개`
                  : `${mentionView.renderedCount}개 표시 · ${mentionView.totalCount}개`}</small>
              </span>
            </button>
            <div hidden={unlinkedSectionCollapsed}>
              {!mentionView.groups.length ? (
                <p>{normalizedQuery ? "검색 조건에 맞는 연결되지 않은 언급이 없습니다." : "제목이나 별칭을 언급한 평문이 없습니다."}</p>
              ) : (
                <ul className="vault-link-groups vault-unlinked-mention-groups">
                  {mentionView.groups.map((group, groupIndex) => {
                    const expanded = !collapsedGroupKeys.has(collapsedKey("mention", group.key));
                    const mentionsId = `${panelId}-mentions-${groupIndex}`;
                    const countLabel = group.matches.length === group.totalMatchCount
                      ? `${group.totalMatchCount}`
                      : `${group.matches.length}/${group.totalMatchCount}`;
                    return (
                      <li className="vault-link-group" key={group.key}>
                        <div className="vault-link-group-header">
                          <button
                            aria-controls={mentionsId}
                            aria-expanded={expanded}
                            aria-label={`${group.entryLabel} 언급 그룹 ${expanded ? "접기" : "펼치기"}`}
                            className="vault-link-group-toggle"
                            onClick={() => toggleGroup("mention", group.key)}
                            type="button"
                          >
                            {expanded ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
                            <span>
                              <strong aria-level={3} role="heading">{group.entryLabel}</strong>
                              <small title={group.entryPath}>{group.entryPath}</small>
                            </span>
                            <span aria-label={`${countLabel}개 occurrence`} className="vault-link-group-count">{countLabel}</span>
                          </button>
                          <button
                            aria-label={`${group.entryLabel} 원본 노트 열기`}
                            className="vault-link-group-open"
                            onClick={() => onOpenEntry(group.entryId)}
                            title="노트 열기"
                            type="button"
                          >
                            <ExternalLink aria-hidden="true" size={14} />
                          </button>
                        </div>
                        <ul className="vault-link-occurrences" hidden={!expanded} id={mentionsId}>
                          {group.matches.map((item) => {
                            const { occurrence } = item;
                            const location = `${occurrence.sourcePath}:${occurrence.line}:${occurrence.column}`;
                            return (
                              <li className="vault-unlinked-mention-row" key={`${item.originalIndex}:${occurrence.startOffset}`}>
                                <button
                                  aria-label={`${group.entryLabel} ${occurrence.line}행 ${occurrence.column}열 언급 열기`}
                                  onClick={() => onOpenEntry(group.entryId)}
                                  type="button"
                                >
                                  <span>{occurrence.context || occurrence.matchedText}</span>
                                  <small title={location}>{location}</small>
                                </button>
                                <button
                                  aria-label={`${group.entryLabel} ${occurrence.line}행 ${occurrence.column}열 링크 만들기`}
                                  className="vault-unlinked-mention-create"
                                  disabled={!onCreateUnlinkedLink}
                                  onClick={() => onCreateUnlinkedLink?.(occurrence)}
                                  title={onCreateUnlinkedLink ? "내부 Wikilink 만들기" : "이 노트를 수정할 수 없습니다."}
                                  type="button"
                                >
                                  <LinkIcon aria-hidden="true" size={14} />
                                  <span>링크 만들기</span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>
        ) : (
          <p className="vault-link-panel-scope">파싱된 실제 내부 링크만 표시합니다.</p>
        )}
      </div>
    </section>
  );
}
