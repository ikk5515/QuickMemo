import { memo, useId, useState } from "react";
import { GraphCanvas, type GraphCanvasProps } from "./GraphCanvas";
import { GraphSettingsDrawer } from "./GraphSettingsDrawer";
import type { GraphSettingsSectionId, GraphViewSettings } from "./types";
import "./graph.css";

export interface GraphViewProps extends GraphCanvasProps {
  defaultSettingsOpen?: boolean;
  collapsedSettingsSections?: readonly GraphSettingsSectionId[];
  onCollapsedSettingsSectionsChange?: (sections: GraphSettingsSectionId[]) => void;
  onSettingsChange: (settings: GraphViewSettings) => void;
  onSettingsVisibilityChange?: (open: boolean) => void;
}

export const GraphView = memo(function GraphView({
  collapsedSettingsSections,
  defaultSettingsOpen = true,
  onCollapsedSettingsSectionsChange,
  onSettingsChange,
  onSettingsVisibilityChange,
  ...canvasProps
}: GraphViewProps) {
  const [settingsOpen, setSettingsOpen] = useState(defaultSettingsOpen);
  const settingsId = `${useId().replace(/:/g, "")}-graph-settings`;

  function toggleSettings() {
    setSettingsOpen((current) => {
      const next = !current;
      onSettingsVisibilityChange?.(next);
      return next;
    });
  }

  return (
    <div className="qm-graph-view" data-graph-scope={canvasProps.settings.scope}>
      <button
        aria-controls={settingsId}
        aria-expanded={settingsOpen}
        aria-label={settingsOpen ? "그래프 설정 닫기" : "그래프 설정 열기"}
        className="qm-graph-view__settings-button"
        onClick={toggleSettings}
        type="button"
      >
        ⚙
      </button>
      <GraphCanvas {...canvasProps} />
      {settingsOpen ? (
        <div className="qm-graph-view__settings" id={settingsId}>
          <GraphSettingsDrawer
            collapsedSections={collapsedSettingsSections}
            onChange={onSettingsChange}
            onCollapsedSectionsChange={onCollapsedSettingsSectionsChange}
            settings={canvasProps.settings}
          />
        </div>
      ) : null}
    </div>
  );
});
