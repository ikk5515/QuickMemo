const KANBAN_MARKER = /^quickmemo-plugin:\s*kanban-v1\s*$/imu;
const MAX_BOARD_CHARACTERS = 500_000;
const MAX_COLUMNS = 50;
const MAX_CARDS = 2_000;
const MAX_CHECKLIST_ITEMS = 5_000;
const MAX_LINE_CHARACTERS = 500;
export const MAX_KANBAN_PARSE_DIAGNOSTICS = 100;

interface KanbanDiagnostics {
  errors: string[];
  omitted: number;
}

export interface KanbanCard {
  checked: boolean;
  checklist?: KanbanChecklistItem[];
  id: string;
  text: string;
}

export interface KanbanChecklistItem {
  checked: boolean;
  id: string;
  text: string;
}

export interface KanbanColumn {
  cards: KanbanCard[];
  id: string;
  title: string;
}

export interface KanbanDocument {
  columns: KanbanColumn[];
  frontmatter: string;
  title: string;
}

export interface KanbanParseResult {
  document: KanbanDocument | null;
  errors: string[];
  readOnly: boolean;
}

export interface KanbanImportResult {
  errors: string[];
  source: string | null;
  warnings: string[];
}

export function createKanbanSource(title = "Kanban") {
  return `---\nquickmemo-plugin: kanban-v1\n---\n# ${writableLine(title, "Kanban")}\n\n## 할 일\n\n## 진행 중\n\n## 완료\n`;
}

function addDiagnostic(diagnostics: KanbanDiagnostics, message: string) {
  // Reserve the final slot for a bounded summary. Keeping the detailed list
  // small prevents a malformed-but-size-valid board from allocating and then
  // rendering hundreds of thousands of error rows.
  if (diagnostics.errors.length < MAX_KANBAN_PARSE_DIAGNOSTICS - 1) {
    diagnostics.errors.push(message);
  } else {
    diagnostics.omitted += 1;
  }
}

function finalizedDiagnostics(diagnostics: KanbanDiagnostics) {
  return diagnostics.omitted > 0
    ? [
        ...diagnostics.errors,
        `추가 진단 ${diagnostics.omitted.toLocaleString("ko-KR")}개는 안전을 위해 표시하지 않았습니다.`
      ]
    : diagnostics.errors;
}

function parsedLine(value: string, fallback: string, lineNumber: number, diagnostics: KanbanDiagnostics) {
  const normalized = value.trim();
  if (normalized.length > MAX_LINE_CHARACTERS) {
    addDiagnostic(
      diagnostics,
      `${lineNumber}행은 ${MAX_LINE_CHARACTERS}자를 초과해 Kanban이 손실 없이 보존할 수 없습니다.`
    );
  }
  return normalized || fallback;
}

function writableLine(value: string, fallback: string) {
  if (/[\r\n]/u.test(value)) {
    throw new Error("Kanban 제목과 카드에는 줄바꿈을 넣을 수 없습니다.");
  }
  const normalized = value.trim();
  if (normalized.length > MAX_LINE_CHARACTERS) {
    throw new Error(`Kanban 제목과 카드는 ${MAX_LINE_CHARACTERS}자까지만 저장할 수 있습니다.`);
  }
  return normalized || fallback;
}

export function parseKanbanSource(source: string): KanbanParseResult {
  const diagnostics: KanbanDiagnostics = { errors: [], omitted: 0 };
  if (source.length > MAX_BOARD_CHARACTERS || new TextEncoder().encode(source).byteLength > MAX_BOARD_CHARACTERS) {
    return { document: null, errors: ["Kanban 노트가 500,000자 제한을 초과했습니다."], readOnly: true };
  }
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!frontmatter || !KANBAN_MARKER.test(frontmatter[1])) {
    return { document: null, errors: ["quickmemo-plugin: kanban-v1 속성이 없습니다."], readOnly: true };
  }
  const body = source.slice(frontmatter[0].length);
  const lines = body.split(/\r?\n/u);
  let title = "Kanban";
  const columns: KanbanColumn[] = [];
  let current: KanbanColumn | null = null;
  let currentCard: KanbanCard | null = null;
  let cardCount = 0;
  let checklistCount = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (diagnostics.omitted > 0) {
      // Once the bounded diagnostic summary is required, stop parsing the
      // malformed remainder instead of spending CPU on messages we discard.
      break;
    }
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    const headingOne = line.match(/^#\s+(.+)$/u);
    if (headingOne && !columns.length && title === "Kanban") {
      title = parsedLine(headingOne[1], "Kanban", lineIndex + 1, diagnostics);
      continue;
    }
    const headingTwo = line.match(/^##\s+(.+)$/u);
    if (headingTwo) {
      if (columns.length >= MAX_COLUMNS) {
        addDiagnostic(diagnostics, `열은 ${MAX_COLUMNS}개까지만 편집할 수 있습니다.`);
        break;
      }
      current = {
        cards: [],
        id: `column-${columns.length}`,
        title: parsedLine(headingTwo[1], `열 ${columns.length + 1}`, lineIndex + 1, diagnostics)
      };
      columns.push(current);
      currentCard = null;
      continue;
    }
    const checklistItem = line.match(/^\s{2,4}-\s+\[([ xX])\]\s+(.+)$/u);
    if (checklistItem && currentCard) {
      checklistCount += 1;
      if (checklistCount > MAX_CHECKLIST_ITEMS) {
        addDiagnostic(diagnostics, `하위 체크리스트는 ${MAX_CHECKLIST_ITEMS}개까지만 편집할 수 있습니다.`);
        break;
      }
      const checklist = currentCard.checklist ?? (currentCard.checklist = []);
      checklist.push({
        checked: checklistItem[1].toLocaleLowerCase() === "x",
        id: `check-${columns.length - 1}-${cardCount - 1}-${checklist.length}`,
        text: parsedLine(checklistItem[2], "빈 체크 항목", lineIndex + 1, diagnostics)
      });
      continue;
    }
    const card = line.match(/^-\s+\[([ xX])\]\s+(.+)$/u);
    if (card && current) {
      cardCount += 1;
      if (cardCount > MAX_CARDS) {
        addDiagnostic(diagnostics, `카드는 ${MAX_CARDS}개까지만 편집할 수 있습니다.`);
        break;
      }
      currentCard = {
        checked: card[1].toLocaleLowerCase() === "x",
        checklist: [],
        id: `card-${columns.length - 1}-${current.cards.length}`,
        text: parsedLine(card[2], "빈 카드", lineIndex + 1, diagnostics)
      };
      current.cards.push(currentCard);
      continue;
    }
    addDiagnostic(diagnostics, `${lineIndex + 1}행은 Kanban이 안전하게 보존할 수 없는 Markdown입니다.`);
  }
  if (!columns.length) {
    addDiagnostic(diagnostics, "Kanban에는 하나 이상의 ## 열이 필요합니다.");
  }
  const errors = finalizedDiagnostics(diagnostics);
  return {
    document: columns.length ? { columns, frontmatter: frontmatter[1], title } : null,
    errors,
    readOnly: errors.length > 0
  };
}

export function serializeKanbanDocument(document: KanbanDocument) {
  if (!KANBAN_MARKER.test(document.frontmatter) || document.frontmatter.length > 100_000) {
    throw new Error("Kanban frontmatter를 안전하게 보존할 수 없습니다.");
  }
  if (document.columns.length < 1 || document.columns.length > MAX_COLUMNS) {
    throw new Error(`Kanban 열은 1~${MAX_COLUMNS}개여야 합니다.`);
  }
  const totalCards = document.columns.reduce((sum, column) => sum + column.cards.length, 0);
  if (totalCards > MAX_CARDS) {
    throw new Error(`Kanban 카드는 ${MAX_CARDS}개까지만 저장할 수 있습니다.`);
  }
  const totalChecklistItems = document.columns.reduce(
    (sum, column) => sum + column.cards.reduce((cardSum, card) => cardSum + (card.checklist?.length ?? 0), 0),
    0
  );
  if (totalChecklistItems > MAX_CHECKLIST_ITEMS) {
    throw new Error(`하위 체크리스트는 ${MAX_CHECKLIST_ITEMS}개까지만 저장할 수 있습니다.`);
  }
  const columns = document.columns;
  const lines = [
    "---",
    document.frontmatter,
    "---",
    `# ${writableLine(document.title, "Kanban")}`,
    ""
  ];
  for (const [columnIndex, column] of columns.entries()) {
    lines.push(`## ${writableLine(column.title, `열 ${columnIndex + 1}`)}`);
    for (const card of column.cards) {
      lines.push(`- [${card.checked ? "x" : " "}] ${writableLine(card.text, "빈 카드")}`);
      for (const item of card.checklist ?? []) {
        lines.push(`  - [${item.checked ? "x" : " "}] ${writableLine(item.text, "빈 체크 항목")}`);
      }
    }
    lines.push("");
  }
  const source = `${lines.join("\n")}\n`;
  const validated = parseKanbanSource(source);
  if (!validated.document || validated.readOnly) {
    throw new Error(validated.errors[0] ?? "Kanban 저장 형식을 검증하지 못했습니다.");
  }
  return source;
}

/**
 * Converts a plain/Obsidian Kanban Markdown document into QuickMemo's bounded
 * canonical form. Conversion is explicit and never overwrites the input.
 */
export function importKanbanMarkdown(source: string): KanbanImportResult {
  if (source.length > MAX_BOARD_CHARACTERS || new TextEncoder().encode(source).byteLength > MAX_BOARD_CHARACTERS) {
    return { errors: ["가져올 Kanban Markdown이 500,000자 제한을 초과했습니다."], source: null, warnings: [] };
  }
  const warnings: string[] = [];
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  let body = frontmatter ? source.slice(frontmatter[0].length) : source;
  const properties = frontmatter
    ? frontmatter[1].split(/\r?\n/u).filter((line) => !/^\s*(?:quickmemo-plugin|kanban-plugin)\s*:/iu.test(line))
    : [];
  body = body.replace(/\n?%%\s*kanban:settings\s*[\s\S]*?%%\s*$/iu, () => {
    warnings.push("Obsidian Kanban 표시 설정은 데이터가 아니므로 가져오지 않았습니다.");
    return "\n";
  });
  const canonical = `---\nquickmemo-plugin: kanban-v1${properties.length ? `\n${properties.join("\n")}` : ""}\n---\n${body.replace(/^\s+/u, "")}`;
  const parsed = parseKanbanSource(canonical);
  if (!parsed.document || parsed.readOnly) {
    return { errors: parsed.errors, source: null, warnings };
  }
  try {
    return { errors: [], source: serializeKanbanDocument(parsed.document), warnings };
  } catch (error) {
    return {
      errors: [error instanceof Error ? error.message : "Kanban Markdown을 가져오지 못했습니다."],
      source: null,
      warnings
    };
  }
}

export function exportObsidianKanbanMarkdown(document: KanbanDocument) {
  const quickMemoSource = serializeKanbanDocument(document);
  return quickMemoSource.replace(
    /^---\n([\s\S]*?)\n---/u,
    (_match, properties: string) => `---\n${properties.replace(/^quickmemo-plugin:\s*kanban-v1\s*$/imu, "kanban-plugin: basic")}\n---`
  );
}

export function isKanbanSource(source: string) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  return Boolean(frontmatter && KANBAN_MARKER.test(frontmatter[1]));
}
