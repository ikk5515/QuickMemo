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

export interface SecureShareStateQuery {
  accessToken: string;
  collectionId: string;
  limit: number;
  projectId: string;
  shareId: string;
}

export interface ExpiredSecureShareStateQuery {
  accessToken: string;
  allDescendants?: boolean;
  collectionId: string;
  fieldPath: "expiresAt" | "retentionExpiresAt";
  limit: number;
  nowIso: string;
  projectId: string;
}

export function querySecureShareDocumentsByShareId(
  input: SecureShareStateQuery
): Promise<Array<{ name: string }>>;

export function queryExpiredSecureShareDocuments(
  input: ExpiredSecureShareStateQuery
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

export interface FirestoreRestDocument {
  fields?: Record<string, unknown>;
  name?: string;
  updateTime?: string;
}

export function beginAttachmentDeletionByName(
  projectId: string,
  documentName: string,
  accessToken: string,
  shouldDelete?: (document: FirestoreRestDocument) => boolean,
  requiredCopyJobId?: string,
  requiredCleanupClaimId?: string
): Promise<FirestoreRestDocument | null>;

export interface CleanupHttpRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
}

export interface CleanupHttpResponse {
  end(body?: string): void;
  setHeader(name: string, value: string): void;
  statusCode: number;
}

export default function handler(
  request: CleanupHttpRequest,
  response: CleanupHttpResponse
): Promise<void>;
