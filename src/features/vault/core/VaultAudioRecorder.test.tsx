import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultAudioRecorder } from "./VaultAudioRecorder";

class FakeMediaRecorder extends EventTarget {
  static latest: FakeMediaRecorder | null = null;
  static isTypeSupported(mimeType: string) {
    return mimeType === "audio/webm;codecs=opus";
  }

  mimeType: string;
  state: RecordingState = "inactive";

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.latest = this;
  }

  start() {
    this.state = "recording";
  }

  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    const dataEvent = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(dataEvent, "data", { value: new Blob([new Uint8Array([7, 8])], { type: this.mimeType }) });
    this.dispatchEvent(dataEvent);
    this.dispatchEvent(new Event("stop"));
  }

  fail() {
    this.dispatchEvent(new Event("error"));
  }
}

const originalMediaRecorder = globalThis.MediaRecorder;
const originalMediaDevices = navigator.mediaDevices;

afterEach(() => {
  FakeMediaRecorder.latest = null;
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: originalMediaRecorder });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: originalMediaDevices });
});

describe("VaultAudioRecorder", () => {
  it("stops tracks and hands bytes only to the encrypted asset callback", async () => {
    const stopTrack = vi.fn();
    Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
    });
    let copiedBytes: number[] = [];
    const onCapture = vi.fn(async (capture) => {
      copiedBytes = [...capture.bytes];
    });
    render(<VaultAudioRecorder onCapture={onCapture} />);

    fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
    await screen.findByRole("button", { name: "녹음 중지" });
    fireEvent.click(screen.getByRole("button", { name: "녹음 중지" }));

    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
    expect(copiedBytes).toEqual([7, 8]);
    expect(stopTrack).toHaveBeenCalled();
    expect(screen.getByText("대기")).toBeInTheDocument();
  });

  it("discards a partial recording after a recorder error", async () => {
    const stopTrack = vi.fn();
    Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) }
    });
    const onCapture = vi.fn(async () => undefined);
    render(<VaultAudioRecorder onCapture={onCapture} />);

    fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
    await screen.findByRole("button", { name: "녹음 중지" });
    act(() => FakeMediaRecorder.latest?.fail());

    expect(await screen.findByRole("alert")).toHaveTextContent("계속할 수 없습니다");
    expect(onCapture).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalled();
  });
});
