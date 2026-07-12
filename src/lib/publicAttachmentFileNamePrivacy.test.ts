import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const notesPageSource = source("src/pages/NotesPage.tsx");
const publicSharePageSource = source("src/pages/PublicSharePage.tsx");
const publicSharesSource = source("src/services/publicShares.ts");
const blobClientSource = source("src/services/blobAttachments.ts");
const blobApiSource = source("api/blob-attachments.js");
const firestoreRulesSource = source("firestore.rules");

describe("public attachment filename privacy", () => {
  it("encrypts actual filenames for both initial share creation and rewrites", () => {
    expect(
      notesPageSource.match(/encryptText\(attachmentDownloadName\(attachment\), contentKey\)/gu)?.length
    ).toBeGreaterThanOrEqual(2);
    expect(notesPageSource.match(/encryptedFileName,/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(notesPageSource).not.toContain("fileName: attachment.fileName");
    expect(notesPageSource).toContain("getOwnerPublicNoteShareAttachments(share.id, currentGeneration)");
    expect(notesPageSource).toContain("attachment.privacyVersion !== 1 || !attachment.encryptedFileName");
    expect(publicSharesSource).toContain("encryptedFileName: EncryptedPayload");
    expect(publicSharesSource).toContain("encryptedFileName: input.encryptedFileName");
  });

  it("sends only an extension-derived generic plaintext name to the public Blob API", () => {
    const publicUploadSource = blobClientSource.match(
      /export async function uploadPublicShareAttachmentBlob[\s\S]*?interface FetchBlobAttachmentInput/u
    )?.[0] ?? "";

    expect(publicUploadSource).toContain("fileName: publicShareGenericAttachmentBaseName(input.extension)");
    expect(publicUploadSource).toContain("encryptedFileName: input.encryptedFileName");
    expect(publicUploadSource).not.toContain("fileName: input.fileName");
  });

  it("strictly validates and stores the encrypted filename map in the service-account API", () => {
    expect(blobApiSource).toContain("isValidEncryptedFileNamePayload(value)");
    expect(blobApiSource).toContain("Public attachment fileName must be generic");
    expect(blobApiSource).toContain("encryptedFileName: encryptedPayloadValue(payload.encryptedFileName)");
    expect(blobApiSource).toContain("privacyVersion: integerValue(1)");
    expect(blobApiSource).toContain('fileName !== publicShareGenericAttachmentBaseName(extension)');
    expect(blobApiSource).toContain('valueInteger(attachment, "privacyVersion") !== 1');
  });

  it("decrypts protected filenames only after a content key exists and rejects legacy metadata", () => {
    const viewSource = publicSharePageSource.match(
      /async function publicShareAttachmentView[\s\S]*?async function decryptPublicShareContent/u
    )?.[0] ?? "";

    expect(viewSource).toContain("attachment.privacyVersion !== 1 || !attachment.encryptedFileName");
    expect(viewSource).toContain("decryptText(attachment.encryptedFileName, contentKey)");
    expect(publicSharePageSource).toContain("publicShareAttachmentView(attachment, shareKey)");
    expect(publicSharesSource).toContain("if (!currentGeneration)");
    expect(publicSharesSource).toContain('where("privacyVersion", "==", 1)');
  });

  it("allows the encrypted field for legacy-compatible reads with bounded payload lengths", () => {
    expect(firestoreRulesSource).toContain('"encryptedFileName"');
    expect(firestoreRulesSource).toContain('"privacyVersion"');
    expect(firestoreRulesSource).toContain("validOptionalPublicAttachmentEncryptedFileName(data)");
    expect(firestoreRulesSource).toContain("publicShareAttachmentPrivacyProtected(resource.data)");
    expect(firestoreRulesSource).toContain("data.encryptedFileName.cipherText.size() <= 1024");
    expect(firestoreRulesSource).toContain("data.encryptedFileName.iv.size() == 16");
  });
});
