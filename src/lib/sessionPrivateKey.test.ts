import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteSessionPrivateKey, readSessionPrivateKey, writeSessionPrivateKey } from "./sessionPrivateKey";

const sessionPrivateKeySource = readFileSync(join(process.cwd(), "src/lib/sessionPrivateKey.ts"), "utf8");

describe("session private key cache", () => {
  afterEach(async () => {
    await deleteSessionPrivateKey("user-a");
  });

  it("keeps unlocked private keys in memory only and never writes them to persistent browser storage", () => {
    expect(sessionPrivateKeySource).not.toContain("indexedDB.open");
    expect(sessionPrivateKeySource).not.toContain("createObjectStore");
    expect(sessionPrivateKeySource).not.toContain("objectStore");
    expect(sessionPrivateKeySource).not.toContain(".put(");
    expect(sessionPrivateKeySource).not.toContain("sessionStorage");
    expect(sessionPrivateKeySource).toContain("indexedDB.deleteDatabase");
  });

  it("returns only unexpired in-memory keys for the matching user", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

    await writeSessionPrivateKey("user-a", key, 1_500);

    await expect(readSessionPrivateKey("user-a", 1_499)).resolves.toBe(key);
    await expect(readSessionPrivateKey("user-a", 1_500)).resolves.toBeNull();
    await expect(readSessionPrivateKey("user-b", 1_499)).resolves.toBeNull();
  });
});
