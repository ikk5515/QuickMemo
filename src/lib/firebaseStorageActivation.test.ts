import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const firebaseSource = readFileSync(join(process.cwd(), "src/lib/firebase.ts"), "utf8");
const notesSource = readFileSync(join(process.cwd(), "src/services/notes.ts"), "utf8");
const publicSharesSource = readFileSync(
  join(process.cwd(), "src/services/publicShares.ts"),
  "utf8"
);
const blobBackendSource = readFileSync(
  join(process.cwd(), "api/blob-attachments.js"),
  "utf8"
);
const managedUserDeleteSource = readFileSync(
  join(process.cwd(), "api/delete-managed-user.js"),
  "utf8"
);

describe("Firebase Storage activation boundary", () => {
  it("does not initialize the legacy client SDK at module load", () => {
    expect(firebaseSource).not.toContain("export const storage = getStorage(app)");
    const getter = firebaseSource.match(
      /export function getLegacyStorage[\s\S]*?return legacyStorage;\n\}/u
    )?.[0] ?? "";
    expect(getter).toContain("if (!legacyFirebaseStorageEnabled)");
    expect(getter).toContain("legacyStorage = getStorage(app)");
    expect(getter).toContain("connectStorageEmulator(legacyStorage");
  });

  it("uses the lazy fallback only after inline and Vercel Blob paths are absent", () => {
    for (const source of [notesSource, publicSharesSource]) {
      const firstBlobBranch = source.indexOf("if (attachment.blobPath)");
      const legacyCall = source.indexOf("ref(getLegacyStorage(), attachment.storagePath)");
      expect(firstBlobBranch).toBeGreaterThan(-1);
      expect(legacyCall).toBeGreaterThan(firstBlobBranch);
    }
  });

  it("blocks legacy server Storage calls unless explicitly enabled", () => {
    for (const source of [blobBackendSource, managedUserDeleteSource]) {
      expect(source).toContain('envValue("LEGACY_FIREBASE_STORAGE_ENABLED") !== "true"');
    }
  });
});
