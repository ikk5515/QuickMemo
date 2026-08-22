import {
  MAX_INLINE_VAULT_ASSET_BYTES,
  normalizeVaultAssetMimeType
} from "../vaultAsset";

export const VAULT_AUDIO_MAX_BYTES = MAX_INLINE_VAULT_ASSET_BYTES;
export const VAULT_AUDIO_DEFAULT_MAX_DURATION_MS = 120_000;

const supportedAudioTypes = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
  "audio/wav"
] as const;

const audioExtensions: Readonly<Record<string, string>> = {
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm"
};

export interface VaultAudioCapture {
  /** Plaintext exists only for the duration of the callback. Persist it with createEncryptedVaultAsset. */
  bytes: Uint8Array;
  durationMs: number;
  mimeType: string;
  suggestedName: string;
}

/** The Promise must cover asset-v1 encoding/encryption before the byte buffer is wiped. */
export type VaultAudioCaptureHandler = (capture: VaultAudioCapture) => Promise<unknown>;

export interface VaultAudioRecordingCapability {
  available: boolean;
  mimeType: string | null;
  reason: "available" | "insecure-context" | "media-devices-unavailable" | "media-recorder-unavailable";
}

interface AudioRecordingEnvironment {
  isSecureContext?: boolean;
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  MediaRecorder?: typeof MediaRecorder;
}

function canonicalAudioMimeType(value: string) {
  const base = value.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? "";
  return base in audioExtensions ? base : "application/octet-stream";
}

export function chooseVaultAudioRecorderMimeType(
  recorder: Pick<typeof MediaRecorder, "isTypeSupported"> | undefined
): string | null {
  if (!recorder || typeof recorder.isTypeSupported !== "function") {
    return null;
  }
  return supportedAudioTypes.find((mimeType) => recorder.isTypeSupported(mimeType)) ?? null;
}

export function vaultAudioRecordingCapability(
  environment: AudioRecordingEnvironment = {
    isSecureContext: globalThis.isSecureContext,
    mediaDevices: globalThis.navigator?.mediaDevices,
    MediaRecorder: globalThis.MediaRecorder
  }
): VaultAudioRecordingCapability {
  if (environment.isSecureContext === false) {
    return { available: false, mimeType: null, reason: "insecure-context" };
  }
  if (!environment.mediaDevices || typeof environment.mediaDevices.getUserMedia !== "function") {
    return { available: false, mimeType: null, reason: "media-devices-unavailable" };
  }
  if (!environment.MediaRecorder) {
    return { available: false, mimeType: null, reason: "media-recorder-unavailable" };
  }
  return {
    available: true,
    mimeType: chooseVaultAudioRecorderMimeType(environment.MediaRecorder),
    reason: "available"
  };
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

export function vaultAudioSuggestedName(recordedAt: Date, mimeType: string) {
  const normalizedMimeType = canonicalAudioMimeType(mimeType);
  const extension = audioExtensions[normalizedMimeType] ?? "bin";
  return [
    "녹음",
    recordedAt.getFullYear(),
    twoDigits(recordedAt.getMonth() + 1),
    twoDigits(recordedAt.getDate()),
    "-",
    twoDigits(recordedAt.getHours()),
    twoDigits(recordedAt.getMinutes()),
    twoDigits(recordedAt.getSeconds())
  ].join("") + `.${extension}`;
}

async function bytesFromBlob(blob: Blob) {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof FileReader === "undefined") {
    throw new Error("이 브라우저에서는 녹음 데이터를 읽을 수 없습니다.");
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(new Error("녹음 데이터를 안전하게 읽지 못했습니다.")), { once: true });
    reader.addEventListener("load", () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error("녹음 데이터를 안전하게 읽지 못했습니다."));
    }, { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

export async function vaultAudioCaptureFromBlob(
  blob: Blob,
  options: { durationMs: number; recordedAt?: Date }
): Promise<VaultAudioCapture> {
  if (!(blob instanceof Blob) || blob.size <= 0) {
    throw new Error("녹음된 오디오 데이터가 없습니다.");
  }
  if (blob.size > VAULT_AUDIO_MAX_BYTES) {
    throw new Error(`녹음 파일은 ${Math.floor(VAULT_AUDIO_MAX_BYTES / 1024)}KB 이하만 Vault에 암호화해 저장할 수 있습니다.`);
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs < 0) {
    throw new Error("녹음 시간을 확인할 수 없습니다.");
  }
  const claimedMimeType = canonicalAudioMimeType(blob.type);
  const mimeType = normalizeVaultAssetMimeType(claimedMimeType);
  if (!mimeType.startsWith("audio/")) {
    throw new Error("지원하지 않는 녹음 형식입니다.");
  }
  const bytes = await bytesFromBlob(blob);
  if (bytes.byteLength !== blob.size) {
    bytes.fill(0);
    throw new Error("녹음 데이터를 안전하게 읽지 못했습니다.");
  }
  const recordedAt = options.recordedAt ?? new Date();
  return {
    bytes,
    durationMs: Math.round(options.durationMs),
    mimeType,
    suggestedName: vaultAudioSuggestedName(recordedAt, mimeType)
  };
}
