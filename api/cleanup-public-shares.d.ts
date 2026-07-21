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
