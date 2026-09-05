import { performance } from "node:perf_hooks";
import { stdout } from "node:process";
import { describe, expect, it, vi } from "vitest";
import * as cryptoFunctions from "../../lib/crypto";
import { mapWithConcurrency } from "../../lib/mapWithConcurrency";
import type { NoteSnapshot } from "../../services/notes";
import { decryptVaultNotes } from "./vaultData";
import { VaultDecryptionSession } from "./vaultDecryptionSession";

function measure<T>(operation: () => Promise<T>) {
  const start = performance.now();
  return operation().then((result) => ({ milliseconds: Number((performance.now() - start).toFixed(2)), result }));
}

describe("Vault decryption performance evidence", () => {
  it("avoids RSA and unchanged-field AES work with real WebCrypto at the original 3072-bit strength", async () => {
    const count = 120;
    const pair = await crypto.subtle.generateKey({
      name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"
    }, true, ["encrypt", "decrypt"]);
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const uid = "benchmark-owner";
    const fixtures = await mapWithConcurrency(Array.from({ length: count }, (_, index) => index), 4, async (index) => {
      const noteKey = await cryptoFunctions.generateNoteKey();
      const title = `Benchmark ${index}`;
      const body = `${index}: ${"encrypted memo body\n".repeat(100)}`;
      const [encryptedTitle, encryptedBody, wrappedKey] = await Promise.all([
        cryptoFunctions.encryptText(title, noteKey), cryptoFunctions.encryptText(body, noteKey),
        cryptoFunctions.wrapNoteKey(noteKey, publicKeyJwk)
      ]);
      const note: NoteSnapshot = {
        id: `benchmark-${index}`, type: "personal", ownerUid: uid, participantUids: [uid],
        updatedBy: uid, revision: 1, contentFormat: "markdown-v1", entryKind: "markdown",
        encryptedTitle, encryptedBody, wrappedKeys: { [uid]: wrappedKey }
      };
      return { note, noteKey, title, body };
    });
    const notes = fixtures.map((fixture) => fixture.note);
    const unwrap = vi.spyOn(cryptoFunctions, "unwrapNoteKey");
    const decrypt = vi.spyOn(cryptoFunctions, "decryptText");
    const session = new VaultDecryptionSession(uid, pair.privateKey);
    try {
      const baseline = await measure(() => decryptVaultNotes(notes, uid, pair.privateKey));
      expect(unwrap).toHaveBeenCalledTimes(count);
      expect(decrypt).toHaveBeenCalledTimes(count * 2);
      const cold = await measure(() => decryptVaultNotes(notes, uid, pair.privateKey, { session }));
      expect(cold.result.map(({ title, body }) => ({ title, body }))).toEqual(fixtures.map(({ title, body }) => ({ title, body })));
      unwrap.mockClear();
      decrypt.mockClear();

      const metadata = await measure(() => decryptVaultNotes(notes.map((note) => ({ ...note, revision: 2, folderId: "moved" })), uid, pair.privateKey, { session }));
      expect(metadata.result).toHaveLength(count);
      expect(unwrap).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
      const changedBody = "A changed encrypted body";
      const updated = [...notes];
      updated[0] = { ...updated[0], revision: 3, encryptedBody: await cryptoFunctions.encryptText(changedBody, fixtures[0].noteKey) };
      const incremental = await measure(() => decryptVaultNotes(updated, uid, pair.privateKey, { session }));
      expect(incremental.result[0]).toMatchObject({ title: fixtures[0].title, body: changedBody, revision: 3 });
      expect(unwrap).not.toHaveBeenCalled();
      expect(decrypt).toHaveBeenCalledTimes(1);
      stdout.write(`${JSON.stringify({
        benchmark: "vault-session-native-webcrypto", entries: count, rsaBits: 3072,
        baselineMs: baseline.milliseconds, coldSessionMs: cold.milliseconds,
        metadataUpdateMs: metadata.milliseconds, oneBodyUpdateMs: incremental.milliseconds,
        baselineCrypto: { rsa: count, aes: count * 2 }, metadataCrypto: { rsa: 0, aes: 0 },
        oneBodyCrypto: { rsa: 0, aes: 1 }, cache: session.stats
      })}\n`);
    } finally {
      session.dispose();
      unwrap.mockRestore();
      decrypt.mockRestore();
    }
  }, 20_000);

  it("keeps a 5000-note metadata refresh free of repeated crypto within the retained-memory budget", async () => {
    const count = 5_000;
    const uid = "benchmark-owner";
    const key = {} as CryptoKey;
    const session = new VaultDecryptionSession(uid, key);
    const unwrap = vi.spyOn(cryptoFunctions, "unwrapNoteKey").mockResolvedValue({} as CryptoKey);
    const decrypt = vi.spyOn(cryptoFunctions, "decryptText").mockImplementation(async (payload) => `plain:${payload.cipherText}`);
    const notes = Array.from({ length: count }, (_, index): NoteSnapshot => ({
      id: `benchmark-${index}`, type: "personal", ownerUid: uid, participantUids: [uid], updatedBy: uid,
      revision: 1, contentFormat: "markdown-v1", entryKind: "markdown",
      encryptedTitle: { version: 1, algorithm: "AES-GCM", iv: "title-iv", cipherText: `title-${index}` },
      encryptedBody: { version: 1, algorithm: "AES-GCM", iv: "body-iv", cipherText: `body-${index}` },
      wrappedKeys: { [uid]: { version: 1, algorithm: "RSA-OAEP", wrappedKey: `wrapped-${index}` } }
    }));
    try {
      const cold = await measure(() => decryptVaultNotes(notes, uid, key, { session }));
      expect(cold.result).toHaveLength(count);
      expect(unwrap).toHaveBeenCalledTimes(count);
      expect(decrypt).toHaveBeenCalledTimes(count * 2);
      unwrap.mockClear();
      decrypt.mockClear();
      const refresh = await measure(() => decryptVaultNotes(notes.map((note) => ({ ...note, revision: 2 })), uid, key, { session }));
      expect(refresh.result.every((note) => note.revision === 2)).toBe(true);
      expect(unwrap).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
      expect(session.stats.entries).toBe(count);
      expect(session.stats.estimatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      stdout.write(`${JSON.stringify({
        benchmark: "vault-session-5000-call-budget", entries: count,
        coldMs: cold.milliseconds, metadataRefreshMs: refresh.milliseconds,
        eliminatedRsaCalls: count, eliminatedAesCalls: count * 2, cache: session.stats
      })}\n`);
    } finally {
      session.dispose();
      unwrap.mockRestore();
      decrypt.mockRestore();
    }
  }, 15_000);
});
