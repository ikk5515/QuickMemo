import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BlobAttachmentCompletionUncertainError,
  BlobAttachmentReservationCleanupError,
  uploadNoteAttachmentBlob,
  uploadPublicShareAttachmentBlob
} from "./blobAttachments";

const mocks = vi.hoisted(() => ({
  auth: {
    currentUser: {
      getIdToken: vi.fn(async () => "firebase-id-token")
    }
  },
  put: vi.fn()
}));

vi.mock("../lib/firebase", () => ({
  auth: mocks.auth
}));

vi.mock("@vercel/blob/client", () => ({
  put: mocks.put
}));

function uploadInput(signal: AbortSignal) {
  return {
    attachmentId: "attachment_123456",
    encryptedBlob: new Blob([new Uint8Array(20)]),
    encryption: {
      algorithm: "AES-GCM" as const,
      encryptedSize: 20,
      iv: new Uint8Array(12),
      version: 1 as const
    },
    extension: "pdf",
    encryptedFileName: {
      algorithm: "AES-GCM" as const,
      cipherText: "encrypted-name",
      iv: "name-iv",
      version: 1 as const
    },
    fileName: "note-pdf-attachment",
    mimeType: "application/pdf",
    noteId: "note_123456",
    originalSize: 4,
    privacyVersion: 1 as const,
    secureShareCopyJobId: "copy_job_1234567890",
    signal,
    uploadedBy: "user_123456"
  };
}

function tokenResponse() {
  return new Response(JSON.stringify({ clientToken: "blob-client-token" }), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function publicShareUploadInput(signal: AbortSignal) {
  return {
    attachmentId: "attachment_123456",
    encryptedBlob: new Blob([new Uint8Array(20)]),
    encryption: {
      algorithm: "AES-GCM" as const,
      encryptedSize: 20,
      iv: new Uint8Array(12),
      version: 1 as const
    },
    encryptedFileName: {
      algorithm: "AES-GCM" as const,
      cipherText: "encrypted-public-name",
      iv: "public-name-iv",
      version: 1 as const
    },
    extension: "pdf",
    generation: "generation_123456",
    mimeType: "application/pdf",
    originalSize: 4,
    shareId: "share_123456",
    signal
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

describe("Blob attachment upload cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes the signal to Blob put and upload completion", async () => {
    const controller = new AbortController();
    const blobResult = {
      contentDisposition: "attachment",
      contentType: "application/octet-stream",
      downloadUrl: "https://blob.example/download",
      pathname: "users/user_123456/notes/note_123456/attachments/attachment_123456/data",
      url: "https://blob.example/data"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.put.mockResolvedValue(blobResult);

    await expect(uploadNoteAttachmentBlob(uploadInput(controller.signal)))
      .resolves.toEqual(blobResult);

    expect(mocks.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Blob),
      expect.objectContaining({
        abortSignal: controller.signal,
        multipart: true,
        token: "blob-client-token"
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: "POST"
    }));
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      signal: controller.signal
    }));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "PATCH",
      signal: controller.signal
    }));
  });

  it("marks public-share filename metadata private in the token request", async () => {
    const controller = new AbortController();
    const blobResult = {
      contentDisposition: "attachment",
      contentType: "application/octet-stream",
      downloadUrl: "https://blob.example/download",
      pathname: "users/user_123456/publicNoteShares/share_123456/attachments/attachment_123456/data",
      url: "https://blob.example/data"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.put.mockResolvedValue(blobResult);

    await expect(uploadPublicShareAttachmentBlob(
      publicShareUploadInput(controller.signal),
      "user_123456"
    )).resolves.toEqual(blobResult);

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const clientPayload = JSON.parse(requestBody.payload.clientPayload);
    expect(clientPayload).toMatchObject({
      attachmentId: "attachment_123456",
      encryptedFileName: expect.objectContaining({
        cipherText: "encrypted-public-name",
        iv: "public-name-iv"
      }),
      fileName: "shared-pdf-attachment",
      privacyVersion: 1,
      scope: "publicShare",
      shareId: "share_123456"
    });
  });

  it("cancels the reservation without reusing an aborted signal when put is aborted", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.put.mockImplementation((
      _pathname: string,
      _body: Blob,
      options: { abortSignal?: AbortSignal }
    ) => new Promise((_resolve, reject) => {
      options.abortSignal?.addEventListener("abort", () => {
        reject(new DOMException("upload cancelled", "AbortError"));
      }, { once: true });
    }));

    const uploading = uploadNoteAttachmentBlob(uploadInput(controller.signal));
    await vi.waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(uploading).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "DELETE"
    }));
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("signal");
  });

  it("waits for an issued token and releases its reservation when cancellation wins", async () => {
    const controller = new AbortController();
    const tokenGate = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => tokenGate.promise)
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const uploading = uploadNoteAttachmentBlob(uploadInput(controller.signal));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    tokenGate.resolve(tokenResponse());

    await expect(uploading).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.put).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "DELETE"
    }));
  });

  it("retries a rejected reservation cleanup response and preserves the upload error", async () => {
    const controller = new AbortController();
    const uploadError = new Error("put failed");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "temporary cleanup failure" }),
        {
          headers: { "content-type": "application/json" },
          status: 503
        }
      ))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.put.mockRejectedValue(uploadError);

    await expect(uploadNoteAttachmentBlob(uploadInput(controller.signal)))
      .rejects.toBe(uploadError);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.slice(1).every(([, options]) =>
      options?.method === "DELETE"
    )).toBe(true);
  });

  it("propagates the reservation target when bounded cleanup retries are exhausted", async () => {
    const controller = new AbortController();
    const uploadError = new DOMException("upload cancelled", "AbortError");
    const networkError = new TypeError("network unavailable");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "cleanup still unavailable" }),
        {
          headers: { "content-type": "application/json" },
          status: 503
        }
      ));
    vi.stubGlobal("fetch", fetchMock);
    mocks.put.mockRejectedValue(uploadError);

    const result = await uploadNoteAttachmentBlob(uploadInput(controller.signal))
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(BlobAttachmentReservationCleanupError);
    expect(result).toMatchObject({
      attachmentId: "attachment_123456",
      cleanupError: expect.objectContaining({
        message: "cleanup still unavailable"
      }),
      code: "blob/reservation-cleanup-failed",
      noteId: "note_123456",
      scope: "note",
      uploadError
    });
    expect((result as Error).cause).toBe(uploadError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries an idempotent completion after its response is lost", async () => {
    const controller = new AbortController();
    const blobResult = {
      contentDisposition: "attachment",
      contentType: "application/octet-stream",
      downloadUrl: "https://blob.example/download",
      pathname: "users/user_123456/notes/note_123456/attachments/attachment_123456/data",
      url: "https://blob.example/data"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new TypeError("completion response lost"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.put.mockResolvedValue(blobResult);

    await expect(uploadNoteAttachmentBlob(uploadInput(controller.signal)))
      .resolves.toEqual(blobResult);
    expect(fetchMock.mock.calls.map(([, options]) => options?.method ?? "GET"))
      .toEqual(["POST", "PATCH", "PATCH"]);
  });

  it("treats a ready status as success and never deletes after ambiguous completion", async () => {
    const controller = new AbortController();
    const blobResult = {
      contentDisposition: "attachment",
      contentType: "application/octet-stream",
      downloadUrl: "https://blob.example/download",
      pathname: "users/user_123456/notes/note_123456/attachments/attachment_123456/data",
      url: "https://blob.example/data"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new TypeError("lost-1"))
      .mockRejectedValueOnce(new TypeError("lost-2"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready" }), {
        headers: { "content-type": "application/json" },
        status: 200
      }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.put.mockResolvedValue(blobResult);

    await expect(uploadNoteAttachmentBlob(uploadInput(controller.signal)))
      .resolves.toEqual(blobResult);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("type=attachment.status");
  });

  it("deletes only after status confirms the uploaded reservation is still pending", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new TypeError("lost-1"))
      .mockRejectedValueOnce(new TypeError("lost-2"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" }), {
        headers: { "content-type": "application/json" },
        status: 200
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.put.mockResolvedValue({
      contentDisposition: "attachment",
      contentType: "application/octet-stream",
      downloadUrl: "https://blob.example/download",
      pathname: "users/user_123456/notes/note_123456/attachments/attachment_123456/data",
      url: "https://blob.example/data"
    });

    await expect(uploadNoteAttachmentBlob(uploadInput(controller.signal)))
      .rejects.toThrow("업로드 완료 처리를 하지 못했습니다");
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE"))
      .toHaveLength(1);
  });

  it("preserves an uploaded blob when completion status also cannot be confirmed", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new TypeError("lost-1"))
      .mockRejectedValueOnce(new TypeError("lost-2"))
      .mockRejectedValueOnce(new TypeError("status unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    mocks.put.mockResolvedValue({
      contentDisposition: "attachment",
      contentType: "application/octet-stream",
      downloadUrl: "https://blob.example/download",
      pathname: "users/user_123456/notes/note_123456/attachments/attachment_123456/data",
      url: "https://blob.example/data"
    });

    await expect(uploadNoteAttachmentBlob(uploadInput(controller.signal)))
      .rejects.toBeInstanceOf(BlobAttachmentCompletionUncertainError);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
  });

  it("reissues an exact pending token request after response loss", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("token response lost"))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.put.mockResolvedValue({
      contentDisposition: "attachment",
      contentType: "application/octet-stream",
      downloadUrl: "https://blob.example/download",
      pathname: "users/user_123456/notes/note_123456/attachments/attachment_123456/data",
      url: "https://blob.example/data"
    });

    await expect(uploadNoteAttachmentBlob(uploadInput(controller.signal))).resolves.toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST"))
      .toHaveLength(2);
    expect(mocks.put).toHaveBeenCalledOnce();
  });
});
