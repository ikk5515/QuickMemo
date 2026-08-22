import { normalizeMarkdownLineEndings } from "../../markdown";
import { canonicalVaultName } from "../vaultIntegrity";

export const MAX_NOTE_COMPOSER_BODY_CHARACTERS = 900_000;

export interface ComposerEntrySnapshot {
  body: string;
  contentFormat: "markdown-v1";
  dirty: boolean;
  folderId: string | null;
  id: string;
  revision: number;
  title: string;
}

export type ComposerRevisionGuard = ComposerEntrySnapshot;

export interface NoteSplitPlan {
  create: {
    body: string;
    folderId: string | null;
    operationId: string;
    title: string;
  };
  replaceSelectionWithLink: boolean;
  source: ComposerRevisionGuard;
  sourceBodyAfterCreate: string;
}

export interface NoteMergePlan {
  operationId: string;
  source: ComposerRevisionGuard;
  target: ComposerRevisionGuard;
  targetBodyAfterMerge: string;
  trashSourceAfterMerge: boolean;
}

export interface NoteComposerAdapter {
  createMarkdownCopy: (input: NoteSplitPlan["create"]) => Promise<{ entryId: string; revision: number }>;
  flushDirtyDraft: (guard: ComposerRevisionGuard) => Promise<ComposerEntrySnapshot>;
  readEntry: (entryId: string) => Promise<ComposerEntrySnapshot | null>;
  saveMarkdown: (input: {
    body: string;
    entryId: string;
    expectedBody: string;
    expectedRevision: number;
    operationId: string;
    title: string;
  }) => Promise<{ revision: number }>;
  trashEntry: (input: {
    entryId: string;
    expectedBody: string;
    expectedRevision: number;
    operationId: string;
  }) => Promise<void>;
}

export type NoteSplitExecutionResult =
  | { kind: "complete"; createdEntryId: string; sourceRevision: number | null }
  | { kind: "created-copy-source-unchanged"; createdEntryId: string; reason: string };

export type NoteMergeExecutionResult =
  | { kind: "complete"; targetRevision: number }
  | { kind: "merged-source-kept"; targetRevision: number; reason: string };

function operationId(factory: () => string) {
  const value = factory().trim();
  if (!/^[a-zA-Z0-9_-]{8,120}$/u.test(value)) {
    throw new Error("Note composer 작업 식별자를 만들지 못했습니다.");
  }
  return value;
}

function defaultOperationId() {
  return globalThis.crypto.randomUUID();
}

function assertComposerEntry(entry: ComposerEntrySnapshot) {
  if (
    !entry.id
    || entry.contentFormat !== "markdown-v1"
    || !Number.isSafeInteger(entry.revision)
    || entry.revision < 0
    || !entry.title.trim()
    || entry.title.includes("\n")
    || entry.title.length > 180
    || entry.body.length > MAX_NOTE_COMPOSER_BODY_CHARACTERS
  ) {
    throw new Error("Note composer에서 사용할 노트 상태가 올바르지 않습니다.");
  }
  canonicalVaultName(entry.title, "entry", "markdown");
}

function titleForWikilink(title: string) {
  const target = title.trim().replace(/\.md$/iu, "");
  return ["[", "]", "|", "#"].some((character) => target.includes(character)) ? "" : target;
}

function validSelectionBoundary(source: string, offset: number) {
  if (offset <= 0 || offset >= source.length) return true;
  const previous = source.charCodeAt(offset - 1);
  const next = source.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

export function planNoteSplit(
  source: ComposerEntrySnapshot,
  options: {
    end: number;
    newTitle: string;
    operationIdFactory?: () => string;
    replaceSelectionWithLink?: boolean;
    start: number;
  }
): NoteSplitPlan {
  assertComposerEntry(source);
  const title = options.newTitle.trim().normalize("NFC");
  if (!title || title.length > 180 || title.includes("\n")) {
    throw new Error("새 노트 이름은 한 줄 1~180자로 입력해주세요.");
  }
  canonicalVaultName(title, "entry", "markdown");
  if (
    !Number.isSafeInteger(options.start)
    || !Number.isSafeInteger(options.end)
    || options.start < 0
    || options.end > source.body.length
    || options.start >= options.end
    || !validSelectionBoundary(source.body, options.start)
    || !validSelectionBoundary(source.body, options.end)
  ) {
    throw new Error("분리할 Markdown 선택 범위가 올바르지 않습니다.");
  }
  const body = source.body.slice(options.start, options.end);
  if (!body.trim()) throw new Error("빈 내용은 새 노트로 분리할 수 없습니다.");
  const replaceSelectionWithLink = options.replaceSelectionWithLink !== false;
  const wikilinkTarget = titleForWikilink(title);
  if (replaceSelectionWithLink && !wikilinkTarget) {
    throw new Error("새 노트 이름으로 안전한 Wikilink를 만들 수 없습니다.");
  }
  const replacement = replaceSelectionWithLink ? `[[${wikilinkTarget}]]` : "";
  const sourceBodyAfterCreate = `${source.body.slice(0, options.start)}${replacement}${source.body.slice(options.end)}`;
  return {
    create: {
      body,
      folderId: source.folderId,
      operationId: operationId(options.operationIdFactory ?? defaultOperationId),
      title
    },
    replaceSelectionWithLink,
    source: { ...source },
    sourceBodyAfterCreate
  };
}

function mergedMarkdown(target: ComposerEntrySnapshot, source: ComposerEntrySnapshot) {
  const targetBody = normalizeMarkdownLineEndings(target.body).trimEnd();
  const normalizedSource = normalizeMarkdownLineEndings(source.body);
  const frontmatter = normalizedSource.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)(?:\n|$)/u);
  const sourceBody = (frontmatter ? normalizedSource.slice(frontmatter[0].length) : normalizedSource).trim();
  const preservedProperties = frontmatter
    ? `\n\n### 원본 Properties\n\n${fencedSource("yaml", frontmatter[1].trimEnd())}`
    : "";
  const sourceSection = `## ${source.title.trim().replace(/^#+\s*/u, "")}\n\n${sourceBody}`;
  const mergedSection = `${sourceSection}${preservedProperties}`;
  return targetBody ? `${targetBody}\n\n${mergedSection}\n` : `${mergedSection}\n`;
}

function fencedSource(language: string, source: string) {
  const longestRun = Math.max(0, ...Array.from(source.matchAll(/`+/gu), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${source}\n${fence}`;
}

export function planNoteMerge(
  source: ComposerEntrySnapshot,
  target: ComposerEntrySnapshot,
  options: {
    operationIdFactory?: () => string;
    trashSourceAfterMerge?: boolean;
  } = {}
): NoteMergePlan {
  assertComposerEntry(source);
  assertComposerEntry(target);
  if (source.id === target.id) throw new Error("노트를 자기 자신과 합칠 수 없습니다.");
  const targetBodyAfterMerge = mergedMarkdown(target, source);
  if (targetBodyAfterMerge.length > MAX_NOTE_COMPOSER_BODY_CHARACTERS) {
    throw new Error("합친 노트가 안전한 저장 크기를 넘습니다.");
  }
  return {
    operationId: operationId(options.operationIdFactory ?? defaultOperationId),
    source: { ...source },
    target: { ...target },
    targetBodyAfterMerge,
    trashSourceAfterMerge: options.trashSourceAfterMerge === true
  };
}

function sameComposerPayload(left: ComposerEntrySnapshot, right: ComposerEntrySnapshot) {
  return left.id === right.id
    && left.body === right.body
    && left.folderId === right.folderId
    && left.title === right.title;
}

async function currentGuard(
  guard: ComposerRevisionGuard,
  adapter: Pick<NoteComposerAdapter, "flushDirtyDraft" | "readEntry">
): Promise<ComposerEntrySnapshot> {
  const flushed = guard.dirty ? await adapter.flushDirtyDraft(guard) : guard;
  if (!sameComposerPayload(flushed, guard)) {
    throw new Error("저장 중 로컬 초안이 달라졌습니다. Note composer를 다시 열어주세요.");
  }
  const latest = await adapter.readEntry(guard.id);
  if (!latest || !sameComposerPayload(latest, guard) || latest.revision !== flushed.revision || latest.dirty) {
    throw new Error("노트가 다른 탭 또는 기기에서 변경되었습니다. 최신 내용을 확인한 뒤 다시 실행해주세요.");
  }
  return latest;
}

export async function executeNoteSplit(
  plan: NoteSplitPlan,
  adapter: NoteComposerAdapter
): Promise<NoteSplitExecutionResult> {
  const source = await currentGuard(plan.source, adapter);
  const created = await adapter.createMarkdownCopy(plan.create);
  if (!plan.replaceSelectionWithLink) {
    return { kind: "complete", createdEntryId: created.entryId, sourceRevision: null };
  }
  try {
    const saved = await adapter.saveMarkdown({
      body: plan.sourceBodyAfterCreate,
      entryId: source.id,
      expectedBody: source.body,
      expectedRevision: source.revision,
      operationId: plan.create.operationId,
      title: source.title
    });
    return { kind: "complete", createdEntryId: created.entryId, sourceRevision: saved.revision };
  } catch (caught) {
    return {
      kind: "created-copy-source-unchanged",
      createdEntryId: created.entryId,
      reason: caught instanceof Error ? caught.message : "원본에 새 노트 링크를 기록하지 못했습니다."
    };
  }
}

export async function executeNoteMerge(
  plan: NoteMergePlan,
  adapter: NoteComposerAdapter
): Promise<NoteMergeExecutionResult> {
  const source = await currentGuard(plan.source, adapter);
  const target = await currentGuard(plan.target, adapter);
  const saved = await adapter.saveMarkdown({
    body: plan.targetBodyAfterMerge,
    entryId: target.id,
    expectedBody: target.body,
    expectedRevision: target.revision,
    operationId: plan.operationId,
    title: target.title
  });
  if (!plan.trashSourceAfterMerge) {
    return { kind: "complete", targetRevision: saved.revision };
  }
  try {
    const latestSource = await adapter.readEntry(source.id);
    if (!latestSource || !sameComposerPayload(latestSource, source) || latestSource.revision !== source.revision) {
      throw new Error("병합 후 원본이 변경되어 휴지통으로 이동하지 않았습니다.");
    }
    await adapter.trashEntry({
      entryId: source.id,
      expectedBody: source.body,
      expectedRevision: source.revision,
      operationId: plan.operationId
    });
    return { kind: "complete", targetRevision: saved.revision };
  } catch (caught) {
    return {
      kind: "merged-source-kept",
      targetRevision: saved.revision,
      reason: caught instanceof Error ? caught.message : "원본을 휴지통으로 이동하지 못했습니다."
    };
  }
}
