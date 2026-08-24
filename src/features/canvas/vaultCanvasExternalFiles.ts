import { MAX_INLINE_VAULT_ASSET_BYTES } from "../vault/vaultAsset";

interface VaultCanvasExternalAssetInput {
  bytes: Uint8Array;
  mimeType: string;
  title: string;
}

export async function importVaultCanvasExternalFiles(input: {
  assertCurrent: () => void;
  createAsset: (asset: VaultCanvasExternalAssetInput) => Promise<void>;
  existingTitles: readonly string[];
  files: readonly File[];
  folderPath: string;
}) {
  const reservedNames = new Set(input.existingTitles.map(
    (title) => title.normalize("NFC").toLocaleLowerCase()
  ));
  const paths: string[] = [];
  let rejected = 0;

  for (const [index, file] of input.files.entries()) {
    input.assertCurrent();
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_INLINE_VAULT_ASSET_BYTES) {
      rejected += 1;
      continue;
    }
    const normalizedName = file.name
      .normalize("NFC")
      .replace(/[\p{Cc}/\\]/gu, "-")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 180);
    const baseName = normalizedName && normalizedName !== "." && normalizedName !== ".."
      ? normalizedName
      : `Canvas 첨부 ${index + 1}`;
    let title = baseName;
    let suffix = 2;
    while (reservedNames.has(title.toLocaleLowerCase())) {
      const suffixText = ` ${suffix}`;
      title = `${baseName.slice(0, 180 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    reservedNames.add(title.toLocaleLowerCase());

    let bytes: Uint8Array | null = null;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      input.assertCurrent();
      if (bytes.byteLength !== file.size) throw new Error("external-file-size-mismatch");
      await input.createAsset({
        bytes,
        mimeType: file.type || "application/octet-stream",
        title
      });
      input.assertCurrent();
      paths.push(input.folderPath ? `${input.folderPath}/${title}` : title);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") throw caught;
      rejected += 1;
    } finally {
      bytes?.fill(0);
    }
  }

  return { paths, rejected };
}
