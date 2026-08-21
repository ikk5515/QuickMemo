import type { ParsedMarkdownMetadata, VaultIndexEntry } from "../knowledge";

export type BaseViewType = "table" | "cards" | "list";
export type BaseSortDirection = "ASC" | "DESC";

export interface BaseDiagnostic {
  code:
    | "invalid-yaml"
    | "invalid-schema"
    | "unsafe-yaml"
    | "unsupported-filter"
    | "unsupported-formula"
    | "unsupported-option"
    | "unsupported-view";
  message: string;
  path?: string;
}
export type BaseFilterSource = string | {
  and?: BaseFilterSource[];
  or?: BaseFilterSource[];
  not?: BaseFilterSource[];
};

export interface BasePropertyConfig {
  displayName?: string;
}

export interface BaseSortRule {
  property: string;
  direction: BaseSortDirection;
}

export interface BaseGroupRule {
  property: string;
  direction: BaseSortDirection;
}

export interface BaseViewConfig {
  type: BaseViewType;
  name: string;
  filters?: BaseFilterSource;
  groupBy?: BaseGroupRule;
  limit?: number;
  order: string[];
  sort: BaseSortRule[];
}

export interface BaseDocument {
  filters?: BaseFilterSource;
  formulas: Record<string, string>;
  properties: Record<string, BasePropertyConfig>;
  views: BaseViewConfig[];
}

export interface BaseParseResult {
  document: BaseDocument | null;
  errors: BaseDiagnostic[];
  warnings: BaseDiagnostic[];
}

export type BaseCellScalar = string | number | boolean | null;
export type BaseCellValue = BaseCellScalar | BaseCellScalar[] | undefined;

export interface BaseInputRow {
  entry: VaultIndexEntry;
  metadata: ParsedMarkdownMetadata;
}

export interface BaseResultRow extends BaseInputRow {
  cells: Record<string, BaseCellValue>;
}

export interface BaseResultGroup {
  key: string;
  label: string;
  rows: BaseResultRow[];
}

export interface BaseMaterializedView {
  columns: string[];
  groups: BaseResultGroup[];
  name: string;
  resultCount: number;
  type: BaseViewType;
  warnings: BaseDiagnostic[];
}
