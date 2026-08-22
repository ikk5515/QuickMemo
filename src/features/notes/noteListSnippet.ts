export const NOTE_LIST_SNIPPET_MAX_LENGTH = 240;

function normalizedPreviewText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Keeps large decrypted note bodies out of the list DOM while retaining useful
 * context for a full-text match. Search still runs against the complete
 * in-memory plaintext; only the rendered list excerpt is bounded here.
 */
export function noteListSnippet(
  value: string,
  query = "",
  maximumLength = NOTE_LIST_SNIPPET_MAX_LENGTH
) {
  const text = normalizedPreviewText(value);
  const limit = Math.max(32, Math.trunc(maximumLength));
  if (text.length <= limit) return text;

  const normalizedQuery = normalizedPreviewText(query).toLocaleLowerCase("ko-KR");
  const matchIndex = normalizedQuery
    ? text.toLocaleLowerCase("ko-KR").indexOf(normalizedQuery)
    : -1;
  const contentBudget = limit - 2;
  const preferredStart = matchIndex < 0
    ? 0
    : matchIndex - Math.floor(contentBudget * 0.35);
  const start = Math.max(0, Math.min(text.length - contentBudget, preferredStart));
  const end = Math.min(text.length, start + contentBudget);

  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
