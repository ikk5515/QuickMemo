import { describe, expect, it } from "vitest";
import {
  chooseVaultAudioRecorderMimeType,
  vaultAudioCaptureFromBlob,
  vaultAudioRecordingCapability,
  vaultAudioSuggestedName
} from "./audioRecorder";

describe("Vault audio recorder contract", () => {
  it("feature-detects secure media recording without opening a microphone", () => {
    const Recorder = class {} as unknown as typeof MediaRecorder;
    Object.defineProperty(Recorder, "isTypeSupported", { value: (mime: string) => mime === "audio/ogg;codecs=opus" });
    expect(vaultAudioRecordingCapability({
      isSecureContext: true,
      mediaDevices: { getUserMedia: async () => ({}) as MediaStream },
      MediaRecorder: Recorder
    })).toEqual({ available: true, mimeType: "audio/ogg;codecs=opus", reason: "available" });
    expect(chooseVaultAudioRecorderMimeType(Recorder)).toBe("audio/ogg;codecs=opus");
    expect(vaultAudioRecordingCapability({ isSecureContext: false })).toMatchObject({
      available: false,
      reason: "insecure-context"
    });
  });

  it("creates a bounded asset-v1 callback payload and normalizes codec metadata", async () => {
    const capture = await vaultAudioCaptureFromBlob(
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" }),
      { durationMs: 1_234.4, recordedAt: new Date(2026, 7, 22, 4, 5, 6) }
    );
    expect(capture).toMatchObject({
      durationMs: 1_234,
      mimeType: "audio/webm",
      suggestedName: "녹음20260822-040506.webm"
    });
    expect([...capture.bytes]).toEqual([1, 2, 3]);
    expect(vaultAudioSuggestedName(new Date(2026, 0, 2, 3, 4, 5), "audio/mp4")).toBe("녹음20260102-030405.m4a");
  });

  it("rejects empty, oversized and active-content MIME claims", async () => {
    await expect(vaultAudioCaptureFromBlob(new Blob([], { type: "audio/webm" }), { durationMs: 1 })).rejects.toThrow("없습니다");
    await expect(vaultAudioCaptureFromBlob(new Blob(["<script>"], { type: "text/html" }), { durationMs: 1 })).rejects.toThrow("지원하지 않는");
  });
});
