export interface SchedulePrioritySource {
  important?: unknown;
  importance?: unknown;
  isImportant?: unknown;
  isUrgent?: unknown;
  priority?: unknown;
  urgent?: unknown;
  urgency?: unknown;
}

const importantTokens = new Set([
  "critical",
  "high",
  "highest",
  "important",
  "importanturgent",
  "urgentimportant",
  "priority",
  "true",
  "yes",
  "1"
]);

const urgentTokens = new Set([
  "critical",
  "high",
  "highest",
  "importanturgent",
  "urgentimportant",
  "true",
  "urgent",
  "yes",
  "1"
]);

const urgentPriorityTokens = new Set(["critical", "importanturgent", "urgentimportant", "urgent", "true", "yes", "1"]);

function normalizedToken(value: string) {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function booleanFromLegacyValue(value: unknown, trueTokens: Set<string>) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }

  if (typeof value === "string") {
    return trueTokens.has(normalizedToken(value));
  }

  return false;
}

function priorityFlag(primary: unknown, fallbacks: unknown[], trueTokens: Set<string>) {
  if (typeof primary === "boolean") {
    return primary;
  }

  return booleanFromLegacyValue(primary, trueTokens) || fallbacks.some((value) => booleanFromLegacyValue(value, trueTokens));
}

export function normalizeSchedulePriorityFlags(source: SchedulePrioritySource) {
  return {
    isImportant: priorityFlag(
      source.isImportant,
      [source.important, source.importance, source.priority],
      importantTokens
    ),
    isUrgent: priorityFlag(source.isUrgent, [source.urgent, source.urgency], urgentTokens)
      || (typeof source.isUrgent !== "boolean" && booleanFromLegacyValue(source.priority, urgentPriorityTokens))
  };
}
