import type {
  EncryptedBinaryPayload,
  EncryptedPayload,
  PublicSharePasswordHash,
  UserKeyBundle,
  UserKeyDocument,
  WrappedNoteKey
} from "../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KDF_ITERATIONS = 210_000;
const PUBLIC_SHARE_PASSWORD_HASH_VERSION = 2;
const PUBLIC_SHARE_PASSWORD_VERIFIER_PURPOSE = "quickmemo/public-share/password-verifier/v2";
const PUBLIC_SHARE_CONTENT_KEY_PURPOSE = "quickmemo/public-share/content-key/v2";

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

async function derivePasswordBits(passwordMaterial: string, salt: Uint8Array, iterations = KDF_ITERATIONS) {
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(passwordMaterial), "PBKDF2", false, [
    "deriveBits"
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations,
      hash: "SHA-256"
    },
    baseKey,
    256
  );

  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
}

function publicSharePasswordMaterial(purpose: string, password: string, shareKeyValue?: string) {
  return `${purpose}\n${shareKeyValue ?? ""}\n${password}`;
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

export async function hashPublicSharePassword(password: string, shareKeyValue?: string): Promise<PublicSharePasswordHash> {
  const salt = randomBytes(16);
  const hash = await derivePasswordBits(
    publicSharePasswordMaterial(PUBLIC_SHARE_PASSWORD_VERIFIER_PURPOSE, password, shareKeyValue),
    salt
  );

  return {
    version: PUBLIC_SHARE_PASSWORD_HASH_VERSION,
    algorithm: "PBKDF2-SHA-256",
    salt: bytesToBase64(salt),
    iterations: KDF_ITERATIONS,
    hash: bytesToBase64(hash)
  };
}

export async function derivePublicShareContentKey(shareKeyValue: string, password: string, payload: PublicSharePasswordHash) {
  if (
    payload.version !== PUBLIC_SHARE_PASSWORD_HASH_VERSION ||
    payload.algorithm !== "PBKDF2-SHA-256" ||
    payload.iterations < 100_000 ||
    payload.iterations > 1_000_000
  ) {
    throw new Error("Unsupported public share password hash.");
  }

  const rawKey = await derivePasswordBits(
    publicSharePasswordMaterial(PUBLIC_SHARE_CONTENT_KEY_PURPOSE, password, shareKeyValue),
    base64ToBytes(payload.salt),
    payload.iterations
  );

  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(rawKey),
    {
      name: "AES-GCM",
      length: 256
    },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function verifyPublicSharePassword(password: string, payload: PublicSharePasswordHash, shareKeyValue?: string) {
  if (
    payload.version !== PUBLIC_SHARE_PASSWORD_HASH_VERSION ||
    payload.algorithm !== "PBKDF2-SHA-256" ||
    payload.iterations < 100_000 ||
    payload.iterations > 1_000_000
  ) {
    return false;
  }

  try {
    const salt = base64ToBytes(payload.salt);
    const expectedHash = base64ToBytes(payload.hash);
    const nextHash = await derivePasswordBits(
      publicSharePasswordMaterial(PUBLIC_SHARE_PASSWORD_VERIFIER_PURPOSE, password, shareKeyValue),
      salt,
      payload.iterations
    );

    return constantTimeEqual(nextHash, expectedHash);
  } catch {
    return false;
  }
}

export async function decryptText(payload: EncryptedPayload, key: CryptoKey) {
  const plainText = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(payload.iv)) },
    key,
    toArrayBuffer(base64ToBytes(payload.cipherText))
  );

  return decoder.decode(plainText);
}

export async function encryptBytes(value: ArrayBuffer | Uint8Array, key: CryptoKey): Promise<EncryptedBinaryPayload> {
  const iv = randomBytes(12);
  const cipherBytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(value instanceof Uint8Array ? value : new Uint8Array(value))
  );

  return {
    version: 1,
    algorithm: "AES-GCM",
    cipherBytes: new Uint8Array(cipherBytes),
    iv
  };
}

export async function decryptBytes(payload: EncryptedBinaryPayload, key: CryptoKey) {
  const plainBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(payload.iv) },
    key,
    toArrayBuffer(payload.cipherBytes)
  );

  return new Uint8Array(plainBytes);
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

export async function relockUserPrivateKey(keyDocument: UserKeyDocument, currentPassword: string, nextPassword: string): Promise<UserKeyBundle> {
  const privateKeyJson = await decryptPrivateKeyJsonWithFallback(keyDocument, currentPassword);
  const nextSalt = randomBytes(16);
  const nextPasswordKey = await derivePasswordKey(nextPassword, nextSalt);

  return {
    publicKeyJwk: keyDocument.publicKeyJwk,
    encryptedPrivateKeyJwk: await encryptText(privateKeyJson, nextPasswordKey),
    kdfSalt: bytesToBase64(nextSalt),
    kdfIterations: KDF_ITERATIONS
  };
}

async function decryptPrivateKeyJsonWithFallback(keyDocument: UserKeyDocument, password: string) {
  try {
    const passwordKey = await derivePasswordKey(
      password,
      base64ToBytes(keyDocument.kdfSalt),
      keyDocument.kdfIterations
    );

    return await decryptText(keyDocument.encryptedPrivateKeyJwk, passwordKey);
  } catch (error) {
    if (
      !keyDocument.pendingEncryptedPrivateKeyJwk ||
      !keyDocument.pendingKdfSalt ||
      !keyDocument.pendingKdfIterations
    ) {
      throw error;
    }

    const pendingPasswordKey = await derivePasswordKey(
      password,
      base64ToBytes(keyDocument.pendingKdfSalt),
      keyDocument.pendingKdfIterations
    );

    return decryptText(keyDocument.pendingEncryptedPrivateKeyJwk, pendingPasswordKey);
  }
}

export async function decryptPrivateKeyJsonForPassword(keyDocument: UserKeyDocument, password: string) {
  return decryptPrivateKeyJsonWithFallback(keyDocument, password);
}

export async function importPrivateKeyJson(privateKeyJson: string) {
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

export async function unlockPrivateKey(keyDocument: UserKeyDocument, password: string) {
  const passwordKey = await derivePasswordKey(
    password,
    base64ToBytes(keyDocument.kdfSalt),
    keyDocument.kdfIterations
  );
  const privateKeyJson = await decryptText(keyDocument.encryptedPrivateKeyJwk, passwordKey);
  return importPrivateKeyJson(privateKeyJson);
}

export async function unlockPrivateKeyWithFallback(keyDocument: UserKeyDocument, password: string) {
  try {
    return await unlockPrivateKey(keyDocument, password);
  } catch (error) {
    if (
      !keyDocument.pendingEncryptedPrivateKeyJwk ||
      !keyDocument.pendingKdfSalt ||
      !keyDocument.pendingKdfIterations
    ) {
      throw error;
    }

    return unlockPrivateKey(
      {
        ...keyDocument,
        encryptedPrivateKeyJwk: keyDocument.pendingEncryptedPrivateKeyJwk,
        kdfSalt: keyDocument.pendingKdfSalt,
        kdfIterations: keyDocument.pendingKdfIterations
      },
      password
    );
  }
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

export async function exportAesKeyBase64Url(key: CryptoKey) {
  return base64UrlFromBase64(bytesToBase64(await crypto.subtle.exportKey("raw", key)));
}

export async function importAesKeyBase64Url(value: string) {
  const rawKey = base64ToBytes(base64FromBase64Url(value));

  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(rawKey),
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

export function base64UrlFromBase64(value: string) {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64FromBase64Url(value: string) {
  const normalizedValue = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalizedValue.length % 4)) % 4;
  return `${normalizedValue}${"=".repeat(paddingLength)}`;
}
