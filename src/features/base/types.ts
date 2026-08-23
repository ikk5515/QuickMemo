import type {
  FrontmatterValue,
  MarkdownBlockReference,
  MarkdownHeading,
  VaultIndexEntry
} from "../knowledge";

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
  summaries: Record<string, string>;
}

export interface BaseDocument {
  filters?: BaseFilterSource;
  formulas: Record<string, string>;
  properties: Record<string, BasePropertyConfig>;
  summaries: Record<string, string>;
  views: BaseViewConfig[];
}

export interface BaseParseResult {
  document: BaseDocument | null;
  errors: BaseDiagnostic[];
  warnings: BaseDiagnostic[];
}

export type BaseCellScalar = string | number | boolean | null;

export interface BaseDateValue {
  __baseType: "date";
  epochMs: number;
}

export interface BaseDurationValue {
  __baseType: "duration";
  /** Calendar months are kept separate because one month is not a fixed duration. */
  months: number;
  milliseconds: number;
}

export interface BaseHtmlValue {
  __baseType: "html";
  source: string;
}

export interface BaseIconValue {
  __baseType: "icon";
  name: string;
}

export interface BaseImageValue {
  __baseType: "image";
  external: boolean;
  path: string;
}

export interface BaseRegexValue {
  __baseType: "regex";
  flags: string;
  source: string;
}

export interface BaseLinkValue {
  __baseType: "link";
  /** Obsidian accepts either text or an icon value as the link label. */
  display?: string | BaseIconValue;
  /** Resolved in-memory Vault identity. Never serialized into a .base file. */
  entryId?: string;
  external: boolean;
  path: string;
}

export interface BaseFileValue {
  __baseType: "file";
  backlinks?: BaseLinkValue[];
  basename: string;
  createdAt?: BaseDateValue;
  embeds: BaseLinkValue[];
  entryId?: string;
  ext: string;
  folder: string;
  links: BaseLinkValue[];
  name: string;
  path: string;
  properties: BaseObjectValue;
  size?: number;
  tags: string[];
  updatedAt?: BaseDateValue;
}

export interface BaseObjectValue {
  __baseType: "object";
  values: Record<string, BaseCellValue>;
}

export type BaseTypedValue =
  | BaseDateValue
  | BaseDurationValue
  | BaseFileValue
  | BaseHtmlValue
  | BaseIconValue
  | BaseImageValue
  | BaseLinkValue
  | BaseObjectValue
  | BaseRegexValue;

export type BaseCellValue = BaseCellScalar | BaseTypedValue | BaseCellValue[] | undefined;

export interface BaseMetadata {
  aliases: readonly string[];
  blocks: readonly MarkdownBlockReference[];
  headings: readonly MarkdownHeading[];
  links: readonly {
    embedded?: boolean;
    syntax?: "markdown" | "wikilink";
    target: string;
    /** Transient projection produced after ACL-scoped link resolution. */
    targetEntryId?: string;
  }[];
  /** Materialization derives this transient projection; it is never persisted. */
  backlinks?: readonly { sourceEntryId?: string; target: string }[];
  properties: Readonly<Record<string, FrontmatterValue>>;
  tags: readonly string[];
}

export interface BaseInputRow {
  entry: VaultIndexEntry;
  metadata: BaseMetadata;
}

export interface BaseEvaluationContext {
  /** The file represented by `this.file` for an embedded/sidebar Base. */
  thisEntry?: VaultIndexEntry;
  thisMetadata?: BaseMetadata;
  /** Test/replay override. Production callers normally omit this. */
  nowEpochMs?: number;
  /** One seed per materialized view; individual rows derive independent streams. */
  randomSeed?: number;
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
  summaries: Array<{
    name: string;
    property: string;
    value: BaseCellValue;
  }>;
  type: BaseViewType;
  warnings: BaseDiagnostic[];
}
