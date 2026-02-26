import { useState, useRef, useCallback, useEffect } from "react";

export function useAudioCapture({ chunkIntervalMs = 10000, onChunk }) {
  const [status, setStatus] = useState("idle"); // idle | recording | paused | stopped
  const [source, setSource] = useState("microphone");
  const [error, setError] = useState(null);

  const mediaStreamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const intervalRef = useRef(null);

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try { recorderRef.current.stop(); } catch (e) { /* ignore */ }
    }
    recorderRef.current = null;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    chunksRef.current = [];
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const processChunks = useCallback(() => {
    if (chunksRef.current.length === 0) return;
    const blob = new Blob(chunksRef.current, { type: "audio/webm;codecs=opus" });
    chunksRef.current = [];
    if (blob.size < 1024) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result?.split(",")[1];
      if (base64) onChunk(base64, "audio/webm");
    };
    reader.readAsDataURL(blob);
  }, [onChunk]);

  const startRecording = useCallback(async (audioSource) => {
    cleanup();
    setError(null);
    setSource(audioSource);

    try {
      let stream;
      if (audioSource === "system") {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        stream.getVideoTracks().forEach((t) => t.stop());
        if (stream.getAudioTracks().length === 0) {
          throw new Error("Nenhuma faixa de áudio capturada. Selecione 'Compartilhar áudio' ao escolher a aba/tela.");
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      }

      mediaStreamRef.current = stream;
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => { setStatus("stopped"); cleanup(); };
      });

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus" : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorderRef.current = recorder;
      recorder.start(1000);
      setStatus("recording");

      intervalRef.current = setInterval(processChunks, chunkIntervalMs);
    } catch (err) {
      const message = err?.name === "NotAllowedError"
        ? "Permissão de áudio negada. Verifique as configurações do navegador."
        : err?.message || "Erro ao iniciar captura de áudio.";
      setError(message);
      setStatus("idle");
      cleanup();
    }
  }, [cleanup, chunkIntervalMs, processChunks]);

  const pause = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      processChunks();
      recorderRef.current.pause();
      setStatus("paused");
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    }
  }, [processChunks]);

  const resume = useCallback(() => {
    if (recorderRef.current?.state === "paused") {
      recorderRef.current.resume();
      setStatus("recording");
      intervalRef.current = setInterval(processChunks, chunkIntervalMs);
    }
  }, [chunkIntervalMs, processChunks]);

  const stop = useCallback(() => {
    processChunks();
    cleanup();
    setStatus("stopped");
  }, [cleanup, processChunks]);

  return { status, source, error, startRecording, pause, resume, stop };
}
