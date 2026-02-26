import { useState, useRef, useCallback } from "react";

export function useOptimizedAudioCapture({
  onChunk,
  silenceThreshold = 800, // ms de silêncio para forçar o chunk
  maxChunkMs = 12000, // 12 segundos max
  minChunkMs = 3000, // 3 segundos min
}) {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [metrics, setMetrics] = useState({ bytesSent: 0, chunksSent: 0 });

  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const chunkTimerRef = useRef(null);
  const audioDataRef = useRef([]);
  const isSpeechActiveRef = useRef(false);

  const sendChunk = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.requestData();
    }
    clearTimeout(chunkTimerRef.current);
    chunkTimerRef.current = null;
  }, []);

  const processAudio = useCallback(() => {
    if (!analyserRef.current || !audioContextRef.current || status !== 'recording') return;

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);
    
    // Calcula volume médio (simples VAD)
    const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
    const isSpeech = average > 15; // Threshold ajustável

    if (isSpeech) {
      // Atividade de voz detectada
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      isSpeechActiveRef.current = true;
    } else if (isSpeechActiveRef.current) {
      // Silêncio detectado após fala
      if (!silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(() => {
          isSpeechActiveRef.current = false;
          sendChunk(); // Força o envio do chunk após o silêncio
        }, silenceThreshold);
      }
    }

    requestAnimationFrame(processAudio);
  }, [silenceThreshold, status, sendChunk]);

  const startRecording = useCallback(async (sourceType) => {
    try {
      setStatus("starting");
      
      // 1. Obter Stream
      const stream = await (sourceType === "system"
        ? navigator.mediaDevices.getDisplayMedia({ video: false, audio: true })
        : navigator.mediaDevices.getUserMedia({ audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true
          } }));

      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        throw new Error("No audio track found in the selected source.");
      }

      streamRef.current = new MediaStream([audioTrack]);
      
      // 2. Setup AudioContext para VAD
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const sourceNode = audioContextRef.current.createMediaStreamSource(streamRef.current);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      sourceNode.connect(analyserRef.current);

      // 3. Setup MediaRecorder
      mediaRecorderRef.current = new MediaRecorder(streamRef.current, { mimeType: "audio/webm;codecs=opus" });
      audioDataRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioDataRef.current.push(event.data);
          const blob = new Blob(audioDataRef.current, { type: "audio/webm;codecs=opus" });
          
          // Envia o chunk
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = reader.result.split(",")[1];
            const estimatedDuration = blob.size / (16000 * 1 * 2); // Aproximação
            onChunk(base64, "audio/webm;codecs=opus", estimatedDuration);
            setMetrics((prev) => ({ bytesSent: prev.bytesSent + blob.size, chunksSent: prev.chunksSent + 1 }));
          };
          reader.readAsDataURL(blob);
          
          audioDataRef.current = []; // Reset para o próximo chunk
          
          // Reinicia o timer de segurança
          clearTimeout(chunkTimerRef.current);
          chunkTimerRef.current = setTimeout(sendChunk, maxChunkMs);
        }
      };

      mediaRecorderRef.current.onstart = () => {
        setStatus("recording");
        processAudio(); // Inicia o loop de VAD
        chunkTimerRef.current = setTimeout(sendChunk, maxChunkMs); // Timer de segurança
      };
      
      mediaRecorderRef.current.start(500); // Grava em timeslices de 500ms
      
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }, [processAudio, maxChunkMs, onChunk, sendChunk]);

  const pause = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.pause();
      setStatus("paused");
      clearTimeout(silenceTimerRef.current);
      clearTimeout(chunkTimerRef.current);
    }
  }, []);

  const resume = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
      mediaRecorderRef.current.resume();
      setStatus("recording");
      processAudio(); // Reinicia o loop de VAD
      chunkTimerRef.current = setTimeout(sendChunk, maxChunkMs);
    }
  }, [maxChunkMs, sendChunk, processAudio]);

  const stop = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    clearTimeout(silenceTimerRef.current);
    clearTimeout(chunkTimerRef.current);
    setStatus("idle");
    isSpeechActiveRef.current = false;
  }, []);

  return { status, error, metrics, startRecording, pause, resume, stop };
}
