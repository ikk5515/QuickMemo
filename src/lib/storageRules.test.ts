import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const firestoreRulesSource = readFileSync(join(process.cwd(), "firestore.rules"), "utf8");
const storageRulesSource = readFileSync(join(process.cwd(), "storage.rules"), "utf8");

describe("storage security rules", () => {
  it("mirrors Firestore owner revocation checks for note attachment reads", () => {
    const canReadNoteObjectSource =
      storageRulesSource.match(/function canReadNoteObject\(noteId\) \{[\s\S]*?function publicShareData/u)?.[0] ?? "";

    expect(firestoreRulesSource).toContain("function ownerAllowsParticipant(data, uid)");
    expect(storageRulesSource).toContain("function ownerAllowsParticipant(data, uid)");
    expect(canReadNoteObjectSource).toMatch(
      /noteActive\(note\)[\s\S]*noteParticipant\(note\)[\s\S]*ownerAllowsParticipant\(note, request\.auth\.uid\)/u
    );
  });

  it("keeps all attachment object mutations behind the authenticated API", () => {
    const privateAttachmentMatch =
      storageRulesSource.match(/match \/notes\/\{noteId\}\/attachments\/\{attachmentId\}\/data \{[\s\S]*?\n {4}\}/u)?.[0] ?? "";
    const publicAttachmentMatch =
      storageRulesSource.match(/match \/publicNoteShares\/\{shareId\}\/attachments\/\{attachmentId\}\/data \{[\s\S]*?\n {4}\}/u)?.[0] ?? "";

    expect(privateAttachmentMatch).toContain("allow create, update, delete: if false;");
    expect(publicAttachmentMatch).toContain("allow create, update, delete: if false;");
    expect(storageRulesSource).not.toContain("function validNoteAttachmentUpload");
  });
});
