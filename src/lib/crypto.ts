import type { EncryptedPayload, UserKeyBundle, UserKeyDocument, WrappedNoteKey } from "../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KDF_ITERATIONS = 210_000;

function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function bytesToBase64(bytes: ArrayBuffer | Uint8Array) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < array.length; i += chunkSize) {
    binary += String.fromCharCode(...array.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

export function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function derivePasswordKey(password: string, salt: Uint8Array, iterations = KDF_ITERATIONS) {
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveKey"
  ]);

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations,
      hash: "SHA-256"
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptText(value: string, key: CryptoKey): Promise<EncryptedPayload> {
  const iv = randomBytes(12);
  const cipherText = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    encoder.encode(value)
  );

  return {
    version: 1,
    algorithm: "AES-GCM",
    cipherText: bytesToBase64(cipherText),
    iv: bytesToBase64(iv)
  };
}

export async function decryptText(payload: EncryptedPayload, key: CryptoKey) {
  const plainText = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(payload.iv)) },
    key,
    toArrayBuffer(base64ToBytes(payload.cipherText))
  );

  return decoder.decode(plainText);
}

export async function generateUserKeyBundle(password: string): Promise<UserKeyBundle> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["encrypt", "decrypt"]
  );

  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const salt = randomBytes(16);
  const passwordKey = await derivePasswordKey(password, salt);

  return {
    publicKeyJwk,
    encryptedPrivateKeyJwk: await encryptText(JSON.stringify(privateKeyJwk), passwordKey),
    kdfSalt: bytesToBase64(salt),
    kdfIterations: KDF_ITERATIONS
  };
}

export async function unlockPrivateKey(keyDocument: UserKeyDocument, password: string) {
  const passwordKey = await derivePasswordKey(
    password,
    base64ToBytes(keyDocument.kdfSalt),
    keyDocument.kdfIterations
  );
  const privateKeyJson = await decryptText(keyDocument.encryptedPrivateKeyJwk, passwordKey);
  const privateKeyJwk = JSON.parse(privateKeyJson) as JsonWebKey;

  return crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256"
    },
    false,
    ["decrypt"]
  );
}

export async function importPublicKey(publicKeyJwk: JsonWebKey) {
  return crypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256"
    },
    false,
    ["encrypt"]
  );
}

export async function generateNoteKey() {
  return crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256
    },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function wrapNoteKey(noteKey: CryptoKey, publicKeyJwk: JsonWebKey): Promise<WrappedNoteKey> {
  const publicKey = await importPublicKey(publicKeyJwk);
  const rawKey = await crypto.subtle.exportKey("raw", noteKey);
  const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawKey);

  return {
    version: 1,
    algorithm: "RSA-OAEP",
    wrappedKey: bytesToBase64(wrappedKey)
  };
}

export async function unwrapNoteKey(wrappedNoteKey: WrappedNoteKey, privateKey: CryptoKey) {
  const rawKey = await crypto.subtle.decrypt(
    {
      name: "RSA-OAEP"
    },
    privateKey,
    toArrayBuffer(base64ToBytes(wrappedNoteKey.wrappedKey))
  );

  return crypto.subtle.importKey(
    "raw",
    rawKey,
    {
      name: "AES-GCM",
      length: 256
    },
    true,
    ["encrypt", "decrypt"]
  );
}
