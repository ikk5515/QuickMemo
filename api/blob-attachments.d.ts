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

export function safeErrorSummary(error: unknown): {
  kind: "error" | "non_error";
  status?: number;
  statusCode?: number;
};

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
