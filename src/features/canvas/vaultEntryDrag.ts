export const JSON_CANVAS_VAULT_ENTRY_MIME = "application/x-quickmemo-vault-entry+json";

export interface JsonCanvasVaultEntryDragPayload {
  entryId: string;
  version: 1;
}

const MAX_VAULT_ENTRY_DRAG_PAYLOAD_CHARACTERS = 512;
const VAULT_ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function serializeJsonCanvasVaultEntryDragPayload(entryId: string): string | null {
  if (!VAULT_ENTRY_ID_PATTERN.test(entryId)) {
    return null;
  }
  return JSON.stringify({ version: 1, entryId } satisfies JsonCanvasVaultEntryDragPayload);
}

export function parseJsonCanvasVaultEntryDragPayload(
  source: string
): JsonCanvasVaultEntryDragPayload | null {
  if (!source || source.length > MAX_VAULT_ENTRY_DRAG_PAYLOAD_CHARACTERS) {
    return null;
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const keys = Object.keys(parsed).sort();
    if (
      keys.length !== 2
      || keys[0] !== "entryId"
      || keys[1] !== "version"
      || parsed.version !== 1
      || typeof parsed.entryId !== "string"
      || !VAULT_ENTRY_ID_PATTERN.test(parsed.entryId)
    ) {
      return null;
    }
    return { version: 1, entryId: parsed.entryId };
  } catch {
    return null;
  }
}

/**
 * File-tree integration contract. The DOM payload intentionally contains only
 * an opaque entry ID: never add a vault path, owner ID, URL, note content, or
 * encryption material as a text/plain fallback.
 */
export function setJsonCanvasVaultEntryDragData(
  dataTransfer: DataTransfer,
  entryId: string
): boolean {
  const payload = serializeJsonCanvasVaultEntryDragPayload(entryId);
  if (!payload) {
    return false;
  }
  try {
    dataTransfer.clearData();
    dataTransfer.setData(JSON_CANVAS_VAULT_ENTRY_MIME, payload);
    dataTransfer.effectAllowed = "copy";
    return true;
  } catch {
    return false;
  }
}

export function containsJsonCanvasVaultEntryDragType(types: readonly string[]): boolean {
  return types.some((type) => type.toLocaleLowerCase() === JSON_CANVAS_VAULT_ENTRY_MIME);
}
