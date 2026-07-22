export interface GoogleCalendarOAuthStateCleanupQuery {
  accessToken: string;
  projectId: string;
  nowIso: string;
  limit: number;
}

export function googleCalendarOAuthStateCleanupBatchLimit(
  batchSize: number,
  maxDocumentDeletes: number
): number;

export function queryExpiredGoogleCalendarOAuthStates(
  input: GoogleCalendarOAuthStateCleanupQuery
): Promise<Array<{ name: string }>>;

export interface LegacyNoteDeletionPageQuery {
  accessToken: string;
  projectId: string;
  limit: number;
  lastDocumentName?: string;
}

export interface LegacyNoteDeletionBackfillConfig {
  accessToken: string;
  projectId: string;
  legacyNoteBackfillMaxScanned: number;
  legacyNoteBackfillPageSize: number;
}

export interface LegacyNoteDeletionBackfillStats {
  legacyNoteBackfillComplete: boolean;
  legacyNoteBackfillFailed?: boolean;
  legacyNotesBackfilled: number;
  legacyNotesScanned: number;
}

export function queryLegacyNoteDeletionPage(
  input: LegacyNoteDeletionPageQuery
): Promise<Array<{
  fields?: Record<string, unknown>;
  name: string;
  updateTime?: string;
}>>;

export function backfillLegacyNoteDeletionMetadata(
  config: LegacyNoteDeletionBackfillConfig,
  stats: LegacyNoteDeletionBackfillStats
): Promise<void>;
