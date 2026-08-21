export interface FuzzyRankedItem<T> {
  item: T;
  score: number;
}

const WORD_BOUNDARY = /[\s/\\._()[\]{}\-:]+/u;

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function scoreFuzzyToken(candidate: string, token: string): number | null {
  if (candidate === token) {
    return 4_000;
  }
  if (candidate.startsWith(token)) {
    return 3_000 - Math.min(candidate.length - token.length, 500);
  }

  const words = candidate.split(WORD_BOUNDARY);
  if (words.some((word) => word.startsWith(token))) {
    return 2_500 - Math.min(candidate.length - token.length, 500);
  }

  let candidateIndex = 0;
  let firstMatch = -1;
  let previousMatch = -2;
  let consecutiveMatches = 0;
  let gapPenalty = 0;

  for (const tokenCharacter of token) {
    const matchIndex = candidate.indexOf(tokenCharacter, candidateIndex);
    if (matchIndex === -1) {
      return null;
    }
    if (firstMatch === -1) {
      firstMatch = matchIndex;
    }
    if (matchIndex === previousMatch + 1) {
      consecutiveMatches += 1;
    } else if (previousMatch >= 0) {
      gapPenalty += matchIndex - previousMatch - 1;
    }
    previousMatch = matchIndex;
    candidateIndex = matchIndex + tokenCharacter.length;
  }

  return 1_500 + consecutiveMatches * 24 - gapPenalty * 8 - firstMatch * 4
    - Math.min(candidate.length - token.length, 300);
}

export function fuzzyScore(searchText: string, query: string): number | null {
  const candidate = normalize(searchText.trim());
  const tokens = normalize(query).trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    return 0;
  }

  let total = 0;
  for (const token of tokens) {
    const score = scoreFuzzyToken(candidate, token);
    if (score === null) {
      return null;
    }
    total += score;
  }
  return total;
}

export function rankFuzzyItems<T>(
  items: readonly T[],
  query: string,
  searchText: (item: T) => string
): Array<FuzzyRankedItem<T>> {
  if (query.trim().length === 0) {
    return items.map((item) => ({ item, score: 0 }));
  }

  return items
    .map((item, originalIndex) => ({
      item,
      originalIndex,
      score: fuzzyScore(searchText(item), query)
    }))
    .filter((result): result is { item: T; originalIndex: number; score: number } => (
      result.score !== null
    ))
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex)
    .map(({ item, score }) => ({ item, score }));
}
