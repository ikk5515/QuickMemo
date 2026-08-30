export interface BlobAttachmentFirestoreDocument {
  fields?: Record<string, unknown>;
  name?: string;
  updateTime?: string;
}

export type BlobAttachmentExtraWrites =
  | Array<Record<string, unknown>>
  | (() => Promise<Array<Record<string, unknown>>>);

export function reserveUserAttachmentBytes(
  projectId: string,
  accessToken: string,
  uid: string,
  bytes: number,
  extraWrites: BlobAttachmentExtraWrites
): Promise<void>;

export function reserveNoteAttachmentCountWrite(
  projectId: string,
  accessToken: string,
  noteId: string
): Promise<Record<string, unknown>>;

export function noteAttachmentReservationWrites(
  projectId: string,
  accessToken: string,
  uid: string,
  payload: Record<string, unknown>,
  attachmentWrite: Record<string, unknown>
): Promise<Array<Record<string, unknown>>>;

export function claimAttachmentDeletion(
  projectId: string,
  accessToken: string,
  attachmentPath: string,
  extraDeletePaths?: string[]
): Promise<BlobAttachmentFirestoreDocument | null>;

export function publicShareAttachmentIsCurrent(
  share: BlobAttachmentFirestoreDocument,
  attachment: BlobAttachmentFirestoreDocument
): boolean;

export function safeAttachmentMimeType(extension: string, mimeType: string): string;

export function canonicalNoteAttachmentMimeType(extension: string, mimeType: string): string;

export function safeFileName(value: string): string;

export function lookupCallerUid(idToken: string): Promise<string>;

export function attachmentRateLimitDecision(input: {
  cost: number;
  count: number;
  limit: number;
  nowMilliseconds: number;
  windowSeconds: number;
}): {
  allow: boolean;
  nextCount: number;
  retryAfter: number;
  windowStartSeconds: number;
};

export function safeErrorSummary(error: unknown): {
  kind: "error" | "non_error";
  status?: number;
  statusCode?: number;
};

export const __blobAttachmentTesting: Readonly<{
  beginAttachmentDeletion(
    projectId: string,
    accessToken: string,
    attachmentPath: string,
    notePath?: string,
    noteUpdatedByUid?: string,
    authorizeCurrent?: (
      attachment: BlobAttachmentFirestoreDocument,
      note: BlobAttachmentFirestoreDocument | null
    ) => Promise<{
      allowed?: boolean;
      verifyDocuments?: BlobAttachmentFirestoreDocument[];
    }>
  ): Promise<BlobAttachmentFirestoreDocument | null>;
  markAttachmentReady(
    projectId: string,
    accessToken: string,
    tokenPayload: {
      attachmentPath: string;
      blobPath: string;
      encryptedSize: number;
      noteId: string;
      scope: "note" | "publicShare";
      uid: string;
      [key: string]: unknown;
    },
    uploadedBlob: { pathname: string; [key: string]: unknown }
  ): Promise<void>;
}>;

export default function handler(
  request: {
    body?: unknown;
    headers?: Record<string, string | string[] | undefined>;
    method?: string;
    url?: string;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  },
  response: {
    end(body?: unknown): void;
    setHeader(name: string, value: string | string[]): void;
    statusCode: number;
  }
): Promise<void>;
