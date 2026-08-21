export interface TemplateCandidate {
  body: string;
  id: string;
  path: string;
  title: string;
}

interface TemplateSourceNote {
  body: string;
  entryKind: string;
  id: string;
  title: string;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function uniqueNoteTitle(now: Date): string {
  return [
    now.getFullYear(),
    twoDigits(now.getMonth() + 1),
    twoDigits(now.getDate()),
    twoDigits(now.getHours()),
    twoDigits(now.getMinutes()),
    twoDigits(now.getSeconds())
  ].join("");
}

export function templateCandidates(
  notes: readonly TemplateSourceNote[],
  entryPaths: ReadonlyMap<string, string>
): TemplateCandidate[] {
  return notes.flatMap((note) => {
    if (note.entryKind !== "markdown") {
      return [];
    }
    const path = entryPaths.get(note.id) ?? note.title;
    const directorySegments = path.split("/").slice(0, -1);
    if (!directorySegments.some((segment) => /^(?:templates|템플릿)$/iu.test(segment))) {
      return [];
    }
    return [{ body: note.body, id: note.id, path, title: note.title }];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function chooseTemplate(
  candidates: readonly TemplateCandidate[],
  query: string
): TemplateCandidate | null {
  const normalized = query.trim().replace(/\.md$/iu, "").normalize("NFC").toLocaleLowerCase();
  if (!normalized) {
    return null;
  }
  const exact = candidates.find((candidate) => (
    candidate.title.replace(/\.md$/iu, "").normalize("NFC").toLocaleLowerCase() === normalized
    || candidate.path.replace(/\.md$/iu, "").normalize("NFC").toLocaleLowerCase() === normalized
  ));
  if (exact) {
    return exact;
  }
  const partial = candidates.filter((candidate) => (
    candidate.title.normalize("NFC").toLocaleLowerCase().includes(normalized)
    || candidate.path.normalize("NFC").toLocaleLowerCase().includes(normalized)
  ));
  return partial.length === 1 ? partial[0] : null;
}

function localDate(now: Date): string {
  return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
}

function localTime(now: Date): string {
  return `${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}`;
}

export function expandTemplate(source: string, context: { now: Date; title: string }): string {
  return source
    .replace(/\{\{\s*title\s*\}\}/giu, () => context.title)
    .replace(/\{\{\s*date\s*\}\}/giu, () => localDate(context.now))
    .replace(/\{\{\s*time\s*\}\}/giu, () => localTime(context.now));
}
