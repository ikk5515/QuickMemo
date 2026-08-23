import type {
  MarkdownLinkReference,
  MarkdownLinkPreviewSource
} from "../markdown";
import type { VaultContentFormat, VaultEntryKind } from "../../types";

export const MAX_VAULT_PAGE_PREVIEW_TITLE_CHARACTERS = 160;
export const MAX_VAULT_PAGE_PREVIEW_PATH_CHARACTERS = 320;
export const MAX_VAULT_PAGE_PREVIEW_BODY_CHARACTERS = 480;
const MAX_VAULT_PAGE_PREVIEW_SOURCE_CHARACTERS = 12_000;
const PAGE_PREVIEW_MARGIN = 12;
const PAGE_PREVIEW_MAX_WIDTH = 360;
const PAGE_PREVIEW_ESTIMATED_HEIGHT = 220;

export interface VaultPagePreviewTarget {
  body: string;
  contentFormat: VaultContentFormat;
  entryKind: VaultEntryKind;
  id: string;
  path: string;
  title: string;
}

export interface VaultPagePreviewContent {
  body: string;
  entryId: string;
  path: string;
  title: string;
}

export interface VaultPagePreviewPosition {
  left: number;
  placement: "above" | "below";
  top: number;
  width: number;
}

interface RectLike {
  bottom: number;
  left: number;
  top: number;
}

function boundedPlainText(value: string, maximumCharacters: number) {
  const withoutControls = Array.from(
    value.slice(0, maximumCharacters * 4).normalize("NFC"),
    (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 8
        || codePoint === 11
        || codePoint === 12
        || (codePoint >= 14 && codePoint <= 31)
        || codePoint === 127
        ? " "
        : character;
    }
  ).join("");
  return withoutControls
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumCharacters);
}

function markdownPreviewText(source: string) {
  let value = source.slice(0, MAX_VAULT_PAGE_PREVIEW_SOURCE_CHARACTERS);
  if (/^---\s*(?:\r?\n)/u.test(value)) {
    value = value.replace(/^---\s*\r?\n[\s\S]{0,8000}?\r?\n---\s*(?:\r?\n|$)/u, " ");
  }
  return value
    .replace(/%%[\s\S]*?%%/gu, " ")
    .replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<[^>]{0,1000}>/gu, " ")
    .replace(/!?\[\[([^\]|#]{1,1000})(?:#[^\]|]{0,1000})?(?:\|([^\]]{1,1000}))?\]\]/gu, "$2 $1")
    .replace(/!?\[([^\]]{1,1000})\]\([^\s)]{1,2000}(?:\s+['"][^)]{0,1000}['"])?\)/gu, "$1")
    .replace(/(^|\s)(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, "$1")
    .replace(/[`*_~]{1,3}/gu, " ");
}

function legacyHtmlPreviewText(source: string) {
  return source
    .slice(0, MAX_VAULT_PAGE_PREVIEW_SOURCE_CHARACTERS)
    .replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<[^>]{0,1000}>/gu, " ");
}

/**
 * Creates inert text for a resolved, already-authorized note only. The caller
 * must obtain `target` from the current decrypted ACL scope; a missing target is
 * deliberately indistinguishable from an unresolved or inaccessible link.
 */
export function createVaultPagePreviewContent(input: {
  reference: MarkdownLinkReference;
  resolvedTargetEntryId?: string;
  target?: VaultPagePreviewTarget | null;
}): VaultPagePreviewContent | null {
  const { reference, resolvedTargetEntryId, target } = input;
  if (
    reference.kind === "external"
    || !resolvedTargetEntryId
    || !target
    || target.id !== resolvedTargetEntryId
    || !(
      (target.entryKind === "markdown" && target.contentFormat === "markdown-v1")
      || (target.entryKind === "legacy-html" && target.contentFormat === "legacy-html-v1")
    )
  ) {
    return null;
  }
  const title = boundedPlainText(target.title, MAX_VAULT_PAGE_PREVIEW_TITLE_CHARACTERS);
  if (!title) {
    return null;
  }
  const bodySource = target.contentFormat === "legacy-html-v1"
    ? legacyHtmlPreviewText(target.body)
    : markdownPreviewText(target.body);
  return {
    body: boundedPlainText(bodySource, MAX_VAULT_PAGE_PREVIEW_BODY_CHARACTERS),
    entryId: target.id,
    path: boundedPlainText(target.path, MAX_VAULT_PAGE_PREVIEW_PATH_CHARACTERS),
    title
  };
}

export function vaultPagePreviewPosition(
  anchor: RectLike,
  viewport: { height: number; width: number }
): VaultPagePreviewPosition {
  const availableWidth = Math.max(0, viewport.width - PAGE_PREVIEW_MARGIN * 2);
  const width = Math.min(PAGE_PREVIEW_MAX_WIDTH, availableWidth);
  const maximumLeft = Math.max(PAGE_PREVIEW_MARGIN, viewport.width - width - PAGE_PREVIEW_MARGIN);
  const left = Math.min(maximumLeft, Math.max(PAGE_PREVIEW_MARGIN, anchor.left));
  const roomBelow = viewport.height - anchor.bottom - PAGE_PREVIEW_MARGIN;
  const roomAbove = anchor.top - PAGE_PREVIEW_MARGIN;
  const placement = roomBelow < PAGE_PREVIEW_ESTIMATED_HEIGHT && roomAbove > roomBelow
    ? "above" as const
    : "below" as const;
  return {
    left,
    placement,
    top: placement === "above"
      ? Math.max(PAGE_PREVIEW_MARGIN, anchor.top - 8)
      : Math.min(viewport.height - PAGE_PREVIEW_MARGIN, anchor.bottom + 8),
    width
  };
}

export function vaultPagePreviewDelay(
  phase: "close" | "open",
  source: MarkdownLinkPreviewSource,
  reducedMotion: boolean
) {
  if (reducedMotion) return 0;
  if (phase === "close") return 120;
  return source === "focus" ? 120 : 320;
}
