import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const firestoreRulesSource = readFileSync(join(process.cwd(), "firestore.rules"), "utf8");
const storageRulesSource = readFileSync(join(process.cwd(), "storage.rules"), "utf8");

describe("storage security rules", () => {
  it("mirrors Firestore owner revocation checks for note attachment reads", () => {
    const canReadNoteObjectSource =
      storageRulesSource.match(/function canReadNoteObject\(noteId\) \{[\s\S]*?function noteAttachmentData/u)?.[0] ?? "";

    expect(firestoreRulesSource).toContain("function ownerAllowsParticipant(data, uid)");
    expect(storageRulesSource).toContain("function ownerAllowsParticipant(data, uid)");
    expect(canReadNoteObjectSource).toMatch(
      /noteActive\(note\)[\s\S]*noteParticipant\(note\)[\s\S]*ownerAllowsParticipant\(note, request\.auth\.uid\)/u
    );
  });

  it("mirrors owner revocation checks for note attachment uploads", () => {
    const validUploadSource =
      storageRulesSource.match(/function validNoteAttachmentUpload\(noteId, attachmentId\) \{[\s\S]*?function canDeleteNoteObject/u)?.[0] ?? "";

    expect(validUploadSource).toContain("noteParticipant(note)");
    expect(validUploadSource).toContain("ownerAllowsParticipant(note, request.auth.uid)");
  });
});
