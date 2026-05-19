import type { UserKeyDocument, UserPasskeyUnlock, UserProfile } from "../types";
import {
  base64FromBase64Url,
  base64ToBytes,
  base64UrlFromBase64,
  bytesToBase64,
  decryptPrivateKeyJsonForPassword,
  decryptText,
  encryptText,
  importPrivateKeyJson
} from "./crypto";

const encoder = new TextEncoder();
const passkeyUnlockPurpose = "quickmemo/passkey-unlock/private-key/v1";

interface WebAuthnPrfResults {
  enabled?: boolean;
  results?: {
    first?: ArrayBuffer | ArrayBufferView;
  };
}

type PublicKeyCredentialWithPrf = PublicKeyCredential & {
  getClientExtensionResults(): {
    prf?: WebAuthnPrfResults;
  };
};

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

function bytesToBase64Url(bytes: Uint8Array) {
  return base64UrlFromBase64(bytesToBase64(bytes));
}

function base64UrlToBytes(value: string) {
  return base64ToBytes(base64FromBase64Url(value));
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
}

function extensionInputs(salt: Uint8Array) {
  return {
    prf: {
      eval: {
        first: toArrayBuffer(salt)
      }
    }
  } as unknown as AuthenticationExtensionsClientInputs;
}

function prfResultBytes(credential: PublicKeyCredentialWithPrf) {
  const firstResult = credential.getClientExtensionResults().prf?.results?.first;

  if (!firstResult) {
    return null;
  }

  return firstResult instanceof ArrayBuffer
    ? new Uint8Array(firstResult)
    : new Uint8Array(firstResult.buffer, firstResult.byteOffset, firstResult.byteLength);
}

async function passkeyUnlockKey(prfResult: Uint8Array, credentialId: Uint8Array) {
  const baseKey = await crypto.subtle.importKey("raw", toArrayBuffer(prfResult), "HKDF", false, ["deriveKey"]);

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(credentialId),
      info: encoder.encode(passkeyUnlockPurpose)
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

function assertWebAuthnSupport() {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.credentials ||
    typeof PublicKeyCredential === "undefined"
  ) {
    throw new Error("이 브라우저는 Passkey를 지원하지 않습니다.");
  }
}

export function passkeyUnlockSupported() {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.credentials) &&
    typeof PublicKeyCredential !== "undefined"
  );
}

async function requestPasskeyPrf(credentialId: Uint8Array, salt: Uint8Array) {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: toArrayBuffer(randomBytes(32)),
      allowCredentials: [
        {
          id: toArrayBuffer(credentialId),
          type: "public-key"
        }
      ],
      timeout: 60_000,
      userVerification: "required",
      extensions: extensionInputs(salt)
    }
  })) as PublicKeyCredentialWithPrf | null;

  if (!credential) {
    throw new Error("Passkey 인증이 취소되었습니다.");
  }

  if (!bytesEqual(new Uint8Array(credential.rawId), credentialId)) {
    throw new Error("요청한 Passkey와 응답한 Passkey가 일치하지 않습니다.");
  }

  const prfResult = prfResultBytes(credential);

  if (!prfResult || prfResult.byteLength !== 32) {
    throw new Error("이 Passkey는 안전한 노트 잠금 해제를 지원하지 않습니다.");
  }

  return prfResult;
}

export async function createPasskeyUnlockPayload(
  profile: UserProfile,
  keyDocument: UserKeyDocument,
  password: string
): Promise<UserPasskeyUnlock> {
  assertWebAuthnSupport();

  const privateKeyJson = await decryptPrivateKeyJsonForPassword(keyDocument, password);
  const prfSalt = randomBytes(32);
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: toArrayBuffer(randomBytes(32)),
      rp: {
        name: "QuickMemo"
      },
      user: {
        id: toArrayBuffer(encoder.encode(profile.uid)),
        name: profile.loginEmail,
        displayName: profile.displayName
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 }
      ],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required"
      },
      timeout: 60_000,
      attestation: "none",
      extensions: extensionInputs(prfSalt)
    }
  })) as PublicKeyCredentialWithPrf | null;

  if (!credential) {
    throw new Error("Passkey 등록이 취소되었습니다.");
  }

  const credentialId = new Uint8Array(credential.rawId);
  const prfResult = prfResultBytes(credential) ?? (await requestPasskeyPrf(credentialId, prfSalt));

  if (prfResult.byteLength !== 32) {
    throw new Error("이 Passkey는 안전한 노트 잠금 해제를 지원하지 않습니다.");
  }

  const unlockKey = await passkeyUnlockKey(prfResult, credentialId);

  return {
    version: 1,
    credentialId: bytesToBase64Url(credentialId),
    prfSalt: bytesToBase64(prfSalt),
    encryptedPrivateKeyJwk: await encryptText(privateKeyJson, unlockKey)
  };
}

export async function unlockPrivateKeyWithPasskeyPayload(keyDocument: UserKeyDocument) {
  assertWebAuthnSupport();

  if (!keyDocument.passkeyUnlock) {
    throw new Error("등록된 Passkey 잠금 해제가 없습니다.");
  }

  const credentialId = base64UrlToBytes(keyDocument.passkeyUnlock.credentialId);
  const prfSalt = base64ToBytes(keyDocument.passkeyUnlock.prfSalt);
  const prfResult = await requestPasskeyPrf(credentialId, prfSalt);
  const unlockKey = await passkeyUnlockKey(prfResult, credentialId);
  const privateKeyJson = await decryptText(keyDocument.passkeyUnlock.encryptedPrivateKeyJwk, unlockKey);

  return importPrivateKeyJson(privateKeyJson);
}
