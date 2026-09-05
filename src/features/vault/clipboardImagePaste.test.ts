import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VAULT_CLIPBOARD_IMAGES,
  MAX_VAULT_CLIPBOARD_BATCH_SOURCE_BYTES,
  MAX_VAULT_CLIPBOARD_SOURCE_BYTES,
  MAX_VAULT_CLIPBOARD_TRANSCODE_DIMENSION,
  MAX_VAULT_CLIPBOARD_TRANSCODE_MS,
  VAULT_MARKDOWN_IMAGE_ACCEPT,
  clearPreparedVaultClipboardImages,
  prepareVaultClipboardImages,
  reserveVaultClipboardImageTitles,
  transcodeVaultClipboardImage,
  vaultClipboardImageEmbedSource,
  vaultClipboardImageFiles,
  vaultClipboardImageTitleStem,
  vaultSelectedImageFiles
} from "./clipboardImagePaste";
import { MAX_INLINE_VAULT_ASSET_BYTES, safeVaultAssetPreviewKind } from "./vaultAsset";

function pngBytes(width = 2, height = 2, imageDataBytes = 0) {
  const bytes = new Uint8Array(57 + imageDataBytes);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  view.setUint32(33, imageDataBytes);
  bytes.set(new TextEncoder().encode("IDAT"), 37);
  view.setUint32(45 + imageDataBytes, 0);
  bytes.set(new TextEncoder().encode("IEND"), 49 + imageDataBytes);
  return bytes;
}

function imageFile(bytes: Uint8Array, name: string, type: string) {
  const fileBytes = bytes.slice().buffer as ArrayBuffer;
  const file = new File([fileBytes], name, { type });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => fileBytes.slice(0)
  });
  return file;
}

function webpLosslessBytes(width = 2, height = 2) {
  const bytes = new Uint8Array(26);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  view.setUint32(16, 5, true);
  bytes[20] = 0x2f;
  view.setUint32(21, (width - 1) + ((height - 1) * 16_384), true);
  return bytes;
}

function pngWithManyAncillaryChunks(
  width: number,
  height: number,
  chunkCount: number,
  imageDataBytes: number
) {
  const bytes = new Uint8Array(57 + (chunkCount * 12) + imageDataBytes);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  let offset = 33;
  for (let index = 0; index < chunkCount; index += 1) {
    view.setUint32(offset, 0);
    bytes.set(new TextEncoder().encode("tEXt"), offset + 4);
    offset += 12;
  }
  view.setUint32(offset, imageDataBytes);
  bytes.set(new TextEncoder().encode("IDAT"), offset + 4);
  offset += 12 + imageDataBytes;
  view.setUint32(offset, 0);
  bytes.set(new TextEncoder().encode("IEND"), offset + 4);
  return bytes;
}

describe("encrypted Vault clipboard image preparation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prefers a supported clipboard representation over duplicate and unsupported alternatives", () => {
    const png = imageFile(pngBytes(), "clipboard.png", "image/png");
    const svg = imageFile(new TextEncoder().encode("<svg/>"), "clipboard.svg", "image/svg+xml");

    expect(vaultClipboardImageFiles({
      files: [png],
      items: [
        { getAsFile: () => png, kind: "file", type: "image/png" },
        { getAsFile: () => svg, kind: "file", type: "image/svg+xml" },
        { getAsFile: () => null, kind: "string", type: "text/plain" }
      ]
    })).toEqual([png]);

    expect(vaultClipboardImageFiles({
      files: [],
      items: [{ getAsFile: () => svg, kind: "file", type: "image/svg+xml" }]
    })).toEqual([svg]);
  });

  it("keeps empty and generic clipboard MIME files for byte-level validation", () => {
    const emptyMime = imageFile(pngBytes(), "", "");
    const genericMime = imageFile(pngBytes(), "clipboard", "application/octet-stream");

    expect(vaultClipboardImageFiles({
      files: [],
      items: [{ getAsFile: () => emptyMime, kind: "file", type: "" }]
    })).toEqual([emptyMime]);
    expect(vaultClipboardImageFiles({ files: [genericMime], items: [] })).toEqual([genericMime]);
  });

  it("uses a supported files representation when items exposes only TIFF", () => {
    const tiff = imageFile(new Uint8Array([0x49, 0x49, 0x2a, 0x00]), "clipboard.tiff", "image/tiff");
    const png = imageFile(pngBytes(), "clipboard.png", "image/png");

    expect(vaultClipboardImageFiles({
      files: [png],
      items: [{ getAsFile: () => tiff, kind: "file", type: "image/tiff" }]
    })).toEqual([png]);
  });

  it("does not duplicate an item PNG through a separate files representation", () => {
    const itemPng = imageFile(pngBytes(), "clipboard.png", "image/png");
    const duplicateFilesPng = imageFile(pngBytes(), "clipboard.png", "image/png");

    expect(vaultClipboardImageFiles({
      files: [duplicateFilesPng],
      items: [{ getAsFile: () => itemPng, kind: "file", type: "image/png" }]
    })).toEqual([itemPng]);
  });

  it("selects supported files, ignores video, and surfaces unsupported image files for rejection", () => {
    const png = imageFile(pngBytes(), "selected.png", "image/png");
    const mov = imageFile(new Uint8Array([0, 0, 0, 0]), "selected.mov", "video/quicktime");
    const heic = imageFile(new Uint8Array([0, 0, 0, 0]), "selected.heic", "image/heic");

    expect(vaultSelectedImageFiles([png, mov])).toEqual([png]);
    expect(vaultSelectedImageFiles([mov])).toEqual([]);
    expect(vaultSelectedImageFiles([heic])).toEqual([heic]);
    expect(VAULT_MARKDOWN_IMAGE_ACCEPT).toContain("image/png");
    expect(VAULT_MARKDOWN_IMAGE_ACCEPT).not.toMatch(/heic|heif|quicktime|\.mov/iu);
  });

  it("accepts a signature-matched static image and clears plaintext bytes on demand", async () => {
    const prepared = await prepareVaultClipboardImages([
      imageFile(pngBytes(), "clipboard.png", "image/png")
    ]);

    expect(prepared).toMatchObject([{ extension: "png", mimeType: "image/png" }]);
    expect(prepared[0].bytes.some((byte) => byte !== 0)).toBe(true);
    clearPreparedVaultClipboardImages(prepared);
    expect(prepared[0].bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("detects a safe static image when the clipboard MIME is empty or generic", async () => {
    const prepared = await prepareVaultClipboardImages([
      imageFile(pngBytes(), "clipboard", ""),
      imageFile(pngBytes(), "clipboard", "application/octet-stream")
    ]);

    expect(prepared).toMatchObject([
      { extension: "png", mimeType: "image/png" },
      { extension: "png", mimeType: "image/png" }
    ]);
    clearPreparedVaultClipboardImages(prepared);
  });

  it("rejects SVG, mismatched signatures, unsafe source sizes, and excessive batches", async () => {
    await expect(prepareVaultClipboardImages([
      imageFile(new TextEncoder().encode("<svg><script/></svg>"), "unsafe.svg", "image/svg+xml")
    ])).rejects.toThrow("PNG, JPG, WEBP");
    await expect(prepareVaultClipboardImages([
      imageFile(new TextEncoder().encode("unsupported heic"), "photo.heic", "image/heic")
    ])).rejects.toThrow("PNG, JPG, WEBP");
    await expect(prepareVaultClipboardImages([
      imageFile(new TextEncoder().encode("not png"), "fake.png", "image/png")
    ])).rejects.toThrow("서명과 해상도");
    const tooLarge = imageFile(pngBytes(), "large.png", "image/png");
    Object.defineProperty(tooLarge, "size", { value: MAX_VAULT_CLIPBOARD_SOURCE_BYTES + 1 });
    await expect(prepareVaultClipboardImages([tooLarge])).rejects.toThrow("32MB 이하");
    await expect(prepareVaultClipboardImages(Array.from(
      { length: MAX_VAULT_CLIPBOARD_IMAGES + 1 },
      () => imageFile(pngBytes(), "many.png", "image/png")
    ))).rejects.toThrow(`${MAX_VAULT_CLIPBOARD_IMAGES}개`);

    const batchFiles = Array.from({ length: 3 }, (_, index) => {
      const file = imageFile(pngBytes(), `batch-${index}.png`, "image/png");
      Object.defineProperty(file, "size", {
        value: Math.floor(MAX_VAULT_CLIPBOARD_BATCH_SOURCE_BYTES / 3) + 1
      });
      return file;
    });
    await expect(prepareVaultClipboardImages(batchFiles)).rejects.toThrow("합계는 64MB 이하");
  });

  it("transcodes an oversized validated raster and revalidates the bounded output", async () => {
    const original = imageFile(
      pngBytes(1280, 720, MAX_INLINE_VAULT_ASSET_BYTES),
      "large.png",
      "image/png"
    );
    const outputBytes = pngBytes(640, 360);
    const transcode = vi.fn(async () => ({
      bytes: outputBytes.slice(),
      mimeType: "image/png" as const
    }));

    const prepared = await prepareVaultClipboardImages([original], { transcode });

    expect(transcode).toHaveBeenCalledWith(expect.objectContaining({
      bytes: expect.any(Uint8Array),
      mimeType: "image/png"
    }));
    expect(prepared).toMatchObject([{ extension: "png", mimeType: "image/png" }]);
    expect(prepared[0].bytes).toEqual(outputBytes);
    clearPreparedVaultClipboardImages(prepared);
  });

  it("uses one absolute transcode deadline for the whole oversized batch", async () => {
    const originals = [0, 1].map((index) => imageFile(
      pngBytes(1280, 720, MAX_INLINE_VAULT_ASSET_BYTES),
      `large-${index}.png`,
      "image/png"
    ));
    const deadlines: number[] = [];
    const transcode = vi.fn(async ({ deadline }: { deadline?: number }) => {
      deadlines.push(deadline ?? 0);
      return { bytes: pngBytes(640, 360), mimeType: "image/png" as const };
    });

    const prepared = await prepareVaultClipboardImages(originals, { transcode });

    expect(deadlines).toHaveLength(2);
    expect(deadlines[0]).toBe(deadlines[1]);
    clearPreparedVaultClipboardImages(prepared);
  });

  it("bounds a stalled clipboard file read and clears a buffer that resolves late", async () => {
    vi.useFakeTimers();
    const lateBytes = pngBytes();
    const lateBuffer = lateBytes.slice().buffer as ArrayBuffer;
    let resolveRead: ((value: ArrayBuffer) => void) | undefined;
    const stalledFile = imageFile(lateBytes, "clipboard.png", "image/png");
    Object.defineProperty(stalledFile, "arrayBuffer", {
      value: () => new Promise<ArrayBuffer>((resolve) => {
        resolveRead = resolve;
      })
    });
    const pending = prepareVaultClipboardImages([stalledFile]);
    const rejected = expect(pending).rejects.toThrow("이미지 배치 준비 시간이 초과");

    await vi.advanceTimersByTimeAsync(MAX_VAULT_CLIPBOARD_TRANSCODE_MS);
    await rejected;
    resolveRead?.(lateBuffer);
    await Promise.resolve();
    await Promise.resolve();

    expect(new Uint8Array(lateBuffer).every((byte) => byte === 0)).toBe(true);
  });

  it("uses the bounded source parser before decoding a large static raster", async () => {
    const source = pngWithManyAncillaryChunks(
      1280,
      720,
      300,
      MAX_INLINE_VAULT_ASSET_BYTES
    );
    expect(safeVaultAssetPreviewKind({ bytes: source, mimeType: "image/png" })).toBeNull();
    const transcode = vi.fn(async () => ({
      bytes: pngBytes(640, 360),
      mimeType: "image/png" as const
    }));

    const prepared = await prepareVaultClipboardImages([
      imageFile(source, "large.png", "image/png")
    ], { transcode });

    expect(transcode).toHaveBeenCalledOnce();
    expect(prepared).toMatchObject([{ extension: "png", mimeType: "image/png" }]);
    clearPreparedVaultClipboardImages(prepared);
  });

  it("rejects a transcoder result that exceeds the encrypted asset envelope", async () => {
    const original = imageFile(
      pngBytes(1280, 720, MAX_INLINE_VAULT_ASSET_BYTES),
      "large.png",
      "image/png"
    );
    const unsafeOutput = pngBytes(640, 360, MAX_INLINE_VAULT_ASSET_BYTES);

    await expect(prepareVaultClipboardImages([original], {
      transcode: async () => ({ bytes: unsafeOutput, mimeType: "image/png" })
    })).rejects.toThrow("축소한 이미지");
    expect(unsafeOutput.every((byte) => byte === 0)).toBe(true);
  });

  it("bounds a stalled browser decoder with the transcode deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>(() => undefined)));
    const pending = transcodeVaultClipboardImage({
      bytes: pngBytes(1280, 720),
      mimeType: "image/png"
    });
    const rejected = expect(pending).rejects.toThrow("이미지 배치 축소 시간이 초과");

    await vi.advanceTimersByTimeAsync(MAX_VAULT_CLIPBOARD_TRANSCODE_MS);
    await rejected;
  });

  it("bounds a stalled browser-encoded Blob read and clears bytes that resolve late", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close, height: 2_000, width: 8_192 })));
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
      globalCompositeOperation: "source-over",
      restore: vi.fn(),
      save: vi.fn()
    };
    const encoded = webpLosslessBytes(640, 360);
    const lateBuffer = encoded.slice().buffer as ArrayBuffer;
    let resolveRead: ((value: ArrayBuffer) => void) | undefined;
    const encodedBlob = new Blob([encoded], { type: "image/webp" });
    Object.defineProperty(encodedBlob, "arrayBuffer", {
      value: () => new Promise<ArrayBuffer>((resolve) => {
        resolveRead = resolve;
      })
    });
    const canvas = {
      getContext: vi.fn(() => context),
      height: 0,
      toBlob: (callback: BlobCallback) => callback(encodedBlob),
      width: 0
    } as unknown as HTMLCanvasElement;
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) => (
      tagName.toLocaleLowerCase("en-US") === "canvas"
        ? canvas
        : createElement(tagName, options)
    ));
    const pending = transcodeVaultClipboardImage({
      bytes: pngBytes(8_192, 2_000),
      mimeType: "image/png"
    });
    const rejected = expect(pending).rejects.toThrow("이미지 배치 축소 시간이 초과");

    await vi.advanceTimersByTimeAsync(MAX_VAULT_CLIPBOARD_TRANSCODE_MS);
    await rejected;
    resolveRead?.(lateBuffer);
    await Promise.resolve();
    await Promise.resolve();

    expect(new Uint8Array(lateBuffer).every((byte) => byte === 0)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("revalidates browser-encoded WebP bytes before returning a transcode", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close, height: 2_000, width: 8_192 })));
    const drawImage = vi.fn();
    const context = {
      clearRect: vi.fn(),
      drawImage,
      fillRect: vi.fn(),
      fillStyle: "",
      globalCompositeOperation: "source-over",
      restore: vi.fn(),
      save: vi.fn()
    };
    const encoded = webpLosslessBytes(640, 360);
    const encodedBlob = new Blob([encoded], { type: "image/webp" });
    Object.defineProperty(encodedBlob, "arrayBuffer", {
      value: async () => encoded.slice().buffer
    });
    const canvas = {
      getContext: vi.fn(() => context),
      height: 0,
      toBlob: (callback: BlobCallback) => callback(encodedBlob),
      width: 0
    } as unknown as HTMLCanvasElement;
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) => (
      tagName.toLocaleLowerCase("en-US") === "canvas"
        ? canvas
        : createElement(tagName, options)
    ));

    const result = await transcodeVaultClipboardImage({
      bytes: pngBytes(8_192, 2_000),
      mimeType: "image/png"
    });

    expect(result).toEqual({ bytes: encoded, mimeType: "image/webp" });
    expect(canvas.width).toBe(MAX_VAULT_CLIPBOARD_TRANSCODE_DIMENSION);
    expect(canvas.height).toBe(500);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps an empty image batch empty and separates a single image from adjacent prose", () => {
    expect(vaultClipboardImageEmbedSource([])).toBe("");
    const source = vaultClipboardImageEmbedSource(["붙여넣은 이미지/문서 -1.png"]);
    expect(`문단 앞${source}문단 뒤`).toBe("문단 앞\n\n![[붙여넣은 이미지/문서 -1.png]]\n\n문단 뒤");
  });

  it("reserves deterministic extension-preserving names and produces only wiki embeds", () => {
    expect(reserveVaultClipboardImageTitles(
      [],
      [{ extension: "png" }, { extension: "jpg" }, { extension: "webp" }],
      "현재 작업중인 노트 이름"
    )).toEqual([
      "현재 작업중인 노트 이름 -1.png",
      "현재 작업중인 노트 이름 -2.jpg",
      "현재 작업중인 노트 이름 -3.webp"
    ]);

    const titles = reserveVaultClipboardImageTitles(
      ["연구 노트 -1.webp"],
      [{ extension: "png" }, { extension: "jpg" }],
      "연구 노트.md"
    );

    expect(titles).toEqual([
      "연구 노트 -2.png",
      "연구 노트 -3.jpg"
    ]);
    const paths = titles.map((title) => `붙여넣은 이미지/${title}`);
    expect(vaultClipboardImageEmbedSource(paths)).toBe(
      "\n\n![[붙여넣은 이미지/연구 노트 -2.png]]\n\n"
      + "![[붙여넣은 이미지/연구 노트 -3.jpg]]\n\n"
    );
    expect(vaultClipboardImageTitleStem("위키 [[제목]] #1 | 50%.md"))
      .toBe("위키 --제목-- -1 - 50-");
    expect(reserveVaultClipboardImageTitles([], [{ extension: "png" }], "기록.md.md"))
      .toEqual(["기록.md -1.png"]);
    expect(`${vaultClipboardImageTitleStem("😀".repeat(100))} -1.webp`.length)
      .toBeLessThanOrEqual(180);
    for (const unsafePath of [
      "unsafe|alias.png",
      "unsafe#fragment.png",
      "unsafe\nline.png",
      "../outside.png",
      "folder/%2fescape.png"
    ]) {
      expect(() => vaultClipboardImageEmbedSource([unsafePath]))
        .toThrow("안전한 내부 링크");
    }
  });
});
