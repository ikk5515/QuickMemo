/** Public copies contain no original IDs, owner profile, keys, or encrypted envelopes. */
export const PUBLISHED_WIKI_LIMITS = Object.freeze({
  notes: 200,
  assets: 64,
  folders: 200,
  textBytes: 128 * 1024,
  assetBytes: 512 * 1024,
  totalBytes: 20 * 1024 * 1024,
  chunkBytes: 1024 * 1024,
  contentPageSize: 8
});

export type PublishedWikiEntryKind = "markdown" | "legacy-html" | "asset";

export interface WikiPublicationFolderInput {
  sourceFolderId: string;
  parentSourceFolderId: string | null;
  name: string;
}

export interface WikiPublicationEntryInput {
  sourceNoteId: string;
  sourceRevision: number;
  sourceFolderId: string | null;
  /** Public placement; null exposes an individually selected note at the wiki root. */
  parentSourceFolderId?: string | null;
  title: string;
  kind: PublishedWikiEntryKind;
}

export interface WikiPublicationSelection { folderIds: string[]; noteIds: string[] }

export interface WikiPublicationInput {
  /** Legacy publications have one source root; workspace publications use selection. */
  rootFolderId: string | null;
  selection?: WikiPublicationSelection;
  title: string;
  /** null means published until explicitly unpublished or its source access is removed. */
  expiresAt: string | null;
  folders: WikiPublicationFolderInput[];
  entries: WikiPublicationEntryInput[];
}

export interface WikiPublicationContentInput { sourceNoteId: string; body: string }

export interface PreparedWikiPublication {
  manifest: WikiPublicationInput;
  contents: WikiPublicationContentInput[];
  omittedEntryCount: number;
  redactedLinkCount: number;
  totalBytes: number;
}

export interface PublishedWikiLegacySummary { wikiId: string; rootFolderId: string; title: string; published: boolean; revision: number }

export interface PublishedWikiOwnerStatus {
  slug?: string | null;
  selection?: WikiPublicationSelection;
  manifest?: WikiPublicationInput | null;
  legacyPublications?: PublishedWikiLegacySummary[];
  legacyHasMore?: boolean;
  wikiId: string | null;
  revision: number;
  published: boolean;
  title: string;
  expiresAt: string | null;
  updatedAt: string | null;
  noteCount: number;
  assetCount: number;
}

export interface WikiPublicationStage {
  wikiId: string;
  generation: string;
  expectedRevision: number;
}

export interface PublishedWikiFolder { id: string; parentId: string | null; name: string; path: string }
export interface PublishedWikiEntry { id: string; folderId: string | null; title: string; path: string; kind: PublishedWikiEntryKind }
export interface PublishedWikiManifest {
  slug?: string | null;
  wikiId: string;
  revision: number;
  title: string;
  expiresAt: string | null;
  updatedAt: string;
  folders: PublishedWikiFolder[];
  entries: PublishedWikiEntry[];
}
export interface PublishedWikiContent extends PublishedWikiEntry { body: string }
export interface PublishedWikiContentPage { revision: number; entries: PublishedWikiContent[] }

export const WIKI_SLUG_MIN_LENGTH = 3;
export const WIKI_SLUG_MAX_LENGTH = 40;
export const WIKI_RESERVED_SLUGS = Object.freeze([
  "admin", "api", "login", "logout", "signup", "settings", "new", "edit", "public", "private", "assets", "static",
  "setup", "home", "app", "wiki", "library", "schedule", "recurring", "share", "s", "legacy"
]);
/** Normalize ASCII case and surrounding spacing; Unicode is never folded into another owner’s slug. */
export function normalizeWikiSlug(value: string): string { return value.trim().replace(/[A-Z]/gu, (letter) => letter.toLowerCase()); }
export function isValidWikiSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/u.test(value) && !WIKI_RESERVED_SLUGS.includes(value);
}
