import { useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  createDefaultGraphSettings,
  GRAPH_SETTING_RANGES,
  moveGraphGroup,
  orderedGraphGroups,
  replaceGraphCommonSettings,
  type GraphNumberRange
} from "./graphSettings";
import type {
  GraphCommonSettings,
  GraphGroup,
  GraphSettingsSectionId,
  GraphViewSettings,
  LocalGraphViewSettings
} from "./types";
import "./graph.css";

const GRAPH_GROUP_COLORS = ["#e05f65", "#e0a958", "#66b47b", "#4aa8c7", "#8b82f6", "#c56fbd"];
const EMPTY_COLLAPSED_SECTIONS: readonly GraphSettingsSectionId[] = [];

interface GraphSettingsSectionProps {
  children: ReactNode;
  collapsed: boolean;
  id: GraphSettingsSectionId;
  onToggle: (id: GraphSettingsSectionId) => void;
  title: string;
}

function GraphSettingsSection({
  children,
  collapsed,
  id,
  onToggle,
  title
}: GraphSettingsSectionProps) {
  const panelId = `graph-settings-${id}`;
  return (
    <section className="qm-graph-settings-section">
      <button
        aria-controls={panelId}
        aria-expanded={!collapsed}
        className="qm-graph-settings-section__toggle"
        onClick={() => onToggle(id)}
        type="button"
      >
        <span aria-hidden="true">{collapsed ? "›" : "⌄"}</span>
        <span>{title}</span>
      </button>
      <div hidden={collapsed} id={panelId}>
        {children}
      </div>
    </section>
  );
}

interface GraphRangeControlProps {
  label: string;
  onChange: (value: number) => void;
  range: GraphNumberRange;
  value: number;
}

function GraphRangeControl({ label, onChange, range, value }: GraphRangeControlProps) {
  return (
    <label className="qm-graph-range">
      <span>{label}</span>
      <output>{Number.isInteger(value) ? value : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}</output>
      <input
        aria-label={label}
        max={range.max}
        min={range.min}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        step={range.step}
        type="range"
        value={value}
      />
    </label>
  );
}

interface GraphToggleProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

function GraphToggle({ checked, label, onChange }: GraphToggleProps) {
  return (
    <label className="qm-graph-toggle">
      <span>{label}</span>
      <input
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
    </label>
  );
}

export interface GraphSettingsDrawerProps {
  collapsedSections?: readonly GraphSettingsSectionId[];
  onChange: (settings: GraphViewSettings) => void;
  onCollapsedSectionsChange?: (sections: GraphSettingsSectionId[]) => void;
  settings: GraphViewSettings;
}

function replaceCommonValue<K extends keyof GraphCommonSettings>(
  settings: GraphViewSettings,
  key: K,
  value: GraphCommonSettings[K]
): GraphViewSettings {
  return replaceGraphCommonSettings(settings, { ...settings.common, [key]: value });
}

function replaceLocalValue<K extends keyof LocalGraphViewSettings>(
  settings: LocalGraphViewSettings,
  key: K,
  value: LocalGraphViewSettings[K]
): LocalGraphViewSettings {
  return { ...settings, [key]: value };
}

export function GraphSettingsDrawer({
  collapsedSections,
  onChange,
  onCollapsedSectionsChange,
  settings
}: GraphSettingsDrawerProps) {
  const instanceId = useId().replace(/:/g, "");
  const nextGroupNumber = useRef(1);
  const [draggedGroupIndex, setDraggedGroupIndex] = useState<number | null>(null);
  const [internalCollapsedSections, setInternalCollapsedSections] = useState<readonly GraphSettingsSectionId[]>(
    EMPTY_COLLAPSED_SECTIONS
  );
  const effectiveCollapsedSections = collapsedSections ?? internalCollapsedSections;
  const groups = orderedGraphGroups(settings.common.groups);

  function updateCollapsedSections(next: GraphSettingsSectionId[]) {
    if (collapsedSections === undefined) {
      setInternalCollapsedSections(next);
    }
    onCollapsedSectionsChange?.(next);
  }

  function toggleSection(sectionId: GraphSettingsSectionId) {
    const next = effectiveCollapsedSections.includes(sectionId)
      ? effectiveCollapsedSections.filter((id) => id !== sectionId)
      : [...effectiveCollapsedSections, sectionId];
    updateCollapsedSections(next);
  }

  function updateGroups(nextGroups: GraphGroup[]) {
    onChange(replaceCommonValue(settings, "groups", orderedGraphGroups(nextGroups)));
  }

  function addGroup() {
    const number = nextGroupNumber.current;
    nextGroupNumber.current += 1;
    updateGroups([
      ...groups,
      {
        id: `graph-group-${instanceId}-${number}`,
        query: "",
        color: GRAPH_GROUP_COLORS[groups.length % GRAPH_GROUP_COLORS.length],
        order: groups.length
      }
    ]);
  }

  function updateGroup(index: number, patch: Partial<GraphGroup>) {
    updateGroups(groups.map((group, groupIndex) => (
      groupIndex === index ? { ...group, ...patch } : group
    )));
  }

  function handleGroupDrop(event: DragEvent<HTMLLIElement>, targetIndex: number) {
    event.preventDefault();
    if (draggedGroupIndex !== null) {
      updateGroups(moveGraphGroup(groups, draggedGroupIndex, targetIndex));
    }
    setDraggedGroupIndex(null);
  }

  return (
    <aside aria-label={`${settings.scope === "global" ? "전체" : "로컬"} 그래프 설정`} className="qm-graph-settings">
      <div className="qm-graph-settings__header">
        <h2>그래프 설정</h2>
        <button
          className="qm-graph-button qm-graph-button--quiet"
          onClick={() => onChange(createDefaultGraphSettings(settings.scope))}
          type="button"
        >
          기본 설정 복원
        </button>
      </div>

      <GraphSettingsSection
        collapsed={effectiveCollapsedSections.includes("filters")}
        id="filters"
        onToggle={toggleSection}
        title="필터"
      >
        <label className="qm-graph-field">
          <span>파일 검색</span>
          <input
            onChange={(event) => onChange(replaceCommonValue(settings, "query", event.currentTarget.value))}
            placeholder="검색어 입력…"
            type="search"
            value={settings.common.query}
          />
        </label>
        <GraphToggle
          checked={settings.common.showTags}
          label="태그"
          onChange={(value) => onChange(replaceCommonValue(settings, "showTags", value))}
        />
        <GraphToggle
          checked={settings.common.showAttachments}
          label="첨부 파일"
          onChange={(value) => onChange(replaceCommonValue(settings, "showAttachments", value))}
        />
        <GraphToggle
          checked={settings.common.existingFilesOnly}
          label="존재하는 파일만"
          onChange={(value) => onChange(replaceCommonValue(settings, "existingFilesOnly", value))}
        />
        {settings.scope === "global" ? (
          <GraphToggle
            checked={settings.showOrphans}
            label="고립된 노트"
            onChange={(showOrphans) => onChange({ ...settings, showOrphans })}
          />
        ) : null}
      </GraphSettingsSection>

      <GraphSettingsSection
        collapsed={effectiveCollapsedSections.includes("groups")}
        id="groups"
        onToggle={toggleSection}
        title="그룹"
      >
        <p className="qm-graph-settings__hint">위에서 먼저 일치한 그룹의 색상을 사용합니다.</p>
        {groups.length === 0 ? <p className="qm-graph-settings__empty">그룹이 없습니다.</p> : null}
        <ol aria-label="그래프 그룹" className="qm-graph-groups">
          {groups.map((group, index) => (
            <li
              className="qm-graph-group"
              key={group.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => handleGroupDrop(event, index)}
            >
              <button
                aria-label={`그룹 ${index + 1} 끌어서 순서 변경`}
                className="qm-graph-group__drag"
                draggable
                onDragEnd={() => setDraggedGroupIndex(null)}
                onDragStart={(event) => {
                  setDraggedGroupIndex(index);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", group.id);
                }}
                type="button"
              >
                ⠿
              </button>
              <input
                aria-label={`그룹 ${index + 1} 검색식`}
                onChange={(event) => updateGroup(index, { query: event.currentTarget.value })}
                placeholder="검색식"
                type="text"
                value={group.query}
              />
              <input
                aria-label={`그룹 ${index + 1} 색상`}
                onChange={(event) => updateGroup(index, { color: event.currentTarget.value })}
                type="color"
                value={group.color}
              />
              <div className="qm-graph-group__actions">
                <button
                  aria-label={`그룹 ${index + 1} 위로 이동`}
                  disabled={index === 0}
                  onClick={() => updateGroups(moveGraphGroup(groups, index, index - 1))}
                  type="button"
                >
                  ↑
                </button>
                <button
                  aria-label={`그룹 ${index + 1} 아래로 이동`}
                  disabled={index === groups.length - 1}
                  onClick={() => updateGroups(moveGraphGroup(groups, index, index + 1))}
                  type="button"
                >
                  ↓
                </button>
                <button
                  aria-label={`그룹 ${index + 1} 삭제`}
                  onClick={() => updateGroups(groups.filter((_, groupIndex) => groupIndex !== index))}
                  type="button"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ol>
        <button className="qm-graph-button" onClick={addGroup} type="button">그룹 추가</button>
      </GraphSettingsSection>

      <GraphSettingsSection
        collapsed={effectiveCollapsedSections.includes("display")}
        id="display"
        onToggle={toggleSection}
        title="표시"
      >
        <GraphToggle
          checked={settings.common.arrows}
          label="화살표"
          onChange={(value) => onChange(replaceCommonValue(settings, "arrows", value))}
        />
        <GraphRangeControl
          label="텍스트 흐림 임계값"
          onChange={(value) => onChange(replaceCommonValue(settings, "textFadeThreshold", value))}
          range={GRAPH_SETTING_RANGES.textFadeThreshold}
          value={settings.common.textFadeThreshold}
        />
        <GraphRangeControl
          label="노드 크기"
          onChange={(value) => onChange(replaceCommonValue(settings, "nodeSize", value))}
          range={GRAPH_SETTING_RANGES.nodeSize}
          value={settings.common.nodeSize}
        />
        <GraphRangeControl
          label="링크 두께"
          onChange={(value) => onChange(replaceCommonValue(settings, "linkThickness", value))}
          range={GRAPH_SETTING_RANGES.linkThickness}
          value={settings.common.linkThickness}
        />
        {settings.scope === "global" ? (
          <GraphToggle
            checked={settings.animate}
            label="시간순 애니메이션"
            onChange={(animate) => onChange({ ...settings, animate })}
          />
        ) : null}
      </GraphSettingsSection>

      <GraphSettingsSection
        collapsed={effectiveCollapsedSections.includes("forces")}
        id="forces"
        onToggle={toggleSection}
        title="장력"
      >
        <GraphRangeControl
          label="중심 장력"
          onChange={(value) => onChange(replaceCommonValue(settings, "centerForce", value))}
          range={GRAPH_SETTING_RANGES.centerForce}
          value={settings.common.centerForce}
        />
        <GraphRangeControl
          label="반발력"
          onChange={(value) => onChange(replaceCommonValue(settings, "repelForce", value))}
          range={GRAPH_SETTING_RANGES.repelForce}
          value={settings.common.repelForce}
        />
        <GraphRangeControl
          label="링크 장력"
          onChange={(value) => onChange(replaceCommonValue(settings, "linkForce", value))}
          range={GRAPH_SETTING_RANGES.linkForce}
          value={settings.common.linkForce}
        />
        <GraphRangeControl
          label="링크 거리"
          onChange={(value) => onChange(replaceCommonValue(settings, "linkDistance", value))}
          range={GRAPH_SETTING_RANGES.linkDistance}
          value={settings.common.linkDistance}
        />
      </GraphSettingsSection>

      {settings.scope === "local" ? (
        <GraphSettingsSection
          collapsed={effectiveCollapsedSections.includes("local")}
          id="local"
          onToggle={toggleSection}
          title="로컬 그래프"
        >
          <GraphRangeControl
            label="깊이"
            onChange={(value) => onChange(replaceLocalValue(settings, "depth", value as LocalGraphViewSettings["depth"]))}
            range={GRAPH_SETTING_RANGES.depth}
            value={settings.depth}
          />
          <GraphToggle
            checked={settings.incoming}
            label="들어오는 링크"
            onChange={(value) => onChange(replaceLocalValue(settings, "incoming", value))}
          />
          <GraphToggle
            checked={settings.outgoing}
            label="나가는 링크"
            onChange={(value) => onChange(replaceLocalValue(settings, "outgoing", value))}
          />
          <GraphToggle
            checked={settings.neighborLinks}
            label="인접 노드 사이의 링크"
            onChange={(value) => onChange(replaceLocalValue(settings, "neighborLinks", value))}
          />
          {settings.root === "follow-active" ? (
            <p className="qm-graph-settings__hint">활성 노트를 따라갑니다.</p>
          ) : (
            <button
              className="qm-graph-button qm-graph-button--quiet"
              onClick={() => onChange({ ...settings, root: "follow-active" })}
              type="button"
            >
              활성 노트 따라가기
            </button>
          )}
        </GraphSettingsSection>
      ) : null}
    </aside>
  );
}
