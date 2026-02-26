// src/useOptimizedAudioCapture.js - Áudio otimizado com silence detection
import { useState, useRef, useCallback, useEffect } from "react";

export function useOptimizedAudioCapture({ 
  onChunk, 
  silenceThreshold = 800,  // ms de silêncio para trigger
  maxChunkMs = 12000,      // máximo 12s (economia vs latência)
  minChunkMs = 3000        // mínimo 3s para evitar chunks vazios
}) {
  const [status, setStatus] = useState("idle");
  const [source, setSource] = useState("microphone");
  const [error, setError] = useState(null);
  const [metrics, setMetrics] = useState({ bytesSent: 0, chunksSent: 0 });

  const mediaStreamRef = useRef(null);
  const recorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const silenceStartRef = useRef(null);
  const chunksRef = useRef([]);
  const intervalRef = useRef(null);
  const dataArrayRef = useRef(null);
  const startTimeRef = useRef(0);

  const cleanup = useCallback(() => {
    clearInterval(intervalRef.current);
    
    if (recorderRef.current?.state !== "inactive") {
      try { recorderRef.current?.stop(); } catch (e) {}
    }
    
    audioContextRef.current?.close().catch(() => {});
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    
    recorderRef.current = null;
    audioContextRef.current = null;
    mediaStreamRef.current = null;
    analyserRef.current = null;
    silenceStartRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const processChunks = useCallback((force = false) => {
    const elapsed = Date.now() - startTimeRef.current;
    
    // Só processa se tem dados suficientes ou foi forçado
    if (chunksRef.current.length === 0) return;
    if (!force && elapsed < minChunkMs) return;
    
    const blob = new Blob(chunksRef.current, { type: "audio/webm;codecs=opus" });
    chunksRef.current = [];
    startTimeRef.current = Date.now();
    
    if (blob.size < 1024) return; // Ignora muito pequeno
    
    // Estatísticas
    setMetrics(prev => ({
      bytesSent: prev.bytesSent + blob.size,
      chunksSent: prev.chunksSent + 1
    }));

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result?.split(",")[1];
      if (base64) {
        // Estimativa: ~1.5kb/s com opus 32kbps mono
        const estimatedDuration = blob.size / 1500;
        onChunk(base64, "audio/webm", blob.size, estimatedDuration);
      }
    };
    reader.readAsDataURL(blob);
  }, [onChunk, minChunkMs]);

  const setupSilenceDetection = useCallback((stream) => {
    audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContextRef.current.createMediaStreamSource(stream);
    analyserRef.current = audioContextRef.current.createAnalyser();
    analyserRef.current.fftSize = 512;
    analyserRef.current.smoothingTimeConstant = 0.8;
    
    source.connect(analyserRef.current);
    dataArrayRef.current = new Uint8Array(analyserRef.current.frequencyBinCount);
    
    const detect = () => {
      if (!analyserRef.current || status !== "recording") return;
      
      analyserRef.current.getByteFrequencyData(dataArrayRef.current);
      const sum = dataArrayRef.current.reduce((a, b) => a + b, 0);
      const average = sum / dataArrayRef.current.length;
      
      const now = Date.now();
      
      if (average < 5) { // Silêncio detectado (threshold baixo)
        if (!silenceStartRef.current) {
          silenceStartRef.current = now;
        } else if (now - silenceStartRef.current > silenceThreshold) {
          // Silêncio prolongado, envia imediatamente
          processChunks(true);
          silenceStartRef.current = null;
        }
      } else {
        silenceStartRef.current = null;
      }
      
      requestAnimationFrame(detect);
    };
    
    detect();
  }, [status, silenceThreshold, processChunks]);

  const startRecording = useCallback(async (audioSource) => {
    cleanup();
    setError(null);
    setSource(audioSource);
    setStatus("starting");
    startTimeRef.current = Date.now();

    try {
      const constraints = audioSource === "system" 
        ? { video: true, audio: { channelCount: 1, sampleRate: 16000, sampleSize: 16 } }
        : { 
            audio: { 
              echoCancellation: true, 
              noiseSuppression: true, 
              autoGainControl: true,
              channelCount: 1,
              sampleRate: 16000,
              sampleSize: 16
            } 
          };

      let stream;
      if (audioSource === "system") {
        stream = await navigator.mediaDevices.getDisplayMedia(constraints);
        stream.getVideoTracks().forEach(t => t.stop());
        if (stream.getAudioTracks().length === 0) {
          throw new Error("No audio track. Select 'Share audio' when choosing tab.");
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      }

      mediaStreamRef.current = stream;
      setupSilenceDetection(stream);
      
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus" 
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { 
        mimeType, 
        audioBitsPerSecond: 24000 // 24kbps suficiente para voz clara
      });
      
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorderRef.current = recorder;
      recorder.start(500); // Coleta a cada 500ms para responsividade
      
      setStatus("recording");
      
      // Intervalo de segurança
      intervalRef.current = setInterval(() => {
        processChunks(true);
      }, maxChunkMs);

    } catch (err) {
      const message = err?.name === "NotAllowedError"
        ? "Permission denied. Check browser settings."
        : err?.message || "Error starting capture.";
      setError(message);
      setStatus("idle");
      cleanup();
    }
  }, [cleanup, setupSilenceDetection, processChunks, maxChunkMs]);

  const pause = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      processChunks(true);
      recorderRef.current.pause();
      setStatus("paused");
      clearInterval(intervalRef.current);
    }
  }, [processChunks]);

  const resume = useCallback(() => {
    if (recorderRef.current?.state === "paused") {
      recorderRef.current.resume();
      setStatus("recording");
      startTimeRef.current = Date.now();
      intervalRef.current = setInterval(() => processChunks(true), maxChunkMs);
    }
  }, [processChunks, maxChunkMs]);

  const stop = useCallback(() => {
    processChunks(true);
    cleanup();
    setStatus("stopped");
  }, [cleanup, processChunks]);

  return { 
    status, 
    source, 
    error, 
    metrics,
    startRecording, 
    pause, 
    resume, 
    stop 
  };
}
