import { resolveProductionStagedFeatureFlag } from "./productionStagedFeatureFlag";

const readonlyNoteRendererV2ProductionDefault = false;
const unifiedSelectUiProductionDefault = false;

function isDefaultOnFeatureEnabled(
  value: unknown,
  productionDefault: boolean
) {
  return resolveProductionStagedFeatureFlag(
    value,
    productionDefault,
    import.meta.env.PROD
  );
}

export function isReadonlyNoteRendererV2Enabled(
  value: unknown = import.meta.env.VITE_READONLY_NOTE_RENDERER_V2_ENABLED
) {
  return isDefaultOnFeatureEnabled(
    value,
    readonlyNoteRendererV2ProductionDefault
  );
}

export function isUnifiedSelectUiEnabled(
  value: unknown = import.meta.env.VITE_UNIFIED_SELECT_UI_ENABLED
) {
  return isDefaultOnFeatureEnabled(value, unifiedSelectUiProductionDefault);
}
