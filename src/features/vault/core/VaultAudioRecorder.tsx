import { Circle, Mic, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  VAULT_AUDIO_DEFAULT_MAX_DURATION_MS,
  VAULT_AUDIO_MAX_BYTES,
  vaultAudioCaptureFromBlob,
  vaultAudioRecordingCapability,
  type VaultAudioCaptureHandler
} from "./audioRecorder";
import "./core.css";

type RecorderState = "idle" | "requesting" | "recording" | "saving";

export interface VaultAudioRecorderProps {
  disabled?: boolean;
  maxDurationMs?: number;
  onCapture: VaultAudioCaptureHandler;
}

function capabilityMessage(reason: ReturnType<typeof vaultAudioRecordingCapability>["reason"]) {
  switch (reason) {
    case "insecure-context":
      return "마이크 녹음은 HTTPS 보안 연결에서만 사용할 수 있습니다.";
    case "media-devices-unavailable":
      return "이 브라우저에서는 마이크 접근을 지원하지 않습니다.";
    case "media-recorder-unavailable":
      return "이 브라우저에서는 오디오 녹음을 지원하지 않습니다.";
    case "available":
      return "";
  }
}

export function VaultAudioRecorder({
  disabled = false,
  maxDurationMs = VAULT_AUDIO_DEFAULT_MAX_DURATION_MS,
  onCapture
}: VaultAudioRecorderProps) {
  const capability = useMemo(() => vaultAudioRecordingCapability(), []);
  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const byteLengthRef = useRef(0);
  const failureRef = useRef("");
  const startedAtRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      chunksRef.current = [];
      byteLengthRef.current = 0;
    };
  }, []);

  const boundedMaxDurationMs = Number.isFinite(maxDurationMs)
    ? Math.max(1_000, Math.min(VAULT_AUDIO_DEFAULT_MAX_DURATION_MS, Math.round(maxDurationMs)))
    : VAULT_AUDIO_DEFAULT_MAX_DURATION_MS;

  useEffect(() => {
    if (state !== "recording") return undefined;
    const update = () => {
      const nextElapsed = Math.max(0, Date.now() - startedAtRef.current);
      setElapsedMs(nextElapsed);
      if (nextElapsed >= boundedMaxDurationMs && recorderRef.current?.state === "recording") {
        recorderRef.current.stop();
      }
    };
    const interval = window.setInterval(update, 250);
    update();
    return () => window.clearInterval(interval);
  }, [boundedMaxDurationMs, state]);

  useEffect(() => {
    if (disabled && recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, [disabled]);

  function releaseStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }

  async function finishRecording(recorder: MediaRecorder) {
    const durationMs = Math.max(0, Date.now() - startedAtRef.current);
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const byteLength = byteLengthRef.current;
    byteLengthRef.current = 0;
    const recordingFailure = failureRef.current;
    failureRef.current = "";
    releaseStream();
    if (!mountedRef.current) return;
    if (recordingFailure) {
      setError(recordingFailure);
      setState("idle");
      return;
    }
    if (byteLength > VAULT_AUDIO_MAX_BYTES) {
      setError(`녹음이 ${Math.floor(VAULT_AUDIO_MAX_BYTES / 1024)}KB 제한을 넘었습니다. 더 짧게 녹음해주세요.`);
      setState("idle");
      return;
    }
    setState("saving");
    let captureBytes: Uint8Array | null = null;
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || capability.mimeType || "" });
      const capture = await vaultAudioCaptureFromBlob(blob, { durationMs });
      captureBytes = capture.bytes;
      await onCapture(capture);
      if (mountedRef.current) {
        setElapsedMs(0);
        setError("");
        setState("idle");
      }
    } catch (caught) {
      if (mountedRef.current) {
        setError(caught instanceof Error ? caught.message : "녹음을 암호화 저장 흐름으로 전달하지 못했습니다.");
        setState("idle");
      }
    } finally {
      captureBytes?.fill(0);
    }
  }

  async function startRecording() {
    if (disabled || state !== "idle" || !capability.available) return;
    setState("requesting");
    setError("");
    chunksRef.current = [];
    byteLengthRef.current = 0;
    failureRef.current = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const recorder = capability.mimeType
        ? new MediaRecorder(stream, { mimeType: capability.mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size <= 0) return;
        chunksRef.current.push(event.data);
        byteLengthRef.current += event.data.size;
        if (byteLengthRef.current > VAULT_AUDIO_MAX_BYTES && recorder.state === "recording") {
          recorder.stop();
        }
      });
      recorder.addEventListener("error", () => {
        failureRef.current = "브라우저에서 녹음을 계속할 수 없습니다.";
        if (recorder.state !== "inactive") recorder.stop();
      });
      recorder.addEventListener("stop", () => void finishRecording(recorder), { once: true });
      startedAtRef.current = Date.now();
      recorder.start(1_000);
      setElapsedMs(0);
      setState("recording");
    } catch (caught) {
      releaseStream();
      if (mountedRef.current) {
        setState("idle");
        setError(caught instanceof DOMException && caught.name === "NotAllowedError"
          ? "마이크 권한이 거부되었습니다. 브라우저 권한을 확인해주세요."
          : "마이크를 시작하지 못했습니다.");
      }
    }
  }

  const unavailableMessage = capability.available ? "" : capabilityMessage(capability.reason);
  const seconds = Math.floor(elapsedMs / 1_000);

  return (
    <section aria-label="Audio recorder" className="vault-core-panel vault-audio-recorder">
      <header><Mic aria-hidden="true" size={16} /><strong>Audio recorder</strong></header>
      <p>녹음은 서버나 외부 API로 전송하지 않고, 완료 후 기존 asset-v1 E2EE 저장 콜백으로만 전달합니다.</p>
      {unavailableMessage ? <p role="status">{unavailableMessage}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="vault-audio-recorder__controls">
        {state === "recording" ? (
          <button onClick={() => recorderRef.current?.stop()} type="button">
            <Square aria-hidden="true" size={14} /> 녹음 중지
          </button>
        ) : (
          <button
            disabled={disabled || !capability.available || state !== "idle"}
            onClick={() => void startRecording()}
            type="button"
          >
            <Circle aria-hidden="true" fill="currentColor" size={12} />
            {state === "requesting" ? "마이크 여는 중…" : state === "saving" ? "암호화 저장 준비 중…" : "녹음 시작"}
          </button>
        )}
        <output aria-live="polite">{state === "recording" ? `${seconds}초` : "대기"}</output>
      </div>
      <small>브라우저별 지원 형식으로 최대 {Math.floor(boundedMaxDurationMs / 1_000)}초·{Math.floor(VAULT_AUDIO_MAX_BYTES / 1024)}KB까지 녹음합니다.</small>
    </section>
  );
}
